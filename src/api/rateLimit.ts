import type { Context, Next } from 'hono';

// ============================================================
// Simple in-memory rate limiter.
//
// Two layers:
//   1. Per-IP:    max N requests per window (default 10/hour)
//   2. Global:    max M requests per day across all IPs
//
// Resets automatically when the window expires.
// Uses a Map so it's lightweight — fine for a single-instance demo.
// ============================================================

interface WindowEntry {
  count:     number;
  resetAt:   number; // epoch ms
}

const ipWindows    = new Map<string, WindowEntry>();
let globalEntry: WindowEntry = { count: 0, resetAt: Date.now() + 86_400_000 };

function getIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

function check(entry: WindowEntry, limit: number, windowMs: number): WindowEntry {
  const now = Date.now();
  if (now > entry.resetAt) {
    return { count: 1, resetAt: now + windowMs };
  }
  return { ...entry, count: entry.count + 1 };
}

export interface RateLimitOptions {
  /** Max requests per IP per windowMs. Default: 10 */
  perIpLimit?: number;
  /** Window duration in ms for per-IP limit. Default: 3_600_000 (1 hour) */
  perIpWindowMs?: number;
  /** Global max requests per day. Default: 200 */
  globalDailyLimit?: number;
}

export function rateLimit(opts: RateLimitOptions = {}) {
  const {
    perIpLimit      = 10,
    perIpWindowMs   = 3_600_000,   // 1 hour
    globalDailyLimit = 200,
  } = opts;

  return async (c: Context, next: Next) => {
    const ip = getIp(c);

    // ── Global daily cap ──────────────────────────────────────
    globalEntry = check(globalEntry, globalDailyLimit, 86_400_000);
    if (globalEntry.count > globalDailyLimit) {
      const resets = new Date(globalEntry.resetAt).toUTCString();
      return c.json(
        { error: `Demo daily limit reached. Resets at ${resets}.` },
        429
      );
    }

    // ── Per-IP limit ──────────────────────────────────────────
    const prev   = ipWindows.get(ip) ?? { count: 0, resetAt: Date.now() + perIpWindowMs };
    const entry  = check(prev, perIpLimit, perIpWindowMs);
    ipWindows.set(ip, entry);

    if (entry.count > perIpLimit) {
      const resets = new Date(entry.resetAt).toUTCString();
      return c.json(
        { error: `Rate limit exceeded. You can make ${perIpLimit} requests per hour. Resets at ${resets}.` },
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
