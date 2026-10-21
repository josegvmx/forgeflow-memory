import { Hono } from 'hono';
import { z } from 'zod';
import { looksLikePromptInjection, OFF_TOPIC_REPLY } from '../../prompts/synthesize.js';
import { queryMemory } from '../../retrieval/query.js';

const queryRoute = new Hono();

const EventTypeEnum = z.enum(['machine_failure', 'routing_adjustment', 'decision', 'coalition', 'recovery']);

// Identifiers are short, plain tokens; free text is capped so a single request
// can't inflate the embedding / LLM prompt.
const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be 1-64 letters, digits, or _ . : -');

const QueryBody = z.object({
  context:         z.string().trim().min(1).max(500),
  topK:            z.number().int().min(1).max(15),
  scenarioId:      Identifier.optional(),
  nodeId:          Identifier.optional(),
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

  // Obvious jailbreak attempts get the fixed refusal without any API spend.
  if (looksLikePromptInjection(context)) {
    return c.json({ events: [], summary: OFF_TOPIC_REPLY });
  }

  const query = { context, topK, scenarioId, nodeId, eventTypeFilter, debug };

  try {
    const result = await queryMemory(query);
    return c.json(result);
  } catch (err) {
    // Log details server-side; don't leak internals (DB hosts, provider errors) to visitors.
    console.error('[query] failed:', err);
    return c.json({ error: 'Query failed. Please try again later.' }, 500);
  }
});

export default queryRoute;
