import db, { wrapDbError } from '../store/client.js';
import { rrf, type RetrievedRow } from '../eval/retrievalMetrics.js';
import { questionHints } from './questionHints.js';

// ============================================================
// Retrieval strategies compared by the retrieval eval (R14 phase 3, step 7).
//
//   vector            pgvector cosine distance (HNSW)
//   vector+scenario   same, only the query's scenario
//   fulltext          Postgres full text (content_tsv, GIN), any word matches, ts_rank_cd
//   hybrid            vector + fulltext fused by reciprocal rank (k = 60)
//   hybrid+scenario   same, only the query's scenario
//   structured        the query's scenario + hints read from the question (questionHints.ts): named
//                     machines / parts / transporters (or the machines of a named operation), the kind
//                     of event asked about, then ordered by distance to the asked cycle and duration,
//                     then by vector distance. Topped up from vector+scenario when the filters leave
//                     fewer rows than asked.
//
// HNSW returns its ef_search best candidates and filters afterwards, so a WHERE clause can leave
// fewer rows than asked; every query raises hnsw.ef_search (SET LOCAL, inside its own transaction).
// No fault.* filter: those labels are the answer key.
// ============================================================

export const STRATEGIES = ['vector', 'vector+scenario', 'fulltext', 'hybrid', 'hybrid+scenario', 'structured'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * An embedding space other than the live column: every event's text under `variant`, embedded with
 * `model` (event_text_variants → embedding_cache), searched exactly. Absent = reasoning_events.embedding (HNSW).
 */
export interface EmbeddingSpace { model: string; variant: string }

export interface StrategyQuery { text: string; embedding: number[]; scenarioId: string; space?: EmbeddingSpace }

type Tx = typeof db;
const fromEvents = (tx: Tx, space?: EmbeddingSpace) => space
  ? tx`reasoning_events e
       JOIN event_text_variants v ON v.event_id = e.id AND v.variant = ${space.variant}
       JOIN embedding_cache c ON c.model = ${space.model} AND c.text_hash = v.text_hash`
  : tx`reasoning_events e`;
const vectorOf = (tx: Tx, space?: EmbeddingSpace) => (space ? tx`c.embedding` : tx`e.embedding`);
const COLUMNS = (tx: Tx) => tx`e.id::text AS id, e.scenario_id, e.event_type, e.metadata, e.run_id::text AS run_id`;

const EF_SEARCH = 400;
/** Candidates per list before fusion / dropping ignored runs. */
export const CANDIDATES = 100;

/** Any word of the question may match: plainto_tsquery's ANDs turned into ORs. */
const orQuery = (text: string) => db`replace(plainto_tsquery('english', ${text})::text, '&', '|')::tsquery`;

async function vectorSearch(q: StrategyQuery, scenario: boolean, limit: number): Promise<RetrievedRow[]> {
  return db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);
    const t = tx as unknown as Tx;
    return tx<RetrievedRow[]>`
      SELECT ${COLUMNS(t)}
      FROM ${fromEvents(t, q.space)}
      WHERE e.embedding IS NOT NULL ${scenario ? tx`AND e.scenario_id = ${q.scenarioId}` : tx``}
      ORDER BY ${vectorOf(t, q.space)} <=> ${JSON.stringify(q.embedding)}::vector
      LIMIT ${limit}
    `;
  }) as Promise<RetrievedRow[]>;
}

async function fulltextSearch(q: StrategyQuery, scenario: boolean, limit: number): Promise<RetrievedRow[]> {
  const tq = orQuery(q.text);
  return db<RetrievedRow[]>`
    SELECT ${COLUMNS(db)}
    FROM reasoning_events e
    WHERE e.content_tsv @@ ${tq} ${scenario ? db`AND e.scenario_id = ${q.scenarioId}` : db``}
    ORDER BY ts_rank_cd(e.content_tsv, ${tq}) DESC, e.id
    LIMIT ${limit}
  `;
}

/**
 * Order by distance to the asked cycle, measured from the cycle the incident started: breakdown cycle
 * for failures (and a disruption's fault cycle), but a recovery or reroute is stored at the cycle work
 * moved again, so step back by how long that took. Omitted (not "ORDER BY 0") when there is no hint.
 */
