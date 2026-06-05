import 'dotenv/config';

// ============================================================
// Embedder
// Picks the provider based on which API key is present in env.
// Priority: Voyage AI → OpenAI
// Both voyage-code-2 and text-embedding-3-small output 1536 dims,
// matching the vector(1536) column in schema.sql.
// ============================================================

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';

async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'voyage-code-2',
      input: text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage AI embedding failed (${res.status}): ${err}`);
  }

  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embedding failed (${res.status}): ${err}`);
  }

  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

/**
 * Embed a single string. Automatically selects the provider
 * based on available API keys (Voyage preferred over OpenAI).
 */
export async function embed(text: string): Promise<number[]> {
  if (process.env.VOYAGE_API_KEY) {
    return embedVoyage(text);
  }
  if (process.env.OPENAI_API_KEY) {
    return embedOpenAI(text);
  }
  throw new Error(
    'No embedding API key found. Set VOYAGE_API_KEY or OPENAI_API_KEY in your .env file.'
  );
}
