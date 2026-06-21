// ============================================================
// Prompts — audit layer
//
// Builds the user-turn prompt sent to Claude when evaluating
// whether an agent response was consistent with its configured mode.
// ============================================================

import type { MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent } from '../audit/events.js';

export function buildAuditPrompt(
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
