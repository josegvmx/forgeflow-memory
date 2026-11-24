import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// postgres.js serializes jsonb parameters with JSON.stringify itself. Passing JSON.stringify(obj) into
// a query stores a JSON *string* (double-encoded), so metadata @> {…} never matches. jsonb values must
// go through db.json(obj). Only vectors (pgvector has no serializer in postgres.js) are sent as text.
describe('SQL parameters', () => {
  it('never pre-stringify a value for a SQL template, except vectors', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
    walk(new URL('../src', import.meta.url).pathname);
    walk(new URL('../scripts', import.meta.url).pathname);
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\$\{\s*JSON\.stringify\(/.test(line) && !/embedding/i.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('schema.sql repairs double-encoded jsonb idempotently', () => {
    const sql = readFileSync(new URL('../src/store/schema.sql', import.meta.url), 'utf8');
    for (const [t, c] of [['reasoning_events', 'metadata'], ['runs', 'flags'], ['runs', 'faults']]) {
      expect(sql).toMatch(new RegExp(`UPDATE ${t} SET ${c}\\s*= \\(${c}\\s*#>> '\\{\\}'\\)::jsonb WHERE jsonb_typeof\\(${c}\\)\\s*= 'string'`));
    }
  });
});
