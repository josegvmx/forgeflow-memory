import { createHash } from 'crypto';

// ============================================================
// Scenario Identity
// Generates a deterministic ID from a ScenarioConfig.
// Two runs with identical configs share the same ID —
// enabling cross-run comparison in the audit and retrieval layers.
// ============================================================

export interface MachineConfig {
  id: string;
  capacity: number;
  type: string;
  [key: string]: unknown;
}

export interface TransporterConfig {
  id: string;
  speed: number;
  [key: string]: unknown;
}

export interface WarehouseConfig {
  id: string;
  capacity: number;
  [key: string]: unknown;
}

export interface ProductConfig {
  id: string;
  processingTime: number;
  [key: string]: unknown;
}

export interface SparePartConfig {
  id: string;
  quantity: number;
  [key: string]: unknown;
}

export interface ScenarioConfig {
  machines: MachineConfig[];
  transporters: TransporterConfig[];
  warehouses: WarehouseConfig[];
  products: ProductConfig[];
  spareParts: SparePartConfig[];
  mode: 'heuristic' | 'ai';
}

/**
 * Recursively sort all object keys so key insertion order
 * never affects the hash. Arrays are preserved as-is.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Generate a stable 12-char hex ID for a scenario config.
 * All object keys are sorted recursively before hashing so
 * key ordering never produces a different ID for equivalent configs.
 */
export function generateScenarioId(config: ScenarioConfig): string {
  const stable = JSON.stringify(sortKeysDeep(config));
  const hash = createHash('sha256')
    .update(stable)
    .digest('hex')
    .slice(0, 12);
  return `scenario_${hash}`;
}
