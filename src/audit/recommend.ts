import { queryMemory } from '../retrieval/query.js';
import {
  getCachedRecommendation,
  setCachedRecommendation,
  type CacheKey,
} from '../store/recommendationCache.js';
import type { MachineFailureEvent } from './events.js';

// ============================================================
// Recommendation System
// Given a current machine failure, queries past similar failures
// and returns a synthesized routing recommendation.
// Cache layer: same (scenarioId, machineId, failureType, mode)
// returns immediately without re-embedding or calling the LLM.
// ============================================================

/**
 * Look up past failures similar to the current one and return
 * a recommendation string based on what worked before.
 *
 * Cache hit  → returns immediately, increments hit_count
 * Cache miss → runs RAG + synthesis, stores result in cache
 */
export async function getFailureRecommendation(
  failure: MachineFailureEvent,
  options?: { scopeToScenario?: boolean; skipCache?: boolean }
): Promise<{ recommendation: string; fromCache: boolean }> {
  const cacheKey: CacheKey = {
    scenarioId:  failure.scenarioId,
    machineId:   failure.metadata.machineId,
    failureType: failure.metadata.failureType,
    mode:        failure.mode,
  };

  // Cache lookup (skip if caller explicitly bypasses)
  if (!options?.skipCache) {
    const cached = await getCachedRecommendation(cacheKey);
    if (cached) {
      return { recommendation: cached, fromCache: true };
    }
  }

  // Cache miss — run full RAG pipeline
  const context = `
    Machine ${failure.metadata.machineId} failed.
    Failure type: ${failure.metadata.failureType}
    Capacity lost: ${failure.metadata.affectedCapacity}%
    Affected products: ${failure.metadata.affectedProducts.join(', ')}
    Mode: ${failure.mode}
    What routing adjustments worked best for similar failures in the past?
    Were there recovery strategies that minimised downtime cycles?
  `.trim();

  const result = await queryMemory({
    context,
    topK: 5,
    scenarioId: options?.scopeToScenario ? failure.scenarioId : undefined,
    eventTypeFilter: ['machine_failure', 'routing_adjustment', 'recovery'],
  });

  // Store in cache for next time
  await setCachedRecommendation(cacheKey, result.summary);

  return { recommendation: result.summary, fromCache: false };
}

/**
 * Compare heuristic vs AI mode recovery performance for a given scenario.
 * Useful for post-run analysis: "did AI outperform heuristic on this config?"
 */
export async function compareModesForScenario(scenarioId: string): Promise<string> {
  const result = await queryMemory({
    context: `Compare heuristic vs AI mode routing and recovery performance for scenario ${scenarioId}. Which mode had lower downtime, better throughput, and faster decision latency?`,
    topK: 20,
    scenarioId,
    eventTypeFilter: ['recovery', 'routing_adjustment'],
  });

  return result.summary;
}
