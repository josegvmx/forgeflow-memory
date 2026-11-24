import { Hono } from 'hono';
import { RunsBodySchema } from '../../audit/runRow.js';
import { upsertRuns } from '../../store/runs.js';

const runsRoute = new Hono();

/**
 * POST /runs (admin) — benchmark rows from forgeflow-sim (roadmap R14 §4.5).
 * Body: { runs: RunRow[] } (1–1000). Whole batch validated first; nothing stored on a 400.
 * Response: { inserted, updated } — a run_id already stored is replaced, not duplicated.
 */
runsRoute.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const result = RunsBodySchema.safeParse(raw);
  if (!result.success) {
    // Say which rows failed (path starts with ['runs', index]); cap the list.
    const issues = result.error.issues.slice(0, 20).map(i => ({ path: i.path.join('.'), message: i.message }));
    return c.json({ error: 'Invalid runs', issues }, 400);
  }
  const stats = await upsertRuns(result.data.runs);
  return c.json(stats);
});

export default runsRoute;
