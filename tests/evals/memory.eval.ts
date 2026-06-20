import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { judgeRelevance } from './judge.js';
import { ingestArchive } from '../../src/ingest/pipeline.js';
import { queryMemory } from '../../src/retrieval/query.js';
import db from '../../src/store/client.js';
import type { ReasoningEvent } from '../../src/types.js';

// ============================================================
// Golden-set Eval — forgeflow-memory RAG pipeline
//
// Prerequisites (skip gracefully when missing):
//   • PostgreSQL running + DATABASE_URL set
//   • VOYAGE_API_KEY or OPENAI_API_KEY set (for embeddings)
//   • ANTHROPIC_API_KEY set (for faithfulness judge)
//       or SYNTHESIS_PROVIDER=ollama + Ollama running
//
// Run:  npm run test:eval
//
// What is tested per query:
//   1. RECALL    — expected chunk keys (nodeId+cycle pairs) present in top-K results
//   2. FAITHFULNESS — LLM-as-a-judge checks summary is grounded in retrieved chunks
//   3. NOT-EXPECTED — facts from other events must not appear in the summary
//
// Thresholds:
//   recall      >= 0.5   (at least 1 of 2 expected chunks retrieved)
//   faithfulness >= 0.7  (judge score)
// ============================================================

// ── Load fixture ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir      = dirname(__filename);

interface GoldenQuery {
  id:                   string;
  question:             string;
  expectedChunkKeys:    string[];   // e.g. ["evt-01", "evt-07"]
  expectedFactsPresent: string[];
  notExpectedFacts:     string[];
}

interface GoldenFixture {
  scenarioId: string;
  events:     (ReasoningEvent & { _key: string })[];
  queries:    GoldenQuery[];
}

const fixture: GoldenFixture = JSON.parse(
  readFileSync(join(__dir, 'fixtures/golden-set.json'), 'utf-8')
);

// Build a lookup: _key → { nodeId, cycle } for recall matching
const keyToChunk = new Map<string, { nodeId: string; cycle: number }>(
  fixture.events.map((e) => [e._key, { nodeId: e.nodeId, cycle: e.cycle }])
);

// ── Prerequisite checks ───────────────────────────────────────────────────────

let dbAvailable   = false;
let embedAvailable = false;
let judgeAvailable = false;

async function checkPrerequisites(): Promise<void> {
  // 1. DB
  try {
    await db`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n[eval] Skipping: DATABASE_URL not reachable (ECONNREFUSED).');
  }

  // 2. Embedder — at least one key must be set
  embedAvailable =
    Boolean(process.env.VOYAGE_API_KEY) || Boolean(process.env.OPENAI_API_KEY);
  if (!embedAvailable) {
    console.warn('[eval] Skipping: no VOYAGE_API_KEY or OPENAI_API_KEY set.');
  }

  // 3. Judge — Anthropic key OR Ollama
  const provider = process.env.SYNTHESIS_PROVIDER ?? 'anthropic';
  judgeAvailable =
    provider === 'ollama'
      ? true   // assume Ollama is available; it will throw at runtime if not
      : Boolean(process.env.ANTHROPIC_API_KEY);
  if (!judgeAvailable) {
    console.warn('[eval] Skipping: no ANTHROPIC_API_KEY set and provider is not ollama.');
  }
}

let ingestSucceeded = false;

const ready = (): boolean => dbAvailable && embedAvailable && judgeAvailable && ingestSucceeded;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute recall: fraction of expected chunk keys found in retrieved events */
function computeRecall(
  retrieved: ReasoningEvent[],
  expectedKeys: string[]
): { score: number; found: string[]; missed: string[] } {
  const found: string[]  = [];
  const missed: string[] = [];

  for (const key of expectedKeys) {
    const chunk = keyToChunk.get(key);
    if (!chunk) continue;

    const hit = retrieved.some(
      (e) => e.nodeId === chunk.nodeId && e.cycle === chunk.cycle
    );
    (hit ? found : missed).push(key);
  }

  return {
    score: expectedKeys.length > 0 ? found.length / expectedKeys.length : 0,
    found,
    missed,
  };
}

/** Check that none of the notExpectedFacts appear in the summary */
function checkNegativeFacts(
  summary: string,
  notExpected: string[]
): string[] {
  return notExpected.filter((fact) =>
    summary.toLowerCase().includes(fact.toLowerCase())
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await checkPrerequisites();
  if (!dbAvailable || !embedAvailable || !judgeAvailable) return;

  console.log(`\n[eval] Ingesting ${fixture.events.length} golden events for ${fixture.scenarioId}...`);

  // Strip the _key helper field before ingesting
  const events: ReasoningEvent[] = fixture.events.map(({ _key: _ignored, ...e }) => e);

  try {
    await ingestArchive(events);
    ingestSucceeded = true;
    console.log('[eval] Ingest complete.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[eval] Ingest failed — skipping all eval tests.\n  Reason: ${msg}`);
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Clean up eval scenario so repeated runs stay idempotent
  const deleted = await db`
    DELETE FROM reasoning_events WHERE scenario_id = ${fixture.scenarioId}
  `;
  console.log(`\n[eval] Cleaned up ${deleted.count} rows for ${fixture.scenarioId}.`);
  await db.end();
});

