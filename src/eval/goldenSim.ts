import type { SimExport } from '../import/simExport.js';
import type { SimEpisode } from '../audit/simEpisode.js';

// ============================================================
// Golden set from labelled forgeflow-sim eval runs (R14 phase 3, step 6)
//
// Ground truth comes from injected faults (fault.* labels, R14 §4.4), never from a person or an LLM.
// Relevance is a predicate, not row ids: the same fault gives the same sentence in every seed (and in
// the pair cases), so "relevant" = every stored event of the scenario whose metadata contains the
// labels, of the right event types. The retrieval eval checks the predicate in SQL
// (scenario_id, event_type = ANY, metadata @> …). Events of runs where the fault changed nothing
// (manifest noEffectRuns) are ignored when scoring: neither hits nor misses.
//
// Left out on purpose: bad_flag. Its labels sit on ordinary breakdowns whose text never mentions the
// flag, and fault.* labels are not embedded (chunker.ts), so only the answer key could find them.
// ============================================================

export type QueryStyle = 'specific' | 'operator' | 'vague';
export type QueryAspect = 'failure' | 'recovery' | 'reroute' | 'disruption' | 'machine-history';

export interface GoldenSimQuery {
  id: string;
  question: string;
  style: QueryStyle;
  aspect: QueryAspect;
  scenarioId: string;
  relevant: {
    eventTypes: SimEpisode['eventType'][];
    /** Flat metadata the relevant events contain (jsonb @>). */
    metadata: Record<string, string | number | string[]>;
  };
  /** Relevant events in the export this set was built from (the DB may hold more, e.g. demo data). */
  relevantInExport: number;
}

export interface GoldenSimSet {
  format: 'forgeflow-golden-sim';
  version: 1;
  simCommit: string | null;
  /** Retrieved events of these runs are dropped before scoring (labelled, but the fault had no effect). */
  ignoreRunIds: string[];
  queries: GoldenSimQuery[];
}

export { opWords } from '../retrieval/vocabulary.js';
import { opWords } from '../retrieval/vocabulary.js';

/** A short readable scenario name for questions ("Apex Cycle Works"); falls back to `fallback`. */
export function shortScenarioName(name: string | undefined, fallback: string): string {
  if (!name || name.includes('/')) return fallback;      // job names leaked in by a scenario without a name
  return name.split(':')[0].trim() || fallback;
}

interface FaultGroup {
  scenarioId: string; type: string; target: string; cycle: number; duration: number | null;
  cases: Set<string>; byType: Map<SimEpisode['eventType'], number>; operations?: string[];
}

