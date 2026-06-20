import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MachineFailureEvent } from '../src/audit/events.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetCached     = vi.fn();
const mockSetCached     = vi.fn();
const mockQueryMemory   = vi.fn();

vi.mock('../src/store/recommendationCache.js', () => ({
  getCachedRecommendation: mockGetCached,
  setCachedRecommendation: mockSetCached,
}));

vi.mock('../src/retrieval/query.js', () => ({
  queryMemory: mockQueryMemory,
}));

// Import AFTER mocks are registered
const { getFailureRecommendation, compareModesForScenario } = await import('../src/audit/recommend.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const failure: MachineFailureEvent = {
  scenarioId: 'scenario_abc',
  nodeId:     'machine-M1',
  cycle:      5,
  mode:       'ai',
  content:    'M1 failed.',
  metadata: {
    machineId:        'M1',
    failureType:      'breakdown',
    affectedCapacity: 60,
    affectedProducts: ['P1', 'P2'],
  },
};

const ragSummary = 'Reroute P1 to M2, P2 to M3. Expected 10-cycle recovery.';

// ── getFailureRecommendation ──────────────────────────────────────────────────

describe('getFailureRecommendation — cache hit', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCached.mockReset();
    mockQueryMemory.mockReset();
  });

  it('returns cached recommendation with fromCache: true', async () => {
    mockGetCached.mockResolvedValue('Cached advice.');
    const result = await getFailureRecommendation(failure);
    expect(result).toEqual({ recommendation: 'Cached advice.', fromCache: true });
  });

  it('does not call queryMemory on cache hit', async () => {
    mockGetCached.mockResolvedValue('Cached advice.');
    await getFailureRecommendation(failure);
    expect(mockQueryMemory).not.toHaveBeenCalled();
  });

  it('does not call setCachedRecommendation on cache hit', async () => {
    mockGetCached.mockResolvedValue('Cached advice.');
    await getFailureRecommendation(failure);
    expect(mockSetCached).not.toHaveBeenCalled();
  });
});

describe('getFailureRecommendation — cache miss', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCached.mockReset();
    mockQueryMemory.mockReset();
    mockGetCached.mockResolvedValue(null);
    mockQueryMemory.mockResolvedValue({ events: [], summary: ragSummary });
    mockSetCached.mockResolvedValue(undefined);
  });

  it('returns RAG summary with fromCache: false', async () => {
    const result = await getFailureRecommendation(failure);
    expect(result).toEqual({ recommendation: ragSummary, fromCache: false });
  });

  it('calls queryMemory once', async () => {
    await getFailureRecommendation(failure);
    expect(mockQueryMemory).toHaveBeenCalledTimes(1);
  });

  it('stores the result in cache after RAG', async () => {
    await getFailureRecommendation(failure);
    expect(mockSetCached).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId:  'scenario_abc',
        machineId:   'M1',
        failureType: 'breakdown',
        mode:        'ai',
      }),
      ragSummary
    );
  });

  it('passes correct eventTypeFilter to queryMemory', async () => {
    await getFailureRecommendation(failure);
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.eventTypeFilter).toContain('machine_failure');
    expect(call.eventTypeFilter).toContain('routing_adjustment');
    expect(call.eventTypeFilter).toContain('recovery');
  });
});

describe('getFailureRecommendation — skipCache option', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCached.mockReset();
    mockQueryMemory.mockReset();
    mockQueryMemory.mockResolvedValue({ events: [], summary: ragSummary });
    mockSetCached.mockResolvedValue(undefined);
  });

  it('skips cache lookup when skipCache: true', async () => {
    await getFailureRecommendation(failure, { skipCache: true });
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it('still runs RAG and stores result when skipCache: true', async () => {
    const result = await getFailureRecommendation(failure, { skipCache: true });
    expect(mockQueryMemory).toHaveBeenCalledTimes(1);
    expect(mockSetCached).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });
});

describe('getFailureRecommendation — scopeToScenario option', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockQueryMemory.mockReset();
    mockSetCached.mockReset();
    mockGetCached.mockResolvedValue(null);
    mockQueryMemory.mockResolvedValue({ events: [], summary: ragSummary });
    mockSetCached.mockResolvedValue(undefined);
  });

  it('passes scenarioId to queryMemory when scopeToScenario: true', async () => {
    await getFailureRecommendation(failure, { scopeToScenario: true });
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.scenarioId).toBe('scenario_abc');
  });

  it('does not pass scenarioId when scopeToScenario is false/undefined', async () => {
    await getFailureRecommendation(failure);
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.scenarioId).toBeUndefined();
  });
});

// ── compareModesForScenario ───────────────────────────────────────────────────

describe('compareModesForScenario', () => {
  beforeEach(() => {
    mockQueryMemory.mockReset();
  });

  it('returns the summary string from queryMemory', async () => {
    mockQueryMemory.mockResolvedValue({ events: [], summary: 'AI outperformed heuristic.' });
    const result = await compareModesForScenario('scenario_abc');
    expect(result).toBe('AI outperformed heuristic.');
  });

  it('scopes the query to the given scenarioId', async () => {
    mockQueryMemory.mockResolvedValue({ events: [], summary: 'ok' });
    await compareModesForScenario('scenario_xyz');
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.scenarioId).toBe('scenario_xyz');
  });

  it('filters for recovery and routing_adjustment events', async () => {
    mockQueryMemory.mockResolvedValue({ events: [], summary: 'ok' });
    await compareModesForScenario('scenario_abc');
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.eventTypeFilter).toContain('recovery');
    expect(call.eventTypeFilter).toContain('routing_adjustment');
  });

  it('requests topK 20', async () => {
    mockQueryMemory.mockResolvedValue({ events: [], summary: 'ok' });
    await compareModesForScenario('scenario_abc');
    const call = mockQueryMemory.mock.calls[0][0];
    expect(call.topK).toBe(20);
  });
});
