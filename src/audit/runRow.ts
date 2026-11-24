import { z } from 'zod';
import { ScenarioIdSchema } from './scenarioId.js';
import { RunIdSchema, Token } from './simEpisode.js';

// ============================================================
// Benchmark row from forgeflow-sim (roadmap R14 §4.5)
//
// One row per run, as forgeflow-sim's replayToRows (src/lib/replay/toRows.ts) / eval export write it.
// Contract fixture: tests/fixtures/sim-run-row.json is real sim output. Unknown keys are dropped,
// so the sim can add a column before the service has it. Stored in the `runs` table (schema.sql).
// ============================================================

const Count = z.number().int().nonnegative();
const Ms = z.number().finite().nonnegative();
const Share = z.number().min(0).max(1);

/** Flat flag map: flag name → value. Values are short; nothing nested. */
const Flags = z.record(Token, z.union([z.string().max(200), z.number().finite(), z.boolean()]))
  .refine(f => Object.keys(f).length <= 60, 'at most 60 flags');

export const RunRowSchema = z.object({
  run_id: RunIdSchema,
  scenario_id: ScenarioIdSchema,
  scenario_name: z.string().min(1).max(200),
  source: z.enum(['eval', 'app']),
  provider: Token,                                  // 'heuristic' when AI was off
  model: z.string().min(1).max(100).nullable(),
  flags: Flags,
  seed: z.number().int().nullable(),
  cycles: z.number().int().positive(),
  breakdown_rate: Share.nullable(),
  faults: z.array(z.string().min(1).max(200)).max(8),
  units: Count,
  plan_done_cycle: Count.nullable(),
  avg_lead_time_s: Ms.nullable(),
  cycles_to_recover_mean: Ms.nullable(),
  rescues: Count,
  double_awards: Count,
  llm_calls: Count,
  tokens_in: Count,
  tokens_out: Count,
  cost_usd: z.number().finite().nonnegative(),
  latency_p50_ms: Ms.nullable(),
  latency_p95_ms: Ms.nullable(),
  llm_decision_share: Share.nullable(),
  llm_priced_bid_share: Share.nullable(),
  fallbacks: Count,
  /** Calls cut off at max_tokens. Older rows count them inside fallbacks only → null (not recorded). */
  truncated: Count.nullable().optional().transform(v => v ?? null),
  rate_limited: Count,
  empty_replies: Count,
  timeouts: Count,
  replay_url: z.string().url().max(2000).refine(u => /^https?:\/\//.test(u), 'http(s) only').nullable(),
  created_at: z.string().datetime({ offset: true }),
}).superRefine((r, ctx) => {
  // An AI-off row with LLM work is a mislabelled row, not a heuristic result.
  if (r.provider === 'heuristic' && (r.llm_calls > 0 || r.model !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: "a 'heuristic' run has no LLM calls and no model" });
  }
  if (r.latency_p50_ms !== null && r.latency_p95_ms !== null && r.latency_p95_ms < r.latency_p50_ms) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latency_p95_ms'], message: 'p95 below p50' });
  }
});

export type RunRow = z.output<typeof RunRowSchema>;

/** POST /runs body. 1000 rows ≈ 1 MB, inside the 5 MB admin body limit. */
export const RunsBodySchema = z.object({ runs: z.array(RunRowSchema).min(1).max(1000) });
