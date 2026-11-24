import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { RunRowSchema, RunsBodySchema } from '../src/audit/runRow.js';

const mockUpsertRuns = vi.fn();
vi.mock('../src/store/runs.js', () => ({ upsertRuns: mockUpsertRuns }));
const { default: runsRoute } = await import('../src/api/routes/runs.js');

const app = new Hono();
app.onError((err, c) => c.json({ error: err.message }, 500));
app.route('/runs', runsRoute);
const post = (body: unknown) => app.request('/runs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Real forgeflow-sim output: replayToRows on the bundled apex AI-on showcase. */
const simRow = JSON.parse(readFileSync(new URL('./fixtures/sim-run-row.json', import.meta.url), 'utf8'));
const heuristicRow = {
  ...simRow, run_id: '7f51d3c8-fdf3-8a87-ab31-76b1cd86e2cf', source: 'eval', provider: 'heuristic', model: null,
  flags: { FORGEFLOW_DBR_ROPE_WIP: 'on', depth: 3, dryRun: false }, seed: 7, faults: ['machine_down:M2_WELD@40+10'],
  llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_p50_ms: null, latency_p95_ms: null,
  llm_decision_share: null, llm_priced_bid_share: 0, fallbacks: 0, truncated: 0,
};

describe('RunRowSchema (roadmap §4.5)', () => {
  it('accepts the sim fixture unchanged; truncated absent → null (not recorded)', () => {
    const r = RunRowSchema.parse(simRow);
    expect(r.run_id).toBe(simRow.run_id);
    expect(r.llm_priced_bid_share).toBe(0.53);
    expect(r.truncated).toBeNull();
  });

  it('accepts an eval heuristic row with flags, seed, faults and truncated', () => {
    const r = RunRowSchema.parse(heuristicRow);
    expect(r).toMatchObject({ seed: 7, truncated: 0, faults: ['machine_down:M2_WELD@40+10'] });
  });

  it('drops unknown keys so the sim can add a column first', () => {
    expect(RunRowSchema.parse({ ...simRow, some_new_column: 1 })).not.toHaveProperty('some_new_column');
  });

  it('rejects a heuristic row that has LLM calls or a model', () => {
    expect(RunRowSchema.safeParse({ ...heuristicRow, llm_calls: 3 }).success).toBe(false);
    expect(RunRowSchema.safeParse({ ...heuristicRow, model: 'x' }).success).toBe(false);
  });

  it.each([
    ['share above 1', { llm_decision_share: 1.2 }],
    ['negative count', { fallbacks: -1 }],
    ['fractional count', { units: 1.5 }],
    ['p95 below p50', { latency_p50_ms: 900, latency_p95_ms: 100 }],
    ['bad run id', { run_id: 'not-a-uuid' }],
    ['bad scenario id', { scenario_id: 'drop table' }],
    ['nested flag', { flags: { a: { b: 1 } } }],
    ['unknown source', { source: 'cli' }],
    ['non-http replay url', { replay_url: 'javascript:alert(1)' }],
    ['date without time', { created_at: '2026-11-24' }],
    ['missing honesty column', { fallbacks: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(RunRowSchema.safeParse({ ...simRow, ...patch }).success).toBe(false);
  });

  it('caps a batch at 1000 rows', () => {
    expect(RunsBodySchema.safeParse({ runs: Array(1001).fill(simRow) }).success).toBe(false);
    expect(RunsBodySchema.safeParse({ runs: [] }).success).toBe(false);
  });
});

describe('POST /runs', () => {
  beforeEach(() => { mockUpsertRuns.mockReset(); });

  it('stores a valid batch and returns inserted / updated', async () => {
    mockUpsertRuns.mockResolvedValue({ inserted: 1, updated: 1 });
    const res = await post({ runs: [simRow, heuristicRow] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, updated: 1 });
    expect(mockUpsertRuns).toHaveBeenCalledWith([expect.objectContaining({ run_id: simRow.run_id, truncated: null }), expect.objectContaining({ provider: 'heuristic' })]);
  });

  it('stores nothing when any row is invalid, and names the row', async () => {
    const res = await post({ runs: [simRow, { ...heuristicRow, llm_calls: 3 }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toBe('runs.1.provider');
    expect(mockUpsertRuns).not.toHaveBeenCalled();
  });

  it('returns 400 for a body that is not JSON', async () => {
    const res = await app.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
  });
});

describe('runs table ↔ RunRowSchema', () => {
  it('schema.sql has a column for every row field, and only stored_at besides', () => {
    const sql = readFileSync(new URL('../src/store/schema.sql', import.meta.url), 'utf8');
    const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS runs ('));
    const body = block.slice(0, block.indexOf('\n);'));
    const cols = [...body.matchAll(/^\s{2}([a-z_0-9]+)\s/gm)].map(m => m[1]).filter(c => c !== 'stored_at');
    const keys = Object.keys((RunRowSchema as any)._def.schema.shape);
    expect(cols.sort()).toEqual(keys.sort());
  });

  it('the store writes every row field', () => {
    const src = readFileSync(new URL('../src/store/runs.ts', import.meta.url), 'utf8');
    for (const k of Object.keys((RunRowSchema as any)._def.schema.shape)) expect(src).toContain(`r.${k}`);
  });
});
