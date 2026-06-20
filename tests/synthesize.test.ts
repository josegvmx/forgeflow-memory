import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReasoningEvent } from '../src/types.js';

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

// Import AFTER mock is registered
const { synthesize } = await import('../src/retrieval/synthesize.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const event: ReasoningEvent = {
  scenarioId: 'scenario_abc',
  nodeId:     'machine-M1',
  cycle:      5,
  eventType:  'machine_failure',
  mode:       'ai',
  content:    'M1 failed at cycle 5.',
};

function makeAnthropicResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('synthesize — empty events', () => {
  it('returns a no-events message without calling any LLM', async () => {
    const result = await synthesize('what happened?', []);
    expect(result).toContain('No relevant events found');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('synthesize — Anthropic provider (default)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.SYNTHESIS_PROVIDER;
  });

  it('calls Anthropic messages.create with the question', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('Reroute to M2.'));
    await synthesize('what should we do?', [event]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('what should we do?');
  });

  it('includes event content in the context sent to Anthropic', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('ok'));
    await synthesize('summarize', [event]);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('M1 failed at cycle 5.');
  });

  it('returns the text from Claude response', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('Use M2 as backup.'));
    const result = await synthesize('advice?', [event]);
    expect(result).toBe('Use M2 as backup.');
  });

  it('uses claude-haiku model', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('ok'));
    await synthesize('q', [event]);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toContain('haiku');
  });

  it('throws when Anthropic returns non-text block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x' }] });
    await expect(synthesize('q', [event])).rejects.toThrow('Unexpected response type');
  });
});

describe('synthesize — Ollama provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockCreate.mockReset();
    process.env.SYNTHESIS_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL    = 'http://localhost:11434';
    process.env.OLLAMA_MODEL       = 'llama3.2';
  });

  afterEach(() => {
    delete process.env.SYNTHESIS_PROVIDER;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    global.fetch = originalFetch;
  });

  it('calls the Ollama /api/chat endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ message: { content: 'Ollama advice.' } }),
    });
    global.fetch = mockFetch as typeof fetch;

    const result = await synthesize('what to do?', [event]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/api/chat');
    expect(result).toBe('Ollama advice.');
  });

  it('includes question in the user message sent to Ollama', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ message: { content: 'ok' } }),
    });
    global.fetch = mockFetch as typeof fetch;

    await synthesize('specific question here', [event]);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    const userMsg = body.messages.find((m) => m.content.includes('specific question here'));
    expect(userMsg).toBeTruthy();
  });

  it('throws on non-ok Ollama response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok:   false,
      status: 503,
      text: async () => 'Service unavailable',
    });
    global.fetch = mockFetch as typeof fetch;

    await expect(synthesize('q', [event])).rejects.toThrow('Ollama synthesis failed (503)');
  });

  it('does not call Anthropic when provider is ollama', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ message: { content: 'ok' } }),
    });
    global.fetch = mockFetch as typeof fetch;

    await synthesize('q', [event]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('synthesize — context building', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.SYNTHESIS_PROVIDER;
  });

  it('includes all events in the context', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('ok'));
    const events: ReasoningEvent[] = [
      { ...event, nodeId: 'machine-A', content: 'Event A content' },
      { ...event, nodeId: 'machine-B', content: 'Event B content' },
    ];
    await synthesize('q', events);
    const call = mockCreate.mock.calls[0][0];
    const content = call.messages[0].content as string;
    expect(content).toContain('Event A content');
    expect(content).toContain('Event B content');
  });

  it('numbers events starting from 1', async () => {
    mockCreate.mockResolvedValue(makeAnthropicResponse('ok'));
    await synthesize('q', [event]);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('[1]');
  });
});
