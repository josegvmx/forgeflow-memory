/**
 * Import a forgeflow-sim memory export (R14 phase 3) into forgeflow-memory over HTTP.
 *
 *   npm run import:sim -- --url https://forgeflow-memory-production.up.railway.app --dry-run
 *   npm run import:sim -- --url <service> [<dir>] [--batch 500] [--runs-only | --episodes-only]
 *
 * <dir> defaults to ../forgeflow-sim/eval/export. The admin token is read from ADMIN_TOKEN (.env);
 * it is never printed. Everything is validated locally first (src/import/simExport.ts). Then rows go
 * to POST /runs (replaced by run_id) and episodes to POST /ingest (de-duplicated; each distinct
 * embedding text is embedded once, server-side, and cached). Safe to re-run after a failure: what
 * was stored is skipped, what was embedded is reused.
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { readSimExport, batches, importSummary } from '../src/import/simExport.js';

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; if (!v || v.startsWith('--')) { console.error(`${f} needs a value`); process.exit(2); } return v; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--url', '--batch'].includes(argv[i - 1] ?? ''));

const dir = resolve(process.cwd(), positional[0] ?? '../forgeflow-sim/eval/export');
const url = (opt('--url') ?? process.env.MEMORY_URL ?? '').replace(/\/+$/, '');
const batchSize = Number(opt('--batch') ?? 500);
const dryRun = flag('--dry-run');
const doRuns = !flag('--episodes-only');
const doEpisodes = !flag('--runs-only');

if (!url && !dryRun) { console.error('Pass --url <service base URL> (or set MEMORY_URL). Nothing sent.'); process.exit(2); }
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) { console.error('--batch must be 1–1000'); process.exit(2); }

const exp = readSimExport(dir);
const summary = importSummary(exp);
console.log(`Export ${dir}`);
console.log(JSON.stringify(summary, null, 2));
if (dryRun) {
  console.log(`\nDry run: would send ${Math.ceil(exp.runs.length / 1000)} POST /runs and ${Math.ceil(exp.episodes.length / batchSize)} POST /ingest requests${url ? ` to ${url}` : ''}. Nothing sent.`);
  process.exit(0);
}
const token = process.env.ADMIN_TOKEN;
if (!token || token.length < 16) { console.error('ADMIN_TOKEN is not set (or shorter than 16 characters): add it to .env. Nothing sent.'); process.exit(2); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** POST with retries on network errors, 429 and 5xx (2, 4, 8 s); 4xx other than 429 stops the import. */
async function post(path: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let status = 0, text = '';
    try {
      const res = await fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      status = res.status; text = await res.text();
      if (res.ok) return JSON.parse(text);
    } catch (err) {
      text = err instanceof Error ? err.message : String(err);
    }
    const retry = status === 0 || status === 429 || status >= 500;
    if (!retry || attempt >= 3) throw new Error(`POST ${path} failed (${status || 'network'}): ${text.slice(0, 300)}`);
    console.log(`  POST ${path}: ${status || 'network error'}; retrying in ${2 ** (attempt + 1)} s`);
    await sleep(2000 * 2 ** attempt);
  }
}

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const tot = { inserted: 0, updated: 0, ingested: 0, skipped: 0, embedded: 0, cached: 0 };
try {
  if (doRuns) {
    for (const b of batches(exp.runs, 1000)) {
      const r = await post('/runs', { runs: b });
      tot.inserted += r.inserted ?? 0; tot.updated += r.updated ?? 0;
    }
    console.log(`\nRuns: ${tot.inserted} inserted, ${tot.updated} replaced (${secs()})`);
  }
  if (doEpisodes) {
    const bs = batches(exp.episodes, batchSize);
    for (const [i, b] of bs.entries()) {
      const r = await post('/ingest', { archive: b });
      tot.ingested += r.ingested ?? 0; tot.skipped += r.skipped ?? 0; tot.embedded += r.embedded ?? 0; tot.cached += r.cached ?? 0;
      console.log(`  episodes ${Math.min((i + 1) * batchSize, exp.episodes.length)}/${exp.episodes.length}: +${r.ingested} stored, ${r.skipped} already there, ${r.embedded} texts embedded, ${r.cached} from cache (${secs()})`);
    }
    console.log(`\nEpisodes: ${tot.ingested} stored, ${tot.skipped} already there; ${tot.embedded} texts embedded, ${tot.cached} reused (${secs()})`);
  }
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error('Nothing is lost: re-run the same command; stored rows and embedded texts are skipped.');
  process.exit(1);
}
console.log(`✓ Import done (sim ${exp.simCommit}).`);
