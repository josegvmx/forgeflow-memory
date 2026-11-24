import db, { wrapDbError } from '../store/client.js';
import { rrf, type RetrievedRow } from '../eval/retrievalMetrics.js';

// ============================================================
// Retrieval strategies compared by the retrieval eval (R14 phase 3, step 7).
//
//   vector            pgvector cosine distance (HNSW)
//   vector+scenario   same, only the query's scenario
//   fulltext          Postgres full text (content_tsv, GIN), any word matches, ts_rank_cd
//   hybrid            vector + fulltext fused by reciprocal rank (k = 60)
//   hybrid+scenario   same, only the query's scenario
//
// HNSW returns its ef_search best candidates and filters afterwards, so a WHERE clause can leave
// fewer rows than asked; every query raises hnsw.ef_search (SET LOCAL, inside its own transaction).
// No fault.* filter: those labels are the answer key.
// ============================================================

export const STRATEGIES = ['vector', 'vector+scenario', 'fulltext', 'hybrid', 'hybrid+scenario'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface StrategyQuery { text: string; embedding: number[]; scenarioId: string }

const EF_SEARCH = 400;
/** Candidates per list before fusion / dropping ignored runs. */
export const CANDIDATES = 100;

/** Any word of the question may match: plainto_tsquery's ANDs turned into ORs. */
const orQuery = (text: string) => db`replace(plainto_tsquery('english', ${text})::text, '&', '|')::tsquery`;

async function vectorSearch(q: StrategyQuery, scenario: boolean, limit: number): Promise<RetrievedRow[]> {
  return db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);
    return tx<RetrievedRow[]>`
      SELECT id::text, scenario_id, event_type, metadata, run_id::text
      FROM reasoning_events
      WHERE embedding IS NOT NULL ${scenario ? tx`AND scenario_id = ${q.scenarioId}` : tx``}
      ORDER BY embedding <=> ${JSON.stringify(q.embedding)}::vector
      LIMIT ${limit}
    `;
  }) as Promise<RetrievedRow[]>;
}

async function fulltextSearch(q: StrategyQuery, scenario: boolean, limit: number): Promise<RetrievedRow[]> {
  const tq = orQuery(q.text);
  return db<RetrievedRow[]>`
    SELECT id::text, scenario_id, event_type, metadata, run_id::text
    FROM reasoning_events
    WHERE content_tsv @@ ${tq} ${scenario ? db`AND scenario_id = ${q.scenarioId}` : db``}
    ORDER BY ts_rank_cd(content_tsv, ${tq}) DESC, id
    LIMIT ${limit}
  `;
}

/** Ranked rows for one query (CANDIDATES long at most). */
export async function retrieve(strategy: Strategy, q: StrategyQuery, limit = CANDIDATES): Promise<RetrievedRow[]> {
  try {
    switch (strategy) {
      case 'vector': return await vectorSearch(q, false, limit);
      case 'vector+scenario': return await vectorSearch(q, true, limit);
      case 'fulltext': return await fulltextSearch(q, false, limit);
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
        AND metadata @> ${JSON.stringify(q.relevant.metadata)}::jsonb
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
