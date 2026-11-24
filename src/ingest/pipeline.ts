import { chunkEvents } from './chunker.js';
import { embedMany, embeddingModel, EMBED_BATCH } from './embedder.js';
import { upsertEvents, findExistingHashes, type StoredEvent } from '../store/upsert.js';
import { eventHash } from '../store/eventHash.js';
import { textHash, getCachedEmbeddings, putCachedEmbeddings } from '../store/embeddingCache.js';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Ingest Pipeline
// Orchestrates: de-duplicate → chunk → embed (cached, batched) → upsert
//
// Each distinct embedding text is embedded once per model: texts already in
// embedding_cache cost nothing, the rest go EMBED_BATCH per API request with a
// small pause between requests. Vectors are cached as each request returns, so
// a failure part-way through keeps what was paid for.
// ============================================================

const RATE_LIMIT_DELAY_MS = 50; // ms between embedding API requests

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IngestStats {
  /** Events embedded and written. */
  inserted: number;
  /** Events skipped: repeated within the batch or already stored. */
  skipped: number;
  /** Distinct texts sent to the embedding API. */
  embedded?: number;
  /** Distinct texts whose vector came from the cache. */
  cached?: number;
}

/**
 * Drop events that repeat within the batch or are already in the store.
 * Runs before embedding so duplicates never cost an embedding call.
 */
async function newEventsOnly(events: ReasoningEvent[]): Promise<ReasoningEvent[]> {
  const byHash = new Map<string, ReasoningEvent>();
  for (const e of events) {
    const h = eventHash(e);
    if (!byHash.has(h)) byHash.set(h, e);
  }
  const existing = await findExistingHashes([...byHash.keys()]);
  return [...byHash].filter(([h]) => !existing.has(h)).map(([, e]) => e);
}

/**
 * Ingest a single event — useful for real-time ingestion
 * from a running simulation. No-op if the event is already stored.
 */
export async function ingestEvent(event: ReasoningEvent): Promise<IngestStats> {
  return ingestArchive([event]);
}

/**
 * Ingest a batch of events (e.g. a full scenario archive or an eval export part).
 * Idempotent: duplicates within the batch and events already stored are
 * skipped before embedding, so re-ingesting an archive costs nothing.
 *
 * @param events - Array of ReasoningEvents to store
 * @param onProgress - Optional callback after each embedding request, with (texts embedded, texts to embed)
 */
export async function ingestArchive(
  events: ReasoningEvent[],
  onProgress?: (completed: number, total: number) => void
): Promise<IngestStats> {
  const fresh = await newEventsOnly(events);
  const skipped = events.length - fresh.length;
  if (fresh.length === 0) return { inserted: 0, skipped, embedded: 0, cached: 0 };

  const chunks = chunkEvents(fresh).map((c) => ({ ...c, hash: textHash(c.text) }));
  const texts = new Map<string, string>();
  for (const c of chunks) if (!texts.has(c.hash)) texts.set(c.hash, c.text);

  const model = embeddingModel();
  const vectors = await getCachedEmbeddings(model, [...texts.keys()]);
  const cached = vectors.size;
  const missing = [...texts].filter(([h]) => !vectors.has(h));
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const embs = await embedMany(batch.map(([, t]) => t));
    const entries = batch.map(([hash], k) => ({ hash, embedding: embs[k] }));
    await putCachedEmbeddings(model, entries);
    for (const e of entries) vectors.set(e.hash, e.embedding);
    onProgress?.(Math.min(i + EMBED_BATCH, missing.length), missing.length);
    if (i + EMBED_BATCH < missing.length) await sleep(RATE_LIMIT_DELAY_MS);
  }

  const stored: StoredEvent[] = chunks.map((c) => ({ ...c.event, embedding: vectors.get(c.hash)!, embedTextHash: c.hash }));
  // Batch upsert in a single transaction
  await upsertEvents(stored);
  return { inserted: stored.length, skipped, embedded: missing.length, cached };
}
