import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatEventForEmbedding, TEXT_VARIANTS } from '../src/ingest/chunker.js';
import { simEpisodeToReasoningEvent, SimEpisodeSchema } from '../src/audit/simEpisode.js';
import { textHash } from '../src/ingest/textHash.js';

const ep = simEpisodeToReasoningEvent(SimEpisodeSchema.parse(JSON.parse(
  readFileSync(new URL('./fixtures/sim-export/part-1-of-1/episodes.jsonl', import.meta.url), 'utf8').split('\n')[0])));

describe('embedding text variants (R14 phase 3)', () => {
  it('default is exactly what the store embeds (stored embed_text_hash stays valid)', () => {
    expect(formatEventForEmbedding(ep, 'default')).toBe(formatEventForEmbedding(ep));
    expect(formatEventForEmbedding(ep)).toMatch(/^Scenario: [0-9a-f]{16}\nNode: /);
  });

  it('no-scenario drops only the scenario line', () => {
    const d = formatEventForEmbedding(ep).split('\n');
    expect(formatEventForEmbedding(ep, 'no-scenario').split('\n')).toEqual(d.slice(1));
  });

  it('content-only is the sentence alone', () => {
    expect(formatEventForEmbedding(ep, 'content-only')).toBe(ep.content);
  });

  it('every variant gives a different text, so a different cache entry', () => {
    expect(new Set(TEXT_VARIANTS.map(v => textHash(formatEventForEmbedding(ep, v)))).size).toBe(TEXT_VARIANTS.length);
  });

  it('no variant embeds the answer key (fault.* labels) or the source', () => {
    for (const v of TEXT_VARIANTS) expect(formatEventForEmbedding(ep, v)).not.toMatch(/fault\.|source:/);
  });

  it('schema.sql has event_text_variants keyed by (event, variant), cascading with the event', () => {
    const sql = readFileSync(new URL('../src/store/schema.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS event_text_variants[\s\S]*REFERENCES reasoning_events\(id\) ON DELETE CASCADE[\s\S]*PRIMARY KEY \(event_id, variant\)/);
  });
});
