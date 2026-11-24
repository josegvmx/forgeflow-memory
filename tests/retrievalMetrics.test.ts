import { describe, it, expect } from 'vitest';
import { containsMetadata, isRelevant, scoreQuery, dropIgnored, rrf, summarise, breakdown, resultsMarkdown, type RetrievedRow } from '../src/eval/retrievalMetrics.js';
import type { GoldenSimQuery } from '../src/eval/goldenSim.js';

const q = (over: Partial<GoldenSimQuery> = {}): GoldenSimQuery => ({
  id: 'q1', question: 'x', style: 'specific', aspect: 'failure', scenarioId: 's1',
  relevant: { eventTypes: ['machine_failure'], metadata: { 'fault.type': 'machine_down', 'fault.target': 'M1' } },
  relevantInExport: 3, ...over,
});
let n = 0;
const row = (relevant: boolean, over: Partial<RetrievedRow> = {}): RetrievedRow => ({
  id: String(++n), scenario_id: 's1', event_type: 'machine_failure', run_id: null,
  metadata: relevant ? { 'fault.type': 'machine_down', 'fault.target': 'M1', machineId: 'M1' } : { machineId: 'M2' }, ...over,
});

describe('relevance (jsonb @> semantics)', () => {
  it('matches scalars exactly and arrays by containment', () => {
    expect(containsMetadata({ a: 1, b: 'x', ops: ['OP_A', 'OP_B'] }, { a: 1, ops: ['OP_B'] })).toBe(true);
    expect(containsMetadata({ a: 1 }, { a: '1' })).toBe(false);
    expect(containsMetadata({ ops: ['OP_A'] }, { ops: ['OP_A', 'OP_B'] })).toBe(false);
    expect(containsMetadata(null, {})).toBe(true);
    expect(containsMetadata(null, { a: 1 })).toBe(false);
  });

  it('needs the scenario, an allowed event type and the metadata', () => {
    expect(isRelevant(row(true), q())).toBe(true);
    expect(isRelevant(row(true, { scenario_id: 's2' }), q())).toBe(false);
    expect(isRelevant(row(true, { event_type: 'recovery' }), q())).toBe(false);
    expect(isRelevant(row(false), q())).toBe(false);
  });
});

describe('scoreQuery', () => {
  it('recall@k is measured against min(k, |relevant|); MRR from the first hit', () => {
    const ranked = [row(false), row(true), row(true), row(false), row(true), row(false)];
    const s = scoreQuery(q(), ranked, 3);
    expect(s.recall[1]).toBe(0);
    expect(s.recall[5]).toBe(1);          // 3 hits / min(5, 3)
    expect(s.recall[10]).toBe(1);
    expect(s.rr).toBe(0.5);
    expect(s.firstHit).toBe(2);
  });

  it('with many relevant events, a full top-k counts as recall 1', () => {
    expect(scoreQuery(q(), Array.from({ length: 10 }, () => row(true)), 200).recall).toEqual({ 1: 1, 5: 1, 10: 1 });
  });

  it('no relevant events (or none found) scores 0, not NaN', () => {
    expect(scoreQuery(q(), [row(true)], 0).recall).toEqual({ 1: 0, 5: 0, 10: 0 });
    expect(scoreQuery(q(), [row(false)], 4)).toMatchObject({ rr: 0, firstHit: null });
  });

  it('MRR only counts the top 10', () => {
    const ranked = [...Array.from({ length: 10 }, () => row(false)), row(true)];
    expect(scoreQuery(q(), ranked, 1).rr).toBe(0);
  });
});

describe('ignored runs and fusion', () => {
  it('drops rows of ignored runs before ranking', () => {
    const a = row(true, { run_id: 'r-ignored' }), b = row(true, { run_id: 'r-ok' }), c = row(true);
    expect(dropIgnored([a, b, c], new Set(['r-ignored']))).toEqual([b, c]);
  });

  it('rrf ranks items found high in both lists first', () => {
    expect(rrf([['a', 'b', 'c'], ['b', 'd']])).toEqual(['b', 'a', 'd', 'c']);
    // 1st + 3rd beats 2nd + 2nd (1/61 + 1/63 > 2/62)
    expect(rrf([['a', 'b', 'c'], ['c', 'b', 'd']])).toEqual(['c', 'b', 'a', 'd']);
    expect(rrf([['a', 'b'], []])).toEqual(['a', 'b']);
    expect(rrf([['x'], ['y']])).toEqual(['x', 'y']); // tie: first list first
  });
});

describe('summaries', () => {
  it('averages per strategy, style and aspect, and renders a table', () => {
    const qs = [q({ id: 'a', style: 'specific' }), q({ id: 'b', style: 'vague', aspect: 'recovery' })];
    const s = { vector: [scoreQuery(qs[0], [row(true)], 1), scoreQuery(qs[1], [row(false)], 1)] };
    const b = breakdown(qs, s);
    expect(b.vector.all).toEqual(summarise(s.vector));
    expect(b.vector.all.recall[1]).toBe(0.5);
    expect(b.vector.style).toMatchObject({ specific: { n: 1, mrr: 1 }, vague: { n: 1, mrr: 0 } });
    const md = resultsMarkdown(b, { model: 'm', queries: 2, date: '2026-11-24', simCommit: 'abc' });
    expect(md).toContain('| vector | 0.50 | 0.50 | 0.50 | 0.50 |');
    expect(md).toContain('specific (n=1)');
  });
});
