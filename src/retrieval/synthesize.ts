import Anthropic from '@anthropic-ai/sdk';
import type { ReasoningEvent } from '../types.js';
import { withRetry } from '../lib/retry.js';
import { SYSTEM_PROMPT, buildUserMessage, guardOutput } from '../prompts/synthesize.js';

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

export function buildContext(events: ReasoningEvent[]): string {
  return events
    .map(
      (e, i) =>
        `[${i + 1}] Scenario=${e.scenarioId} Node=${e.nodeId} Cycle=${e.cycle} ` +
        `Type=${e.eventType} Mode=${e.mode}\n${e.content}`
    )
    .join('\n---\n');
}

async function synthesizeWithAnthropic(question: string, context: string, client = new Anthropic()): Promise<string> {
  const message = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(question, context) }],
    })
  );
  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
  return block.text;
}

async function synthesizeWithOllama(question: string, context: string): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model   = process.env.OLLAMA_MODEL ?? 'llama3.2';

  const res = await withRetry(() =>
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: buildUserMessage(question, context) },
        ],
      }),
    })
  );

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
  events: ReasoningEvent[],
  client = new Anthropic()
): Promise<string> {
  if (events.length === 0) {
    return 'No relevant events found in memory for this query.';
  }

  const context  = buildContext(events);
  const provider = process.env.SYNTHESIS_PROVIDER ?? 'anthropic';

  const answer = provider === 'ollama'
    ? await synthesizeWithOllama(question, context)
    : await synthesizeWithAnthropic(question, context, client);

  return guardOutput(answer);
}
