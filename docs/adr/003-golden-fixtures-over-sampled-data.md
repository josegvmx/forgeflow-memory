# ADR 003 — Use hand-crafted golden fixtures instead of sampled production data

**Status:** Accepted

## Context

The eval pipeline needs a ground-truth dataset to measure RAG recall and faithfulness. Two approaches were considered:

- **Sampled production data**: record real simulation runs, log which events were retrieved for which queries, and use those logs as ground truth.
- **Hand-crafted golden fixtures**: write a small set of synthetic events and queries by hand, with explicit `expectedChunkKeys` and `notExpectedFacts` per query.

## Decision

Use **hand-crafted golden fixtures** in `tests/evals/fixtures/golden-set.json`.

## Rationale

**Deterministic ground truth.** With sampled data, ground truth depends on the embedding model and retrieval parameters in use at sample time. If either changes, the ground truth is stale and must be re-collected. With hand-crafted fixtures, the expected chunks are declared explicitly and remain correct regardless of model version — the eval measures whether the *current* system finds the *intended* chunks.

**Control over retrieval difficulty.** Hand-crafted events can be designed so that expected and unexpected facts have a clear semantic boundary. Sampled production data tends to be noisy: related events cluster together in embedding space, making it hard to define `notExpectedFacts` that are reliably below the retrieval boundary.

**Zero infrastructure dependency for fixture creation.** Sampling production data requires a running simulation, a live DB, and a logged trace. Writing fixture JSON requires only a text editor. This matters for onboarding new contributors.

**Limitation acknowledged.** The current fixture set (5 queries, ~15 events) has no distribution coverage. It was designed around a single failure scenario (M2 bearing breakdown) and does not represent the full diversity of ForgeFlow simulation runs. Recall scores on this fixture set do not generalise to production query distributions.

## Consequences

- **Positive:** Fixture creation is fast, deterministic, and requires no running infrastructure.
- **Positive:** `expectedChunkKeys` are stable across embedding model changes (they reference nodeId+cycle pairs, not embedding distances).
- **Positive:** `notExpectedFacts` can be precisely chosen to test the retrieval boundary rather than relying on what happened to be sampled.
- **Negative:** Small fixture set (5 queries) may miss retrieval failures that only appear at scale or in edge-case scenarios.
- **Negative:** Fixture events are synthetic — they don't reflect the vocabulary distribution of real ForgeFlow logs, which could hide embedding model mismatches.
- **Action required:** Before expanding the fixture set, run `scripts/explore-retrieval.ts` for each new query to observe actual retrieval distances, then design `notExpectedFacts` around the observed boundary rather than intuition. Document observed distances in a `_retrieval_notes` field per query.
