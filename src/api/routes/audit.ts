import { Hono } from 'hono';
import { z } from 'zod';
import { ScenarioIdSchema, SCENARIO_ID_SOURCE } from '../../audit/scenarioId.js';
import { ingestAuditEvent } from '../../audit/events.js';
import { SimEpisodeSchema, simEpisodeToReasoningEvent, looksLikeSimEpisode } from '../../audit/simEpisode.js';
import { ingestEvent } from '../../ingest/pipeline.js';
import { auditFailureResponse } from '../../audit/audit.js';
import { getFailureRecommendation, compareModesForScenario } from '../../audit/recommend.js';
import { queryMemory } from '../../retrieval/query.js';

const auditRoute = new Hono();

// ── Zod schemas ───────────────────────────────────────────────
const ModeEnum = z.enum(['heuristic', 'ai']);

// Identifiers are short, plain tokens. They are interpolated into LLM prompts,
// so free text is never accepted in these fields.
const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be 1-64 letters, digits, or _ . : -');

const MachineFailureMetaSchema = z.object({
  machineId:        Identifier,
  failureType:      z.enum(['breakdown', 'maintenance', 'capacity_reduction']),
  affectedCapacity: z.number().min(0).max(100),
  affectedProducts: z.array(Identifier).max(20),
  cycleOfRecovery:  z.number().int().optional(),
});

const RoutingAdjustmentMetaSchema = z.object({
  triggeredByFailure:    z.string(),
  fromMachine:           z.string(),
  toMachine:             z.string(),
  productsRerouted:      z.array(z.string()),
  throughputBefore:      z.number(),
  throughputAfter:       z.number(),
  decisionLatencyCycles: z.number().int(),
});

const RecoveryOutcomeMetaSchema = z.object({
  machineId:        z.string(),
  cyclesDowntime:   z.number().int(),
  productionLost:   z.number(),
  recoveryStrategy: z.string(),
  successful:       z.boolean(),
});

const AuditEventBaseSchema = z.object({
  scenarioId: ScenarioIdSchema,
  nodeId:     Identifier,
  cycle:      z.number().int().nonnegative(),
  mode:       ModeEnum,
  content:    z.string().min(1).max(4000),
});

const AuditEventSchema = z.discriminatedUnion('eventType', [
  AuditEventBaseSchema.extend({ eventType: z.literal('machine_failure'),    metadata: MachineFailureMetaSchema }),
  AuditEventBaseSchema.extend({ eventType: z.literal('routing_adjustment'), metadata: RoutingAdjustmentMetaSchema }),
  AuditEventBaseSchema.extend({ eventType: z.literal('recovery'),           metadata: RecoveryOutcomeMetaSchema }),
]);

const MachineFailureSchema = AuditEventBaseSchema.extend({ eventType: z.literal('machine_failure'),    metadata: MachineFailureMetaSchema });
const RoutingAdjustmentSchema = AuditEventBaseSchema.extend({ eventType: z.literal('routing_adjustment'), metadata: RoutingAdjustmentMetaSchema });
const RecoveryOutcomeSchema = AuditEventBaseSchema.extend({ eventType: z.literal('recovery'),           metadata: RecoveryOutcomeMetaSchema });

const AuditBodySchema = z.object({
  failure:     MachineFailureSchema,
  adjustments: z.array(RoutingAdjustmentSchema).optional(),
  outcome:     RecoveryOutcomeSchema,
});

const RecommendBodySchema = z.object({
  failure:         MachineFailureSchema,
  scopeToScenario: z.boolean().optional(),
  skipCache:       z.boolean().optional(),
});

// ──────────────────────────────────────────────
// POST /scenarios — removed in R14
// The scenarioId is computed by forgeflow-sim and sent as given; this service no longer hashes
// scenario configs. Kept as 410 so an old caller gets a reason instead of a 404.
// ──────────────────────────────────────────────
auditRoute.post('/scenarios', (c) =>
  c.json({ error: `Gone: scenarioId is computed by ${SCENARIO_ID_SOURCE} and sent as given.` }, 410));

// ──────────────────────────────────────────────
// POST /events
// Body: MachineFailureEvent | RoutingAdjustmentEvent | RecoveryOutcomeEvent
//     | a forgeflow-sim episode (R14 §4.3: runId + source, flat metadata, fault.* labels)
// Returns: { ok: true } — for a sim episode also { inserted } (0 when it was already stored)
// ──────────────────────────────────────────────
auditRoute.post('/events', async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (looksLikeSimEpisode(raw)) {
    const episode = SimEpisodeSchema.safeParse(raw);
    if (!episode.success) return c.json({ error: episode.error.flatten() }, 400);
    try {
      const stats = await ingestEvent(simEpisodeToReasoningEvent(episode.data));
      return c.json({ ok: true, inserted: stats?.inserted ?? 1 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Event ingest failed: ${message}` }, 500);
    }
  }
  const parsed = AuditEventSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  try {
    await ingestAuditEvent(parsed.data);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Event ingest failed: ${message}` }, 500);
  }
});

// ──────────────────────────────────────────────
// POST /audit
// Body: { failure, adjustments, outcome }
// Returns: AuditResult
// ──────────────────────────────────────────────
auditRoute.post('/audit', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = AuditBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { failure, adjustments, outcome } = parsed.data;

  try {
    const result = await auditFailureResponse(failure, adjustments ?? [], outcome);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Audit failed: ${message}` }, 500);
  }
});

// ──────────────────────────────────────────────
// POST /recommend
// Body: { failure: MachineFailureEvent, scopeToScenario?: boolean }
// Returns: { recommendation: string }
// ──────────────────────────────────────────────
auditRoute.post('/recommend', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = RecommendBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { failure, scopeToScenario, skipCache } = parsed.data;

  try {
    const result = await getFailureRecommendation(failure, {
      scopeToScenario,
      skipCache,
    });
    return c.json(result);  // { recommendation, fromCache }
  } catch (err) {
    console.error('[recommend] failed:', err);
    return c.json({ error: 'Recommendation failed. Please try again later.' }, 500);
  }
});

// ──────────────────────────────────────────────
// GET /scenarios/:scenarioId/summary
// Returns all events for the scenario + mode comparison
// ──────────────────────────────────────────────
auditRoute.get('/scenarios/:scenarioId/summary', async (c) => {
  const scenarioId = c.req.param('scenarioId');
  if (!ScenarioIdSchema.safeParse(scenarioId).success) {
    return c.json({ error: 'Invalid scenarioId' }, 400);
  }

  try {
    const [failures, adjustments, recoveries] = await Promise.all([
      queryMemory({ context: 'machine failures', scenarioId, topK: 50, eventTypeFilter: ['machine_failure'] }),
      queryMemory({ context: 'routing adjustments', scenarioId, topK: 50, eventTypeFilter: ['routing_adjustment'] }),
      queryMemory({ context: 'recovery outcomes', scenarioId, topK: 50, eventTypeFilter: ['recovery'] }),
    ]);

    const modeComparison = await compareModesForScenario(scenarioId);

    return c.json({
      scenarioId,
      failures: failures.events,
      adjustments: adjustments.events,
      recoveries: recoveries.events,
      modeComparison,
    });
  } catch (err) {
    console.error('[summary] failed:', err);
    return c.json({ error: 'Summary failed. Please try again later.' }, 500);
  }
});

export default auditRoute;
