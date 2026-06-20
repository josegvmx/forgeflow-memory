import Anthropic from '@anthropic-ai/sdk';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Synthesis — LLM summarises retrieved events into an
// actionable recommendation for the caller.
//
// Provider selection (via SYNTHESIS_PROVIDER env var):
//   'anthropic' (default) — Claude Haiku, ~$0.001 per query
//   'ollama'              — local Ollama, free, requires Ollama running
//
// Ollama setup:
//   brew install ollama
//   ollama pull llama3.2   # or any model you prefer
//   ollama serve           # starts on http://localhost:11434
//   Set OLLAMA_MODEL=llama3.2 in .env (optional, defaults to llama3.2)
// ============================================================

const SYSTEM_PROMPT = `You are an analyst for a manufacturing simulation system called ForgeFlow.
You are given a set of past simulation events (machine failures, routing adjustments, agent decisions, coalition handoffs)
and a question about them.

Your job is to synthesise the events into a concise, actionable recommendation.
Focus on patterns, recurring failures, and what worked well.
Be specific — reference node IDs, cycles, and event types from the context.
Keep your response under 200 words.`;

function buildContext(events: ReasoningEvent[]): string {
  return events
    .map(
      (e, i) =>
        `[${i + 1}] Scenario=${e.scenarioId} Node=${e.nodeId} Cycle=${e.cycle} ` +
        `Type=${e.eventType} Mode=${e.mode}\n${e.content}`
    )
    .join('\n---\n');
}

async function synthesizeWithAnthropic(question: string, context: string): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Retrieved events:\n\n${context}\n\nQuestion: ${question}` }],
  });
  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
  return block.text;
}

async function synthesizeWithOllama(question: string, context: string): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model   = process.env.OLLAMA_MODEL ?? 'llama3.2';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Retrieved events:\n\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama synthesis failed (${res.status}): ${err}`);
  }

  const json = (await res.json()) as { message: { content: string } };
  return json.message.content;
}

/**
 * Synthesise retrieved events into a recommendation.
 * Provider is selected via SYNTHESIS_PROVIDER env var ('anthropic' | 'ollama').
 */
export async function synthesize(
  question: string,
  events: ReasoningEvent[]
): Promise<string> {
  if (events.length === 0) {
    return 'No relevant events found in memory for this query.';
  }

  const context  = buildContext(events);
  const provider = process.env.SYNTHESIS_PROVIDER ?? 'anthropic';

  if (provider === 'ollama') {
    return synthesizeWithOllama(question, context);
  }

  return synthesizeWithAnthropic(question, context);
}
