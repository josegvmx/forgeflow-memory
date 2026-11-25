import type { breakdown } from './retrievalMetrics.js';

// ============================================================
// Retrieval gates (R14 phase 3, step 8): minimums on the golden-set eval, set from measured
// results minus a margin (tests/evals/fixtures/retrieval-gates.json). Pure, unit-tested; the
// gate itself runs with npm run test:eval (tests/evals/retrieval.eval.ts).
// ============================================================

export interface RetrievalGate {
  strategy: string;
  /** 'all', or 'style:<specific|operator|vague>', or 'aspect:<failure|recovery|reroute|disruption|machine-history>'. */
  group: string;
  metric: 'recall@1' | 'recall@5' | 'recall@10' | 'mrr';
  min: number;
  /** Why this number (what was measured). */
  note?: string;
}

type Summary = ReturnType<typeof breakdown>;

/** Failures as readable lines; [] when every gate holds. A gate on a missing strategy or group fails. */
export function checkGates(summary: Summary, gates: RetrievalGate[]): string[] {
  const out: string[] = [];
  for (const g of gates) {
    const s = summary[g.strategy];
    if (!s) { out.push(`${g.strategy}: not run`); continue; }
    const [kind, name] = g.group === 'all' ? ['all', ''] : g.group.split(':');
    const sum = kind === 'all' ? s.all : kind === 'style' ? s.style[name] : kind === 'aspect' ? s.aspect[name] : undefined;
    if (!sum) { out.push(`${g.strategy} ${g.group}: no such group`); continue; }
    const v = g.metric === 'mrr' ? sum.mrr : sum.recall[Number(g.metric.split('@')[1]) as 1 | 5 | 10];
    if (!(v >= g.min)) out.push(`${g.strategy} ${g.group} ${g.metric} = ${v.toFixed(2)} < ${g.min.toFixed(2)}${g.note ? ` (${g.note})` : ''}`);
  }
  return out;
}
