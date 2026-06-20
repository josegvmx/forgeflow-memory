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
 * Generate a stable 12-char hex ID for a scenario config.
 * The config is sorted before hashing so key ordering doesn't
 * produce different IDs for equivalent configs.
 */
export function generateScenarioId(config: ScenarioConfig): string {
  const stable = JSON.stringify(config, Object.keys(config).sort());
  const hash = createHash('sha256')
    .update(stable)
    .digest('hex')
    .slice(0, 12);
  return `scenario_${hash}`;
}
