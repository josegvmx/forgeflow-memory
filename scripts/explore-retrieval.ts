/**
 * Explore retrieval — inspect which chunks are returned for a question
 * and their cosine distances.
 *
 * Use this BEFORE writing golden-set fixtures to understand the
 * embedding model's actual similarity landscape, not the intended one.
 * Run for each candidate golden query and design notExpectedFacts around
 * the OBSERVED retrieval boundary.
 *
 * Usage:
 *   tsx scripts/explore-retrieval.ts --question "what caused the M2 failure?" --topK 10
 *   tsx scripts/explore-retrieval.ts --question "..." --topK 5 --scenario scenario_eval_001
 *
 * Output: ranked list of retrieved chunks with cosine distance, nodeId, cycle,
 *         eventType, mode, and content preview.
 */

import 'dotenv/config';
import db from '../src/store/client.js';
import { embed } from '../src/ingest/embedder.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const question       = getArg('--question');
const topKArg        = getArg('--topK') ?? getArg('--topk');
const scenarioFilter = getArg('--scenario');

if (!question) {
  console.error('Usage: tsx scripts/explore-retrieval.ts --question "<text>" [--topK 10] [--scenario <id>]');
  process.exit(1);
}

const topK = topKArg ? parseInt(topKArg, 10) : 10;
if (isNaN(topK) || topK < 1) {
  console.error('--topK must be a positive integer');
  process.exit(1);
}

// ── Query ─────────────────────────────────────────────────────────────────────

interface EventRow {
  id:          string;
  scenario_id: string;
  node_id:     string;
  cycle:       number;
  event_type:  string;
  mode:        string;
  content:     string;
  distance:    number;
}

console.log('\nForgeFlow Memory — Explore Retrieval');
console.log('─'.repeat(50));
console.log(`Question : "${question}"`);
console.log(`topK     : ${topK}`);
if (scenarioFilter) console.log(`Scenario : ${scenarioFilter}`);
console.log();

let embedding: number[];
try {
  process.stdout.write('Embedding question… ');
  embedding = await embed(question);
  console.log('done.');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFailed to embed question: ${msg}`);
  await db.end();
  process.exit(1);
}

const scenarioClause = scenarioFilter
  ? db`AND scenario_id = ${scenarioFilter}`
  : db``;

const rows = await db<EventRow[]>`
  SELECT
    id,
    scenario_id,
    node_id,
    cycle,
    event_type,
    mode,
    content,
    embedding <=> ${JSON.stringify(embedding)}::vector AS distance
  FROM reasoning_events
  WHERE embedding IS NOT NULL
  ${scenarioClause}
  ORDER BY distance ASC
  LIMIT ${topK}
`;

if (rows.length === 0) {
  console.log('No rows found. Is the DB running and populated?');
  await db.end();
  process.exit(0);
}

// ── Print results ─────────────────────────────────────────────────────────────

const PREVIEW_LENGTH = 120;

console.log(`Retrieved ${rows.length} chunk(s):\n`);

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const preview = r.content.length > PREVIEW_LENGTH
    ? r.content.slice(0, PREVIEW_LENGTH).trimEnd() + '…'
    : r.content;

  console.log(`[${i + 1}] distance=${r.distance.toFixed(4)}  node=${r.node_id}  cycle=${r.cycle}  type=${r.event_type}  mode=${r.mode}`);
  console.log(`    scenario=${r.scenario_id}`);
  console.log(`    "${preview}"`);
  console.log();
}

// ── Boundary summary ──────────────────────────────────────────────────────────
// Shows the distance gap between the last retrieved chunk and what would have
// been next — useful for deciding notExpectedFacts thresholds.

if (rows.length === topK) {
  const boundary = rows[rows.length - 1].distance;
  console.log(`─`.repeat(50));
  console.log(`Retrieval boundary: last chunk distance = ${boundary.toFixed(4)}`);
  console.log(`Any chunk with distance > ${boundary.toFixed(4)} was NOT retrieved.`);
  console.log(`Use this boundary when designing notExpectedFacts in golden-set.json.`);
}

await db.end();
