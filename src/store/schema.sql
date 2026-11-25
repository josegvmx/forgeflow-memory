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

  -- 'machine_failure' | 'routing_adjustment' | 'decision' | 'coalition' | 'recovery' | 'disruption'
  -- (keep in sync with EVENT_TYPES in src/types.ts and the R14 block below)
  event_type  TEXT        NOT NULL
                CHECK (event_type IN (
                  'machine_failure',
                  'routing_adjustment',
                  'decision',
                  'coalition',
                  'recovery',
                  'disruption'
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
-- R14 (roadmap §4.1, §4.3) — idempotent, safe on every startup
-- ============================================================

-- The run an event came from (UUID from forgeflow-sim). Nullable: events stored
-- before R14 have none, and keep their content_hash (see eventHash.ts).
ALTER TABLE reasoning_events ADD COLUMN IF NOT EXISTS run_id UUID;

-- 'disruption' events (stock-outs, transporter loss). CREATE TABLE IF NOT EXISTS
-- leaves an existing table's CHECK untouched, so widen it here: drop every CHECK
-- on event_type that doesn't allow 'disruption' yet (whatever it is named), then
-- add the current one. Does nothing once applied.
DO $$
DECLARE c record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reasoning_events'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%event_type%'
      AND pg_get_constraintdef(oid) LIKE '%disruption%'
  ) THEN
    FOR c IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'reasoning_events'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%event_type%'
    LOOP
      EXECUTE format('ALTER TABLE reasoning_events DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE reasoning_events ADD CONSTRAINT reasoning_events_event_type_check
      CHECK (event_type IN ('machine_failure', 'routing_adjustment', 'decision', 'coalition', 'recovery', 'disruption'));
  END IF;
END $$;

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

-- Run lookups (replay, run rows, postmortems). Partial: pre-R14 rows have no run.
CREATE INDEX IF NOT EXISTS reasoning_events_run_id_idx
  ON reasoning_events (run_id) WHERE run_id IS NOT NULL;

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
-- One row per (scenario, node, cycle, event type, mode, content[, run]).
-- content_hash is computed in the app by src/store/eventHash.ts;
-- the backfill below must use the exact same formula.
-- Re-ingesting an archive is now a no-op instead of adding copies.
-- ============================================================
ALTER TABLE reasoning_events ADD COLUMN IF NOT EXISTS content_hash TEXT;

UPDATE reasoning_events
SET content_hash = encode(sha256(convert_to(
      scenario_id || '|' || node_id || '|' || cycle::text || '|' ||
      event_type  || '|' || mode    || '|' || content ||
      COALESCE('|' || run_id::text, ''), 'UTF8')), 'hex')
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

-- ============================================================
-- R14 phase 3 — benchmark rows (roadmap §4.5), one per run
--
-- Written by POST /runs (admin) from forgeflow-sim's replayToRows /
-- eval export. Plain columns so a comparison is a GROUP BY
-- (provider, model, flags…). The honesty columns
-- (llm_decision_share, llm_priced_bid_share, fallbacks, truncated,
-- rate_limited) say how much of an AI run was really the LLM.
-- Upsert on run_id: eval runs have deterministic ids, so a re-export
-- replaces the row instead of adding a copy.
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  run_id                 UUID        PRIMARY KEY,
  scenario_id            TEXT        NOT NULL,
  scenario_name          TEXT        NOT NULL,
  source                 TEXT        NOT NULL CHECK (source IN ('eval', 'app')),
  provider               TEXT        NOT NULL,            -- 'heuristic' when AI was off
  model                  TEXT,
  flags                  JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- flat
  seed                   BIGINT,                          -- null for app runs
  cycles                 INTEGER     NOT NULL,
  breakdown_rate         DOUBLE PRECISION,
  faults                 JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- flat list of labels
  units                  INTEGER     NOT NULL,
  plan_done_cycle        INTEGER,
  avg_lead_time_s        DOUBLE PRECISION,
  cycles_to_recover_mean DOUBLE PRECISION,
  rescues                INTEGER     NOT NULL DEFAULT 0,
  double_awards          INTEGER     NOT NULL DEFAULT 0,
  llm_calls              INTEGER     NOT NULL DEFAULT 0,
  tokens_in              BIGINT      NOT NULL DEFAULT 0,
  tokens_out             BIGINT      NOT NULL DEFAULT 0,
  cost_usd               DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_p50_ms         DOUBLE PRECISION,
  latency_p95_ms         DOUBLE PRECISION,
  llm_decision_share     DOUBLE PRECISION CHECK (llm_decision_share BETWEEN 0 AND 1),
  llm_priced_bid_share   DOUBLE PRECISION CHECK (llm_priced_bid_share BETWEEN 0 AND 1),
  fallbacks              INTEGER     NOT NULL DEFAULT 0,
  truncated              INTEGER,                         -- null: not recorded separately (older rows)
  rate_limited           INTEGER     NOT NULL DEFAULT 0,
  empty_replies          INTEGER     NOT NULL DEFAULT 0,
  timeouts               INTEGER     NOT NULL DEFAULT 0,
  replay_url             TEXT,
  created_at             TIMESTAMPTZ NOT NULL,            -- when the run was recorded
  stored_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_scenario_idx ON runs (scenario_id);
CREATE INDEX IF NOT EXISTS runs_provider_model_idx ON runs (provider, model);

-- ============================================================
-- R14 phase 3 — full-text search for hybrid retrieval
--
-- Generated from content, so every insert path fills it with no app
-- code and no backfill. Hybrid retrieval fuses this ranking
-- (ts_rank_cd over plainto/websearch_to_tsquery('english', …)) with
-- the pgvector ranking by reciprocal rank fusion. Adding it rewrites
-- the table once (small); afterwards both statements are no-ops.
-- Every read names its columns, so it never reaches API responses.
-- ============================================================
ALTER TABLE reasoning_events ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS reasoning_events_content_tsv_idx
  ON reasoning_events USING gin (content_tsv);

-- ============================================================
-- R14 phase 3 — embedding cache, one vector per (model, text)
--
-- Many events share their embedding text (templated sentences across
-- seeds: ~8.7k distinct texts in 19k eval episodes), so the pipeline
-- embeds each distinct text once per model and reuses it; re-imports
-- and a second embedding model only pay for texts not seen before.
-- text_hash = sha256 of the exact embedding text (src/ingest/chunker.ts);
-- reasoning_events.embed_text_hash links an event to its cache entry.
-- ============================================================
CREATE TABLE IF NOT EXISTS embedding_cache (
  model      TEXT        NOT NULL,
  text_hash  TEXT        NOT NULL,
  embedding  vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model, text_hash)
);

ALTER TABLE reasoning_events ADD COLUMN IF NOT EXISTS embed_text_hash TEXT;

-- ============================================================
-- Repair (2026-11-24): jsonb written as a JSON string
--
-- postgres.js serializes jsonb parameters with JSON.stringify itself; the
-- code passed JSON.stringify(obj), so values were stored double-encoded
-- (a jsonb string holding the JSON text). Writes now use db.json(obj).
-- Turn stored strings back into objects. Idempotent: no rows match once
-- repaired.
-- ============================================================
UPDATE reasoning_events SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE runs SET flags  = (flags  #>> '{}')::jsonb WHERE jsonb_typeof(flags)  = 'string';
UPDATE runs SET faults = (faults #>> '{}')::jsonb WHERE jsonb_typeof(faults) = 'string';

-- ============================================================
-- R14 phase 3 — embedding spaces for the retrieval eval
--
-- An event's embedding text under each variant (src/ingest/chunker.ts:
-- default, no-scenario, content-only), by hash. With embedding_cache
-- (model, text_hash) this gives every event a vector per (model, variant)
-- without new vector columns; the eval searches a space exactly.
-- Filled by `npm run embed:variant`; the live store only uses
-- reasoning_events.embedding.
-- ============================================================
CREATE TABLE IF NOT EXISTS event_text_variants (
  event_id   UUID NOT NULL REFERENCES reasoning_events(id) ON DELETE CASCADE,
  variant    TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  PRIMARY KEY (event_id, variant)
);

CREATE INDEX IF NOT EXISTS event_text_variants_hash_idx ON event_text_variants (variant, text_hash);
