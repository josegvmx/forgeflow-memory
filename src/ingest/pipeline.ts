import { chunkEvents } from './chunker.js';
import { embed } from './embedder.js';
import { upsertEvents, findExistingHashes, type StoredEvent } from '../store/upsert.js';
import { eventHash } from '../store/eventHash.js';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Ingest Pipeline
// Orchestrates: chunk → embed → upsert
//
// Embedding API calls are made sequentially with a small delay
// to respect rate limits. Switch to batched/parallel if your
// provider supports batch embeddings and throughput is a concern.
// ============================================================

const RATE_LIMIT_DELAY_MS = 50; // ms between embedding API calls

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IngestStats {
  /** Events embedded and written. */
  inserted: number;
  /** Events skipped: repeated within the batch or already stored. */
  skipped: number;
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
  const [fresh] = await newEventsOnly([event]);
  if (!fresh) return { inserted: 0, skipped: 1 };
  const { text } = chunkEvents([fresh])[0];
  const embedding = await embed(text);
  await upsertEvents([{ ...fresh, embedding }]);
  return { inserted: 1, skipped: 0 };
}

/**
 * Ingest a batch of events (e.g. a full scenario archive).
 * Idempotent: duplicates within the batch and events already stored are
 * skipped before embedding, so re-ingesting an archive costs nothing.
 *
 * @param events - Array of ReasoningEvents to store
 * @param onProgress - Optional callback called after each embed, with (completed, total)
 */
export async function ingestArchive(
  events: ReasoningEvent[],
  onProgress?: (completed: number, total: number) => void
): Promise<IngestStats> {
  const fresh = await newEventsOnly(events);
  const skipped = events.length - fresh.length;
  if (fresh.length === 0) return { inserted: 0, skipped };

  const chunks = chunkEvents(fresh);
  const stored: StoredEvent[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { event, text } = chunks[i];
    const embedding = await embed(text);
    stored.push({ ...event, embedding });
    onProgress?.(i + 1, chunks.length);
    // Respect rate limits between calls (skip delay on last item)
    if (i < chunks.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }
  // Batch upsert in a single transaction
  await upsertEvents(stored);
  return { inserted: stored.length, skipped };
}
