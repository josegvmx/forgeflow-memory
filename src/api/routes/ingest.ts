import { Hono } from 'hono';
import { z } from 'zod';
import { ingestArchive } from '../../ingest/pipeline.js';
import { clearRecommendationCache } from '../../store/recommendationCache.js';

const ingestRoute = new Hono();

const ReasoningEventSchema = z.object({
  scenarioId: z.string(),
  nodeId:     z.string(),
  cycle:      z.number().int().nonnegative(),
  eventType:  z.enum(['machine_failure', 'routing_adjustment', 'decision', 'coalition', 'recovery']),
  mode:       z.enum(['heuristic', 'ai']),
  content:    z.string().min(1),
  metadata:   z.record(z.unknown()).optional(),
});

const IngestBody = z.object({
  archive: z.array(ReasoningEventSchema).min(1),
});

/**
 * POST /ingest
 * Body: { archive: ReasoningEvent[] }
 * Response: { ingested: number }
 */
ingestRoute.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const result = IngestBody.safeParse(raw);
  if (!result.success) {
    return c.json({ error: result.error.flatten() }, 400);
  }
  const { archive } = result.data;
  let stats: { inserted: number; skipped: number } | undefined;

  try {
    stats = await ingestArchive(archive, (done, total) => {
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

  return c.json({ ingested: stats?.inserted ?? archive.length, skipped: stats?.skipped ?? 0 });
});

export default ingestRoute;
