-- ============================================================
-- forgeflow-memory: pgvector schema
-- Run via: npm run db:migrate
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Core events table
-- Every simulation event (failure, decision, coalition, etc.)
-- is stored here as a single row with a 1536-dim embedding.
-- ============================================================
CREATE TABLE IF NOT EXISTS reasoning_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id TEXT        NOT NULL,
  node_id     TEXT        NOT NULL,
  cycle       INTEGER     NOT NULL,

  -- 'machine_failure' | 'routing_adjustment' | 'decision' | 'coalition'
  event_type  TEXT        NOT NULL
                CHECK (event_type IN (
                  'machine_failure',
                  'routing_adjustment',
                  'decision',
                  'coalition',
                  'recovery'
                )),

  -- 'heuristic' | 'ai'
  mode        TEXT        NOT NULL
                CHECK (mode IN ('heuristic', 'ai')),

  -- Human-readable description used as the embedding source
  content     TEXT        NOT NULL,

  -- Flexible payload: outcome, severity, affected_nodes, etc.
  metadata    JSONB,

  -- Dimension matches voyage-code-2 and text-embedding-3-small (both 1536)
  embedding   vector(1536),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes
-- ============================================================

-- Approximate nearest-neighbour search (cosine distance)
-- HNSW is preferred over ivfflat: no minimum-rows requirement,
-- works correctly at any dataset size, and is faster at query time.
-- m=16 (connections per layer) and ef_construction=64 are solid defaults;
-- raise ef_construction for better recall at the cost of slower index builds.
CREATE INDEX IF NOT EXISTS reasoning_events_embedding_idx
  ON reasoning_events
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Fast filtering by scenario_id alone (used in audit summary + cache lookups)
CREATE INDEX IF NOT EXISTS reasoning_events_scenario_id_idx
  ON reasoning_events (scenario_id);

-- Fast filtering by scenario + event type (used in POST /query with eventTypeFilter)
CREATE INDEX IF NOT EXISTS reasoning_events_scenario_type_idx
  ON reasoning_events (scenario_id, event_type);

-- Fast filtering by node (useful for genetic-inheritance queries)
CREATE INDEX IF NOT EXISTS reasoning_events_node_idx
  ON reasoning_events (node_id);

-- ============================================================
-- Recommendation cache
-- Stores synthesised recommendations keyed by failure pattern.
-- Same (scenario, machine, failure type, mode) = same answer,
-- so we skip the RAG + LLM call on repeated lookups.
-- ============================================================
CREATE TABLE IF NOT EXISTS recommendations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id    TEXT        NOT NULL,
  machine_id     TEXT        NOT NULL,
  failure_type   TEXT        NOT NULL,
  mode           TEXT        NOT NULL CHECK (mode IN ('heuristic', 'ai')),
  recommendation TEXT        NOT NULL,
  hit_count      INTEGER     NOT NULL DEFAULT 1,   -- how many times this was served from cache
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One cached recommendation per failure pattern + mode
  UNIQUE (scenario_id, machine_id, failure_type, mode)
);

CREATE INDEX IF NOT EXISTS recommendations_lookup_idx
  ON recommendations (scenario_id, machine_id, failure_type, mode);

-- ============================================================
-- De-duplication (idempotent — safe on every startup)
--
-- One row per (scenario, node, cycle, event type, mode, content).
-- content_hash is computed in the app by src/store/eventHash.ts;
-- the backfill below must use the exact same formula.
-- Re-ingesting an archive is now a no-op instead of adding copies.
-- ============================================================
ALTER TABLE reasoning_events ADD COLUMN IF NOT EXISTS content_hash TEXT;

UPDATE reasoning_events
SET content_hash = encode(sha256(convert_to(
      scenario_id || '|' || node_id || '|' || cycle::text || '|' ||
      event_type  || '|' || mode    || '|' || content, 'UTF8')), 'hex')
WHERE content_hash IS NULL;

-- Remove existing duplicates (keep one row per hash). If anything was
-- removed, cached recommendations were built on duplicated retrieval,
-- so clear them too.
WITH removed AS (
  DELETE FROM reasoning_events a
  USING reasoning_events b
  WHERE a.content_hash = b.content_hash
    AND a.ctid > b.ctid
  RETURNING 1
)
DELETE FROM recommendations WHERE EXISTS (SELECT 1 FROM removed);

CREATE UNIQUE INDEX IF NOT EXISTS reasoning_events_content_hash_idx
  ON reasoning_events (content_hash);
