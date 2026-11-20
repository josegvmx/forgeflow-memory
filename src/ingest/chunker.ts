import type { ReasoningEvent } from '../types.js';

// ============================================================
// Chunker
// Converts a ReasoningEvent into the text string that gets
// passed to the embedding model.
//
// Strategy: one chunk per event. The formatted string includes
// all structured fields as labelled context so the embedding
// captures both the semantic content AND the metadata signal
// (node, cycle, type, mode). This makes similarity search
// sensitive to both "what happened" and "where/when/how".
// ============================================================

/**
 * Format a ReasoningEvent into the text that will be embedded.
 * Keep labels short — embedding models handle structured text well
 * but token budget matters for long content fields.
 */
/** Metadata keys stored with an event but left out of its embedding text. */
export const isEmbedded = (key: string): boolean => !key.startsWith('fault.') && key !== 'source';

export function formatEventForEmbedding(event: ReasoningEvent): string {
  const lines = [
    `Scenario: ${event.scenarioId}`,
    `Node: ${event.nodeId}`,
    `Cycle: ${event.cycle}`,
    `Type: ${event.eventType}`,
    `Mode: ${event.mode}`,
    `Event: ${event.content}`,
  ];

  // Append any metadata values as flat key: value pairs so they
  // contribute signal without bloating the embedding unnecessarily.
  // Ground-truth fault labels (fault.*) and provenance (source) are stored but
  // never embedded: retrieval must find a fault from what happened, not from
  // its answer key (R14 §4.4 — the retrieval eval is built on those labels).
  if (event.metadata) {
    for (const [key, value] of Object.entries(event.metadata)) {
      if (!isEmbedded(key)) continue;
      if (value !== null && value !== undefined) {
        lines.push(`${key}: ${String(value)}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Chunk an array of events into embeddable strings.
 * Returns tuples of [event, text] so the pipeline can pair
 * each embedding with its source event without re-formatting.
 */
export function chunkEvents(
  events: ReasoningEvent[]
): Array<{ event: ReasoningEvent; text: string }> {
  return events.map((event) => ({
    event,
    text: formatEventForEmbedding(event),
  }));
}
