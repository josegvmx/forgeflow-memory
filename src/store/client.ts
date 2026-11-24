import 'dotenv/config';
import postgres from 'postgres';
import { UpstreamError } from '../api/errors.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example → .env and fill in the value.');
}

// Singleton postgres.js client.
// postgres.js handles connection pooling internally.
const db = postgres(connectionString, {
  // Register the vector type so postgres.js serialises float[] ↔ pgvector correctly.
  // pgvector npm package patches the postgres.js type parser on import.
  types: {},
});

// Wrap postgres connection errors so callers receive a 503 instead of a raw 500
export function wrapDbError(err: unknown): never {
  throw new UpstreamError(`Database error: ${describeDbError(err)}`);
}

/**
 * A readable one-line description of a database error. Connection failures often arrive as an
 * AggregateError with an empty message (one inner error per address tried), so the code, the
 * error's name and the inner errors' codes are included; never the query or its parameters.
 */
export function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err) || 'unknown error';
  const e = err as Error & { code?: unknown; errors?: unknown[]; severity?: unknown };
  const inner = Array.isArray(e.errors)
    ? [...new Set(e.errors.map((x) => { const i = x as { code?: unknown; message?: unknown }; return String(i?.code ?? i?.message ?? x); }))].join(', ')
    : '';
  const parts = [typeof e.code === 'string' ? e.code : '', e.message || e.name, inner ? `(${inner})` : ''].filter(Boolean);
  return parts.join(' ') || e.name || 'unknown error';
}

export default db;
