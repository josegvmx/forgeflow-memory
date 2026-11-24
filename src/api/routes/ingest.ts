import { Hono } from 'hono';
import { z } from 'zod';
import { ScenarioIdSchema } from '../../audit/scenarioId.js';
import { FlatMetadataSchema, RunIdSchema, SourceSchema } from '../../audit/simEpisode.js';
import { EVENT_TYPES } from '../../types.js';
import { ingestArchive } from '../../ingest/pipeline.js';
import { clearRecommendationCache } from '../../store/recommendationCache.js';

const ingestRoute = new Hono();

const ReasoningEventSchema = z.object({
  scenarioId: ScenarioIdSchema,
  nodeId:     z.string(),
  cycle:      z.number().int().nonnegative(),
  eventType:  z.enum(EVENT_TYPES),
  mode:       z.enum(['heuristic', 'ai']),
  content:    z.string().min(1),
  // R14: flat only (the chunker stringifies values); runId to its own column, source into metadata.
  metadata:   FlatMetadataSchema.optional(),
  runId:      RunIdSchema.optional(),
  source:     SourceSchema.optional(),
}).transform(({ source, ...e }) => (source ? { ...e, metadata: { ...(e.metadata ?? {}), source } } : e));

const IngestBody = z.object({
  archive: z.array(ReasoningEventSchema).min(1),
});

/**
 * POST /ingest
 * Body: { archive: ReasoningEvent[] }
 * Response: { ingested, skipped, embedded, cached } — embedded / cached count distinct embedding texts
 */
ingestRoute.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const result = IngestBody.safeParse(raw);
  if (!result.success) {
    return c.json({ error: result.error.flatten() }, 400);
  }
  const { archive } = result.data;
  let stats: { inserted: number; skipped: number; embedded?: number; cached?: number } | undefined;

  try {
    stats = await ingestArchive(archive, (done, total) => {
      process.stderr.write(`\rIngesting... ${done}/${total}`);
    });
    process.stderr.write('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] failed after ${archive.length} events received: ${message}`);
    return c.json({ error: `Ingest failed: ${message}` }, 500);
  }

  // Invalidate recommendation cache — new data may change past recommendations
  const invalidated = await clearRecommendationCache();
  if (invalidated > 0) {
    process.stderr.write(`Cleared ${invalidated} cached recommendation(s) after ingest.\n`);
  }

  return c.json({ ingested: stats?.inserted ?? archive.length, skipped: stats?.skipped ?? 0, embedded: stats?.embedded ?? 0, cached: stats?.cached ?? 0 });
});

export default ingestRoute;
