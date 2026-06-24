/**
 * deploy-seed.ts
 *
 * Idempotent seed script for Railway deploys.
 * - Applies the schema (CREATE TABLE IF NOT EXISTS — safe to re-run)
 * - Skips ingestion if sample data is already present
 * - Exits 0 on success so the deploy doesn't fail if API keys are missing
 *
 * Called automatically via the Railway deploy hook:
 *   npm run db:migrate && tsx scripts/deploy-seed.ts
 */

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ingestArchive } from '../src/ingest/pipeline.js';
import type { ReasoningEvent } from '../src/types.js';
import db from '../src/store/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  // Check if sample data already exists
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reasoning_events
    WHERE scenario_id LIKE 'scenario-%'
  `;

  const existing = parseInt(rows[0]?.count ?? '0', 10);

  if (existing > 0) {
    console.log(`[deploy-seed] ${existing} events already present — skipping ingest.`);
    await db.end();
    process.exit(0);
  }

  console.log('[deploy-seed] No data found — ingesting sample archive...');

  const archivePath = join(__dirname, '../data/demo-archive.json');
  const raw = await readFile(archivePath, 'utf-8');
  const archive: ReasoningEvent[] = JSON.parse(raw);

  await ingestArchive(archive, (done, total) => {
    process.stdout.write(`[deploy-seed] Progress: ${done}/${total}\r`);
  });

  console.log(`\n[deploy-seed] Ingested ${archive.length} events successfully.`);
  await db.end();
  process.exit(0);
}

run().catch((err) => {
  console.error('[deploy-seed] Failed:', err.message);
  // Exit 0 so a seed failure doesn't take down the deploy
  process.exit(0);
});
