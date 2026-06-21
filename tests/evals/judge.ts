import Anthropic from '@anthropic-ai/sdk';
import { JUDGE_PROMPT, buildJudgePrompt } from '../../src/prompts/judge.js';

// ============================================================
// Faithfulness Judge
//
// LLM-as-a-judge that checks whether a RAG summary is grounded
// in its retrieved context — i.e., contains no claims invented
// outside the source chunks.
//
// Uses Claude Haiku by default (cheap, fast, good at structured
// JSON output). Switch to Ollama by setting SYNTHESIS_PROVIDER=ollama
// in .env — the same env var used by the main synthesis layer.
//
// Score:  1.0 = fully faithful
//         0.0 = completely hallucinated
//         0.5 = mixed (some claims grounded, some not)
// ============================================================

export interface JudgeResult {
  faithful: boolean;
  violations: string[];   // specific claims NOT supported by the context
  score: number;          // 0.0–1.0
  reasoning: string;      // one-sentence explanation
}

async function judgeWithAnthropic(context: string, summary: string): Promise<JudgeResult> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     JUDGE_PROMPT,
    messages:   [{ role: 'user', content: buildJudgePrompt(context, summary) }],
  });

  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from judge LLM');

  const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(raw) as JudgeResult;
  } catch {
    throw new Error(`Judge LLM returned invalid JSON:\n${block.text}`);
  }
}

async function judgeWithOllama(context: string, summary: string): Promise<JudgeResult> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model   = process.env.OLLAMA_MODEL ?? 'llama3.2';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user',   content: buildJudgePrompt(context, summary) },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama judge failed (${res.status}): ${err}`);
  }

  const json = (await res.json()) as { message: { content: string } };
  const raw = json.message.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(raw) as JudgeResult;
  } catch {
    throw new Error(`Ollama judge returned invalid JSON:\n${json.message.content}`);
  }
}

/**
 * Evaluate whether `summary` is faithful to `context`.
 * Provider is selected via SYNTHESIS_PROVIDER env var ('anthropic' | 'ollama').
 */
export async function judgeRelevance(
  context: string,
  summary: string
): Promise<JudgeResult> {
  const provider = process.env.SYNTHESIS_PROVIDER ?? 'anthropic';
  return provider === 'ollama'
    ? judgeWithOllama(context, summary)
    : judgeWithAnthropic(context, summary);
}
