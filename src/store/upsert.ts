import db, { wrapDbError } from './client.js';
import type { ReasoningEvent } from '../types.js';

export interface StoredEvent extends ReasoningEvent {
  embedding: number[];
}

/**
 * Insert a single reasoning event with its embedding.
 * There is no natural business key, so every call produces a new row.
 * If idempotent re-ingestion is needed later, add a content hash column
 * and switch to an ON CONFLICT DO UPDATE.
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
        embedding
      ) VALUES (
        ${event.scenarioId},
        ${event.nodeId},
        ${event.cycle},
        ${event.eventType},
        ${event.mode},
        ${event.content},
        ${event.metadata ? JSON.stringify(event.metadata) : null},
        ${JSON.stringify(event.embedding)}
      )
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
            embedding
          ) VALUES (
            ${event.scenarioId},
            ${event.nodeId},
            ${event.cycle},
            ${event.eventType},
            ${event.mode},
            ${event.content},
            ${event.metadata ? JSON.stringify(event.metadata) : null},
            ${JSON.stringify(event.embedding)}
          )
        `;
      }
    });
  } catch (err) {
    wrapDbError(err);
  }
}
