import { createHash } from 'node:crypto';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Event identity for de-duplication.
//
// Two events are the same if scenario, node, cycle, type, mode and text all
// match (metadata is ignored). MUST stay in sync with the SQL backfill in
// src/store/schema.sql:
//   encode(sha256(convert_to(scenario_id || '|' || node_id || '|' ||
//     cycle::text || '|' || event_type || '|' || mode || '|' || content,
//     'UTF8')), 'hex')
// ============================================================

export function eventHash(e: Pick<ReasoningEvent, 'scenarioId' | 'nodeId' | 'cycle' | 'eventType' | 'mode' | 'content'>): string {
  const key = [e.scenarioId, e.nodeId, String(e.cycle), e.eventType, e.mode, e.content].join('|');
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
