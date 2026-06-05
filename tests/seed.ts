/**
 * Seed script — ingest sample-archive.json then run 3 test queries.
 *
 * Usage:
 *   npm run seed
 *
 * Requires:
 *   - Docker pgvector running (npm run db:migrate already applied)
 *   - .env with DATABASE_URL + at least one embedding key + ANTHROPIC_API_KEY
 */

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ingestArchive } from '../src/ingest/pipeline.js';
import { queryMemory } from '../src/retrieval/query.js';
import type { ReasoningEvent } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────

function separator(label: string) {
  console.log('\n' + '─'.repeat(60));
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

function printResult(result: Awaited<ReturnType<typeof queryMemory>>) {
  console.log(`\nRetrieved ${result.events.length} event(s):\n`);
  for (const e of result.events) {
    console.log(`  [${e.eventType.toUpperCase()}] ${e.scenarioId} / ${e.nodeId} / cycle ${e.cycle}`);
    console.log(`  ${e.content}\n`);
  }
  console.log('Synthesis:\n');
  console.log(`  ${result.summary.replace(/\n/g, '\n  ')}`);
}

// ── 1. Ingest ─────────────────────────────────────────────────

separator('STEP 1 — Ingesting sample-archive.json');

const archivePath = join(__dirname, '../data/sample-archive.json');
const raw = await readFile(archivePath, 'utf-8');
const archive: ReasoningEvent[] = JSON.parse(raw);

console.log(`\nFound ${archive.length} events. Embedding and storing...\n`);

await ingestArchive(archive, (done, total) => {
  process.stdout.write(`  Progress: ${done}/${total}\r`);
});

console.log(`\n\nIngested ${archive.length} events successfully.`);

// ── 2. Test queries ───────────────────────────────────────────

// Query 1 — broad: what causes cascade failures?
separator('QUERY 1 — What causes cascade failures across scenarios?');
const q1 = await queryMemory({
  context: 'What causes cascade machine failures and how were they handled?',
  topK: 5,
});
printResult(q1);

// Query 2 — scoped to one scenario: how did AI mode handle A1 failure?
separator('QUERY 2 — scenario-beta-002: how did AI handle the A1 failure?');
const q2 = await queryMemory({
  context: 'How did the system respond to machine A1 going down?',
  scenarioId: 'scenario-beta-002',
  topK: 4,
});
printResult(q2);

// Query 3 — filtered by event type: coalition outcomes
separator('QUERY 3 — Which coalitions succeeded and which dissolved?');
const q3 = await queryMemory({
  context: 'Which coalitions were formed and what were their outcomes?',
  topK: 4,
  eventTypeFilter: ['coalition'],
});
printResult(q3);

separator('DONE');
console.log('\nAll validation checks passed. Memory layer is operational.\n');

process.exit(0);
