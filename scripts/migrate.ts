/**
 * migrate.ts
 * Applies src/store/schema.sql using the postgres.js client.
 * No psql binary required — works in Alpine Docker containers.
 * Retries while the database isn't reachable yet (Railway's private network at container start);
 * see src/store/migrate.ts. Run by the server in the background once it is listening
 * (src/api/server.ts), and by hand with `npm run db:migrate`. Exits 1 on failure.
 */

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import postgres from 'postgres';
import { applySchema, SESSION_SETTINGS } from '../src/store/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

const sql = await readFile(join(__dirname, '../src/store/schema.sql'), 'utf-8');
// Own short-lived client (one connection, quick connect timeout) — not the app's pooled singleton.
const db = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });

const t0 = Date.now();
console.log('[migrate] Applying schema...');
try {
  const attempts = await applySchema(text => db.unsafe(SESSION_SETTINGS + text), sql);
  console.log(`[migrate] Done in ${Date.now() - t0} ms${attempts > 1 ? ` (after ${attempts} attempts)` : ''}.`);
  await db.end({ timeout: 5 });
} catch {
  await db.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
}
