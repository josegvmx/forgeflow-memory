# forgeflow-memory

Persistence, retrieval, and audit layer for the ForgeFlow simulation system. Every simulation event — machine failures, routing adjustments, agent decisions, coalition handoffs — is stored here as a vector embedding and queried via semantic search. Claude or Ollama synthesises retrieved events into actionable recommendations.

Both `scenario-audit` and `genetic-inheritance` modules depend on this layer.

---

## Status

| Module | Status |
|---|---|
| Memory layer (store, ingest, retrieval, API) | ✅ Complete |
| Scenario audit (events, audit, recommend) | ✅ Complete |
| Recommendation cache | ✅ Complete |
| ForgeFlow-sim export integration | ✅ Complete |
| Genetic inheritance | 🔜 Next |

---

## Stack

- **Database:** PostgreSQL + pgvector (HNSW index + B-tree indexes on `scenario_id`, `event_type`)
- **Language:** TypeScript (ESM), strict mode
- **Validation:** Zod — all request bodies parsed and typed at the boundary
- **Embeddings:** Voyage AI `voyage-code-2` or OpenAI `text-embedding-3-small` (auto-detected from env)
- **Synthesis / Audit:** Claude Haiku (Anthropic) or Ollama (local, free) — switchable via env var
- **API:** Hono + `@hono/node-server`

---

## Project Structure

```
forgeflow-memory/
├── src/
│   ├── types.ts                        # Shared domain types (ReasoningEvent, MemoryQuery, MemoryResult)
│   ├── api/
│   │   ├── errors.ts                   # Error hierarchy: ValidationError (400), UpstreamError (503), AppError (500)
│   │   ├── server.ts                   # Hono app, mounts all routes, central onError handler
│   │   └── routes/
│   │       ├── ingest.ts               # POST /ingest  — Zod-validated
│   │       ├── query.ts                # POST /query   — Zod-validated
│   │       └── audit.ts                # POST /scenarios, /events, /audit, /recommend, GET /scenarios/:id/summary
│   ├── prompts/
│   │   ├── synthesize.ts               # SYSTEM_PROMPT + buildUserMessage()
│   │   ├── audit.ts                    # buildAuditPrompt()
│   │   └── judge.ts                    # JUDGE_PROMPT + buildJudgePrompt()
│   ├── lib/
│   │   └── retry.ts                    # withRetry — exponential backoff + per-attempt timeout
│   ├── store/
│   │   ├── schema.sql                  # pgvector table + HNSW + B-tree indexes + recommendations cache
│   │   ├── client.ts                   # postgres.js singleton + wrapDbError (DB errors → 503)
│   │   ├── upsert.ts                   # single + batch insert
│   │   └── recommendationCache.ts      # get/set/invalidate recommendation cache
│   ├── ingest/
│   │   ├── chunker.ts                  # format event → embeddable text
│   │   ├── embedder.ts                 # Voyage AI / OpenAI embedding wrapper (retried)
│   │   └── pipeline.ts                 # chunk → embed → upsert orchestration
│   ├── retrieval/
│   │   ├── query.ts                    # cosine similarity search + metadata filters
│   │   └── synthesize.ts               # Anthropic or Ollama synthesis over retrieved events (retried)
│   └── audit/
│       ├── scenarioId.ts               # deterministic scenario ID from config hash
│       ├── events.ts                   # MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent
│       ├── audit.ts                    # Claude audit: did agent follow its mode? (0-1 score, retried)
│       └── recommend.ts                # RAG-based failure recommendations + mode comparison (cached)
├── scripts/
│   ├── export.ts                       # dump DB back to archive JSON (npm run export)
│   └── explore-retrieval.ts            # inspect retrieved chunks + cosine distances (npm run explore)
├── docs/
│   └── adr/                            # Architecture Decision Records (MADR format)
│       ├── 001-pgvector-over-dedicated-vector-db.md
│       ├── 002-llm-as-judge-for-faithfulness.md
│       ├── 003-golden-fixtures-over-sampled-data.md
│       └── 004-graceful-skip-vs-hard-fail-in-tests.md
├── data/
│   └── sample-archive.json             # 14 sample events across 3 scenarios for seeding
├── tests/
│   ├── seed.ts                         # ingest sample data + run 3 validation queries
│   └── evals/
│       ├── fixtures/golden-set.json    # golden query set for RAG recall + faithfulness eval
│       ├── judge.ts                    # LLM-as-judge faithfulness evaluator
│       └── memory.eval.ts              # end-to-end eval suite (requires DB + API keys)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Setup

### 1. Start pgvector

```bash
docker run -d \
  --name forgeflow-memory \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=forgeflow \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in DATABASE_URL, VOYAGE_API_KEY or OPENAI_API_KEY, and ANTHROPIC_API_KEY
