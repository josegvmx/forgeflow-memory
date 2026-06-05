import 'dotenv/config';
import postgres from 'postgres';

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

export default db;