// ── Eval suite ────────────────────────────────────────────────────────────────

describe('forgeflow-memory RAG eval — golden set', () => {
  // Run one describe block per query so scores are reported individually
  for (const goldenQuery of fixture.queries) {
    describe(`[${goldenQuery.id}] ${goldenQuery.question.slice(0, 60)}…`, () => {

      // Shared state within this query's describe
      let recallScore  = 0;
      let foundKeys:   string[] = [];
      let missedKeys:  string[] = [];
      let summary      = '';
      let debugContext = '';
      let leakingFacts: string[] = [];

      // Run the query once, shared across the tests below
      beforeAll(async () => {
        if (!ready()) return;

        let result;
        try {
          result = await queryMemory({
            context:    goldenQuery.question,
            topK:       4,
            scenarioId: fixture.scenarioId,
            debug:      true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  [${goldenQuery.id}] query failed — skipping.\n    Reason: ${msg}`);
          return;
        }

        summary      = result.summary;
        debugContext = result._debugContext ?? '';

        const recall = computeRecall(result.events, goldenQuery.expectedChunkKeys);
        recallScore  = recall.score;
        foundKeys    = recall.found;
        missedKeys   = recall.missed;

        leakingFacts = checkNegativeFacts(summary, goldenQuery.notExpectedFacts);

        // Always log scores for visibility — even when tests pass
        console.log(`\n  [${goldenQuery.id}] recall=${(recallScore * 100).toFixed(0)}%`);
        console.log(`    found:  ${foundKeys.join(', ') || '—'}`);
        if (missedKeys.length) console.log(`    missed: ${missedKeys.join(', ')}`);
        if (leakingFacts.length) console.log(`    leaked: ${leakingFacts.join(', ')}`);
      });

      // ── Test 1: Recall ───────────────────────────────────────────────────────
      it('recall ≥ 0.5 — at least half the expected chunks retrieved', () => {
        if (!ready()) {
          console.log(`  [${goldenQuery.id}] skipped — prerequisites not met`);
          return;
        }
        expect(
          recallScore,
          `Expected chunks not retrieved.\nFound: ${foundKeys.join(', ')}\nMissed: ${missedKeys.join(', ')}`
        ).toBeGreaterThanOrEqual(0.5);
      });

      // ── Test 2: Faithfulness ─────────────────────────────────────────────────
      it('faithfulness score ≥ 0.7 — summary grounded in retrieved context', async () => {
        if (!ready()) {
          console.log(`  [${goldenQuery.id}] skipped — prerequisites not met`);
          return;
        }
        if (!debugContext) {
          console.log(`  [${goldenQuery.id}] skipped — no debug context returned`);
          return;
        }

        const judgment = await judgeRelevance(debugContext, summary);

        console.log(`    faithfulness=${judgment.score.toFixed(2)} faithful=${judgment.faithful}`);
        if (judgment.violations.length) {
          console.log(`    violations: ${judgment.violations.join('; ')}`);
        }
        console.log(`    reasoning: ${judgment.reasoning}`);

        expect(
          judgment.score,
          `Faithfulness too low.\nViolations:\n${judgment.violations.map((v) => `  - ${v}`).join('\n')}`
        ).toBeGreaterThanOrEqual(0.7);
      });

      // ── Test 3: Negative fact leakage ────────────────────────────────────────
      it('summary does not contain facts from other events (no cross-contamination)', () => {
        if (!ready()) return;
        expect(
          leakingFacts,
          `Summary mentions facts that belong to OTHER events:\n${leakingFacts.map((f) => `  - "${f}"`).join('\n')}`
        ).toHaveLength(0);
      });
    });
  }
});
