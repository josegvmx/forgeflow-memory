# ADR 001 — Use pgvector instead of a dedicated vector database

**Status:** Accepted

## Context

forgeflow-memory needs to store `ReasoningEvent` records and retrieve them by cosine similarity so the synthesis layer can answer natural-language questions about past simulation runs. The two mainstream options were:

- **Dedicated vector DB** (Pinecone, Weaviate, Qdrant, Chroma): purpose-built for vector search, managed or self-hosted, separate service to operate.
- **pgvector**: PostgreSQL extension that adds a `vector` column type and ANN indexes (HNSW, IVFFlat) on top of an ordinary Postgres table.

The project already uses PostgreSQL for the recommendation cache (`recommendations` table), so both options were evaluated against that baseline.

## Decision

Use **pgvector with an HNSW index** (`vector_cosine_ops`, m=16, ef_construction=64).

## Rationale

**Operational simplicity.** The project runs a single Postgres instance (Docker locally, managed PG in CI/cloud). Adding pgvector requires one `CREATE EXTENSION IF NOT EXISTS vector` line; it does not require running, monitoring, or paying for a second service. A dedicated vector DB would add a second failure domain, a second set of credentials, and a second backup concern.

**Sufficient performance.** At the dataset sizes expected for ForgeFlow (thousands to tens of thousands of events per scenario), HNSW delivers sub-millisecond ANN search. Benchmarks from the pgvector team show HNSW recall >0.99 at 10ms latency up to ~1M vectors — well beyond our scale. A dedicated vector DB would offer marginal latency gains that are invisible behind the embedding API round-trip (50–200ms).

**Transactional consistency.** Events are written and queried inside the same Postgres connection. pgvector lets us read events within a transaction, keeping the vector index and relational data consistent. With a dedicated vector DB we would need to manage two-phase consistency manually.

**Cost.** pgvector is free. Managed vector DBs charge per vector stored and per query; at scale this becomes non-trivial.

## Consequences

- **Positive:** Single service to operate, single backup, single connection string, no new auth flow.
- **Positive:** Full SQL filtering (scenario_id, event_type) applied before ANN — no post-filter approximation.
- **Negative:** pgvector HNSW index is not distributed; if we ever need horizontal shale at >100M vectors we would need to re-evaluate (likely Citus + pgvector, or migration to a dedicated DB).
- **Negative:** Index builds are in-process; a very large backfill will block the Postgres server for a brief period.
