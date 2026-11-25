import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import db from '../../src/store/client.js';
import { runRetrievalEval, type RetrievalRun } from '../../src/eval/runRetrieval.js';
import { checkGates, type RetrievalGate } from '../../src/eval/gates.js';
import type { Strategy } from '../../src/retrieval/strategies.js';
import type { GoldenSimSet } from '../../src/eval/goldenSim.js';

// ============================================================
// Retrieval gate (R14 phase 3, step 8) — npm run test:eval
//
// Runs the golden-sim set against the store in DATABASE_URL (it must hold the imported sim
// export; on Railway use the pgvector public URL) with the gated strategies, and fails if any
// number falls below tests/evals/fixtures/retrieval-gates.json. Skips when the database or the
// embedding key is missing, or the store has no sim export (local development DB).
// ============================================================

const golden: GoldenSimSet = JSON.parse(readFileSync(new URL('./fixtures/golden-sim.json', import.meta.url), 'utf8'));
const { gates }: { gates: RetrievalGate[] } = JSON.parse(readFileSync(new URL('./fixtures/retrieval-gates.json', import.meta.url), 'utf8'));

let run: RetrievalRun | null = null;
let skip = '';

beforeAll(async () => {
  try { await db`SELECT 1`; } catch { skip = 'DATABASE_URL not reachable'; return; }
  if (!process.env.VOYAGE_API_KEY && !process.env.OPENAI_API_KEY) { skip = 'no embedding key'; return; }
  const [{ n }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM reasoning_events WHERE run_id IS NOT NULL`;
  if (n < 1000) { skip = `store has ${n} sim events (import the sim export first)`; return; }
  const strategies = [...new Set(gates.map(g => g.strategy))] as Strategy[];
  run = await runRetrievalEval({ golden, strategies, log: line => console.log(`[retrieval] ${line}`) });
}, 600_000);

afterAll(async () => { await db.end(); });

describe('retrieval gate (golden-sim)', () => {
  it('every golden query has relevant events in the store', () => {
    if (!run) { console.warn(`[retrieval] skipped: ${skip}`); return; }
    expect(run.empty).toEqual([]);
  });

  it('meets the gates in retrieval-gates.json', () => {
    if (!run) return;
    expect(checkGates(run.summary, gates)).toEqual([]);
  });
});
