import db, { wrapDbError } from './client.js';

// ============================================================
// Recommendation Cache
// Read-through cache for synthesised failure recommendations.
// Keyed by (scenarioId, machineId, failureType, mode).
// ============================================================

export interface CacheKey {
  scenarioId:  string;
  machineId:   string;
  failureType: string;
  mode:        'heuristic' | 'ai';
}

interface CacheRow {
  id:             string;
  recommendation: string;
  hit_count:      number;
  created_at:     Date;
  updated_at:     Date;
}

/**
 * Look up a cached recommendation.
 * Returns the recommendation string on hit, null on miss.
 * Increments hit_count on each cache hit.
 */
export async function getCachedRecommendation(key: CacheKey): Promise<string | null> {
  try {
    const rows = await db<CacheRow[]>`
      UPDATE recommendations
      SET hit_count = hit_count + 1,
          updated_at = now()
      WHERE scenario_id  = ${key.scenarioId}
        AND machine_id   = ${key.machineId}
        AND failure_type = ${key.failureType}
        AND mode         = ${key.mode}
      RETURNING id, recommendation, hit_count, created_at, updated_at
    `;
    return rows[0]?.recommendation ?? null;
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Check whether a recommendation is cached, without touching hit_count.
 * Used by the rate limiter so cache hits don't consume a visitor's LLM budget.
 */
export async function hasCachedRecommendation(key: CacheKey): Promise<boolean> {
  try {
    const rows = await db`
      SELECT 1 FROM recommendations
      WHERE scenario_id  = ${key.scenarioId}
        AND machine_id   = ${key.machineId}
        AND failure_type = ${key.failureType}
        AND mode         = ${key.mode}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Store a recommendation in the cache.
 * Uses ON CONFLICT to upsert — safe to call even if the key already exists.
 */
export async function setCachedRecommendation(
  key: CacheKey,
  recommendation: string
): Promise<void> {
  try {
    await db`
      INSERT INTO recommendations (scenario_id, machine_id, failure_type, mode, recommendation)
      VALUES (${key.scenarioId}, ${key.machineId}, ${key.failureType}, ${key.mode}, ${recommendation})
      ON CONFLICT (scenario_id, machine_id, failure_type, mode)
      DO UPDATE SET
        recommendation = EXCLUDED.recommendation,
        updated_at     = now()
    `;
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Invalidate all cached recommendations for a scenario.
 * Call this after new events are ingested for the scenario
 * so stale recommendations don't persist.
 */
export async function invalidateScenarioCache(scenarioId: string): Promise<number> {
  try {
    const rows = await db`
      DELETE FROM recommendations
      WHERE scenario_id = ${scenarioId}
      RETURNING id
    `;
    return rows.length;
  } catch (err) {
    wrapDbError(err);
  }
}

/**
 * Invalidate the entire recommendation cache.
 * Useful after a bulk ingest of new data.
 */
export async function clearRecommendationCache(): Promise<number> {
  try {
    const rows = await db`DELETE FROM recommendations RETURNING id`;
    return rows.length;
  } catch (err) {
    wrapDbError(err);
  }
}
