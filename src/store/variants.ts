import db, { wrapDbError } from './client.js';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Embedding spaces (R14 phase 3): event → text hash per variant (event_text_variants),
// vectors per (model, text hash) in embedding_cache. Used by `npm run embed:variant`
// and the retrieval eval only.
// ============================================================

export interface StoredEventRow { id: string; event: ReasoningEvent }

/** One page of stored events, by id (keyset pagination). */
export async function eventsPage(afterId: string | null, limit: number): Promise<StoredEventRow[]> {
  try {
    const rows = await db<Array<{ id: string; scenario_id: string; node_id: string; cycle: number; event_type: string; mode: string; content: string; metadata: Record<string, unknown> | null; run_id: string | null }>>`
      SELECT id::text, scenario_id, node_id, cycle, event_type, mode, content, metadata, run_id::text
      FROM reasoning_events
      WHERE embedding IS NOT NULL ${afterId ? db`AND id > ${afterId}::uuid` : db``}
      ORDER BY id
      LIMIT ${limit}
    `;
    return rows.map(r => ({
      id: r.id,
      event: {
        scenarioId: r.scenario_id, nodeId: r.node_id, cycle: r.cycle, eventType: r.event_type as ReasoningEvent['eventType'],
        mode: r.mode as ReasoningEvent['mode'], content: r.content, metadata: (r.metadata ?? undefined) as ReasoningEvent['metadata'],
        ...(r.run_id ? { runId: r.run_id } : {}),
      },
    }));
  } catch (err) {
    wrapDbError(err);
  }
}

/** Record each event's text hash under a variant (replaces an existing entry). */
export async function putVariantHashes(variant: string, rows: Array<{ eventId: string; hash: string }>): Promise<void> {
  if (!rows.length) return;
  try {
    await db`
      INSERT INTO event_text_variants (event_id, variant, text_hash)
      SELECT x.event_id::uuid, ${variant}, x.text_hash
      FROM unnest(${rows.map(r => r.eventId)}::text[], ${rows.map(r => r.hash)}::text[]) AS x(event_id, text_hash)
      ON CONFLICT (event_id, variant) DO UPDATE SET text_hash = EXCLUDED.text_hash
    `;
  } catch (err) {
    wrapDbError(err);
  }
}

/** Which of these text hashes already have a vector for the model (without loading the vectors). */
export async function cachedHashes(model: string, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const rows = await db<{ text_hash: string }[]>`
      SELECT text_hash FROM embedding_cache WHERE model = ${model} AND text_hash = ANY(${hashes})
    `;
    return new Set(rows.map(r => r.text_hash));
  } catch (err) {
    wrapDbError(err);
  }
}

/** Events with a vector in the space (variant entry whose hash is cached for the model). */
export async function spaceCoverage(model: string, variant: string): Promise<{ events: number; covered: number }> {
  try {
    const [r] = await db<{ events: number; covered: number }[]>`
      SELECT
        (SELECT count(*)::int FROM reasoning_events WHERE embedding IS NOT NULL) AS events,
        (SELECT count(*)::int FROM event_text_variants v JOIN embedding_cache c ON c.model = ${model} AND c.text_hash = v.text_hash
           WHERE v.variant = ${variant}) AS covered
    `;
    return r;
  } catch (err) {
    wrapDbError(err);
  }
}
