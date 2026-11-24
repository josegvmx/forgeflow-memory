import type { GoldenSimQuery } from './goldenSim.js';

// ============================================================
// Retrieval scoring (R14 phase 3, step 7) — pure, unit-tested.
//
// recall@k = relevant hits in the top k / min(k, |relevant|): one fault can have dozens of identical
// relevant events, so plain recall (÷ |relevant|) would punish every strategy for k < |relevant|.
// MRR = 1 / rank of the first relevant hit within the top MRR_CUTOFF (0 if none).
// Rows of ignored runs (fault had no effect) are dropped before ranking: neither hit nor miss.
// ============================================================

export const KS = [1, 5, 10] as const;
export const MRR_CUTOFF = 10;

export interface RetrievedRow {
  id: string;
  scenario_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  run_id: string | null;
}

/** jsonb @> for flat metadata: scalars equal; an array value must contain every element asked for. */
export function containsMetadata(meta: Record<string, unknown> | null, want: Record<string, unknown>): boolean {
  if (!meta) return Object.keys(want).length === 0;
  return Object.entries(want).every(([k, v]) => {
    const got = meta[k];
    if (Array.isArray(v)) return Array.isArray(got) && v.every(x => got.includes(x));
    return got === v;
  });
}

export function isRelevant(row: RetrievedRow, q: Pick<GoldenSimQuery, 'scenarioId' | 'relevant'>): boolean {
  return row.scenario_id === q.scenarioId
    && (q.relevant.eventTypes as string[]).includes(row.event_type)
    && containsMetadata(row.metadata, q.relevant.metadata);
}

export interface QueryScore {
  id: string;
  recall: Record<(typeof KS)[number], number>;
  rr: number;
  /** Rank (1-based) of the first relevant hit, or null. */
  firstHit: number | null;
}

/** Score one query's ranked results (already without ignored runs). */
export function scoreQuery(q: GoldenSimQuery, ranked: RetrievedRow[], relevantCount: number): QueryScore {
  const rel = ranked.map(r => isRelevant(r, q));
  const recall = {} as QueryScore['recall'];
  for (const k of KS) {
    const denom = Math.min(k, relevantCount);
    recall[k] = denom > 0 ? rel.slice(0, k).filter(Boolean).length / denom : 0;
  }
  const i = rel.slice(0, MRR_CUTOFF).indexOf(true);
  return { id: q.id, recall, rr: i >= 0 ? 1 / (i + 1) : 0, firstHit: i >= 0 ? i + 1 : null };
}

export const dropIgnored = (rows: RetrievedRow[], ignore: ReadonlySet<string>) => rows.filter(r => !r.run_id || !ignore.has(r.run_id));

/** Reciprocal rank fusion of ranked lists (ids), k = 60 (Cormack et al.). Ties keep first-list order. */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let n = 0;
  for (const list of lists) {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, n++);
    });
  }
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!);
}

export interface Summary { n: number; recall: Record<(typeof KS)[number], number>; mrr: number }

export function summarise(scores: QueryScore[]): Summary {
  const n = scores.length;
  const mean = (f: (s: QueryScore) => number) => (n ? Math.round((scores.reduce((a, s) => a + f(s), 0) / n) * 1000) / 1000 : 0);
  return { n, recall: { 1: mean(s => s.recall[1]), 5: mean(s => s.recall[5]), 10: mean(s => s.recall[10]) }, mrr: mean(s => s.rr) };
}

/** Results by strategy: overall, then by query style and by aspect. */
export function breakdown(queries: GoldenSimQuery[], byStrategy: Record<string, QueryScore[]>) {
  const qs = new Map(queries.map(q => [q.id, q]));
  const out: Record<string, { all: Summary; style: Record<string, Summary>; aspect: Record<string, Summary> }> = {};
  for (const [strategy, scores] of Object.entries(byStrategy)) {
    const group = (key: 'style' | 'aspect') => {
      const g: Record<string, QueryScore[]> = {};
      for (const s of scores) { const v = qs.get(s.id)![key]; (g[v] ??= []).push(s); }
      return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, summarise(v)]));
    };
    out[strategy] = { all: summarise(scores), style: group('style'), aspect: group('aspect') };
  }
  return out;
}

/** Markdown tables for the service docs. */
export function resultsMarkdown(b: ReturnType<typeof breakdown>, meta: { model: string; queries: number; date: string; simCommit: string | null }): string {
  const f = (x: number) => x.toFixed(2);
  const strategies = Object.keys(b);
  const lines = [
    `Model \`${meta.model}\` · ${meta.queries} queries (golden-sim, sim ${meta.simCommit ?? '?'}) · ${meta.date}`,
    '',
    '| strategy | recall@1 | recall@5 | recall@10 | MRR@10 |',
    '|---|---|---|---|---|',
    ...strategies.map(s => `| ${s} | ${f(b[s].all.recall[1])} | ${f(b[s].all.recall[5])} | ${f(b[s].all.recall[10])} | ${f(b[s].all.mrr)} |`),
  ];
  for (const key of ['style', 'aspect'] as const) {
    const groups = [...new Set(strategies.flatMap(s => Object.keys(b[s][key])))];
    lines.push('', `recall@5 by ${key}:`, '', `| strategy | ${groups.map(g => `${g} (n=${b[strategies[0]][key][g]?.n ?? 0})`).join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`);
    for (const s of strategies) lines.push(`| ${s} | ${groups.map(g => (b[s][key][g] ? f(b[s][key][g].recall[5]) : '–')).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}
