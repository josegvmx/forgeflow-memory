import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(new URL('../src/store/schema.sql', import.meta.url), 'utf8');

describe('schema.sql (applied on every start, so it must be idempotent)', () => {
  it('only creates or adds things with IF NOT EXISTS', () => {
    const creates = sql.match(/^\s*(CREATE (TABLE|INDEX|UNIQUE INDEX|EXTENSION)|ALTER TABLE \w+ ADD COLUMN)\b.*$/gm) ?? [];
    expect(creates.length).toBeGreaterThan(5);
    for (const line of creates) expect(line).toMatch(/IF NOT EXISTS/);
  });

  it('full-text column is generated from content (no backfill code) with a GIN index', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS content_tsv tsvector\s+GENERATED ALWAYS AS \(to_tsvector\('english', content\)\) STORED/);
    expect(sql).toMatch(/reasoning_events_content_tsv_idx\s+ON reasoning_events USING gin \(content_tsv\)/);
  });

  it('no code reads reasoning_events with SELECT * (content_tsv stays out of responses)', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
    walk(new URL('../src', import.meta.url).pathname); walk(new URL('../scripts', import.meta.url).pathname);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/SELECT\s+\*/i);
  });
});
