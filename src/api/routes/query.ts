import { Hono } from 'hono';
import { queryMemory } from '../../retrieval/query.js';
import type { MemoryQuery } from '../../types.js';

const queryRoute = new Hono();

/**
 * POST /query
 * Body: { scenarioId?, nodeId?, context, topK, eventTypeFilter? }
 * Response: { events: ReasoningEvent[], summary: string }
 */
queryRoute.post('/', async (c) => {
  let body: Partial<MemoryQuery>;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { context, topK, scenarioId, nodeId, eventTypeFilter } = body;

  if (!context || typeof context !== 'string') {
    return c.json({ error: '`context` is required and must be a string' }, 400);
  }

  if (!topK || typeof topK !== 'number' || topK < 1) {
    return c.json({ error: '`topK` is required and must be a positive number' }, 400);
  }

  const validTypes = ['machine_failure', 'routing_adjustment', 'decision', 'coalition'];
  if (eventTypeFilter) {
    if (!Array.isArray(eventTypeFilter)) {
      return c.json({ error: '`eventTypeFilter` must be an array' }, 400);
    }
    const invalid = eventTypeFilter.filter((t) => !validTypes.includes(t));
    if (invalid.length > 0) {
      return c.json({ error: `Invalid event types: ${invalid.join(', ')}` }, 400);
    }
  }

  const query: MemoryQuery = {
    context,
    topK,
    scenarioId: scenarioId ?? undefined,
    nodeId: nodeId ?? undefined,
    eventTypeFilter: eventTypeFilter ?? undefined,
  };

  try {
    const result = await queryMemory(query);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Query failed: ${message}` }, 500);
  }
});

export default queryRoute;
