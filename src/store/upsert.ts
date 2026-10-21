import db, { wrapDbError } from './client.js';
import type { ReasoningEvent } from '../types.js';
import { eventHash } from './eventHash.js';

export interface StoredEvent extends ReasoningEvent {
  embedding: number[];
}

/**
 * Insert a single reasoning event with its embedding.
 * Idempotent: an event identical to one already stored (same eventHash)
 * is ignored via ON CONFLICT (content_hash) DO NOTHING.
 */
export async function upsertEvent(event: StoredEvent): Promise<void> {
  try {
    await db`
      INSERT INTO reasoning_events (
        scenario_id,
        node_id,
        cycle,
        event_type,
        mode,
        content,
        metadata,
        embedding,
        content_hash
      ) VALUES (
        ${event.scenarioId},
        ${event.nodeId},
        ${event.cycle},
        ${event.eventType},
        ${event.mode},
        ${event.content},
        ${event.metadata ? JSON.stringify(event.metadata) : null},
        ${JSON.stringify(event.embedding)},
        ${eventHash(event)}
      )
      ON CONFLICT (content_hash) DO NOTHING
    `;
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Batch insert — runs all upserts in a single transaction.
 */
export async function upsertEvents(events: StoredEvent[]): Promise<void> {
  try {
    await db.begin(async (tx) => {
      for (const event of events) {
        await tx`
          INSERT INTO reasoning_events (
            scenario_id,
            node_id,
            cycle,
            event_type,
            mode,
            content,
            metadata,
            embedding,
            content_hash
          ) VALUES (
            ${event.scenarioId},
            ${event.nodeId},
            ${event.cycle},
            ${event.eventType},
            ${event.mode},
            ${event.content},
            ${event.metadata ? JSON.stringify(event.metadata) : null},
            ${JSON.stringify(event.embedding)},
            ${eventHash(event)}
          )
          ON CONFLICT (content_hash) DO NOTHING
        `;
      }
    });
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Return which of the given event hashes are already stored, so callers can
 * skip embedding (and paying for) events that would be ignored anyway.
 */
export async function findExistingHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  try {
    const rows = await db<{ content_hash: string }[]>`
      SELECT content_hash FROM reasoning_events
      WHERE content_hash = ANY(${hashes})
    `;
    return new Set(rows.map((r) => r.content_hash));
  } catch (err) {
    wrapDbError(err);
  }
}
