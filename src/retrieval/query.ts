import db from '../store/client.js';
import { embed } from '../ingest/embedder.js';
import { synthesize, buildContext } from './synthesize.js';
import type { MemoryQuery, MemoryResult, ReasoningEvent } from '../types.js';

// ============================================================
// Retrieval — similarity search + synthesis
// ============================================================

/**
 * Row shape returned by postgres.js from reasoning_events.
 * snake_case matches the DB column names.
 */
interface EventRow {
  id: string;
  scenario_id: string;
  node_id: string;
  cycle: number;
  event_type: string;
  mode: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  distance: number;
}

function rowToEvent(row: EventRow): ReasoningEvent {
  return {
    scenarioId: row.scenario_id,
    nodeId: row.node_id,
    cycle: row.cycle,
    eventType: row.event_type as ReasoningEvent['eventType'],
    mode: row.mode as ReasoningEvent['mode'],
    content: row.content,
    metadata: row.metadata ?? undefined,
  };
}

/**
 * Run a similarity search against reasoning_events.
 * Applies optional filters for scenarioId, nodeId, and eventTypeFilter
 * before ranking by cosine distance.
 */
export async function queryMemory(query: MemoryQuery): Promise<MemoryResult> {
  const queryEmbedding = await embed(query.context);

  // Build filter clauses dynamically.
  // postgres.js tagged templates handle parameterisation safely.
  const scenarioFilter =
    query.scenarioId != null
      ? db`AND scenario_id = ${query.scenarioId}`
      : db``;

  const nodeFilter =
    query.nodeId != null
      ? db`AND node_id = ${query.nodeId}`
      : db``;

  const typeFilter =
    query.eventTypeFilter && query.eventTypeFilter.length > 0
      ? db`AND event_type = ANY(${query.eventTypeFilter})`
      : db``;

  const rows = await db<EventRow[]>`
    SELECT
      id,
      scenario_id,
      node_id,
      cycle,
      event_type,
      mode,
      content,
      metadata,
      created_at,
      embedding <=> ${JSON.stringify(queryEmbedding)}::vector AS distance
    FROM reasoning_events
    WHERE embedding IS NOT NULL
    ${scenarioFilter}
    ${nodeFilter}
    ${typeFilter}
    ORDER BY distance ASC
    LIMIT ${query.topK}
  `;

  const events = rows.map(rowToEvent);
  const summary = await synthesize(query.context, events);

  const result: import('../types.js').MemoryResult = { events, summary };
  if (query.debug) {
    result._debugContext = buildContext(events);
  }

  return result;
}
