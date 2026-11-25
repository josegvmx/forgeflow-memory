/**
 * Retrieval eval (R14 phase 3, step 7): the golden set against the stored events, per strategy.
 *
 *   npm run eval:retrieval [-- --golden tests/evals/fixtures/golden-sim.json] [--strategies vector,hybrid]
 *   npm run eval:retrieval -- --spaces voyage-code-2:default,text-embedding-3-small:no-scenario
 *
 * Without --spaces: the live column (reasoning_events.embedding, HNSW) with the service's model.
 * With --spaces: each (model, variant) filled by `npm run embed:variant`, searched exactly; writes
 * docs/retrieval-eval-spaces.md / .json instead.
 *
 * Needs DATABASE_URL (the store holding the imported sim export) and the embedding key of the model
 * the events were embedded with (checked against embedding_cache). Questions are embedded once and
 * cached like events. Writes docs/retrieval-eval.md (tables) and docs/retrieval-eval.json (per query).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import db from '../src/store/client.js';
import { embedManyWith, embeddingModel } from '../src/ingest/embedder.js';
import { getCachedEmbeddings, putCachedEmbeddings } from '../src/store/embeddingCache.js';
import { textHash } from '../src/ingest/textHash.js';
import { STRATEGIES, retrieve, countRelevant, cachedModels, type Strategy, type EmbeddingSpace } from '../src/retrieval/strategies.js';
import { spaceCoverage } from '../src/store/variants.js';
import { scoreQuery, dropIgnored, breakdown, resultsMarkdown, type QueryScore } from '../src/eval/retrievalMetrics.js';
import type { GoldenSimSet } from '../src/eval/goldenSim.js';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const golden: GoldenSimSet = JSON.parse(readFileSync(resolve(process.cwd(), opt('--golden') ?? 'tests/evals/fixtures/golden-sim.json'), 'utf8'));
const strategies = (opt('--strategies')?.split(',') ?? [...STRATEGIES]) as Strategy[];
for (const s of strategies) if (!STRATEGIES.includes(s)) { console.error(`unknown strategy ${s} (${STRATEGIES.join(', ')})`); process.exit(2); }

const spaceArg = opt('--spaces');
const spaces: Array<EmbeddingSpace | undefined> = spaceArg
  ? spaceArg.split(',').map(x => { const [model, variant = 'default'] = x.split(':'); return { model, variant }; })
  : [undefined];
const qs = golden.queries;
const hashes = qs.map(q => textHash(q.question));

/** Question vectors for a model: embedded once, cached like event texts. */
async function questionVectors(model: string): Promise<Map<string, number[]>> {
  const vecs = await getCachedEmbeddings(model, hashes);
  const missing = qs.filter((_q, i) => !vecs.has(hashes[i]));
  if (missing.length) {
    const embs = await embedManyWith(model, missing.map(q => q.question));
    const entries = missing.map((q, i) => ({ hash: textHash(q.question), embedding: embs[i] }));
    await putCachedEmbeddings(model, entries);
    for (const e of entries) vecs.set(e.hash, e.embedding);
  }
  console.log(`${qs.length} questions with ${model} (${missing.length} embedded now)`);
  return vecs;
}

const ignore = new Set(golden.ignoreRunIds);
const relevant = new Map<string, number>();
for (const q of qs) relevant.set(q.id, await countRelevant(q, golden.ignoreRunIds));
const empty = qs.filter(q => relevant.get(q.id) === 0);
if (empty.length) console.warn(`⚠ ${empty.length} queries have no relevant events in this store (import missing?): ${empty.map(q => q.id).join(', ')}`);

const byStrategy: Record<string, QueryScore[]> = {};
const perQuery: Record<string, Record<string, { firstHit: number | null; recall5: number }>> = {};
const models = await cachedModels();
for (const space of spaces) {
  const model = space?.model ?? embeddingModel();
  if (!space && models.length && !models.includes(model)) {
    console.error(`The stored events were embedded with ${models.join(', ')}, but this environment would embed questions with ${model}. Set the matching key.`);
    process.exit(2);
  }
  if (space) {
    const cov = await spaceCoverage(space.model, space.variant);
    if (cov.covered < cov.events) {
      // Skipped, not fatal: the other spaces are still scored and written.
      console.warn(`⚠ skipped ${space.model}/${space.variant}: only ${cov.covered} of ${cov.events} events have a vector (npm run embed:variant -- --model ${space.model} --variant ${space.variant})`);
      continue;
    }
  }
  const vecs = await questionVectors(model);
  // Fulltext ignores the embedding space: run it once, with the live store.
  const ss = space ? strategies.filter(s => s !== 'fulltext') : strategies;
  for (const s of ss) {
    const key = space ? `${s} @ ${space.model}/${space.variant}` : s;
    const t0 = Date.now();
    byStrategy[key] = [];
    for (const [i, q] of qs.entries()) {
      const rows = dropIgnored(await retrieve(s, { text: q.question, embedding: vecs.get(hashes[i])!, scenarioId: q.scenarioId, space }), ignore);
      const sc = scoreQuery(q, rows, relevant.get(q.id)!);
      byStrategy[key].push(sc);
      (perQuery[q.id] ??= {})[key] = { firstHit: sc.firstHit, recall5: sc.recall[5] };
    }
    const b = breakdown(qs, { [key]: byStrategy[key] })[key].all;
    console.log(`  ${key.padEnd(50)} recall@5 ${b.recall[5].toFixed(2)}  recall@10 ${b.recall[10].toFixed(2)}  MRR ${b.mrr.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}

const b = breakdown(qs, byStrategy);
const md = resultsMarkdown(b, { model: spaceArg ? `per row (${spaceArg})` : embeddingModel(), queries: qs.length, date: new Date().toISOString().slice(0, 10), simCommit: golden.simCommit });
mkdirSync('docs', { recursive: true });
const caveats = [
  '- **structured** reads ids, cycles and the kind of event from the question (src/retrieval/questionHints.ts).',
  '  Its rules were written knowing the golden set\'s question templates, so its numbers here are optimistic;',
  '  on 11 paraphrases outside the golden set the event-type rules first got 9 right (now 11, so no longer held out).',
  '- **machine-history** is easy for any strategy that filters by machine and event type: every such event is relevant.',
  '- **vague** questions name no machine, cycle or part; they are reported, not gated.',
].join('\n');
const out = spaceArg ? 'docs/retrieval-eval-spaces' : 'docs/retrieval-eval';
writeFileSync(`${out}.md`, `# Retrieval eval (golden-sim)${spaceArg ? ': embedding models and text variants' : ''}\n\nGenerated by \`npm run eval:retrieval\`; see src/eval/retrievalMetrics.ts for the definitions.\n\n${caveats}\n\n${md}`);
writeFileSync(`${out}.json`, JSON.stringify({ spaces: spaceArg ?? embeddingModel(), simCommit: golden.simCommit, summary: b, perQuery, relevant: Object.fromEntries(relevant) }, null, 2) + '\n');
console.log('\n' + md + `\nWritten: ${out}.md, ${out}.json`);
await db.end();
