import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from '../src/api/rateLimit.js';

function makeApp() {
  const app = new Hono();
  app.use('/llm', rateLimit({
    perIpLimit: 2,
    globalDailyLimit: 1000,
    skip: async (c) => (await c.req.json().catch(() => ({}))).cached === true,
  }));
  // The route must still be able to read the body after skip() parsed it.
  app.post('/llm', async (c) => c.json(await c.req.json()));
  return app;
}

const call = (app: Hono, ip: string, body: unknown) =>
  app.request('/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

describe('rateLimit', () => {
  it('blocks requests over the per-IP limit', async () => {
    const app = makeApp();
    expect((await call(app, '10.0.0.1', {})).status).toBe(200);
    expect((await call(app, '10.0.0.1', {})).status).toBe(200);
    expect((await call(app, '10.0.0.1', {})).status).toBe(429);
  });

  it('does not count skipped requests, and the route can still read the body', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await call(app, '10.0.0.2', { cached: true, n: i });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cached: true, n: i });
    }
    expect((await call(app, '10.0.0.2', {})).status).toBe(200);
    expect((await call(app, '10.0.0.2', {})).status).toBe(200);
    expect((await call(app, '10.0.0.2', {})).status).toBe(429);
  });
});
