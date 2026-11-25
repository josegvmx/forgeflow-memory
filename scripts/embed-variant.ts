/**
 * Fill an embedding space for the retrieval eval (R14 phase 3, step 5):
 * every stored event's text under a variant, embedded with a model.
 *
 *   npm run embed:variant -- --model text-embedding-3-small --variant default [--dry-run]
 *   models: voyage-code-2 (VOYAGE_API_KEY), text-embedding-3-small (OPENAI_API_KEY)
 *   variants: default, no-scenario, content-only (src/ingest/chunker.ts)
 *
 * Needs DATABASE_URL. Each distinct text is embedded once per model (embedding_cache); re-running is
 * free. The live store is not changed: reasoning_events.embedding stays as it is.
 */
import 'dotenv/config';
import db from '../src/store/client.js';
import { formatEventForEmbedding, TEXT_VARIANTS, type TextVariant } from '../src/ingest/chunker.js';
import { embedManyWith, EMBEDDING_MODELS, EMBED_BATCH } from '../src/ingest/embedder.js';
import { textHash } from '../src/ingest/textHash.js';
import { putCachedEmbeddings } from '../src/store/embeddingCache.js';
import { eventsPage, putVariantHashes, cachedHashes, spaceCoverage } from '../src/store/variants.js';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const model = opt('--model') ?? '';
const variant = (opt('--variant') ?? 'default') as TextVariant;
const dryRun = argv.includes('--dry-run');
if (!(EMBEDDING_MODELS as readonly string[]).includes(model)) { console.error(`--model must be one of ${EMBEDDING_MODELS.join(', ')}`); process.exit(2); }
if (!TEXT_VARIANTS.includes(variant)) { console.error(`--variant must be one of ${TEXT_VARIANTS.join(', ')}`); process.exit(2); }

const t0 = Date.now();
const texts = new Map<string, string>();     // hash → text
let events = 0;
let after: string | null = null;
for (;;) {
  const page = await eventsPage(after, 2000);
  if (!page.length) break;
  const rows = page.map(r => { const t = formatEventForEmbedding(r.event, variant); const hash = textHash(t); texts.set(hash, t); return { eventId: r.id, hash }; });
  if (!dryRun) await putVariantHashes(variant, rows);
  events += page.length;
  after = page[page.length - 1].id;
}
const hashes = [...texts.keys()];
const have = new Set<string>();
for (let i = 0; i < hashes.length; i += 5000) for (const h of await cachedHashes(model, hashes.slice(i, i + 5000))) have.add(h);
const missing = hashes.filter(h => !have.has(h));
const tokens = Math.round(missing.reduce((a, h) => a + texts.get(h)!.length, 0) / 4);
console.log(`${events} events · ${hashes.length} distinct ${variant} texts · ${have.size} already embedded with ${model} · ${missing.length} to embed (~${tokens} tokens)`);
if (dryRun) { console.log('Dry run: nothing written or embedded.'); await db.end(); process.exit(0); }

for (let i = 0; i < missing.length; i += EMBED_BATCH * 4) {
  const batch = missing.slice(i, i + EMBED_BATCH * 4);
  const vecs = await embedManyWith(model, batch.map(h => texts.get(h)!));
  await putCachedEmbeddings(model, batch.map((hash, k) => ({ hash, embedding: vecs[k] })));
  process.stdout.write(`\r  embedded ${Math.min(i + batch.length, missing.length)}/${missing.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const cov = await spaceCoverage(model, variant);
console.log(`\nSpace ${model} / ${variant}: ${cov.covered} of ${cov.events} events have a vector (${((Date.now() - t0) / 1000).toFixed(0)} s).`);
await db.end();
