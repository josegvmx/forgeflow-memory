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
  const message = err instanceof Error ? err.message : String(err);
  throw new UpstreamError(`Database error: ${message}`);
}

export default db;
