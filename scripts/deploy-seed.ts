/**
 * deploy-seed.ts
 *
 * Idempotent seed script for Railway deploys (runs after migrate on startup).
 * - Ingests the three demo archives in data/ (1,875 events).
 * - Ingest is de-duplicated by event hash, so events already in the DB are
 *   skipped before embedding: re-running on every restart costs nothing and
 *   never creates copies.
 * - Exits 0 even on failure so a seed problem doesn't take down the deploy.
 */
import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ingestArchive } from '../src/ingest/pipeline.js';
import type { ReasoningEvent } from '../src/types.js';
import db from '../src/store/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEMO_ARCHIVES = [
  'demo-archive.json',        // scenario_demo_001 — heuristic baseline
  'demo-archive-errors.json', // scenario_demo_002 — machine failures
  'demo-archive-ai.json',     // scenario_demo_003 — AI agents
];

async function run() {
  let inserted = 0;
  let skipped = 0;

  for (const file of DEMO_ARCHIVES) {
    const raw = await readFile(join(__dirname, '../data', file), 'utf-8');
    const parsed = JSON.parse(raw);
    const archive: ReasoningEvent[] = Array.isArray(parsed) ? parsed : parsed.archive;

    const stats = await ingestArchive(archive, (done, total) => {
      process.stdout.write(`[deploy-seed] ${file}: embedding ${done}/${total}\r`);
    });
    inserted += stats.inserted;
    skipped += stats.skipped;
    console.log(`[deploy-seed] ${file}: ${stats.inserted} new, ${stats.skipped} already present or duplicate.`);
  }

  console.log(`[deploy-seed] Done — ${inserted} inserted, ${skipped} skipped.`);
  await db.end();
  process.exit(0);
}

run().catch((err) => {
  console.error('[deploy-seed] Failed:', err.message);
  // Exit 0 so a seed failure doesn't take down the deploy
  process.exit(0);
});
