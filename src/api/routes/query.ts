import { Hono } from 'hono';
import { z } from 'zod';
import { queryMemory } from '../../retrieval/query.js';

const queryRoute = new Hono();

const EventTypeEnum = z.enum(['machine_failure', 'routing_adjustment', 'decision', 'coalition', 'recovery']);

const QueryBody = z.object({
  context:         z.string().min(1),
  topK:            z.number().int().min(1),
  scenarioId:      z.string().optional(),
  nodeId:          z.string().optional(),
  eventTypeFilter: z.array(EventTypeEnum).optional(),
  debug:           z.boolean().optional(),
});

/**
 * POST /query
 * Body: { scenarioId?, nodeId?, context, topK, eventTypeFilter? }
 * Response: { events: ReasoningEvent[], summary: string }
 */
queryRoute.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const result = QueryBody.safeParse(raw);
  if (!result.success) {
    return c.json({ error: result.error.flatten() }, 400);
  }
  const { context, topK, scenarioId, nodeId, eventTypeFilter, debug } = result.data;

  const query = { context, topK, scenarioId, nodeId, eventTypeFilter, debug };

  try {
    const result = await queryMemory(query);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Query failed: ${message}` }, 500);
  }
});

export default queryRoute;
