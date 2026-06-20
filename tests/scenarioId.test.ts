import { describe, it, expect } from 'vitest';
import { generateScenarioId } from '../src/audit/scenarioId.js';
import type { ScenarioConfig } from '../src/audit/scenarioId.js';

const baseConfig: ScenarioConfig = {
  machines:     [{ id: 'M1', capacity: 100, type: 'assembly' }],
  transporters: [{ id: 'T1', speed: 10 }],
  warehouses:   [{ id: 'W1', capacity: 500 }],
  products:     [{ id: 'P1', processingTime: 5 }],
  spareParts:   [{ id: 'SP1', quantity: 20 }],
  mode:         'ai',
};

describe('generateScenarioId', () => {
  it('returns a string prefixed with scenario_', () => {
    const id = generateScenarioId(baseConfig);
    expect(id).toMatch(/^scenario_[a-f0-9]{12}$/);
  });

  it('is deterministic — same config produces same ID', () => {
    const id1 = generateScenarioId(baseConfig);
    const id2 = generateScenarioId(baseConfig);
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different modes', () => {
    const heuristic = generateScenarioId({ ...baseConfig, mode: 'heuristic' });
    const ai        = generateScenarioId({ ...baseConfig, mode: 'ai' });
    expect(heuristic).not.toBe(ai);
  });

  it('produces different IDs when machines differ', () => {
    const id1 = generateScenarioId(baseConfig);
    const id2 = generateScenarioId({
      ...baseConfig,
      machines: [{ id: 'M2', capacity: 200, type: 'welding' }],
    });
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs when a machine capacity changes', () => {
    const id1 = generateScenarioId(baseConfig);
    const id2 = generateScenarioId({
      ...baseConfig,
      machines: [{ id: 'M1', capacity: 999, type: 'assembly' }],
    });
    expect(id1).not.toBe(id2);
  });

  it('is stable across multiple identical deep-copy configs', () => {
    const copy1 = JSON.parse(JSON.stringify(baseConfig)) as ScenarioConfig;
    const copy2 = JSON.parse(JSON.stringify(baseConfig)) as ScenarioConfig;
    expect(generateScenarioId(copy1)).toBe(generateScenarioId(copy2));
  });

  it('hash portion is exactly 12 hex characters', () => {
    const id = generateScenarioId(baseConfig);
    const hash = id.replace('scenario_', '');
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
