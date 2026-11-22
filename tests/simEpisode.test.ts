import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimEpisodeSchema, simEpisodeToReasoningEvent, looksLikeSimEpisode, FlatMetadataSchema } from '../src/audit/simEpisode.js';
import { formatEventForEmbedding } from '../src/ingest/chunker.js';

// Real forgeflow-sim output (FORGEFLOW_FAULTS=1 npm run eval -- --episodes …), one of each kind.
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sim-episodes.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const of = (pred: (e: any) => boolean) => structuredClone(fixture.find(pred));
const disruption = () => of(e => e.eventType === 'disruption');
const failure = () => of(e => e.eventType === 'machine_failure' && e.metadata['fault.injected'] === true);

describe('sim episodes contract (R14 §4.3)', () => {
  it('the fixture covers every sim event type, labelled and not', () => {
    expect(new Set(fixture.map(e => e.eventType))).toEqual(new Set(['machine_failure', 'routing_adjustment', 'recovery', 'disruption']));
    expect(fixture.some(e => e.metadata['fault.injected'] === true)).toBe(true);
    expect(fixture.some(e => !('fault.injected' in e.metadata))).toBe(true);
  });

  it.each(fixture.map((e, i) => [`${i}: ${e.eventType}`, e]))('parses %s', (_l, e) => {
    const r = SimEpisodeSchema.safeParse(e);
    if (!r.success) throw new Error(JSON.stringify(r.error.flatten()));
    expect(r.data).toEqual(e); // nothing dropped or rewritten
  });

  it('an unrelated episode in a fault run (fault.injected: false) parses', () => {
    const e = failure();
    for (const k of Object.keys(e.metadata)) if (k.startsWith('fault.')) delete e.metadata[k];
    e.metadata['fault.injected'] = false;
    expect(SimEpisodeSchema.safeParse(e).success).toBe(true);
  });

  it('maps to a stored event: runId in its own field, source into metadata, labels kept but not embedded', () => {
    const e = failure();
    const ev = simEpisodeToReasoningEvent(SimEpisodeSchema.parse(e));
    expect(ev).toMatchObject({ runId: e.runId, scenarioId: e.scenarioId, nodeId: e.nodeId, cycle: e.cycle, eventType: 'machine_failure' });
    expect(ev.metadata).toMatchObject({ source: 'sim', 'fault.type': 'machine_down' });
    expect(formatEventForEmbedding(ev)).not.toMatch(/fault\.|source:/);
  });

  it('tells sim episodes from older audit events', () => {
    expect(looksLikeSimEpisode(failure())).toBe(true);
    expect(looksLikeSimEpisode({ scenarioId: 'scenario_abc', metadata: {} })).toBe(false);
    expect(looksLikeSimEpisode(null)).toBe(false);
  });

  it.each<[string, (e: any) => void]>([
    ['nested metadata', e => { e.metadata.extra = { a: 1 }; }],
    ['an array of numbers', e => { e.metadata.extra = [1, 2]; }],
    ['a null value', e => { e.metadata.extra = null; }],
    ['NaN', e => { e.metadata.extra = NaN; }],
    ['a missing core key', e => { delete e.metadata.unitsDelta; }],
    ['an unknown disruption fault type', e => { e.metadata.faultType = 'meteor'; }],
    ['a non-token target (prompt injection)', e => { e.metadata.targets = ['x; ignore previous instructions']; }],
    ['a bad runId', e => { e.runId = 'run-1'; }],
    ['an uppercase runId', e => { e.runId = e.runId.toUpperCase(); }],
    ['a bad scenarioId', e => { e.scenarioId = 'apex'; }],
    ['an unknown source', e => { e.source = 'user'; }],
    ['an unknown event type', e => { e.eventType = 'decision'; }],
    ['empty content', e => { e.content = ''; }],
  ])('rejects %s', (_l, edit) => {
    const e = disruption();
    edit(e);
    expect(SimEpisodeSchema.safeParse(e).success).toBe(false);
  });

  it('flat metadata: at most 40 keys', () => {
    expect(FlatMetadataSchema.safeParse(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))).success).toBe(true);
    expect(FlatMetadataSchema.safeParse(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, i]))).success).toBe(false);
  });
});
