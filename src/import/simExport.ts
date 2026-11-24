import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunRowSchema, type RunRow } from '../audit/runRow.js';
import { SimEpisodeSchema, simEpisodeToReasoningEvent, type SimEpisode } from '../audit/simEpisode.js';
import { formatEventForEmbedding } from '../ingest/chunker.js';
import { textHash } from '../store/embeddingCache.js';

// ============================================================
// forgeflow-sim memory export (R14 phase 3): reading and checking
//
// `npm run eval:export` in forgeflow-sim writes
//   <dir>/part-<i>-of-<n>/{runs.jsonl, episodes.jsonl, manifest.json}
// Everything is validated here, against the same schemas the routes
// use, before anything is sent: an import never stops half-way on a 400.
// ============================================================

export interface ExportManifest {
  format: string; version: number; simCommit: string | null;
  shard: { index: number; count: number };
  runs: number; episodes: number;
  faultRuns: Array<{ run_id: string; name: string; case: string; faults: string[]; effect: { changed: boolean } }>;
  noEffectRuns: string[];
  [k: string]: unknown;
}

export interface SimExport {
  runs: RunRow[];
  episodes: SimEpisode[];
  manifests: ExportManifest[];
  simCommit: string | null;
}

const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '');

/** Read and validate an export directory; throws with a precise message on anything inconsistent. */
export function readSimExport(dir: string): SimExport {
  if (!existsSync(dir)) throw new Error(`no export at ${dir} (run npm run eval:export in forgeflow-sim)`);
  const parts = readdirSync(dir).filter(d => /^part-\d+-of-\d+$/.test(d)).sort();
  if (!parts.length) throw new Error(`${dir}: no part-<i>-of-<n> folders`);
  const counts = new Set(parts.map(p => Number(p.split('-of-')[1])));
  if (counts.size !== 1) throw new Error(`${dir}: parts from different shard counts (${[...counts].join(', ')}): export into an empty folder`);
  const n = [...counts][0];
  const missing = Array.from({ length: n }, (_, i) => `part-${i + 1}-of-${n}`).filter(p => !parts.includes(p));
  if (missing.length) throw new Error(`${dir}: missing ${missing.join(', ')}`);

  const runs: RunRow[] = [], episodes: SimEpisode[] = [], manifests: ExportManifest[] = [];
  for (const p of parts) {
    const at = (f: string) => join(dir, p, f);
    const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8')) as ExportManifest;
    if (manifest.format !== 'forgeflow-memory-export' || manifest.version !== 1) throw new Error(`${p}: not a forgeflow-memory-export v1 manifest`);
    manifests.push(manifest);
    lines(at('runs.jsonl')).forEach((l, i) => {
      const r = RunRowSchema.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`${p}/runs.jsonl line ${i + 1}: ${r.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      runs.push(r.data);
    });
    lines(at('episodes.jsonl')).forEach((l, i) => {
      const r = SimEpisodeSchema.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`${p}/episodes.jsonl line ${i + 1}: ${r.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      episodes.push(r.data);
    });
  }
  const commits = new Set(manifests.map(m => m.simCommit));
  if (commits.size !== 1) throw new Error(`${dir}: parts from different sim commits (${[...commits].join(', ')}): re-export into an empty folder`);
  const total = manifests.reduce((a, m) => ({ runs: a.runs + m.runs, episodes: a.episodes + m.episodes }), { runs: 0, episodes: 0 });
  if (total.runs !== runs.length || total.episodes !== episodes.length) {
    throw new Error(`${dir}: manifests list ${total.runs} runs / ${total.episodes} episodes, files hold ${runs.length} / ${episodes.length}`);
  }
  const ids = new Set<string>();
  for (const r of runs) { if (ids.has(r.run_id)) throw new Error(`${dir}: run ${r.run_id} appears twice`); ids.add(r.run_id); }
  const orphan = episodes.find(e => !ids.has(e.runId));
  if (orphan) throw new Error(`${dir}: an episode belongs to run ${orphan.runId}, which is not in runs.jsonl`);
  return { runs, episodes, manifests, simCommit: [...commits][0] };
}

/** Split into consecutive batches of at most `size`. */
export function batches<T>(xs: T[], size: number): T[][] {
  if (!(size >= 1)) throw new Error('batch size must be ≥ 1');
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** What an import would send, for --dry-run: counts, distinct embedding texts, rough tokens. */
export function importSummary(exp: SimExport) {
  const texts = new Map<string, number>();
  for (const e of exp.episodes) { const t = formatEventForEmbedding(simEpisodeToReasoningEvent(e)); texts.set(textHash(t), t.length); }
  const chars = [...texts.values()].reduce((a, b) => a + b, 0);
  const types: Record<string, number> = {};
  for (const e of exp.episodes) types[e.eventType] = (types[e.eventType] ?? 0) + 1;
  return {
    simCommit: exp.simCommit,
    parts: exp.manifests.length,
    runs: exp.runs.length,
    faultRuns: exp.runs.filter(r => r.faults.length > 0).length,
    noEffectRuns: exp.manifests.reduce((a, m) => a + m.noEffectRuns.length, 0),
    episodes: exp.episodes.length,
    episodeTypes: types,
    labelledEpisodes: exp.episodes.filter(e => e.metadata['fault.injected'] === true).length,
    distinctEmbeddingTexts: texts.size,
    approxEmbeddingTokens: Math.round(chars / 4),
  };
}