```

### 3. Apply schema

```bash
npm run db:migrate
```

### 4. Install and run

```bash
npm install
npm run dev       # starts on http://localhost:3001
```

### 5. Validate

```bash
npm run seed      # ingests 14 events, runs 3 test queries
```

---

## Environment Variables

```bash
# Database
DATABASE_URL=postgres://postgres:password@localhost:5432/forgeflow

# Embedding provider — pick one (Voyage preferred)
VOYAGE_API_KEY=
OPENAI_API_KEY=

# Synthesis provider: 'anthropic' (default) or 'ollama' (free, local)
SYNTHESIS_PROVIDER=anthropic
ANTHROPIC_API_KEY=

# Ollama settings (only needed if SYNTHESIS_PROVIDER=ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

### Using Ollama (free, local synthesis)

```bash
brew install ollama
ollama pull llama3.2
ollama serve
```

Then set `SYNTHESIS_PROVIDER=ollama` in `.env` and restart. No API key needed. The audit endpoint (`POST /audit`) still uses Anthropic for reliable JSON output.

---

## API Reference

All request bodies are validated by Zod at the route boundary. Validation failures return a structured 400 with field-level errors. Infrastructure failures (DB unavailable, upstream API unreachable) return 503.

### Memory Layer

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/ingest` | Ingest an array of `ReasoningEvent[]` — clears recommendation cache |
| `POST` | `/query` | Semantic search + synthesis |
| `GET` | `/health` | Health check |

**POST /ingest**
```json
{ "archive": [ReasoningEvent, ...] }
→ { "ingested": 14 }
```

**POST /query**
```json
{
  "context": "string",
  "topK": 5,
  "scenarioId?": "...",
  "nodeId?": "...",
  "eventTypeFilter?": ["machine_failure"],
  "debug?": false
}
→ { "events": [...], "summary": "synthesis", "_debugContext?": "..." }
```

`debug: true` includes `_debugContext` — the raw formatted string passed to the LLM. Used by the eval pipeline for faithfulness checks.

### Scenario Audit

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/scenarios` | Generate a deterministic scenario ID from config |
| `POST` | `/events` | Ingest a typed audit event (failure, adjustment, recovery) |
| `POST` | `/audit` | Evaluate mode consistency, returns 0–1 score |
| `POST` | `/recommend` | RAG recommendation — cached by (scenarioId, machineId, failureType, mode) |
| `GET` | `/scenarios/:id/summary` | All events + mode comparison for a scenario |

**POST /events** — `eventType` is required and drives the discriminated union validation:
```json
{
  "scenarioId": "scenario_abc",
  "nodeId": "machine-M1",
  "cycle": 10,
  "eventType": "machine_failure",
  "mode": "ai",
  "content": "M1 failed at cycle 10.",
  "metadata": { "machineId": "M1", "failureType": "breakdown", "affectedCapacity": 60, "affectedProducts": ["P1"] }
}
→ { "ok": true }
```

**POST /audit**
```json
{ "failure": MachineFailureEvent, "adjustments": [...], "outcome": RecoveryOutcomeEvent }
→ { "scenarioId": "...", "failureId": "M1_cycle10", "mode": "ai", "consistent": true, "score": 0.85, "deviations": [] }
```

