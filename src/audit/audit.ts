import Anthropic from '@anthropic-ai/sdk';
import type { MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent } from './events.js';

// ============================================================
// Audit — did the agent behave consistently with its mode?
// ============================================================

const client = new Anthropic();

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

function buildAuditPrompt(
  failure: MachineFailureEvent,
  adjustments: RoutingAdjustmentEvent[],
  outcome: RecoveryOutcomeEvent
): string {
  const adjustmentLines = adjustments.length > 0
    ? adjustments.map((a) => `- ${a.content} (latency: ${a.metadata.decisionLatencyCycles} cycles, throughput: ${a.metadata.throughputBefore}% → ${a.metadata.throughputAfter}%)`).join('\n')
    : '- No routing adjustments recorded.';

  return `
Evaluate whether this agent response to a machine failure was consistent with the configured mode: ${failure.mode.toUpperCase()}

FAILURE:
${failure.content}
Machine: ${failure.metadata.machineId}
Failure type: ${failure.metadata.failureType}
Affected capacity: ${failure.metadata.affectedCapacity}%
Affected products: ${failure.metadata.affectedProducts.join(', ')}

ROUTING ADJUSTMENTS MADE:
${adjustmentLines}

OUTCOME:
${outcome.content}
Downtime cycles: ${outcome.metadata.cyclesDowntime}
Production lost: ${outcome.metadata.productionLost} units
Recovery strategy: ${outcome.metadata.recoveryStrategy}
Successful: ${outcome.metadata.successful}

MODE EXPECTATIONS:
HEURISTIC MODE should: use fixed routing rules, minimise deviation from the baseline plan, prefer known safe paths over optimal ones.
AI MODE should: dynamically optimise routing, prioritise throughput over rule compliance, adapt based on current state, accept short-term risk for better recovery.

Return ONLY valid JSON with this exact shape (no markdown, no explanation):
{
  "consistent": boolean,
  "expectedBehavior": string,
  "actualBehavior": string,
  "deviations": string[],
  "score": number
}

Score 1.0 = perfectly consistent with mode. Score 0.0 = completely opposite to mode expectations.
  `.trim();
}

/**
 * Audit a failure response triplet — failure → adjustments → outcome.
 * Calls Claude to evaluate mode consistency and returns a structured AuditResult.
 */
export async function auditFailureResponse(
  failure: MachineFailureEvent,
  adjustments: RoutingAdjustmentEvent[],
  outcome: RecoveryOutcomeEvent
): Promise<AuditResult> {
  const prompt = buildAuditPrompt(failure, adjustments, outcome);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

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
