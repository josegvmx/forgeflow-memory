import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReasoningEvent } from '../src/types.js';

// ── Mocks: no embedder or DB calls ────────────────────────────────────────────
// embedMany returns one vector per text, tagged with the call number so tests can see where a vector came from.
let embedCalls: string[][] = [];
const mockEmbedMany = vi.fn(async (texts: string[]) => { embedCalls.push(texts); return texts.map(() => new Array(1536).fill(embedCalls.length)); });
const mockUpsertEvents       = vi.fn(async (_events: unknown[]) => {});
const mockFindExistingHashes = vi.fn(async () => new Set<string>());
const cache = new Map<string, number[]>();
const mockPutCached = vi.fn(async (_m: string, entries: Array<{ hash: string; embedding: number[] }>) => { for (const e of entries) cache.set(e.hash, e.embedding); });

vi.mock('../src/ingest/embedder.js', () => ({ embedMany: mockEmbedMany, embeddingModel: () => 'test-model', EMBED_BATCH: 2 }));
vi.mock('../src/store/upsert.js', () => ({
  upsertEvents:       mockUpsertEvents,
  findExistingHashes: mockFindExistingHashes,
}));
vi.mock('../src/store/embeddingCache.js', () => ({
  getCachedEmbeddings: vi.fn(async (_m: string, hashes: string[]) => new Map(hashes.filter(h => cache.has(h)).map(h => [h, cache.get(h)!]))),
  putCachedEmbeddings: mockPutCached,
}));

const embedded = () => embedCalls.flat().length;
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
  embedCalls = [];
  cache.clear();
  mockEmbedMany.mockClear();
  mockPutCached.mockClear();
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
    expect(stats).toMatchObject({ inserted: 2, skipped: 2, embedded: 2, cached: 0 });
    expect(embedded()).toBe(2);
    expect(mockUpsertEvents.mock.calls[0][0]).toHaveLength(2);
  });

  it('skips events already in the store before embedding them', async () => {
    mockFindExistingHashes.mockResolvedValue(new Set([eventHash(ev())]));
    const stats = await ingestArchive([ev(), ev({ cycle: 61 })]);
    expect(stats).toMatchObject({ inserted: 1, skipped: 1, embedded: 1 });
    expect(embedded()).toBe(1);
  });

  it('costs nothing when re-ingesting an archive that is fully stored', async () => {
    const archive = [ev(), ev({ cycle: 61 })];
    mockFindExistingHashes.mockResolvedValue(new Set(archive.map(eventHash)));
    const stats = await ingestArchive(archive);
    expect(stats).toMatchObject({ inserted: 0, skipped: 2 });
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(mockUpsertEvents).not.toHaveBeenCalled();
  });

  it('ingestEvent is a no-op for an already-stored event', async () => {
    mockFindExistingHashes.mockResolvedValue(new Set([eventHash(ev())]));
    expect(await ingestEvent(ev())).toMatchObject({ inserted: 0, skipped: 1 });
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});

describe('ingestArchive embedding cache (R14 phase 3)', () => {
  const runA = '0ff8a7ab-5933-8e2c-8229-0ce22cbfa597';
  const runB = 'ae6b1428-02de-8853-80c3-6fb3306c2205';

  it('the same text in two runs is two events but one embedding', async () => {
    const stats = await ingestArchive([ev({ runId: runA }), ev({ runId: runB })]);
    expect(stats).toMatchObject({ inserted: 2, skipped: 0, embedded: 1, cached: 0 });
    const stored = mockUpsertEvents.mock.calls[0][0] as Array<{ embedding: number[]; embedTextHash: string }>;
    expect(stored[0].embedTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[1].embedTextHash).toBe(stored[0].embedTextHash);
    expect(stored[1].embedding).toBe(stored[0].embedding);
  });

  it('a text already cached is not embedded again (later import, other run)', async () => {
    await ingestArchive([ev({ runId: runA })]);
    embedCalls = [];
    const stats = await ingestArchive([ev({ runId: runB })]);
    expect(stats).toMatchObject({ inserted: 1, embedded: 0, cached: 1 });
    expect(mockEmbedMany).toHaveBeenCalledTimes(1); // only the first import
    expect((mockUpsertEvents.mock.calls[1][0] as Array<{ embedding: number[] }>)[0].embedding[0]).toBe(1); // vector from call 1
  });

  it('embeds EMBED_BATCH texts per request and caches after each request', async () => {
    const stats = await ingestArchive([1, 2, 3, 4, 5].map(cycle => ev({ cycle })));
    expect(stats).toMatchObject({ inserted: 5, embedded: 5 });
    expect(embedCalls.map(c => c.length)).toEqual([2, 2, 1]);
    expect(mockPutCached).toHaveBeenCalledTimes(3);
    expect((mockUpsertEvents.mock.calls[0][0] as Array<{ embedding: number[] }>).map(e => e.embedding[0])).toEqual([1, 1, 2, 2, 3]);
  });

  it('keeps what was embedded when a later request fails, and stores no events', async () => {
    mockEmbedMany.mockImplementationOnce(async (t: string[]) => { embedCalls.push(t); return t.map(() => new Array(1536).fill(1)); })
      .mockImplementationOnce(async () => { throw new Error('rate limited'); });
    await expect(ingestArchive([1, 2, 3].map(cycle => ev({ cycle })))).rejects.toThrow('rate limited');
    expect(cache.size).toBe(2);
    expect(mockUpsertEvents).not.toHaveBeenCalled();
    // Retry: only the text that failed is embedded.
    embedCalls = [];
    expect(await ingestArchive([1, 2, 3].map(cycle => ev({ cycle })))).toMatchObject({ inserted: 3, embedded: 1, cached: 2 });
  });
});
