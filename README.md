# forgeflow-memory

Persistence, retrieval, and audit layer for the ForgeFlow simulation system. Every simulation event — machine failures, routing adjustments, agent decisions, coalition handoffs — is stored here as a vector embedding and queried via semantic search. Claude or Ollama synthesises retrieved events into actionable recommendations.

The `scenario-audit` module (implemented here) builds on this layer; the planned `genetic-inheritance` module will use it as its fitness signal source.

> **Note:** forgeflow-memory currently works on exported ForgeFlow-sim runs (JSON archives). Live integration — agents reading memory during a running simulation — is the next step.

---

## Status

| Module | Status |
|---|---|
| Memory layer (store, ingest, retrieval, API) | ✅ Complete |
| Scenario audit (events, audit, recommend) | ✅ Complete |
| Recommendation cache | ✅ Complete |
| Export from ForgeFlow-sim (archived runs) | ✅ Complete |
| Live integration with running ForgeFlow-sim | 🔜 Next |
| Genetic inheritance | 🗓️ Planned |

---

## Stack

- **Database:** PostgreSQL + pgvector (HNSW index + B-tree indexes on `scenario_id`, `event_type`)
- **Language:** TypeScript (ESM), strict mode
- **Validation:** Zod — all request bodies parsed and typed at the boundary
- **Embeddings:** Voyage AI `voyage-code-2` or OpenAI `text-embedding-3-small` (auto-detected from env)
- **Synthesis / Audit:** Claude Haiku (Anthropic) or Ollama (local, free) — switchable via env var
- **API:** Hono + `@hono/node-server`
- **Rate limiting:** In-memory per-IP (10 req/hour) + global daily cap (200 req/day) on LLM endpoints
- **Demo UI:** React (CDN, no build step) served at `GET /` — query, scenario summary, and recommend tabs

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
├── public/
│   └── index.html                      # React demo UI (served at GET /)
├── scripts/
│   ├── export.ts                       # dump DB back to archive JSON (npm run export)
│   ├── explore-retrieval.ts            # inspect retrieved chunks + cosine distances (npm run explore)
│   └── deploy-seed.ts                  # idempotent seed for Railway deploys (npm run deploy:seed)
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
├── Dockerfile
├── railway.toml
├── DEPLOY.md                           # Step-by-step Railway deployment guide
├── ARCHITECTURE.md                     # System overview + data flow diagram
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
npm run deploy:seed   # apply schema + seed demo data (idempotent, used by Railway on deploy)
```

Unit tests always pass regardless of environment. Integration tests (`recommendationCache`) and evals skip gracefully (shown as yellow in the reporter) when prerequisites are unavailable — they never report as false green.

---

## Exporting from ForgeFlow-sim

After running simulation cycles, click the **Memory (N)** button in the Configuration Manifest panel. This downloads a `forgeflow-memory-archive-{scenarioId}-{timestamp}.json` file ready for ingest:

```bash
curl -X POST http://localhost:3001/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d @forgeflow-memory-archive-scenario_xxxx.json
```

`/ingest` requires `ADMIN_TOKEN` (see [Security](#security)).

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

## Demo UI

A React demo UI is served at `GET /` on the same host as the API (no separate deployment needed). It has three tabs:

- **Query** — natural language search with topK slider, scenario and event type filters, synthesis result, and suggested query chips
- **Scenario Summary** — all recorded events grouped by node with stats breakdown
- **Recommend** — RAG-based failure recommendation by machine + failure type + mode, with ⚡ cache hit indicator

No build step — React is loaded from CDN. The UI is a single file at `public/index.html`.

Live demo: [forgeflow-memory-production.up.railway.app](https://forgeflow-memory-production.up.railway.app)

---

## Security

The live demo is public, so the API treats every visitor as untrusted.

**Write and pipeline endpoints are admin-only.** `POST /ingest`, `POST /events`, `POST /scenarios` and `POST /audit` require `Authorization: Bearer $ADMIN_TOKEN` (or `X-Admin-Token`). If `ADMIN_TOKEN` is not set (or is shorter than 16 characters) these endpoints return `403`, which is the default for the demo. The startup seed runs in-process and is unaffected.

**Abuse and cost limits** on the public endpoints:

| Protection | Applies to | Limit |
|---|---|---|
| Per-IP rate limit | `/query`, `/recommend` (shared budget) | 10 requests / hour |
| Global rate limit | `/query`, `/recommend` | 200 requests / day |
| Concurrent LLM calls | `/query`, `/recommend` | 4 in flight (`MAX_CONCURRENT_LLM`), then `503` |
| Read rate limit | `GET /scenarios/:id/summary` | 30 requests / minute per IP |
| Request body size | public endpoints / admin endpoints | 16 KB / 5 MB |
| Input validation | `/query`, `/recommend` | question ≤ 500 chars, `topK` ≤ 15, IDs `[A-Za-z0-9_.:-]{1,64}` |

Cached `/recommend` answers don't count against the LLM budget. Requests blocked by the per-IP limit don't consume the global budget, so one client can't lock everyone out. Client IPs come from the proxy-appended (right-most) `X-Forwarded-For` entry, so rotating that header doesn't bypass the limit (`TRUST_PROXY_HOPS` if more proxies sit in front). Limiter memory is bounded. Error responses don't expose internal details.

These limits protect the API budget and the single instance. They are not volumetric DDoS protection. For that, put the service behind a CDN/WAF such as Cloudflare.

**Prompt injection** (`src/prompts/synthesize.ts`):

- Visitor questions and retrieved events go to the model inside `<question>` / `<events>` delimiters. The system prompt marks them as untrusted data and tells the model never to follow instructions found in them, never to reveal its instructions, and to answer only questions about the simulation.
- Input is normalised before prompting: control and zero-width characters are removed, attempts to forge the delimiter tags are neutralised, and length is capped.
- Common jailbreak phrasings ("ignore previous instructions", "reveal your system prompt", persona switches) get a fixed refusal before any embedding or LLM spend.
- Replies that leak the system prompt are replaced with the refusal, and the UI renders model output through DOMPurify under a strict Content-Security-Policy.
- Only ID-shaped values (validated by regex) are interpolated into the `/recommend` prompt, and the model has no tools, so a successful injection can at worst produce an off-topic answer.

---

## Deployment

See [DEPLOY.md](DEPLOY.md) for the full step-by-step Railway guide. In short:

```bash
# 1. Push repo to GitHub
# 2. Create Railway project → Deploy from GitHub
# 3. Add PostgreSQL plugin → enable vector extension
# 4. Set env vars (DATABASE_URL, VOYAGE_API_KEY, ANTHROPIC_API_KEY)
# 5. Set deploy command:
npm run deploy:seed && node dist/api/server.js
```

The deploy seed is idempotent — it skips ingestion if data already exists, so re-deploys are safe.

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
| `genetic-inheritance` *(planned)* | `queryMemory`, `synthesize`, `/query` |
