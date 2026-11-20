import { createHash } from 'node:crypto';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Event identity for de-duplication.
//
// Two events are the same if scenario, node, cycle, type, mode and text all
// match (metadata is ignored) — and, since R14, the run: the same sentence in
// two seeds of one scenario is two events. The run is appended only when
// present, so events stored before R14 (no runId) keep their hash.
// MUST stay in sync with the SQL backfill in src/store/schema.sql:
//   encode(sha256(convert_to(scenario_id || '|' || node_id || '|' ||
//     cycle::text || '|' || event_type || '|' || mode || '|' || content ||
//     COALESCE('|' || run_id::text, ''), 'UTF8')), 'hex')
// ============================================================

export function eventHash(e: Pick<ReasoningEvent, 'scenarioId' | 'nodeId' | 'cycle' | 'eventType' | 'mode' | 'content' | 'runId'>): string {
  const parts = [e.scenarioId, e.nodeId, String(e.cycle), e.eventType, e.mode, e.content];
  if (e.runId) parts.push(e.runId);
  const key = parts.join('|');
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
