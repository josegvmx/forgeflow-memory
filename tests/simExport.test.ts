import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSimExport, batches, importSummary } from '../src/import/simExport.js';

/** A real (trimmed) forgeflow-sim eval:export: base run, labelled fault run with a reroute, no-effect fault run. */
const FIXTURE = new URL('./fixtures/sim-export', import.meta.url).pathname;
const tmps: string[] = [];
const copy = () => { const d = mkdtempSync(join(tmpdir(), 'simexp-')); tmps.push(d); cpSync(FIXTURE, d, { recursive: true }); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

describe('readSimExport (forgeflow-sim eval:export)', () => {
  it('reads and validates the sample: rows, episodes, fault labels', () => {
    const exp = readSimExport(FIXTURE);
    expect(exp.runs).toHaveLength(3);
    expect(exp.episodes).toHaveLength(12);
    expect(exp.runs.every(r => r.source === 'eval' && r.provider === 'heuristic' && r.truncated === 0)).toBe(true);
    expect(exp.runs.filter(r => r.faults.length)).toHaveLength(2);
    expect(exp.episodes.some(e => e.eventType === 'routing_adjustment' && e.metadata['fault.injected'] === true)).toBe(true);
    expect(exp.manifests[0].noEffectRuns).toHaveLength(1);
  });

  it('summarises what an import would send (dry run)', () => {
    const s = importSummary(readSimExport(FIXTURE));
    expect(s).toMatchObject({ parts: 1, runs: 3, faultRuns: 2, noEffectRuns: 1, episodes: 12, labelledEpisodes: 4 });
    expect(s.distinctEmbeddingTexts).toBeGreaterThan(0);
    expect(s.distinctEmbeddingTexts).toBeLessThanOrEqual(12);
  });

  it('refuses a missing part', () => {
    const d = copy();
    renameSync(join(d, 'part-1-of-1'), join(d, 'part-1-of-2'));
    expect(() => readSimExport(d)).toThrow(/missing part-2-of-2/);
  });

  it('refuses parts from different shard counts', () => {
    const d = copy();
    cpSync(join(d, 'part-1-of-1'), join(d, 'part-1-of-2'), { recursive: true });
    expect(() => readSimExport(d)).toThrow(/different shard counts/);
  });

  it('refuses an invalid row and names the line', () => {
    const d = copy();
    const p = join(d, 'part-1-of-1', 'runs.jsonl');
    const rows = readFileSync(p, 'utf8').trim().split('\n');
    rows[1] = JSON.stringify({ ...JSON.parse(rows[1]), llm_calls: 3 }); // a heuristic row with LLM calls
    writeFileSync(p, rows.join('\n') + '\n');
    expect(() => readSimExport(d)).toThrow(/runs\.jsonl line 2: provider/);
  });

  it('refuses an episode of a run that is not exported, and counts that disagree with the manifest', () => {
    const d = copy();
    const p = join(d, 'part-1-of-1', 'episodes.jsonl');
    const first = JSON.parse(readFileSync(p, 'utf8').split('\n')[0]);
    appendFileSync(p, JSON.stringify({ ...first, runId: '00000000-0000-4000-8000-000000000000' }) + '\n');
    expect(() => readSimExport(d)).toThrow(/manifests list 3 runs \/ 12 episodes, files hold 3 \/ 13/);
    const m = join(d, 'part-1-of-1', 'manifest.json');
    writeFileSync(m, JSON.stringify({ ...JSON.parse(readFileSync(m, 'utf8')), episodes: 13 }));
    expect(() => readSimExport(d)).toThrow(/not in runs\.jsonl/);
  });

  it('refuses a folder with no export', () => {
    expect(() => readSimExport(join(tmpdir(), 'nope-' + Date.now()))).toThrow(/no export/);
  });
});

describe('batches', () => {
  it('splits in order, last batch short', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 3)).toEqual([]);
    expect(() => batches([1], 0)).toThrow();
  });
});
