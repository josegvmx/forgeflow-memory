import 'dotenv/config';
import { withRetry } from '../lib/retry.js';

// ============================================================
// Embedder
// Picks the provider based on which API key is present in env.
// Priority: Voyage AI → OpenAI
// Both voyage-code-2 and text-embedding-3-small output 1536 dims,
// matching the vector(1536) column in schema.sql.
// ============================================================

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';

/** The model `embed` / `embedMany` use: Voyage when its key is set, else OpenAI (both 1536-dim). */
export function embeddingModel(): string {
  if (process.env.VOYAGE_API_KEY) return 'voyage-code-2';
  if (process.env.OPENAI_API_KEY) return 'text-embedding-3-small';
  throw new Error('No embedding API key found. Set VOYAGE_API_KEY or OPENAI_API_KEY in your .env file.');
}

/** Texts per embedding request: well inside both providers' limits (Voyage 128 inputs, OpenAI 2048). */
export const EMBED_BATCH = 64;
const DIMS = 1536;

/** Models the service can embed with (both 1536-dim, so they share embedding_cache). */
export const EMBEDDING_MODELS = ['voyage-code-2', 'text-embedding-3-small'] as const;
export type EmbeddingModel = (typeof EMBEDDING_MODELS)[number];

async function callEmbeddings(inputs: string[], model: string = embeddingModel()): Promise<number[][]> {
  const voyage = model.startsWith('voyage-');
  const key = voyage ? process.env.VOYAGE_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`${model} needs ${voyage ? 'VOYAGE_API_KEY' : 'OPENAI_API_KEY'}`);
  const res = await withRetry(() =>
    fetch(voyage ? VOYAGE_API_URL : OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, input: inputs }),
    }),
    { timeoutMs: 30_000 },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${voyage ? 'Voyage AI' : 'OpenAI'} embedding failed (${res.status}): ${err.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data: { embedding: number[]; index?: number }[] };
  // Both APIs return one item per input with its index; order by it rather than trusting array order.
  const out = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding);
  if (out.length !== inputs.length || out.some(v => v?.length !== DIMS)) {
    throw new Error(`embedding reply has ${out.length} vectors for ${inputs.length} inputs (expected ${DIMS} dims each)`);
  }
  return out;
}

/** Embed many strings, EMBED_BATCH per request, in order, with the service's model. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  return embedManyWith(embeddingModel(), texts);
}

/** Embed many strings with a named model (eval / variant scripts compare models). */
export async function embedManyWith(model: string, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...await callEmbeddings(texts.slice(i, i + EMBED_BATCH), model));
  return out;
}

/**
 * Embed a single string. Automatically selects the provider
 * based on available API keys (Voyage preferred over OpenAI).
 */
export async function embed(text: string): Promise<number[]> {
  return (await embedMany([text]))[0];
}
