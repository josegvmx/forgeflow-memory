import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import 'dotenv/config';
import type { CacheKey } from '../src/store/recommendationCache.js';

// src/store/client.ts throws on import when DATABASE_URL is unset (e.g. CI),
// so the DB modules are only loaded when it's configured. Otherwise `db` is
// null, the SELECT 1 probe below fails, and every test skips (ADR 004).
type Db = typeof import('../src/store/client.js').default;
type CacheModule = typeof import('../src/store/recommendationCache.js');

const hasDbUrl = Boolean(process.env.DATABASE_URL);
const db = (hasDbUrl ? (await import('../src/store/client.js')).default : null) as Db;
const {
  getCachedRecommendation,
  setCachedRecommendation,
  invalidateScenarioCache,
  clearRecommendationCache,
} = (hasDbUrl ? await import('../src/store/recommendationCache.js') : {}) as CacheModule;

// ── Integration tests — require a running PostgreSQL + recommendations table ──
// Skip gracefully if DATABASE_URL is not reachable (e.g. CI without Docker).
// To run locally: make sure Docker pgvector is running and npm run db:migrate.

const key: CacheKey = {
  scenarioId:  'scenario_test_cache',
  machineId:   'M_TEST',
  failureType: 'breakdown',
  mode:        'ai',
};

const recommendation = 'Test recommendation: reroute to M2 immediately.';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db`SELECT 1`;
    dbAvailable = true;
    await db`DELETE FROM recommendations WHERE scenario_id = ${key.scenarioId}`;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db`DELETE FROM recommendations WHERE scenario_id = ${key.scenarioId}`;
  await db.end();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db`DELETE FROM recommendations WHERE scenario_id = ${key.scenarioId}`;
});

// Helper: skip test when DB is unavailable
const itDb = (name: string, fn: (ctx: { skip: () => void }) => Promise<void>) =>
  it(name, async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await fn(ctx);
  });

describe('getCachedRecommendation', () => {
  itDb('returns null on cache miss', async () => {
    const result = await getCachedRecommendation(key);
    expect(result).toBeNull();
  });

  itDb('returns the recommendation on cache hit', async () => {
    await setCachedRecommendation(key, recommendation);
    const result = await getCachedRecommendation(key);
    expect(result).toBe(recommendation);
  });

  itDb('increments hit_count on each cache hit', async () => {
    await setCachedRecommendation(key, recommendation);

    await getCachedRecommendation(key);
    await getCachedRecommendation(key);

    const rows = await db`
      SELECT hit_count FROM recommendations
      WHERE scenario_id = ${key.scenarioId}
        AND machine_id   = ${key.machineId}
        AND failure_type = ${key.failureType}
        AND mode         = ${key.mode}
    `;
    // Started at 1, two hits = 3
    expect(rows[0].hit_count).toBe(3);
  });

  itDb('returns null for different mode', async () => {
    await setCachedRecommendation(key, recommendation);
    const result = await getCachedRecommendation({ ...key, mode: 'heuristic' });
    expect(result).toBeNull();
  });

  itDb('returns null for different machineId', async () => {
    await setCachedRecommendation(key, recommendation);
    const result = await getCachedRecommendation({ ...key, machineId: 'M_OTHER' });
    expect(result).toBeNull();
  });
});

describe('setCachedRecommendation', () => {
  itDb('stores a recommendation', async () => {
    await setCachedRecommendation(key, recommendation);
    const result = await getCachedRecommendation(key);
    expect(result).toBe(recommendation);
  });

  itDb('overwrites an existing recommendation on upsert', async () => {
    await setCachedRecommendation(key, 'old recommendation');
    await setCachedRecommendation(key, 'new recommendation');
    const result = await getCachedRecommendation(key);
    expect(result).toBe('new recommendation');
  });

  itDb('is idempotent — no error on duplicate insert', async () => {
    await expect(setCachedRecommendation(key, recommendation)).resolves.not.toThrow();
    await expect(setCachedRecommendation(key, recommendation)).resolves.not.toThrow();
  });
});

describe('invalidateScenarioCache', () => {
  itDb('removes all recommendations for a scenario', async () => {
    await setCachedRecommendation(key, recommendation);
    await setCachedRecommendation({ ...key, machineId: 'M_OTHER' }, recommendation);

    const deleted = await invalidateScenarioCache(key.scenarioId);
    expect(deleted).toBe(2);

    const result = await getCachedRecommendation(key);
    expect(result).toBeNull();
  });

  itDb('returns 0 when no rows matched', async () => {
    const deleted = await invalidateScenarioCache('scenario_nonexistent');
    expect(deleted).toBe(0);
  });
});

describe('clearRecommendationCache', () => {
  itDb('removes all recommendations', async () => {
    await setCachedRecommendation(key, recommendation);
    await clearRecommendationCache();
    const result = await getCachedRecommendation(key);
    expect(result).toBeNull();
  });
});
