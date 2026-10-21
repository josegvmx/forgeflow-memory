import 'dotenv/config';
import { spawn } from 'child_process';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import ingestRoute from './routes/ingest.js';
import queryRoute from './routes/query.js';
import auditRoute from './routes/audit.js';
import { ValidationError, UpstreamError } from './errors.js';
import { rateLimit } from './rateLimit.js';
import { requireAdminToken, concurrencyLimit } from './security.js';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { hasCachedRecommendation } from '../store/recommendationCache.js';
import type { Context } from 'hono';

const app = new Hono();

// Request logging
app.use('*', logger());

// Baseline security headers (CSP allows only the CDNs the demo page uses)
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdnjs.cloudflare.com'],
    styleSrc:   ["'self'", "'unsafe-inline'"],
    imgSrc:     ["'self'", 'data:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
}));

// Health check — useful for Docker / Railway / Render probes
app.get('/health', (c) => c.json({ status: 'ok' }));

// Serve React demo UI from public/
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

// ── Abuse protection ─────────────────────────────────────────
// Public read endpoints get small bodies, per-IP + global rate limits and a
// cap on concurrent LLM calls. Write / pipeline endpoints require ADMIN_TOKEN
// (disabled entirely when it isn't set). See README → Security.

const tooLarge = (c: Context) => c.json({ error: 'Request body too large' }, 413);
const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge });
const adminBody = bodyLimit({ maxSize: 5 * 1024 * 1024, onError: tooLarge });

// /recommend answers from cache when it can; those requests never reach the
// LLM, so they don't count against the LLM budget.
async function isCachedRecommendation(c: Context): Promise<boolean> {
  if (!c.req.path.startsWith('/recommend')) return false;
  const body = await c.req.json().catch(() => null);
  const f = body?.failure;
  if (!f?.metadata || body.skipCache) return false;
  try {
    return await hasCachedRecommendation({
      scenarioId:  String(f.scenarioId),
      machineId:   String(f.metadata.machineId),
      failureType: String(f.metadata.failureType),
      mode:        f.mode,
    });
  } catch {
    return false;
  }
}

// One shared LLM budget for /query and /recommend:
// 10 requests/IP/hour · 200 requests/day across everyone.
const llmRateLimit = rateLimit({ perIpLimit: 10, globalDailyLimit: 200, skip: isCachedRecommendation });
const llmConcurrency = concurrencyLimit(Number(process.env.MAX_CONCURRENT_LLM ?? 4));
// Cheap DB reads: 30 requests/IP/minute.
const readRateLimit = rateLimit({ perIpLimit: 30, perIpWindowMs: 60_000, globalDailyLimit: 20_000 });
const admin = requireAdminToken();

app.use('/query',     smallBody, llmRateLimit, llmConcurrency);
app.use('/recommend', smallBody, llmRateLimit, llmConcurrency);
app.get('/scenarios/:scenarioId/summary', readRateLimit);

app.use('/ingest',  admin, adminBody);
app.use('/ingest/*', admin, adminBody);
app.on('POST', ['/events', '/scenarios', '/audit'], admin, adminBody);

// Routes
app.route('/ingest', ingestRoute);
app.route('/query', queryRoute);

// Audit routes (includes /events, /audit, /recommend, /scenarios)
app.route('/', auditRoute);

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof UpstreamError)   return c.json({ error: err.message }, 503);
  console.error(err);
  return c.json({ error: 'internal server error' }, 500);
});

const PORT = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`forgeflow-memory listening on http://localhost:${PORT}`);

  // Run migration + seed in the background after the server is up.
  // Spawned as a child process so the healthcheck is never blocked.
  if (process.env.NODE_ENV !== 'test') {
    const child = spawn(
      'tsx',
      ['scripts/migrate.ts', '&&', 'tsx', 'scripts/deploy-seed.ts'],
      { shell: true, stdio: 'inherit' }
    );
    child.on('error', (err) =>
      console.error('[startup] Background seed error (non-fatal):', err.message)
    );
  }
});

export default app;
