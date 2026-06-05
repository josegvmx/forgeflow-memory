import { chunkEvents } from './chunker.js';
import { embed } from './embedder.js';
import { upsertEvents, type StoredEvent } from '../store/upsert.js';
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

/**
 * Ingest a single event — useful for real-time ingestion
 * from a running simulation.
 */
export async function ingestEvent(event: ReasoningEvent): Promise<void> {
  const { text } = chunkEvents([event])[0];
  const embedding = await embed(text);
  await upsertEvents([{ ...event, embedding }]);
}

/**
 * Ingest a batch of events (e.g. a full scenario archive).
 * Logs progress to stderr so it doesn't pollute stdout.
 *
 * @param events - Array of ReasoningEvents to store
 * @param onProgress - Optional callback called after each embed, with (completed, total)
 */
export async function ingestArchive(
  events: ReasoningEvent[],
  onProgress?: (completed: number, total: number) => void
): Promise<void> {
  const chunks = chunkEvents(events);
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
}
