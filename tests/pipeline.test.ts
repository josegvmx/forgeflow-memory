import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReasoningEvent } from '../src/types.js';

// ── Mocks: no embedder or DB calls ────────────────────────────────────────────
const mockEmbed              = vi.fn(async () => new Array(1536).fill(0));
const mockUpsertEvents       = vi.fn(async (_events: unknown[]) => {});
const mockFindExistingHashes = vi.fn(async () => new Set<string>());

vi.mock('../src/ingest/embedder.js', () => ({ embed: mockEmbed }));
vi.mock('../src/store/upsert.js', () => ({
  upsertEvents:       mockUpsertEvents,
  findExistingHashes: mockFindExistingHashes,
}));

const { ingestArchive, ingestEvent } = await import('../src/ingest/pipeline.js');
const { eventHash } = await import('../src/store/eventHash.js');

const ev = (over: Partial<ReasoningEvent> = {}): ReasoningEvent => ({
  scenarioId: 'scenario_demo_001',
  nodeId:     'transportation',
  cycle:      60,
  eventType:  'routing_adjustment',
  mode:       'heuristic',
  content:    'Routed P_BETA to M5 (heuristic)',
  metadata:   { productIds: ['P_BETA'] },
  ...over,
});

beforeEach(() => {
  mockEmbed.mockClear();
  mockUpsertEvents.mockClear();
  mockFindExistingHashes.mockReset().mockResolvedValue(new Set());
});

describe('eventHash', () => {
  it('is stable and ignores metadata', () => {
    expect(eventHash(ev())).toBe(eventHash(ev({ metadata: { other: true } })));
    expect(eventHash(ev())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when any identity field differs', () => {
    const base = eventHash(ev());
    for (const over of [{ scenarioId: 'x' }, { nodeId: 'x' }, { cycle: 61 }, { eventType: 'decision' as const }, { mode: 'ai' as const }, { content: 'x' }]) {
      expect(eventHash(ev(over))).not.toBe(base);
    }
  });

  it('R14: without a runId the hash is the pre-R14 formula (stored rows keep their hash)', async () => {
    const { createHash } = await import('node:crypto');
    const e = ev();
    const legacy = createHash('sha256').update([e.scenarioId, e.nodeId, String(e.cycle), e.eventType, e.mode, e.content].join('|'), 'utf8').digest('hex');
    expect(eventHash(e)).toBe(legacy);
  });

  it('R14: the same event in two runs is two events', () => {
    const a = eventHash(ev({ runId: '0ff8a7ab-5933-8e2c-8229-0ce22cbfa597' }));
    const b = eventHash(ev({ runId: 'ae6b1428-02de-8853-80c3-6fb3306c2205' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(eventHash(ev()));
  });
});

describe('ingestArchive de-duplication', () => {
  it('embeds and stores repeated events in a batch only once', async () => {
    const stats = await ingestArchive([ev(), ev(), ev({ metadata: { x: 1 } }), ev({ cycle: 61 })]);
    expect(stats).toEqual({ inserted: 2, skipped: 2 });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    expect(mockUpsertEvents.mock.calls[0][0]).toHaveLength(2);
  });

  it('skips events already in the store before embedding them', async () => {
    mockFindExistingHashes.mockResolvedValue(new Set([eventHash(ev())]));
    const stats = await ingestArchive([ev(), ev({ cycle: 61 })]);
    expect(stats).toEqual({ inserted: 1, skipped: 1 });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('costs nothing when re-ingesting an archive that is fully stored', async () => {
    const archive = [ev(), ev({ cycle: 61 })];
    mockFindExistingHashes.mockResolvedValue(new Set(archive.map(eventHash)));
    const stats = await ingestArchive(archive);
    expect(stats).toEqual({ inserted: 0, skipped: 2 });
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockUpsertEvents).not.toHaveBeenCalled();
  });

  it('ingestEvent is a no-op for an already-stored event', async () => {
    mockFindExistingHashes.mockResolvedValue(new Set([eventHash(ev())]));
    expect(await ingestEvent(ev())).toEqual({ inserted: 0, skipped: 1 });
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
