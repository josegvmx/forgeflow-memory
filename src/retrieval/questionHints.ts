import { opsInText } from './vocabulary.js';

// ============================================================
// Structured hints read from a question (R14 phase 3, strategy "structured").
//
// Embeddings barely encode numbers, and the events of one machine differ mostly by cycle and
// duration. So ids, cycle numbers and the kind of event asked about are read from the question
// itself (never from the answer labels) and turned into filters and an ordering. General wording,
// not the golden set's templates: tests include paraphrases the golden set does not contain.
// ============================================================

export type HintEventType = 'machine_failure' | 'recovery' | 'routing_adjustment' | 'disruption';

export interface QuestionHints {
  /** Machine, transporter and part ids named in the question (node_id). */
  ids: string[];
  /** Operation codes named in words ("the welding station" → OP_WELD). */
  ops: string[];
  /** The incident's cycle ("at cycle 10", "around cycle 5", "the cycle-10 breakdown"). */
  cycle: number | null;
  /** How long a machine was down ("for 30 cycles"). */
  duration: number | null;
  /** The kind of event asked about, if the wording says so. */
  eventType: HintEventType | null;
}

const ID = /\b(?:[MT]\d+_[A-Z0-9]+|PART_[A-Z0-9_]+)\b/g;

// First match wins: the more specific question comes first ("after it failed, when did work move
// again?" asks about recovery, not the failure).
const KINDS: Array<[HintEventType, RegExp]> = [
  ['routing_adjustment', /\brerout|\b(?:moved?|sent|send|went|go) (?:its \w+ |the \w+ )?to (?:another|a different|an? other|the other|the backup)|\bwhere (?:was|did) (?:its|the) (?:work|parts?)|\b(?:take|took|taking|takes) over\b/i],
  ['recovery', /\b(?:move|moving|moved|going|running|flowing) again\b|\brecover|\bhow long did (?:the )?(?:parts?|work|steps?)[^?]*\bwait|\bunstuck/i],
  ['disruption', /\bran out\b|\brun out\b|\bstock[- ]?out\b|\btransporters?\b|\bagvs?\b|\bfleet\b|\braw (?:part|material)|\bshort of\b/i],
  ['machine_failure', /\bbr(?:eak|oke|eaks) down\b|\bwent down\b|\bwent offline\b|\bfail(?:ed|ure|s)?\b|\bstopped\b|\bout of service\b|\bbreakdowns?\b/i],
];

export function questionHints(question: string): QuestionHints {
  const ids = [...new Set(question.match(ID) ?? [])];
  const cycleM = /\bcycle[-\s]+(\d{1,4})\b/i.exec(question);
  const durM = /\bfor (\d{1,4}) cycles\b/i.exec(question);
  const kind = KINDS.find(([, re]) => re.test(question));
  return {
    ids,
    ops: ids.length ? [] : opsInText(question),
    cycle: cycleM ? Number(cycleM[1]) : null,
    duration: durM ? Number(durM[1]) : null,
    eventType: kind ? kind[0] : null,
  };
}
