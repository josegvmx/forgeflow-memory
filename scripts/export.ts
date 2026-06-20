/**
 * Export script — dumps reasoning_events from pgvector back to a
 * forgeflow-memory archive JSON file ready for POST /ingest.
 *
 * Usage:
 *   npm run export                          # exports all rows
 *   npm run export -- --scenario scenario_abc123  # filter by scenarioId
 *   npm run export -- --output my-file.json       # custom output path
 *
 * Output file shape: { "archive": ReasoningEvent[] }
 * Drop it straight into: curl -X POST http://localhost:3001/ingest -d @<file>
 */

import 'dotenv/config';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import db from '../src/store/client.js';
import type { ReasoningEvent } from '../src/types.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const scenarioFilter = getArg('--scenario');
const outputArg      = getArg('--output');

// ── Query ─────────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  scenario_id: string;
  node_id: string;
  cycle: number;
  event_type: string;
  mode: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

console.log('\nForgeFlow Memory — Export');
console.log('─'.repeat(40));

if (scenarioFilter) {
  console.log(`Filter: scenarioId = ${scenarioFilter}`);
} else {
  console.log('Filter: none (exporting all rows)');
}

const rows = scenarioFilter
  ? await db<EventRow[]>`
      SELECT id, scenario_id, node_id, cycle, event_type, mode, content, metadata, created_at
      FROM reasoning_events
      WHERE scenario_id = ${scenarioFilter}
      ORDER BY created_at ASC
    `
  : await db<EventRow[]>`
      SELECT id, scenario_id, node_id, cycle, event_type, mode, content, metadata, created_at
      FROM reasoning_events
      ORDER BY created_at ASC
    `;

if (rows.length === 0) {
  console.log('\nNo rows found. Nothing to export.');
  await db.end();
  process.exit(0);
}

// ── Transform to ReasoningEvent[] ─────────────────────────────────────────────

const archive: ReasoningEvent[] = rows.map(row => ({
  scenarioId: row.scenario_id,
  nodeId:     row.node_id,
  cycle:      row.cycle,
  eventType:  row.event_type as ReasoningEvent['eventType'],
  mode:       row.mode as ReasoningEvent['mode'],
  content:    row.content,
  metadata:   row.metadata ?? undefined,
}));

// ── Write file ────────────────────────────────────────────────────────────────

const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix     = scenarioFilter ? `${scenarioFilter}-` : '';
const filename   = outputArg ?? `forgeflow-memory-export-${suffix}${timestamp}.json`;
const outputPath = outputArg ? filename : join(process.cwd(), 'data', filename);

const payload = JSON.stringify({ archive }, null, 2);
await writeFile(outputPath, payload, 'utf-8');

const sizeKb = (Buffer.byteLength(payload) / 1024).toFixed(1);

console.log(`\nExported ${archive.length} events → ${outputPath}`);
console.log(`File size: ${sizeKb} KB`);

// Summary by scenario
const byScenario = archive.reduce<Record<string, number>>((acc, e) => {
  acc[e.scenarioId] = (acc[e.scenarioId] ?? 0) + 1;
  return acc;
}, {});

console.log('\nBreakdown by scenario:');
for (const [id, count] of Object.entries(byScenario)) {
  console.log(`  ${id}: ${count} events`);
}

await db.end();
process.exit(0);
