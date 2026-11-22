import { describe, it, expect } from 'vitest';
import { applySchema, isRetryable, SESSION_SETTINGS } from '../src/store/migrate.js';

const err = (code: string) => Object.assign(new Error(code), { code });
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

describe('applySchema', () => {
  it('runs once when the database is reachable', async () => {
    const calls: string[] = [];
    expect(await applySchema(async s => { calls.push(s); }, 'SQL', { log: () => {} })).toBe(1);
    expect(calls).toEqual(['SQL']);
  });

  it('retries while the private network is not up yet, then succeeds', async () => {
    const c = clock();
    const seq = [err('ENOTFOUND'), err('ECONNREFUSED'), err('CONNECT_TIMEOUT')];
    const log: string[] = [];
    const attempts = await applySchema(async () => { const e = seq.shift(); if (e) throw e; }, 'SQL', { ...c, log: l => log.push(l) });
    expect(attempts).toBe(4);
    expect(log.filter(l => l.includes('retrying'))).toHaveLength(3);
    expect(c.now()).toBe(1000 + 2000 + 4000); // backoff 1 s, 2 s, 4 s
  });

  it('gives up after maxWaitMs and rethrows', async () => {
    const c = clock();
    await expect(applySchema(async () => { throw err('ENOTFOUND'); }, 'SQL', { ...c, maxWaitMs: 20_000, log: () => {} })).rejects.toThrow('ENOTFOUND');
    expect(c.now()).toBeLessThanOrEqual(20_000);
  });

  it('does not retry SQL errors (or a lock timeout)', async () => {
    let n = 0;
    await expect(applySchema(async () => { n++; throw err('42601'); }, 'SQL', { log: () => {} })).rejects.toThrow();
    expect(n).toBe(1);
    expect(isRetryable(err('55P03'))).toBe(false); // lock_not_available
    expect(isRetryable(err('57P03'))).toBe(true);  // cannot_connect_now (DB starting)
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  it('sets a lock timeout before the schema', () => {
    expect(SESSION_SETTINGS).toMatch(/lock_timeout = '15s'/);
  });
});
