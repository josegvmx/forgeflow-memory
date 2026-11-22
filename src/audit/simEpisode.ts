import { z } from 'zod';
import { ScenarioIdSchema } from './scenarioId.js';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// forgeflow-sim episodes (roadmap R14 §4.3, §4.4)
//
// The sim's memory episodes (src/lib/metrics/episodes.ts there): one sentence of content, flat
// metadata (strings, finite numbers, booleans, arrays of strings — nothing nested), a runId and a
// source, and fault.* ground-truth labels on injected-fault runs. Every type has a few required
// core keys; extra flat keys are allowed so the sim can add fields without a service release.
// Contract fixture: tests/fixtures/sim-episodes.jsonl is real sim output.
// ============================================================

/** Prompt-safe token: ids and short enum-like values are interpolated into LLM prompts. */
export const Token = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be 1-64 letters, digits, or _ . : -');
/** A run id from forgeflow-sim: UUID-shaped (random v4 for app runs, deterministic v8 for eval runs). */
export const RunIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'runId must be a lowercase UUID');
export const SourceSchema = z.enum(['sim', 'investigator']);

const FlatValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(50),
]);
/** Flat metadata: the chunker stringifies values, so nesting would only reach the embedding as "[object Object]". */
export const FlatMetadataSchema = z.record(FlatValue).refine(m => Object.keys(m).length <= 40, 'at most 40 metadata keys');

const TokenList = z.array(Token).max(50);
const Int = z.number().int();

/** Ground-truth labels (all optional; present on fault runs). */
const FaultLabels = {
  'fault.injected': z.boolean().optional(),
  'fault.type': Token.optional(),
  'fault.target': z.string().regex(/^[A-Za-z0-9_.:,-]{1,200}$/).optional(),
  'fault.cycle': Int.optional(),
  'fault.duration': Int.optional(),
  'fault.all': z.array(z.string().max(200)).max(8).optional(),
};

const meta = <T extends z.ZodRawShape>(core: T) =>
  z.object({ ...core, ...FaultLabels }).catchall(FlatValue).superRefine((m, ctx) => {
    if (Object.keys(m).length > 40) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 40 metadata keys' });
  });

const MachineFailureMeta = meta({
  machineId: Token, failureType: Token, hadWork: z.boolean(), stepsCaught: Int.nonnegative(),
  affectedProducts: TokenList, operations: TokenList.optional(), cyclesDown: Int.nonnegative().optional(),
});
const RoutingAdjustmentMeta = meta({
  fromMachine: Token, toMachine: Token, triggeredByFailure: Token, affectedProducts: TokenList,
  decisionLatencyCycles: Int.nonnegative(),
});
const RecoveryMeta = meta({
  machineId: Token, recoveryStrategy: Token, successful: z.boolean(), censored: z.boolean(),
  stepsCaught: Int.nonnegative(), affectedProducts: TokenList,
});
const DisruptionMeta = meta({
  faultType: z.enum(['stock_out', 'fleet_short']), targets: TokenList.min(1), atCycle: Int.positive(),
  unitsWithFault: Int.nonnegative(), unitsWithoutFault: Int.nonnegative(), unitsDelta: Int, cyclesRun: Int.positive(),
});

const Base = z.object({
  runId: RunIdSchema,
  scenarioId: ScenarioIdSchema,
  nodeId: Token,
  cycle: Int.nonnegative(),
  mode: z.enum(['heuristic', 'ai']),
  source: SourceSchema,
  content: z.string().min(1).max(4000),
});

export const SimEpisodeSchema = z.discriminatedUnion('eventType', [
  Base.extend({ eventType: z.literal('machine_failure'), metadata: MachineFailureMeta }),
  Base.extend({ eventType: z.literal('routing_adjustment'), metadata: RoutingAdjustmentMeta }),
  Base.extend({ eventType: z.literal('recovery'), metadata: RecoveryMeta }),
  Base.extend({ eventType: z.literal('disruption'), metadata: DisruptionMeta }),
]);
export type SimEpisode = z.infer<typeof SimEpisodeSchema>;

/** A sim episode as a stored event: runId in its own column, source kept in metadata. */
export function simEpisodeToReasoningEvent(e: SimEpisode): ReasoningEvent {
  return {
    scenarioId: e.scenarioId,
    nodeId: e.nodeId,
    cycle: e.cycle,
    eventType: e.eventType,
    mode: e.mode,
    runId: e.runId,
    content: e.content,
    metadata: { ...e.metadata, source: e.source },
  };
}

/** Sim episodes carry runId and source; the older audit events carry neither. */
export const looksLikeSimEpisode = (raw: unknown): boolean =>
  !!raw && typeof raw === 'object' && 'runId' in raw && 'source' in raw;
