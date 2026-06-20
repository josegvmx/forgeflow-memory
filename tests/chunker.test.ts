import { describe, it, expect } from 'vitest';
import { formatEventForEmbedding, chunkEvents } from '../src/ingest/chunker.js';
import type { ReasoningEvent } from '../src/types.js';

const baseEvent: ReasoningEvent = {
  scenarioId: 'scenario_abc123',
  nodeId:     'machine-A1',
  cycle:      10,
  eventType:  'machine_failure',
  mode:       'heuristic',
  content:    'Machine A1 failed due to overheating.',
};

describe('formatEventForEmbedding', () => {
  it('includes all required labels', () => {
    const text = formatEventForEmbedding(baseEvent);
    expect(text).toContain('Scenario: scenario_abc123');
    expect(text).toContain('Node: machine-A1');
    expect(text).toContain('Cycle: 10');
    expect(text).toContain('Type: machine_failure');
    expect(text).toContain('Mode: heuristic');
    expect(text).toContain('Event: Machine A1 failed due to overheating.');
  });

  it('appends metadata key-value pairs', () => {
    const event: ReasoningEvent = {
      ...baseEvent,
      metadata: { severity: 'high', downtime_cycles: 3 },
    };
    const text = formatEventForEmbedding(event);
    expect(text).toContain('severity: high');
    expect(text).toContain('downtime_cycles: 3');
  });

  it('skips null and undefined metadata values', () => {
    const event: ReasoningEvent = {
      ...baseEvent,
      metadata: { severity: 'high', cause: null as unknown as string, empty: undefined },
    };
    const text = formatEventForEmbedding(event);
    expect(text).toContain('severity: high');
    expect(text).not.toContain('cause:');
    expect(text).not.toContain('empty:');
  });

  it('works with no metadata', () => {
    const text = formatEventForEmbedding(baseEvent);
    expect(text).toBeTruthy();
    expect(text).toContain('Event:');
  });

  it('does not include trailing whitespace on lines', () => {
    const text = formatEventForEmbedding(baseEvent);
    const lines = text.split('\n');
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe('chunkEvents', () => {
  it('returns one chunk per event', () => {
    const events: ReasoningEvent[] = [
      baseEvent,
      { ...baseEvent, nodeId: 'machine-B2', cycle: 11, eventType: 'routing_adjustment' },
    ];
    const chunks = chunkEvents(events);
    expect(chunks).toHaveLength(2);
  });

  it('pairs each event with its formatted text', () => {
    const chunks = chunkEvents([baseEvent]);
    expect(chunks[0].event).toBe(baseEvent);
    expect(chunks[0].text).toContain('machine-A1');
  });

  it('returns empty array for empty input', () => {
    expect(chunkEvents([])).toEqual([]);
  });

  it('each chunk text matches formatEventForEmbedding output', () => {
    const chunks = chunkEvents([baseEvent]);
    expect(chunks[0].text).toBe(formatEventForEmbedding(baseEvent));
  });
});
