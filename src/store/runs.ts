import db, { wrapDbError } from './client.js';
import type { RunRow } from '../audit/runRow.js';

/**
 * Insert or replace benchmark rows (one per run_id), in one transaction.
 * Eval run ids are deterministic, so re-exporting a run replaces its row (stored_at moves on).
 * JSONB columns go through db.json(): postgres.js serializes jsonb parameters with JSON.stringify
 * itself, so a pre-stringified value would be stored as a JSON string, not an object.
 */
export async function upsertRuns(rows: RunRow[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  try {
    await db.begin(async (tx) => {
      for (const r of rows) {
        const [res] = await tx`
          INSERT INTO runs (
            run_id, scenario_id, scenario_name, source, provider, model, flags, seed, cycles,
            breakdown_rate, faults, units, plan_done_cycle, avg_lead_time_s, cycles_to_recover_mean,
            rescues, double_awards, llm_calls, tokens_in, tokens_out, cost_usd, latency_p50_ms,
            latency_p95_ms, llm_decision_share, llm_priced_bid_share, fallbacks, truncated,
            rate_limited, empty_replies, timeouts, replay_url, created_at
          ) VALUES (
            ${r.run_id}, ${r.scenario_id}, ${r.scenario_name}, ${r.source}, ${r.provider}, ${r.model},
            ${db.json(r.flags)}, ${r.seed}, ${r.cycles}, ${r.breakdown_rate},
            ${db.json(r.faults)}, ${r.units}, ${r.plan_done_cycle}, ${r.avg_lead_time_s},
            ${r.cycles_to_recover_mean}, ${r.rescues}, ${r.double_awards}, ${r.llm_calls}, ${r.tokens_in},
            ${r.tokens_out}, ${r.cost_usd}, ${r.latency_p50_ms}, ${r.latency_p95_ms},
            ${r.llm_decision_share}, ${r.llm_priced_bid_share}, ${r.fallbacks}, ${r.truncated},
            ${r.rate_limited}, ${r.empty_replies}, ${r.timeouts}, ${r.replay_url}, ${r.created_at}
          )
          ON CONFLICT (run_id) DO UPDATE SET
            scenario_id = EXCLUDED.scenario_id, scenario_name = EXCLUDED.scenario_name,
            source = EXCLUDED.source, provider = EXCLUDED.provider, model = EXCLUDED.model,
            flags = EXCLUDED.flags, seed = EXCLUDED.seed, cycles = EXCLUDED.cycles,
            breakdown_rate = EXCLUDED.breakdown_rate, faults = EXCLUDED.faults, units = EXCLUDED.units,
            plan_done_cycle = EXCLUDED.plan_done_cycle, avg_lead_time_s = EXCLUDED.avg_lead_time_s,
            cycles_to_recover_mean = EXCLUDED.cycles_to_recover_mean, rescues = EXCLUDED.rescues,
            double_awards = EXCLUDED.double_awards, llm_calls = EXCLUDED.llm_calls,
            tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd,
            latency_p50_ms = EXCLUDED.latency_p50_ms, latency_p95_ms = EXCLUDED.latency_p95_ms,
            llm_decision_share = EXCLUDED.llm_decision_share,
            llm_priced_bid_share = EXCLUDED.llm_priced_bid_share, fallbacks = EXCLUDED.fallbacks,
            truncated = EXCLUDED.truncated, rate_limited = EXCLUDED.rate_limited,
            empty_replies = EXCLUDED.empty_replies, timeouts = EXCLUDED.timeouts,
            replay_url = EXCLUDED.replay_url, created_at = EXCLUDED.created_at, stored_at = now()
          RETURNING (xmax = 0) AS inserted
        `;
        if (res?.inserted) inserted++;
      }
    });
  } catch (err) {
    wrapDbError(err);
  }
  return { inserted, updated: rows.length - inserted };
}
