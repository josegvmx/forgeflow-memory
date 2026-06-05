import Anthropic from '@anthropic-ai/sdk';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Synthesis — Claude summarises retrieved events into a
// actionable recommendation for the caller.
// ============================================================

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an analyst for a manufacturing simulation system called ForgeFlow.
You are given a set of past simulation events (machine failures, routing adjustments, agent decisions, coalition handoffs)
and a question about them.

Your job is to synthesise the events into a concise, actionable recommendation.
Focus on patterns, recurring failures, and what worked well.
Be specific — reference node IDs, cycles, and event types from the context.
Keep your response under 200 words.`;

/**
 * Format retrieved events into a readable context block for the prompt.
 */
function buildContext(events: ReasoningEvent[]): string {
  return events
    .map(
      (e, i) =>
        `[${i + 1}] Scenario=${e.scenarioId} Node=${e.nodeId} Cycle=${e.cycle} ` +
        `Type=${e.eventType} Mode=${e.mode}\n${e.content}`
    )
    .join('\n---\n');
}

/**
 * Call Claude with the question + retrieved events and return
 * a synthesised recommendation string.
 */
export async function synthesize(
  question: string,
  events: ReasoningEvent[]
): Promise<string> {
  if (events.length === 0) {
    return 'No relevant events found in memory for this query.';
  }

  const context = buildContext(events);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',  // fast + cheap for synthesis
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Retrieved events:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('Unexpected response type from Claude synthesis call');
  }

  return block.text;
}
