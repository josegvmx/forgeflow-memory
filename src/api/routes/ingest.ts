import { Hono } from 'hono';
import { ingestArchive } from '../../ingest/pipeline.js';
import { clearRecommendationCache } from '../../store/recommendationCache.js';
import type { ReasoningEvent } from '../../types.js';

const ingestRoute = new Hono();

/**
 * POST /ingest
 * Body: { archive: ReasoningEvent[] }
 * Response: { ingested: number }
 */
ingestRoute.post('/', async (c) => {
  let body: { archive: ReasoningEvent[] };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { archive } = body;

  if (!Array.isArray(archive) || archive.length === 0) {
    return c.json({ error: '`archive` must be a non-empty array of ReasoningEvents' }, 400);
  }

  // Basic shape validation on the first item — catches obviously wrong payloads
  const sample = archive[0];
  const required = ['scenarioId', 'nodeId', 'cycle', 'eventType', 'mode', 'content'];
  const missing = required.filter((k) => !(k in sample));
  if (missing.length > 0) {
    return c.json({ error: `Missing required fields: ${missing.join(', ')}` }, 400);
  }

  try {
    await ingestArchive(archive, (done, total) => {
      process.stderr.write(`\rIngesting... ${done}/${total}`);
    });
    process.stderr.write('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Ingest failed: ${message}` }, 500);
  }

  // Invalidate recommendation cache — new data may change past recommendations
  const invalidated = await clearRecommendationCache();
  if (invalidated > 0) {
    process.stderr.write(`Cleared ${invalidated} cached recommendation(s) after ingest.\n`);
  }

  return c.json({ ingested: archive.length });
});

export default ingestRoute;
