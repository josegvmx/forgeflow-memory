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

- **Database:** PostgreSQL + pgvector (HNSW index, cosine similarity)
- **Language:** TypeScript (ESM)
- **Embeddings:** Voyage AI `voyage-code-2` or OpenAI `text-embedding-3-small` (auto-detected from env)
- **Synthesis / Audit:** Claude Haiku (Anthropic) or Ollama (local, free) — switchable via env var
- **API:** Hono + `@hono/node-server`

---

## Project Structure

```
forgeflow-memory/
├── src/
│   ├── types.ts                        # Shared domain types (ReasoningEvent, MemoryQuery, MemoryResult)
│   ├── store/
│   │   ├── schema.sql                  # pgvector table + HNSW index + recommendations cache table
│   │   ├── client.ts                   # postgres.js singleton
│   │   ├── upsert.ts                   # single + batch insert
│   │   └── recommendationCache.ts      # get/set/invalidate recommendation cache
│   ├── ingest/
│   │   ├── chunker.ts                  # format event → embeddable text
│   │   ├── embedder.ts                 # Voyage AI / OpenAI embedding wrapper
│   │   └── pipeline.ts                 # chunk → embed → upsert orchestration
│   ├── retrieval/
│   │   ├── query.ts                    # cosine similarity search + metadata filters
│   │   └── synthesize.ts               # Anthropic or Ollama synthesis over retrieved events
│   ├── audit/
│   │   ├── scenarioId.ts               # deterministic scenario ID from config hash
│   │   ├── events.ts                   # MachineFailureEvent, RoutingAdjustmentEvent, RecoveryOutcomeEvent
│   │   ├── audit.ts                    # Claude audit: did agent follow its mode? (0-1 score)
│   │   └── recommend.ts                # RAG-based failure recommendations + mode comparison (cached)
│   └── api/
│       ├── server.ts                   # Hono app, mounts all routes
│       └── routes/
│           ├── ingest.ts               # POST /ingest
│           ├── query.ts                # POST /query
│           └── audit.ts                # POST /scenarios, /events, /audit, /recommend, GET /scenarios/:id/summary
├── scripts/
│   └── export.ts                       # dump DB back to archive JSON (npm run export)
├── data/
│   └── sample-archive.json             # 14 sample events across 3 scenarios for seeding
├── tests/
│   └── seed.ts                         # ingest sample data + run 3 validation queries
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
{ "context": "string", "topK": 5, "scenarioId?": "...", "nodeId?": "...", "eventTypeFilter?": ["machine_failure"] }
→ { "events": [...], "summary": "synthesis" }
```

### Scenario Audit

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/scenarios` | Generate a deterministic scenario ID from config |
| `POST` | `/events` | Ingest a typed audit event (failure, adjustment, recovery) |
| `POST` | `/audit` | Evaluate mode consistency, returns 0–1 score |
| `POST` | `/recommend` | RAG recommendation — cached by (scenarioId, machineId, failureType, mode) |
| `GET` | `/scenarios/:id/summary` | All events + mode comparison for a scenario |

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

## Utility Scripts

```bash
# Export all rows back to archive JSON
npm run export

# Export one scenario
npm run export -- --scenario scenario_a4c03c055c7d

# Custom output path
npm run export -- --output ./backups/run-001.json
```

Output goes to `data/` by default. File is ready to feed straight into `POST /ingest` on a fresh DB.

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

## Dependencies for Other Modules

| Module | Needs from here |
|---|---|
| `scenario-audit` | `ingestAuditEvent`, `ReasoningEvent`, `/events`, `/audit`, `/recommend` |
| `genetic-inheritance` | `queryMemory`, `synthesize`, `/query` |
