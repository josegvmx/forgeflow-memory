/**
 * Apply schema.sql at startup (Railway start command: `npm run db:migrate && node dist/api/server.js`).
 *
 * Until R14 nothing connected to the database at boot, so the private network (`*.railway.internal`)
 * being briefly unreachable when a container starts didn't matter. The migration connects first, so it
 * retries connection-level failures with backoff (up to `maxWaitMs`), and sets a lock timeout so an
 * ALTER TABLE waiting on a busy table fails instead of hanging. SQL errors fail at once. Pure apart
 * from the injected `exec` / `sleep`, so it's unit-tested without a database.
 */

const RETRYABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', '57P03']);

/** Connection-level failure (network not ready, DB starting up) rather than a problem with the SQL. */
export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

export interface MigrateOptions {
  /** Give up retrying connection errors after this long (ms). */
  maxWaitMs?: number;
  /** First retry delay (ms); doubles up to 8 s. */
  firstDelayMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Runs `exec(sql)` until it succeeds, a non-retryable error occurs, or `maxWaitMs` passes. Returns attempts used. */
export async function applySchema(exec: (sql: string) => Promise<unknown>, sql: string, opts: MigrateOptions = {}): Promise<number> {
  const maxWaitMs = opts.maxWaitMs ?? 45_000;
  const log = opts.log ?? (line => console.log(line));
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  let delay = opts.firstDelayMs ?? 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      await exec(sql);
      return attempt;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryable(err)) {
        log(`[migrate] failed (not retried): ${code ?? ''} ${msg}`.trim());
        throw err;
      }
      const waited = now() - start;
      if (waited + delay > maxWaitMs) {
        log(`[migrate] database still unreachable after ${Math.round(waited / 1000)} s (${code}): giving up`);
        throw err;
      }
      log(`[migrate] attempt ${attempt}: database not reachable yet (${code}); retrying in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

/** Prepended to schema.sql: an ALTER waiting behind a busy table fails after 15 s instead of hanging. */
export const SESSION_SETTINGS = "SET lock_timeout = '15s';\n";
