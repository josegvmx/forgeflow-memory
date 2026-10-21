import type { Context, Next } from 'hono';
import { getClientIp } from './security.js';

// ============================================================
// Simple in-memory rate limiter.
//
// Two layers:
//   1. Per-IP:    max N requests per window (default 10/hour)
//   2. Global:    max M requests per day across all IPs
//
// Resets automatically when the window expires.
// Uses a Map so it's lightweight — fine for a single-instance demo.
// Memory is bounded (MAX_TRACKED_IPS) and the client IP is proxy-aware.
// ============================================================

interface WindowEntry {
  count:     number;
  resetAt:   number; // epoch ms
}

/** Upper bound on tracked IPs, so a flood of distinct IPs can't exhaust memory. */
const MAX_TRACKED_IPS = 10_000;

function check(entry: WindowEntry, limit: number, windowMs: number): WindowEntry {
  const now = Date.now();
  if (now > entry.resetAt) {
    return { count: 1, resetAt: now + windowMs };
  }
  return { ...entry, count: entry.count + 1 };
}

function windowLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return ms === 3_600_000 ? 'hour' : `${ms / 3_600_000} hours`;
  if (ms % 60_000 === 0)    return ms === 60_000 ? 'minute' : `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}

function prune(map: Map<string, WindowEntry>): void {
  const now = Date.now();
  for (const [ip, e] of map) if (now > e.resetAt) map.delete(ip);
  // Still too big (sustained many-IP flood): drop oldest entries.
  if (map.size > MAX_TRACKED_IPS) {
    const excess = map.size - MAX_TRACKED_IPS;
    let i = 0;
    for (const ip of map.keys()) { if (i++ >= excess) break; map.delete(ip); }
  }
}

export interface RateLimitOptions {
  /** Max requests per IP per windowMs. Default: 10 */
  perIpLimit?: number;
  /** Window duration in ms for per-IP limit. Default: 3_600_000 (1 hour) */
  perIpWindowMs?: number;
  /** Global max requests per day. Default: 200 */
  globalDailyLimit?: number;
  /**
   * Return true to let a request through without counting it against either
   * limit (e.g. it will be served from cache and never reaches the LLM).
   */
  skip?: (c: Context) => boolean | Promise<boolean>;
}

export function rateLimit(opts: RateLimitOptions = {}) {
  const {
    perIpLimit      = 10,
    perIpWindowMs   = 3_600_000,   // 1 hour
    globalDailyLimit = 200,
    skip,
  } = opts;

  // State is per limiter instance, so limiters with different budgets
  // (e.g. LLM vs. cheap reads) never share counters.
  const ipWindows = new Map<string, WindowEntry>();
  let globalEntry: WindowEntry = { count: 0, resetAt: Date.now() + 86_400_000 };

  return async (c: Context, next: Next) => {
    if (skip && (await skip(c))) {
      await next();
      return;
    }

    const ip = getClientIp(c);

    // ── Per-IP limit (checked first, so blocked requests never ──
    //    consume the shared global budget) ─────────────────────
    const prev   = ipWindows.get(ip) ?? { count: 0, resetAt: Date.now() + perIpWindowMs };
    const entry  = check(prev, perIpLimit, perIpWindowMs);
    ipWindows.set(ip, entry);
    if (ipWindows.size > MAX_TRACKED_IPS) prune(ipWindows);

    if (entry.count > perIpLimit) {
      const resets = new Date(entry.resetAt).toUTCString();
      c.header('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000))));
      return c.json(
        { error: `Rate limit exceeded. You can make ${perIpLimit} requests per ${windowLabel(perIpWindowMs)}. Resets at ${resets}.` },
        429
      );
    }

    // ── Global daily cap ──────────────────────────────────────
    globalEntry = check(globalEntry, globalDailyLimit, 86_400_000);
    if (globalEntry.count > globalDailyLimit) {
      const resets = new Date(globalEntry.resetAt).toUTCString();
      return c.json(
        { error: `Demo daily limit reached. Resets at ${resets}.` },
        429
      );
    }

    // Expose remaining count in response headers
    c.header('X-RateLimit-Limit',     String(perIpLimit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, perIpLimit - entry.count)));
    c.header('X-RateLimit-Reset',     String(Math.ceil(entry.resetAt / 1000)));

    await next();
  };
}
