// ============================================================
// withRetry — exponential backoff + per-attempt timeout
//
// Wraps any async function with up to `retries` retry attempts.
// Each attempt races against a per-call timeout so a hung upstream
// does not stall the request indefinitely.
//
// Usage:
//   const result = await withRetry(() => client.messages.create(...));
// ============================================================

export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, backoffMs = 300, timeoutMs = 10_000 } = {}
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}
