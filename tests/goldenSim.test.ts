import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readSimExport } from '../src/import/simExport.js';
import { buildGoldenSimSet, opWords, shortScenarioName, type GoldenSimSet } from '../src/eval/goldenSim.js';

const sample = readSimExport(new URL('./fixtures/sim-export', import.meta.url).pathname);
/** The committed golden set, built from the full forgeflow-sim export (npm run golden:build). */
const full: GoldenSimSet = JSON.parse(readFileSync(new URL('./evals/fixtures/golden-sim.json', import.meta.url), 'utf8'));

describe('buildGoldenSimSet (from labelled sim runs)', () => {
  it('turns the sample fault run into failure / recovery / reroute questions with label predicates', () => {
    const set = buildGoldenSimSet(sample);
    const fault = set.queries.filter(q => q.aspect !== 'machine-history');
    expect(new Set(fault.map(q => q.aspect))).toEqual(new Set(['failure', 'recovery', 'reroute']));
    expect(new Set(fault.map(q => q.style))).toEqual(new Set(['specific', 'operator', 'vague']));
    for (const q of fault) {
      expect(q.relevant.metadata).toMatchObject({ 'fault.type': 'machine_down', 'fault.target': 'M1_WELD', 'fault.cycle': 5 });
      expect(q.relevantInExport).toBe(1);
    }
    expect(fault.find(q => q.aspect === 'reroute')!.relevant.eventTypes).toEqual(['routing_adjustment']);
  });

  it('ignores runs whose fault had no effect, and builds nothing from them', () => {
    const set = buildGoldenSimSet(sample);
    expect(set.ignoreRunIds).toEqual(sample.manifests[0].noEffectRuns);
    expect(set.queries.some(q => q.relevant.metadata['fault.type'] === 'stock_out')).toBe(false); // the sample's stock-out had no effect
  });

  it('is deterministic', () => {
    expect(buildGoldenSimSet(sample)).toEqual(buildGoldenSimSet(sample));
  });

  it('names scenarios readably', () => {
    expect(shortScenarioName('Apex Cycle Works: High-Performance Factory', 'x')).toBe('Apex Cycle Works');
    expect(shortScenarioName('simple/defaults/bd3/seed1', 'Simple')).toBe('Simple');
    expect(opWords('OP_WELD')).toBe('welding');
    expect(opWords('OP_FOO_BAR')).toBe('foo bar');
  });
});

describe('committed golden set (tests/evals/fixtures/golden-sim.json)', () => {
  it('has 100+ queries with unique ids and questions', () => {
    expect(full.queries.length).toBeGreaterThanOrEqual(100);
    expect(new Set(full.queries.map(q => q.id)).size).toBe(full.queries.length);
    expect(new Set(full.queries.map(q => q.question)).size).toBe(full.queries.length);
  });

  it('never asks about bad_flag (its labels cannot be found from the text)', () => {
    expect(full.queries.some(q => q.relevant.metadata['fault.type'] === 'bad_flag')).toBe(false);
  });

  it('vague questions give no machine id, part id or cycle number', () => {
    for (const q of full.queries.filter(x => x.style === 'vague')) {
      expect(q.question, q.id).not.toMatch(/\b(M\d+_|T\d+_|PART_)\w*|cycle \d+/);
    }
  });

  it('every question names its scenario and every predicate is flat with at least one relevant event', () => {
    const names = new Set(full.queries.map(q => q.question.match(/^(?:In )?([^:,]+)[:,]/)?.[1]));
    expect(names).toEqual(new Set(['Apex Cycle Works', 'Lean Line', 'Simple Bike Line']));
    for (const q of full.queries) {
      expect(q.relevantInExport, q.id).toBeGreaterThan(0);
      for (const v of Object.values(q.relevant.metadata)) expect(typeof v === 'object' ? Array.isArray(v) : true).toBe(true);
    }
  });

  it('covers every aspect and style', () => {
    expect(new Set(full.queries.map(q => q.aspect))).toEqual(new Set(['failure', 'recovery', 'reroute', 'disruption', 'machine-history']));
    expect(new Set(full.queries.map(q => q.style))).toEqual(new Set(['specific', 'operator', 'vague']));
  });
});