**POST /recommend**
```json
{ "failure": MachineFailureEvent, "scopeToScenario?": false, "skipCache?": false }
→ { "recommendation": "...", "fromCache": true }
```

Cache hit returns instantly with zero embedding or LLM calls. Use `"skipCache": true` to force a fresh recommendation.

---

## Error Handling

The API distinguishes three error classes:

| Status | Class | Meaning |
|---|---|---|
| `400` | `ValidationError` | Bad request — missing or malformed fields (Zod error detail in body) |
| `503` | `UpstreamError` | Upstream unavailable — DB connection failure, Voyage/Anthropic/Ollama unreachable |
| `500` | `AppError` | Bug — unexpected internal error |

Callers can use the status code to decide whether to retry (`503`) or fix the request (`400`).

---

## Reliability

All external API calls are wrapped with `withRetry` (exponential backoff, 3 attempts, 10s per-attempt timeout):

- Voyage AI / OpenAI embedding calls (`src/ingest/embedder.ts`)
- Anthropic `messages.create` in synthesis and audit (`src/retrieval/synthesize.ts`, `src/audit/audit.ts`)
- Ollama `/api/chat` fetch (`src/retrieval/synthesize.ts`)

A single transient 429 or 502 from an upstream will retry automatically rather than failing the request.

---

## Utility Scripts

```bash
# Export all rows back to archive JSON
npm run export

# Export one scenario
npm run export -- --scenario scenario_a4c03c055c7d

# Custom output path
npm run export -- --output ./backups/run-001.json

# Explore retrieval — inspect which chunks a question retrieves and their cosine distances.
# Run this before writing golden-set fixtures to understand the actual retrieval boundary.
npm run explore -- --question "what caused the M2 failure?" --topK 10
npm run explore -- --question "..." --topK 5 --scenario scenario_eval_001
```

`npm run export` output goes to `data/` by default and is ready to feed straight into `POST /ingest` on a fresh DB.

---

## Running Tests

```bash
npm test              # unit tests (no DB or API keys required)
npm run test:watch    # watch mode
npm run test:eval     # RAG eval suite (requires DB + VOYAGE_API_KEY + ANTHROPIC_API_KEY)
```

Unit tests always pass regardless of environment. Integration tests (`recommendationCache`) and evals skip gracefully (shown as yellow in the reporter) when prerequisites are unavailable — they never report as false green.

---

## Exporting from ForgeFlow-sim

After running simulation cycles, click the **Memory (N)** button in the Configuration Manifest panel. This downloads a `forgeflow-memory-archive-{scenarioId}-{timestamp}.json` file ready for ingest:

```bash
curl -X POST http://localhost:3001/ingest \
  -H "Content-Type: application/json" \
  -d @forgeflow-memory-archive-scenario_xxxx.json
```

---

## Event Types

| Type | Used by |
|---|---|
| `machine_failure` | Memory layer, scenario-audit |
| `routing_adjustment` | Memory layer, scenario-audit |
| `decision` | Memory layer |
| `coalition` | Memory layer, genetic-inheritance (planned) |
| `recovery` | Scenario-audit |

---

## Architecture Decisions

Key design choices are documented in [`docs/adr/`](docs/adr/):

- [001 — pgvector over dedicated vector DB](docs/adr/001-pgvector-over-dedicated-vector-db.md)
- [002 — LLM-as-judge for faithfulness evaluation](docs/adr/002-llm-as-judge-for-faithfulness.md)
- [003 — Golden fixtures over sampled data](docs/adr/003-golden-fixtures-over-sampled-data.md)
- [004 — Graceful skip vs hard fail in tests](docs/adr/004-graceful-skip-vs-hard-fail-in-tests.md)

---

## Dependencies for Other Modules

| Module | Needs from here |
|---|---|
| `scenario-audit` | `ingestAuditEvent`, `ReasoningEvent`, `/events`, `/audit`, `/recommend` |
| `genetic-inheritance` | `queryMemory`, `synthesize`, `/query` |