export function buildGoldenSimSet(exp: SimExport, opts: { scenarioNames?: Record<string, string> } = {}): GoldenSimSet {
  const runById = new Map(exp.runs.map(r => [r.run_id, r]));
  const caseOf = new Map<string, string>();
  const ignore = new Set<string>();
  for (const m of exp.manifests) {
    for (const f of m.faultRuns) caseOf.set(f.run_id, f.case);
    for (const id of m.noEffectRuns) ignore.add(id);
  }
  const nameOf = (scenarioId: string) => {
    const fromRun = exp.runs.find(r => r.scenario_id === scenarioId)?.scenario_name;
    return opts.scenarioNames?.[scenarioId] ?? shortScenarioName(fromRun, `scenario ${scenarioId.slice(0, 6)}`);
  };
  const operationsOf = new Map<string, string[]>(); // scenarioId|machineId → its operations
  for (const e of exp.episodes) {
    const ops = e.metadata.operations;
    if (e.eventType === 'machine_failure' && Array.isArray(ops) && ops.length) operationsOf.set(`${e.scenarioId}|${e.metadata.machineId}`, ops.map(String));
  }

  // ── Fault groups: labelled episodes of effective runs, by (scenario, fault.type, fault.target, fault.cycle)
  const groups = new Map<string, FaultGroup>();
  for (const e of exp.episodes) {
    const m = e.metadata;
    if (m['fault.injected'] !== true || ignore.has(e.runId)) continue;
    const type = String(m['fault.type']);
    if (type === 'bad_flag') continue;
    const target = String(m['fault.target']), cycle = Number(m['fault.cycle']);
    const key = `${e.scenarioId}|${type}|${target}|${cycle}`;
    let g = groups.get(key);
    if (!g) {
      const d = m['fault.duration'];
      g = { scenarioId: e.scenarioId, type, target, cycle, duration: typeof d === 'number' && d > 0 ? d : null, cases: new Set(), byType: new Map() };
      groups.set(key, g);
    }
    const c = caseOf.get(e.runId); if (c) g.cases.add(c);
    g.byType.set(e.eventType, (g.byType.get(e.eventType) ?? 0) + 1);
    if (type === 'machine_down') g.operations = operationsOf.get(`${e.scenarioId}|${target}`);
  }

  const queries: GoldenSimQuery[] = [];
  const add = (q: Omit<GoldenSimQuery, 'id'>) => queries.push({ id: `q${String(queries.length + 1).padStart(3, '0')}`, ...q });

  for (const g of [...groups.values()].sort((a, b) => `${a.scenarioId}${a.type}${a.target}${a.cycle}`.localeCompare(`${b.scenarioId}${b.type}${b.target}${b.cycle}`))) {
    const sc = nameOf(g.scenarioId);
    const labels = { 'fault.type': g.type, 'fault.target': g.target, 'fault.cycle': g.cycle };
    const n = (t: SimEpisode['eventType']) => g.byType.get(t) ?? 0;
    const q = (style: QueryStyle, aspect: QueryAspect, eventType: SimEpisode['eventType'], question: string) =>
      n(eventType) > 0 && add({ question, style, aspect, scenarioId: g.scenarioId, relevant: { eventTypes: [eventType], metadata: labels }, relevantInExport: n(eventType) });

    if (g.type === 'machine_down') {
      const station = g.operations?.length ? `the ${g.operations.map(opWords).join(' and ')} station` : 'a station';
      const forD = g.duration ? ` for ${g.duration} cycles` : '';
      const role = g.cases.has('constraint-down') || g.cases.has('pair-constraint-fleet') ? 'the bottleneck machine'
        : g.cases.has('redundant-down') || g.cases.has('pair-redundant-norescue') ? 'a machine that has a backup' : 'one machine';
      q('specific', 'failure', 'machine_failure', `${sc}: machine ${g.target} went down at cycle ${g.cycle}${forD}. How much work was waiting on it?`);
      q('operator', 'failure', 'machine_failure', `In ${sc}, ${station} broke down around cycle ${g.cycle}. What was stuck there when it failed?`);
      q('vague', 'failure', 'machine_failure', `In ${sc}, ${role} stopped early in the run and stayed out for a long stretch. What happened at that machine?`);
      q('specific', 'recovery', 'recovery', `${sc}: after ${g.target} failed at cycle ${g.cycle}, how many cycles until the caught work moved again?`);
      q('operator', 'recovery', 'recovery', `In ${sc}, how long did parts wait after ${station} failed around cycle ${g.cycle}, and how much did the floor finish meanwhile?`);
      q('vague', 'recovery', 'recovery', `In ${sc}, when ${role} went down early, how did the work caught there recover?`);
      q('specific', 'reroute', 'routing_adjustment', `${sc}: after ${g.target} broke down at cycle ${g.cycle}, where was its work rerouted?`);
      q('operator', 'reroute', 'routing_adjustment', `In ${sc}, ${station} failed around cycle ${g.cycle}. Did its parts move to another machine?`);
      q('vague', 'reroute', 'routing_adjustment', `In ${sc}, ${role} broke down. Was its work sent to another machine instead of waiting?`);
    } else if (g.type === 'stock_out') {
      q('specific', 'disruption', 'disruption', `${sc}: raw part ${g.target} ran out at cycle ${g.cycle}. How many units did the run lose?`);
      q('operator', 'disruption', 'disruption', `In ${sc}, we ran out of ${g.target.replace(/^PART_/, '').toLowerCase()} around cycle ${g.cycle}. How did that change output?`);
      q('vague', 'disruption', 'disruption', `In ${sc}, a raw material ran out partway through the run. What did it cost in finished units?`);
    } else if (g.type === 'fleet_short') {
      q('specific', 'disruption', 'disruption', `${sc}: transporter ${g.target} left the floor at cycle ${g.cycle}. What was the effect on units completed?`);
      q('operator', 'disruption', 'disruption', `In ${sc}, one of the AGVs was taken off the floor around cycle ${g.cycle}. How much output did we lose?`);
      q('vague', 'disruption', 'disruption', `In ${sc}, we were a transporter short for most of the run. How did that affect production?`);
    }
  }

  // ── Machine history (all runs, labelled or not): failures and recoveries per scenario × machine
  const machines = new Map<string, { scenarioId: string; machineId: string; failures: number; recoveries: number }>();
  for (const e of exp.episodes) {
    if (e.eventType !== 'machine_failure' && e.eventType !== 'recovery') continue;
    const machineId = String(e.metadata.machineId ?? '');
    if (!machineId) continue;
    const k = `${e.scenarioId}|${machineId}`;
    const s = machines.get(k) ?? { scenarioId: e.scenarioId, machineId, failures: 0, recoveries: 0 };
    if (e.eventType === 'machine_failure') s.failures++; else s.recoveries++;
    machines.set(k, s);
  }
  for (const s of [...machines.values()].sort((a, b) => `${a.scenarioId}${a.machineId}`.localeCompare(`${b.scenarioId}${b.machineId}`))) {
    const sc = nameOf(s.scenarioId);
    const ops = operationsOf.get(`${s.scenarioId}|${s.machineId}`);
    const what = ops?.length ? `${s.machineId} (${ops.map(opWords).join(', ')})` : s.machineId;
    if (s.failures > 0) add({ question: `${sc}: how often did ${what} break down, and for how long?`, style: 'specific', aspect: 'machine-history',
      scenarioId: s.scenarioId, relevant: { eventTypes: ['machine_failure'], metadata: { machineId: s.machineId } }, relevantInExport: s.failures });
    if (s.recoveries > 0) add({ question: `${sc}: when ${what} broke down, how long did the work caught there take to move again?`, style: 'specific', aspect: 'machine-history',
      scenarioId: s.scenarioId, relevant: { eventTypes: ['recovery'], metadata: { machineId: s.machineId } }, relevantInExport: s.recoveries });
  }

  // Operator wording: by operation, not machine id. Several machines can share an operation, so the
  // predicate is operations ⊇ [op] on failures (recovery episodes don't carry operations).
  const byOp = new Map<string, { scenarioId: string; op: string; failures: number; machines: Set<string> }>();
  for (const e of exp.episodes) {
    const ops = e.metadata.operations;
    if (e.eventType !== 'machine_failure' || !Array.isArray(ops)) continue;
    for (const op of ops) {
      const k = `${e.scenarioId}|${op}`;
      const s = byOp.get(k) ?? { scenarioId: e.scenarioId, op: String(op), failures: 0, machines: new Set<string>() };
      s.failures++; s.machines.add(String(e.metadata.machineId));
      byOp.set(k, s);
    }
  }
  for (const s of [...byOp.values()].sort((a, b) => `${a.scenarioId}${a.op}`.localeCompare(`${b.scenarioId}${b.op}`))) {
    const sc = nameOf(s.scenarioId);
    const many = s.machines.size > 1;
    const station = `the ${opWords(s.op)} station${many ? 's' : ''}`;
    add({ question: `In ${sc}, how often did ${station} break down, and how long ${many ? 'were they' : 'was it'} out?`, style: 'operator', aspect: 'machine-history',
      scenarioId: s.scenarioId, relevant: { eventTypes: ['machine_failure'], metadata: { operations: [s.op] } }, relevantInExport: s.failures });
  }

  return { format: 'forgeflow-golden-sim', version: 1, simCommit: exp.simCommit, ignoreRunIds: [...ignore].sort(), queries };
}
