import { describe, it, expect, vi } from 'vitest';

vi.mock('postgres', () => ({ default: () => ({}) }));
vi.stubEnv('DATABASE_URL', 'postgres://unused');
const { describeDbError } = await import('../src/store/client.js');

describe('describeDbError', () => {
  it('names a connection failure that arrives as an AggregateError with an empty message', () => {
    const err = new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }), Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], '');
    expect(describeDbError(err)).toBe('AggregateError (ECONNREFUSED)');
  });

  it('keeps a Postgres error code and message', () => {
    const err = Object.assign(new Error('could not extend file: No space left on device'), { code: '53100' });
    expect(describeDbError(err)).toBe('53100 could not extend file: No space left on device');
  });

  it('never returns an empty string', () => {
    expect(describeDbError(new Error(''))).toBe('Error');
    expect(describeDbError('')).toBe('unknown error');
    expect(describeDbError(Object.assign(new Error(''), { code: 'CONNECTION_CLOSED' }))).toBe('CONNECTION_CLOSED Error');
  });
});
