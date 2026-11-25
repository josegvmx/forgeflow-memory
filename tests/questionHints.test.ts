import { describe, it, expect } from 'vitest';
import { questionHints } from '../src/retrieval/questionHints.js';
import { opsInText, opWords } from '../src/retrieval/vocabulary.js';

describe('questionHints: ids, cycle, duration', () => {
  it('reads machine, transporter and part ids, the cycle and the duration', () => {
    expect(questionHints('Apex: machine M1_WELD went down at cycle 5 for 30 cycles. How much work was waiting?'))
      .toMatchObject({ ids: ['M1_WELD'], cycle: 5, duration: 30, eventType: 'machine_failure', ops: [] });
    expect(questionHints('transporter T3_AGV left the floor at cycle 10').ids).toEqual(['T3_AGV']);
    expect(questionHints('raw part PART_STEEL ran out at cycle 30')).toMatchObject({ ids: ['PART_STEEL'], cycle: 30, eventType: 'disruption' });
    expect(questionHints('work caught by the cycle-12 breakdown').cycle).toBe(12);
  });

  it('reads operations in words when no id is given', () => {
    expect(questionHints('the welding station broke down around cycle 10').ops).toEqual(['OP_WELD']);
    expect(opsInText('the mechanical assembly line and the electrical assembly bench')).toEqual(['OP_ELEC', 'OP_MECH']);
    expect(opsInText('our coaters and the QA bench')).toEqual(['OP_COAT', 'OP_QA']);
    expect(opsInText('nothing here')).toEqual([]);
    expect(opWords('OP_ELEC')).toBe('electrical assembly');
  });

  it('gives nothing it cannot read', () => {
    expect(questionHints('What happened in the run?')).toEqual({ ids: [], ops: [], cycle: null, duration: null, eventType: null });
  });
});

// Paraphrases written apart from the golden set's templates: the rules must not only fit those.
describe('questionHints: kind of event, on paraphrases not in the golden set', () => {
  it.each([
    ['Where did the parts go when M2_CNC failed?', 'routing_adjustment'],
    ['Did the backup machine take over after the weld cell broke down?', 'routing_adjustment'],
    ['Was the work sent to a different machine?', 'routing_adjustment'],
    ['How long until production got going again after M4_ELEC stopped?', 'recovery'],
    ['How long did the steps sit and wait before M3_MECH was back?', 'recovery'],
    ['Did the stuck work recover quickly?', 'recovery'],
    ['What did running short of steel tubes cost us?', 'disruption'],
    ['We lost an AGV mid-shift; impact on throughput?', 'disruption'],
    ['How often does M7_QA break down?', 'machine_failure'],
    ['Which machine went offline at cycle 40?', 'machine_failure'],
    ['List the breakdowns of the coating line.', 'machine_failure'],
  ])('%s → %s', (q, kind) => {
    expect(questionHints(q).eventType).toBe(kind);
  });
});
