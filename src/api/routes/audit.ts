import { Hono } from 'hono';
import { generateScenarioId } from '../../audit/scenarioId.js';
import { ingestAuditEvent } from '../../audit/events.js';
import { auditFailureResponse } from '../../audit/audit.js';
import { getFailureRecommendation, compareModesForScenario } from '../../audit/recommend.js';
import { queryMemory } from '../../retrieval/query.js';
import type { ScenarioConfig } from '../../audit/scenarioId.js';
import type { MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent } from '../../audit/events.js';

const auditRoute = new Hono();

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
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const required = ['scenarioId', 'nodeId', 'cycle', 'mode', 'content', 'metadata'];
  const missing = required.filter((k) => !(k in body));
  if (missing.length > 0) {
    return c.json({ error: `Missing required fields: ${missing.join(', ')}` }, 400);
  }

  const meta = body.metadata as Record<string, unknown>;
  const validTypes = ['failureType', 'triggeredByFailure', 'cyclesDowntime'];
  const hasValidMeta = validTypes.some((k) => k in meta);
  if (!hasValidMeta) {
    return c.json({
      error: 'metadata must be a MachineFailureEvent, RoutingAdjustmentEvent, or RecoveryOutcomeEvent shape',
    }, 400);
  }

  try {
    await ingestAuditEvent(body as MachineFailureEvent | RoutingAdjustmentEvent | RecoveryOutcomeEvent);
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
  let body: {
    failure: MachineFailureEvent;
    adjustments: RoutingAdjustmentEvent[];
    outcome: RecoveryOutcomeEvent;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { failure, adjustments, outcome } = body;
  if (!failure || !outcome) {
    return c.json({ error: '`failure` and `outcome` are required' }, 400);
  }

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
  let body: { failure: MachineFailureEvent; scopeToScenario?: boolean; skipCache?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.failure) {
    return c.json({ error: '`failure` is required' }, 400);
  }

  try {
    const result = await getFailureRecommendation(body.failure, {
      scopeToScenario: body.scopeToScenario,
      skipCache: body.skipCache,
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
