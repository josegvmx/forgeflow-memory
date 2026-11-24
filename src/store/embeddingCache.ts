import db, { wrapDbError } from './client.js';

export { textHash } from '../ingest/textHash.js';

// ============================================================
// Embedding cache (schema.sql: embedding_cache): one vector per
// (model, exact embedding text). The ingest pipeline looks texts up
// here before calling the embedding API and stores what it embedded.
// ============================================================

/** Cached vectors for the given text hashes (missing hashes are absent from the map). */
export async function getCachedEmbeddings(model: string, hashes: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (hashes.length === 0) return out;
  try {
    // pgvector's text form is '[1,2,3]', which is valid JSON.
    const rows = await db<{ text_hash: string; v: string }[]>`
      SELECT text_hash, embedding::text AS v FROM embedding_cache
      WHERE model = ${model} AND text_hash = ANY(${hashes})
    `;
    for (const r of rows) out.set(r.text_hash, JSON.parse(r.v));
  } catch (err) {
    wrapDbError(err);
  }
  return out;
}

/** Store vectors; an entry already cached for (model, hash) is left as is. */
export async function putCachedEmbeddings(model: string, entries: Array<{ hash: string; embedding: number[] }>): Promise<void> {
  if (entries.length === 0) return;
  try {
    await db.begin(async (tx) => {
      for (const e of entries) {
        await tx`
          INSERT INTO embedding_cache (model, text_hash, embedding)
          VALUES (${model}, ${e.hash}, ${JSON.stringify(e.embedding)})
          ON CONFLICT (model, text_hash) DO NOTHING
        `;
      }
    });
  } catch (err) {
    wrapDbError(err);
  }
}
