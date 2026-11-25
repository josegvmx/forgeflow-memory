import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkGates, type RetrievalGate } from '../src/eval/gates.js';
import { breakdown, scoreQuery, type RetrievedRow } from '../src/eval/retrievalMetrics.js';
import type { GoldenSimQuery } from '../src/eval/goldenSim.js';

const q = (id: string, style: GoldenSimQuery['style']): GoldenSimQuery => ({
  id, question: id, style, aspect: 'failure', scenarioId: 's', relevant: { eventTypes: ['machine_failure'], metadata: { machineId: 'M1' } }, relevantInExport: 1,
});
const hit: RetrievedRow = { id: '1', scenario_id: 's', event_type: 'machine_failure', metadata: { machineId: 'M1' }, run_id: null };
const miss: RetrievedRow = { ...hit, id: '2', metadata: { machineId: 'M2' } };
const qs = [q('a', 'specific'), q('b', 'vague')];
const summary = breakdown(qs, { structured: [scoreQuery(qs[0], [hit], 1), scoreQuery(qs[1], [miss], 1)] });
const gate = (over: Partial<RetrievalGate>): RetrievalGate => ({ strategy: 'structured', group: 'all', metric: 'recall@5', min: 0.5, ...over });

describe('checkGates', () => {
  it('passes at or above the minimum', () => {
    expect(checkGates(summary, [gate({}), gate({ group: 'style:specific', min: 1 }), gate({ metric: 'mrr', min: 0.5 })])).toEqual([]);
  });

  it('reports each failure with the measured value and the note', () => {
    expect(checkGates(summary, [gate({ min: 0.6, note: 'measured 0.85' })])).toEqual(['structured all recall@5 = 0.50 < 0.60 (measured 0.85)']);
    expect(checkGates(summary, [gate({ group: 'style:vague', min: 0.1 })])).toHaveLength(1);
  });

  it('fails a gate whose strategy did not run or whose group does not exist', () => {
    expect(checkGates(summary, [gate({ strategy: 'vector' })])).toEqual(['vector: not run']);
    expect(checkGates(summary, [gate({ group: 'aspect:reroute' })])).toEqual(['structured aspect:reroute: no such group']);
  });

  it('the committed gates are well-formed and never gate vague questions', () => {
    const { gates }: { gates: RetrievalGate[] } = JSON.parse(readFileSync(new URL('./evals/fixtures/retrieval-gates.json', import.meta.url), 'utf8'));
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) {
      expect(['recall@1', 'recall@5', 'recall@10', 'mrr']).toContain(g.metric);
      expect(g.min).toBeGreaterThan(0);
      expect(g.min).toBeLessThanOrEqual(1);
      expect(g.group).not.toBe('style:vague');
    }
  });
});
