import { describe, it, expect } from 'vitest';
import { isScenarioId, isCanonicalScenarioId, ScenarioIdSchema } from '../src/audit/scenarioId.js';

// R14 §4.2: the service accepts forgeflow-sim's scenarioId as given and no longer computes one.
describe('scenarioId format', () => {
  it('accepts the sim canonical form (16 lowercase hex)', () => {
    for (const id of ['6514fc6232151a5c', '91e948b60ff71b98', '0000000000000000']) {
      expect(isCanonicalScenarioId(id)).toBe(true);
      expect(isScenarioId(id)).toBe(true);
    }
  });
  it('accepts legacy ids already stored (scenario_ / scenario- prefix)', () => {
    for (const id of ['scenario_demo_001', 'scenario_eval_001', 'scenario-beta-002', 'scenario_abc']) {
      expect(isCanonicalScenarioId(id)).toBe(false);
      expect(isScenarioId(id)).toBe(true);
    }
  });
  it('rejects anything else', () => {
    for (const id of ['', '6514FC6232151A5C', '6514fc6232151a5', 'scenario', 'scenario_', 'x', 'scenario_a b', 'scenario_a;b', `scenario_${'a'.repeat(56)}`, 42, null]) {
      expect(isScenarioId(id)).toBe(false);
    }
  });
  it('schema gives a message naming the sim', () => {
    const r = ScenarioIdSchema.safeParse('nope');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain('forgeflow-sim');
  });
});