const byCycle = (tx: typeof db, c: number) => tx`abs((CASE e.event_type
    WHEN 'recovery' THEN e.cycle - COALESCE((e.metadata->>'cyclesToRecover')::numeric, 0)
    WHEN 'routing_adjustment' THEN e.cycle - COALESCE((e.metadata->>'decisionLatencyCycles')::numeric, 0)
    ELSE e.cycle END) - ${c}::numeric),`;
const byDuration = (tx: typeof db, d: number) =>
  tx`(CASE WHEN e.event_type = 'machine_failure' THEN abs(COALESCE((e.metadata->>'cyclesDown')::numeric, 0) - ${d}::numeric) ELSE 0 END),`;

async function structuredSearch(q: StrategyQuery, limit: number): Promise<RetrievedRow[]> {
  const h = questionHints(q.text);
  let nodes = h.ids;
  if (!nodes.length && h.ops.length) {
    // Machines that perform the named operation(s), from their failure events in this scenario.
    nodes = (await db<{ node_id: string }[]>`
      SELECT DISTINCT node_id FROM reasoning_events
      WHERE scenario_id = ${q.scenarioId} AND event_type = 'machine_failure' AND metadata->'operations' ?| ${h.ops}
    `).map(r => r.node_id);
  }
  const t = db as Tx;
  const rows = await db<RetrievedRow[]>`
    SELECT ${COLUMNS(t)}
    FROM ${fromEvents(t, q.space)}
    WHERE e.embedding IS NOT NULL AND e.scenario_id = ${q.scenarioId}
      ${h.eventType ? db`AND e.event_type = ${h.eventType}` : db``}
      ${nodes.length ? db`AND e.node_id = ANY(${nodes})` : db``}
    ORDER BY
      ${h.cycle !== null ? byCycle(t, h.cycle) : db``}
      ${h.duration !== null ? byDuration(t, h.duration) : db``}
      ${vectorOf(t, q.space)} <=> ${JSON.stringify(q.embedding)}::vector
    LIMIT ${limit}
  `;
  if (rows.length >= limit) return rows;
  const seen = new Set(rows.map(r => r.id));
  return [...rows, ...(await vectorSearch(q, true, limit)).filter(r => !seen.has(r.id))].slice(0, limit);
}

/** Ranked rows for one query (CANDIDATES long at most). */
export async function retrieve(strategy: Strategy, q: StrategyQuery, limit = CANDIDATES): Promise<RetrievedRow[]> {
  try {
    switch (strategy) {
      case 'vector': return await vectorSearch(q, false, limit);
      case 'vector+scenario': return await vectorSearch(q, true, limit);
      case 'fulltext': return await fulltextSearch(q, false, limit);
      case 'structured': return await structuredSearch(q, limit);
      case 'hybrid':
      case 'hybrid+scenario': {
        const scenario = strategy === 'hybrid+scenario';
        const [v, t] = await Promise.all([vectorSearch(q, scenario, CANDIDATES), fulltextSearch(q, scenario, CANDIDATES)]);
        const byId = new Map([...v, ...t].map(r => [r.id, r]));
        return rrf([v.map(r => r.id), t.map(r => r.id)]).slice(0, limit).map(id => byId.get(id)!);
      }
    }
  } catch (err) {
    wrapDbError(err);
  }
}

/** Relevant events in the store for a golden query (ignored runs excluded). */
export async function countRelevant(q: { scenarioId: string; relevant: { eventTypes: string[]; metadata: Record<string, unknown> } }, ignoreRunIds: string[]): Promise<number> {
  try {
    const [r] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reasoning_events
      WHERE embedding IS NOT NULL
        AND scenario_id = ${q.scenarioId}
        AND event_type = ANY(${q.relevant.eventTypes})
        AND metadata @> ${db.json(q.relevant.metadata as Parameters<typeof db.json>[0])}
        AND (run_id IS NULL OR NOT (run_id::text = ANY(${ignoreRunIds})))
    `;
    return r?.n ?? 0;
  } catch (err) {
    wrapDbError(err);
  }
}

/** Embedding models with vectors in the cache (to check the eval embeds questions with the same one). */
export async function cachedModels(): Promise<string[]> {
  try {
    return (await db<{ model: string }[]>`SELECT DISTINCT model FROM embedding_cache`).map(r => r.model);
  } catch (err) {
    wrapDbError(err);
  }
}
