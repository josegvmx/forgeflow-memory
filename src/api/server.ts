import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import ingestRoute from './routes/ingest.js';
import queryRoute from './routes/query.js';

const app = new Hono();

// Request logging
app.use('*', logger());

// Health check — useful for Docker / Railway / Render probes
app.get('/health', (c) => c.json({ status: 'ok' }));

// Routes
app.route('/ingest', ingestRoute);
app.route('/query', queryRoute);

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

const PORT = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`forgeflow-memory listening on http://localhost:${PORT}`);
});

export default app;
