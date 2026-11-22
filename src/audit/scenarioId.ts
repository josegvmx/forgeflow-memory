import { z } from 'zod';

// ============================================================
// Scenario identity (roadmap R14 §4.2)
//
// The scenarioId is computed by forgeflow-sim (src/lib/scenario/scenarioId.ts) — a sha256 over
// the scenario's structure, first 16 hex characters — and this service stores it as given. It
// no longer computes its own: the old hash ran over fields ForgeFlow's scenarios don't have.
//
// Accepted forms:
//   - canonical: 16 lowercase hex characters, e.g. "6514fc6232151a5c"
//   - legacy:    "scenario" + "_" or "-" + a token, e.g. "scenario_demo_001", "scenario-beta-002"
//                (rows and fixtures written before R14)
// Both are plain tokens, safe to interpolate into prompts.
// ============================================================

export const CANONICAL_SCENARIO_ID = /^[0-9a-f]{16}$/;
export const LEGACY_SCENARIO_ID = /^scenario[_-][A-Za-z0-9_-]{1,55}$/;

export const isCanonicalScenarioId = (v: unknown): v is string =>
  typeof v === 'string' && CANONICAL_SCENARIO_ID.test(v);

export const isScenarioId = (v: unknown): v is string =>
  typeof v === 'string' && (CANONICAL_SCENARIO_ID.test(v) || LEGACY_SCENARIO_ID.test(v));

export const ScenarioIdSchema = z.string().refine(isScenarioId, {
  message: 'scenarioId must be 16 lowercase hex characters (from forgeflow-sim) or a legacy scenario_… id',
});

/** Where the canonical function lives, for error messages. */
export const SCENARIO_ID_SOURCE = 'forgeflow-sim src/lib/scenario/scenarioId.ts';
