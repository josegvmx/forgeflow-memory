import { embedManyWith, embeddingModel } from '../ingest/embedder.js';
import { getCachedEmbeddings, putCachedEmbeddings } from '../store/embeddingCache.js';
import { textHash } from '../ingest/textHash.js';
import { retrieve, countRelevant, cachedModels, type Strategy, type EmbeddingSpace } from '../retrieval/strategies.js';
import { spaceCoverage } from '../store/variants.js';
import { scoreQuery, dropIgnored, breakdown, type QueryScore } from './retrievalMetrics.js';
import type { GoldenSimSet } from './goldenSim.js';

// ============================================================
// Retrieval eval core (R14 phase 3): the golden set against the store, per strategy and embedding
// space. Used by `npm run eval:retrieval` (writes the docs) and the gate (tests/evals/retrieval.eval.ts).
// ============================================================

export interface RetrievalRun {
  byStrategy: Record<string, QueryScore[]>;
  perQuery: Record<string, Record<string, { firstHit: number | null; recall5: number }>>;
  relevant: Record<string, number>;
  summary: ReturnType<typeof breakdown>;
  /** Queries with no relevant events in this store (import missing?). */
  empty: string[];
  /** Spaces skipped because not every event has a vector there. */
  skipped: string[];
}

export interface RetrievalRunOptions {
  golden: GoldenSimSet;
  strategies: Strategy[];
  /** Embedding spaces; [undefined] = the live column (reasoning_events.embedding, HNSW). */
  spaces?: Array<EmbeddingSpace | undefined>;
  log?: (line: string) => void;
}

export async function runRetrievalEval(opts: RetrievalRunOptions): Promise<RetrievalRun> {
  const { golden, strategies } = opts;
  const spaces = opts.spaces ?? [undefined];
  const log = opts.log ?? (() => {});
  const qs = golden.queries;
  const hashes = qs.map(q => textHash(q.question));
  const ignore = new Set(golden.ignoreRunIds);

  /** Question vectors for a model: embedded once, cached like event texts. */
  const questionVectors = async (model: string) => {
    const vecs = await getCachedEmbeddings(model, hashes);
    const missing = qs.filter((_q, i) => !vecs.has(hashes[i]));
    if (missing.length) {
      const embs = await embedManyWith(model, missing.map(q => q.question));
      const entries = missing.map((q, i) => ({ hash: textHash(q.question), embedding: embs[i] }));
      await putCachedEmbeddings(model, entries);
      for (const e of entries) vecs.set(e.hash, e.embedding);
    }
    log(`${qs.length} questions with ${model} (${missing.length} embedded now)`);
    return vecs;
  };

  const relevant: Record<string, number> = {};
  for (const q of qs) relevant[q.id] = await countRelevant(q, golden.ignoreRunIds);
  const empty = qs.filter(q => relevant[q.id] === 0).map(q => q.id);

  const byStrategy: RetrievalRun['byStrategy'] = {};
  const perQuery: RetrievalRun['perQuery'] = {};
  const skipped: string[] = [];
  const models = await cachedModels();
  for (const space of spaces) {
    const model = space?.model ?? embeddingModel();
    if (!space && models.length && !models.includes(model)) {
      throw new Error(`The stored events were embedded with ${models.join(', ')}, but this environment would embed questions with ${model}. Set the matching key.`);
    }
    if (space) {
      const cov = await spaceCoverage(space.model, space.variant);
      if (cov.covered < cov.events) {
        skipped.push(`${space.model}/${space.variant}: ${cov.covered} of ${cov.events} events have a vector (npm run embed:variant -- --model ${space.model} --variant ${space.variant})`);
        continue;
      }
    }
    const vecs = await questionVectors(model);
    // Full text ignores the embedding space: run it with the live store only.
    for (const s of space ? strategies.filter(x => x !== 'fulltext') : strategies) {
      const key = space ? `${s} @ ${space.model}/${space.variant}` : s;
      const t0 = Date.now();
      byStrategy[key] = [];
      for (const [i, q] of qs.entries()) {
        const rows = dropIgnored(await retrieve(s, { text: q.question, embedding: vecs.get(hashes[i])!, scenarioId: q.scenarioId, space }), ignore);
        const sc = scoreQuery(q, rows, relevant[q.id]);
        byStrategy[key].push(sc);
        (perQuery[q.id] ??= {})[key] = { firstHit: sc.firstHit, recall5: sc.recall[5] };
      }
      const b = breakdown(qs, { [key]: byStrategy[key] })[key].all;
      log(`  ${key.padEnd(50)} recall@5 ${b.recall[5].toFixed(2)}  recall@10 ${b.recall[10].toFixed(2)}  MRR ${b.mrr.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
  return { byStrategy, perQuery, relevant, summary: breakdown(qs, byStrategy), empty, skipped };
}
