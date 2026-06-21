import Anthropic from '@anthropic-ai/sdk';
import type { MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent } from './events.js';
import { withRetry } from '../lib/retry.js';
import { buildAuditPrompt } from '../prompts/audit.js';

// ============================================================
// Audit — did the agent behave consistently with its mode?
// ============================================================

export interface AuditResult {
  scenarioId: string;
  failureId: string;        // machineId + cycle, used as a stable reference
  mode: 'heuristic' | 'ai';
  expectedBehavior: string;
  actualBehavior: string;
  consistent: boolean;
  deviations: string[];
  score: number;            // 0-1, how well the agent followed the mode
}

/**
 * Audit a failure response triplet — failure → adjustments → outcome.
 * Calls Claude to evaluate mode consistency and returns a structured AuditResult.
 */
export async function auditFailureResponse(
  failure: MachineFailureEvent,
  adjustments: RoutingAdjustmentEvent[],
  outcome: RecoveryOutcomeEvent,
  client = new Anthropic()
): Promise<AuditResult> {
  const prompt = buildAuditPrompt(failure, adjustments, outcome);

  const message = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })
  );

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('Unexpected response type from Claude audit call');
  }

  // Claude sometimes wraps the JSON in a markdown code block — strip it.
  const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: Omit<AuditResult, 'scenarioId' | 'failureId' | 'mode'>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned invalid JSON for audit:\n${block.text}`);
  }

  return {
    scenarioId: failure.scenarioId,
    failureId: `${failure.metadata.machineId}_cycle${failure.cycle}`,
    mode: failure.mode,
    ...parsed,
  };
}
