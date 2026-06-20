import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent } from '../src/audit/events.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const failure: MachineFailureEvent = {
  scenarioId: 'scenario_abc123',
  nodeId:     'machine-M1',
  cycle:      10,
  mode:       'ai',
  content:    'Machine M1 failed at cycle 10. Capacity lost: 60%.',
  metadata: {
    machineId:        'M1',
    failureType:      'breakdown',
    affectedCapacity: 60,
    affectedProducts: ['P1', 'P2'],
  },
};

const adjustment: RoutingAdjustmentEvent = {
  scenarioId: 'scenario_abc123',
  nodeId:     'machine-M2',
  cycle:      11,
  mode:       'ai',
  content:    'Rerouted P1 from M1 to M2.',
  metadata: {
    triggeredByFailure:    'M1',
    fromMachine:           'M1',
    toMachine:             'M2',
    productsRerouted:      ['P1'],
    throughputBefore:      100,
    throughputAfter:       80,
    decisionLatencyCycles: 1,
  },
};

const outcome: RecoveryOutcomeEvent = {
  scenarioId: 'scenario_abc123',
  nodeId:     'coordinator-C1',
  cycle:      14,
  mode:       'ai',
  content:    'M1 recovered after 4 cycles.',
  metadata: {
    machineId:        'M1',
    cyclesDowntime:   4,
    productionLost:   120,
    recoveryStrategy: 'spare_part_replacement',
    successful:       true,
  },
};

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

// Import AFTER mock is set up
const { auditFailureResponse } = await import('../src/audit/audit.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClaudeResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

const validAuditJson = JSON.stringify({
  consistent:       true,
  expectedBehavior: 'AI should dynamically optimise routing.',
  actualBehavior:   'Agent rerouted dynamically with 1-cycle latency.',
  deviations:       [],
  score:            0.9,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auditFailureResponse', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns a valid AuditResult on clean JSON response', async () => {
    mockCreate.mockResolvedValue(makeClaudeResponse(validAuditJson));

    const result = await auditFailureResponse(failure, [adjustment], outcome);

    expect(result.scenarioId).toBe('scenario_abc123');
    expect(result.failureId).toBe('M1_cycle10');
    expect(result.mode).toBe('ai');
    expect(result.consistent).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.deviations).toEqual([]);
  });

  it('strips markdown code fences from Claude response', async () => {
    const wrapped = '```json\n' + validAuditJson + '\n```';
    mockCreate.mockResolvedValue(makeClaudeResponse(wrapped));

    const result = await auditFailureResponse(failure, [adjustment], outcome);
    expect(result.score).toBe(0.9);
  });

  it('strips plain ``` fences without json tag', async () => {
    const wrapped = '```\n' + validAuditJson + '\n```';
    mockCreate.mockResolvedValue(makeClaudeResponse(wrapped));

    const result = await auditFailureResponse(failure, [adjustment], outcome);
    expect(result.consistent).toBe(true);
  });

  it('throws on invalid JSON', async () => {
    mockCreate.mockResolvedValue(makeClaudeResponse('not json at all'));
    await expect(auditFailureResponse(failure, [adjustment], outcome))
      .rejects.toThrow('Claude returned invalid JSON for audit');
  });

  it('works with empty adjustments array', async () => {
    mockCreate.mockResolvedValue(makeClaudeResponse(validAuditJson));
    const result = await auditFailureResponse(failure, [], outcome);
    expect(result.failureId).toBe('M1_cycle10');
  });

  it('sets failureId as machineId_cycleN', async () => {
    mockCreate.mockResolvedValue(makeClaudeResponse(validAuditJson));
    const result = await auditFailureResponse(failure, [], outcome);
    expect(result.failureId).toBe(`${failure.metadata.machineId}_cycle${failure.cycle}`);
  });

  it('passes mode from failure to AuditResult', async () => {
    const heuristicFailure = { ...failure, mode: 'heuristic' as const };
    mockCreate.mockResolvedValue(makeClaudeResponse(validAuditJson));
    const result = await auditFailureResponse(heuristicFailure, [], outcome);
    expect(result.mode).toBe('heuristic');
  });

  it('includes deviations when Claude returns them', async () => {
    const withDeviations = JSON.stringify({
      consistent:       false,
      expectedBehavior: 'AI should optimise dynamically.',
      actualBehavior:   'Agent used fixed routing rules.',
      deviations:       ['Used fixed routing instead of dynamic', 'No throughput optimisation'],
      score:            0.2,
    });
    mockCreate.mockResolvedValue(makeClaudeResponse(withDeviations));

    const result = await auditFailureResponse(failure, [], outcome);
    expect(result.consistent).toBe(false);
    expect(result.deviations).toHaveLength(2);
    expect(result.score).toBe(0.2);
  });
});
