import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  MachineFailureEvent,
  RoutingAdjustmentEvent,
  RecoveryOutcomeEvent,
} from '../src/audit/events.js';

// ── Mock the ingest pipeline so we never hit the DB or embedder ───────────────
const mockIngestEvent = vi.fn();

vi.mock('../src/ingest/pipeline.js', () => ({
  ingestEvent: mockIngestEvent,
  ingestArchive: vi.fn(),
}));

// Import AFTER mock is registered
const { ingestAuditEvent } = await import('../src/audit/events.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const failure: MachineFailureEvent = {
  scenarioId: 'scenario_abc',
  nodeId:     'machine-M1',
  cycle:      5,
  mode:       'ai',
  content:    'M1 failed with breakdown.',
  metadata: {
    machineId:        'M1',
    failureType:      'breakdown',
    affectedCapacity: 80,
    affectedProducts: ['P1'],
  },
};

const adjustment: RoutingAdjustmentEvent = {
  scenarioId: 'scenario_abc',
  nodeId:     'machine-M2',
  cycle:      6,
  mode:       'heuristic',
  content:    'Rerouted P1 to M2.',
  metadata: {
    triggeredByFailure:    'M1',
    fromMachine:           'M1',
    toMachine:             'M2',
    productsRerouted:      ['P1'],
    throughputBefore:      100,
    throughputAfter:       75,
    decisionLatencyCycles: 1,
  },
};

const recovery: RecoveryOutcomeEvent = {
  scenarioId: 'scenario_abc',
  nodeId:     'coordinator-C1',
  cycle:      9,
  mode:       'ai',
  content:    'M1 recovered after 4 cycles.',
  metadata: {
    machineId:        'M1',
    cyclesDowntime:   4,
    productionLost:   200,
    recoveryStrategy: 'spare_part_replacement',
    successful:       true,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestAuditEvent — MachineFailureEvent', () => {
  beforeEach(() => mockIngestEvent.mockReset());

  it('calls ingestEvent once', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(failure);
    expect(mockIngestEvent).toHaveBeenCalledTimes(1);
  });

  it('maps eventType to machine_failure', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(failure);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.eventType).toBe('machine_failure');
  });

  it('preserves scenarioId, nodeId, cycle, mode, content', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(failure);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.scenarioId).toBe(failure.scenarioId);
    expect(arg.nodeId).toBe(failure.nodeId);
    expect(arg.cycle).toBe(failure.cycle);
    expect(arg.mode).toBe(failure.mode);
    expect(arg.content).toBe(failure.content);
  });

  it('preserves metadata intact', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(failure);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.metadata).toEqual(failure.metadata);
  });
});

describe('ingestAuditEvent — RoutingAdjustmentEvent', () => {
  beforeEach(() => mockIngestEvent.mockReset());

  it('maps eventType to routing_adjustment', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(adjustment);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.eventType).toBe('routing_adjustment');
  });

  it('preserves all top-level fields', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(adjustment);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.scenarioId).toBe(adjustment.scenarioId);
    expect(arg.mode).toBe('heuristic');
    expect(arg.metadata.triggeredByFailure).toBe('M1');
  });
});

describe('ingestAuditEvent — RecoveryOutcomeEvent', () => {
  beforeEach(() => mockIngestEvent.mockReset());

  it('maps eventType to recovery', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(recovery);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.eventType).toBe('recovery');
  });

  it('passes successful flag in metadata', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(recovery);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.metadata.successful).toBe(true);
  });

  it('preserves cyclesDowntime', async () => {
    mockIngestEvent.mockResolvedValue(undefined);
    await ingestAuditEvent(recovery);
    const arg = mockIngestEvent.mock.calls[0][0];
    expect(arg.metadata.cyclesDowntime).toBe(4);
  });
});

