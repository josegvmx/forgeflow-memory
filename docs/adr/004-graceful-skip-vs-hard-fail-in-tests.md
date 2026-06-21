# ADR 004 — Graceful skip (not hard fail) when DB or API keys are unavailable

**Status:** Accepted

## Context

Several test suites require external services that are not always available:

- `tests/recommendationCache.test.ts` — requires a live PostgreSQL instance with the schema applied.
- `tests/evals/memory.eval.ts` — requires PostgreSQL, an embedding API key (Voyage or OpenAI), and an Anthropic key for the faithfulness judge.

Two options for handling missing prerequisites were considered:

- **Hard fail**: throw an error or call `expect.fail()` at the top of the suite if the prerequisite is missing. The test run fails with a clear message.
- **Graceful skip**: detect the missing prerequisite at runtime and skip the affected tests using Vitest's `ctx.skip()`. The test run completes with skipped tests reported as yellow.

## Decision

Use **graceful skip via `ctx.skip()`** when external prerequisites are unavailable.

## Rationale

**CI runs without a DB by default.** The project's CI workflow (`.github/workflows/ci.yml`) runs `npm test` without a Docker Postgres service. Hard-failing on missing DB would make the unit test suite (which does not need Postgres) unrunnable in CI unless a DB service is added. Adding a DB service to CI solely to avoid skips would significantly increase CI runtime and complexity.

**Separation of concerns.** Unit tests (chunker, synthesize, audit, scenarioId, etc.) verify logic in isolation and should always pass. Integration tests (recommendationCache) and evals (memory.eval) verify live system behaviour and are opt-in based on environment. Graceful skip enforces this separation without requiring separate CI jobs.

**`ctx.skip()` over `console.log + return`.** The original implementation used `console.log(...); return` inside test bodies, causing skipped tests to appear as *passing* (green) in the Vitest reporter. This was misleading: reviewers saw "95 passing" without knowing 11 tests were no-ops. Replacing with `ctx.skip()` makes skipped tests appear as *skipped* (yellow), which is honest — the test was not run, not that it passed.

## Tradeoffs

| | Graceful skip | Hard fail |
|---|---|---|
| CI without DB | ✅ Unit tests still run | ❌ Entire suite fails |
| Visibility of missing prereqs | ⚠️ Yellow skip (easy to miss) | ✅ Red failure (impossible to ignore) |
| Integration test coverage in CI | ❌ Not verified unless DB added | ✅ Forced to add DB service |
| Developer experience locally | ✅ No setup required to run unit tests | ❌ Must have DB running for any `npm test` |

## Consequences

- **Positive:** `npm test` always runs the full unit suite regardless of environment.
- **Positive:** Skipped tests are visibly yellow in the reporter — not silently green.
- **Negative:** It is possible to merge code that breaks integration tests if no DB is available in CI. Mitigated by running `npm test` locally with DB before merging, and by the intention to add a DB service to CI in a future iteration.
- **Action item:** Consider adding a `docker-compose.yml` with Postgres + pgvector for local development and a `services:` block in `ci.yml` to enable integration tests in CI. This would let the CI reporter show red on DB failures rather than yellow skips.
