/**
 * Build the retrieval golden set from a forgeflow-sim eval export (R14 phase 3, step 6).
 *   npm run golden:build -- [<export dir>] [--out tests/evals/fixtures/golden-sim.json]
 * Deterministic: the same export gives the same file. See src/eval/goldenSim.ts for the rules.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readSimExport } from '../src/import/simExport.js';
import { buildGoldenSimSet } from '../src/eval/goldenSim.js';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const out = resolve(process.cwd(), oi >= 0 ? argv[oi + 1] : 'tests/evals/fixtures/golden-sim.json');
const dir = resolve(process.cwd(), argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out') ?? '../forgeflow-sim/eval/export');

const set = buildGoldenSimSet(readSimExport(dir), {
  // The simple scenario file has no name; its runs carry job names (fixed in forgeflow-sim later).
  scenarioNames: { d8a5e11c5a8e2949: 'Simple Bike Line' },
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(set, null, 2) + '\n');
const by = (k: 'style' | 'aspect') => set.queries.reduce<Record<string, number>>((a, q) => ({ ...a, [q[k]]: (a[q[k]] ?? 0) + 1 }), {});
console.log(`${set.queries.length} queries → ${out}`);
console.log('by style ', by('style'));
console.log('by aspect', by('aspect'));
console.log(`ignored runs (no measurable fault effect): ${set.ignoreRunIds.length}`);
