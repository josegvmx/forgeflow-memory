import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';

// ============================================================
// Security middleware for the public demo deployment.
//
//   requireAdminToken — guards write / pipeline endpoints
//   concurrencyLimit  — caps simultaneous expensive (LLM) requests
//   getClientIp       — proxy-aware client IP for rate limiting
// ============================================================

/**
 * Client IP for rate limiting.
 *
 * The left-most X-Forwarded-For entry is whatever the client sent, so an
 * attacker can rotate it to dodge per-IP limits. The right-most entry is the
 * one appended by the closest proxy (Railway's edge), which the client cannot
 * forge. Set TRUST_PROXY_HOPS if more trusted proxies sit in front.
 */
export function getClientIp(c: Context): string {
  const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS ?? 1));
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Require `Authorization: Bearer <ADMIN_TOKEN>` (or `X-Admin-Token`).
 * If ADMIN_TOKEN is not set, the guarded endpoints are disabled entirely —
 * the safe default for a public demo that only needs read access.
 */
export function requireAdminToken() {
  return async (c: Context, next: Next) => {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || expected.length < 16) {
      return c.json({ error: 'This endpoint is disabled on this deployment.' }, 403);
    }
    const auth = c.req.header('authorization');
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('x-admin-token');
    if (!given || !timingSafeEqual(sha256(given), sha256(expected))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

/**
 * Reject new requests with 503 while `max` are already in flight.
 * Protects the LLM budget and the event loop from bursts that slip past
 * per-IP limits (e.g. many IPs at once).
 */
export function concurrencyLimit(max: number) {
  let inFlight = 0;
  return async (c: Context, next: Next) => {
    if (inFlight >= max) {
      c.header('Retry-After', '5');
      return c.json({ error: 'The demo is busy right now. Please try again in a few seconds.' }, 503);
    }
    inFlight++;
    try {
      await next();
    } finally {
      inFlight--;
    }
  };
}
