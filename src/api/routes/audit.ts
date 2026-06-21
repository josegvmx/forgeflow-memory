import { Hono } from 'hono';
import { z } from 'zod';
import { generateScenarioId } from '../../audit/scenarioId.js';
import { ingestAuditEvent } from '../../audit/events.js';
import { auditFailureResponse } from '../../audit/audit.js';
import { getFailureRecommendation, compareModesForScenario } from '../../audit/recommend.js';
import { queryMemory } from '../../retrieval/query.js';
import type { ScenarioConfig } from '../../audit/scenarioId.js';

const auditRoute = new Hono();

// ── Zod schemas ───────────────────────────────────────────────
const ModeEnum = z.enum(['heuristic', 'ai']);

const MachineFailureMetaSchema = z.object({
  machineId:        z.string(),
  failureType:      z.enum(['breakdown', 'maintenance', 'capacity_reduction']),
  affectedCapacity: z.number(),
  affectedProducts: z.array(z.string()),
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
  scenarioId: z.string(),
  nodeId:     z.string(),
  cycle:      z.number().int().nonnegative(),
  mode:       ModeEnum,
  content:    z.string().min(1),
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
// POST /scenarios
// Body: { config: ScenarioConfig }
// Returns: { scenarioId }
// ──────────────────────────────────────────────
auditRoute.post('/scenarios', async (c) => {
  let body: { config: ScenarioConfig };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.config) {
    return c.json({ error: '`config` is required' }, 400);
  }

  const scenarioId = generateScenarioId(body.config);
  return c.json({ scenarioId });
});

// ──────────────────────────────────────────────
// POST /events
// Body: MachineFailureEvent | RoutingAdjustmentEvent | RecoveryOutcomeEvent
// Returns: { ok: true }
// ──────────────────────────────────────────────
auditRoute.post('/events', async (c) => {
  const raw = await c.req.json().catch(() => null);
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
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Recommendation failed: ${message}` }, 500);
  }
});

// ──────────────────────────────────────────────
// GET /scenarios/:scenarioId/summary
// Returns all events for the scenario + mode comparison
// ──────────────────────────────────────────────
auditRoute.get('/scenarios/:scenarioId/summary', async (c) => {
  const scenarioId = c.req.param('scenarioId');

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
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Summary failed: ${message}` }, 500);
  }
});

export default auditRoute;
