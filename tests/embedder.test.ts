import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embedMany, embedManyWith, embed, embeddingModel, EMBED_BATCH } from '../src/ingest/embedder.js';

const vec = (x: number) => new Array(1536).fill(x);
let bodies: any[] = [];

beforeEach(() => {
  bodies = [];
  vi.stubEnv('VOYAGE_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // Reply out of order: the embedder must order by index.
    const data = body.input.map((t: string, index: number) => ({ index, embedding: vec(Number(t)) })).reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('embedder (R14 phase 3: batched)', () => {
  it('picks the model from the key present (Voyage first)', () => {
    expect(embeddingModel()).toBe('text-embedding-3-small');
    vi.stubEnv('VOYAGE_API_KEY', 'v');
    expect(embeddingModel()).toBe('voyage-code-2');
  });

  it('sends EMBED_BATCH texts per request and returns vectors in input order', async () => {
    const texts = Array.from({ length: EMBED_BATCH + 3 }, (_, i) => String(i));
    const out = await embedMany(texts);
    expect(bodies.map(b => b.input.length)).toEqual([EMBED_BATCH, 3]);
    expect(bodies[0].model).toBe('text-embedding-3-small');
    expect(out.map(v => v[0])).toEqual(texts.map(Number));
  });

  it('embed(text) is one request with one input', async () => {
    expect((await embed('7'))[0]).toBe(7);
    expect(bodies).toEqual([{ model: 'text-embedding-3-small', input: ['7'] }]);
  });

  it('embedManyWith uses the named model and its own key, whatever the default is', async () => {
    vi.stubEnv('VOYAGE_API_KEY', 'v-key');
    await embedManyWith('text-embedding-3-small', ['1']);
    expect(bodies.at(-1).model).toBe('text-embedding-3-small');
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls;
    expect(calls.at(-1)![0]).toContain('openai.com');
    expect(calls.at(-1)![1].headers.Authorization).toBe('Bearer test-key');
    await embedManyWith('voyage-code-2', ['2']);
    expect(calls.at(-1)![0]).toContain('voyageai.com');
    expect(calls.at(-1)![1].headers.Authorization).toBe('Bearer v-key');
  });

  it('says which key a model needs when it is missing', async () => {
    await expect(embedManyWith('voyage-code-2', ['1'])).rejects.toThrow('voyage-code-2 needs VOYAGE_API_KEY');
  });

  it('refuses a reply with the wrong number or size of vectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 })));
    await expect(embedMany(['1'])).rejects.toThrow(/expected 1536 dims/);
  });

  it('reports a provider error without the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    await expect(embedMany(['1'])).rejects.toThrow(/OpenAI embedding failed \(429\): quota exceeded/);
  });
});
