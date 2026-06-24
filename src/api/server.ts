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

const app = new Hono();

// Request logging
app.use('*', logger());

// Health check — useful for Docker / Railway / Render probes
app.get('/health', (c) => c.json({ status: 'ok' }));

// Serve React demo UI from public/
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

// Rate limiting — applied only to LLM-hitting endpoints
// 10 requests/IP/hour · 200 global requests/day
const llmRateLimit = rateLimit({ perIpLimit: 10, globalDailyLimit: 200 });

// Routes
app.route('/ingest', ingestRoute);
app.use('/query',     llmRateLimit);
app.use('/audit',     llmRateLimit);
app.use('/recommend', llmRateLimit);
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
