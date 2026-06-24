/**
 * migrate.ts
 * Applies src/store/schema.sql using the postgres.js client.
 * No psql binary required — works in Alpine Docker containers.
 */

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from '../src/store/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sql = await readFile(join(__dirname, '../src/store/schema.sql'), 'utf-8');

console.log('[migrate] Applying schema...');
await db.unsafe(sql);
console.log('[migrate] Done.');
await db.end();
