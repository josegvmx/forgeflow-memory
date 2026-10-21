# Deploying to Railway (free tier)

Railway provides free managed Postgres with pgvector support. The whole setup takes about 10 minutes.

---

## Prerequisites

- A [Railway account](https://railway.app) (free, GitHub login)
- The repo pushed to GitHub
- A Voyage AI or OpenAI API key (for embeddings)
- An Anthropic API key (for synthesis + audit)

---

## Step 1 — Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo** → select `forgeflow-memory`
3. Railway detects the `Dockerfile` automatically

---

## Step 2 — Add Postgres with pgvector

1. In your Railway project, click **+ Add Service** → **Database** → **PostgreSQL**
2. Once provisioned, click the Postgres service → **Variables** tab
3. Note the `DATABASE_PRIVATE_URL` value — you'll reference it in Step 3

Then enable the pgvector extension. In the Postgres service → **Query** tab, run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Step 3 — Set environment variables

In your Railway app service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_PRIVATE_URL}}` |
| `VOYAGE_API_KEY` | your Voyage AI key — **or** |
| `OPENAI_API_KEY` | your OpenAI key (if using OpenAI embeddings) |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `SYNTHESIS_PROVIDER` | `anthropic` |
| `PORT` | `3001` |

> Use `${{Postgres.DATABASE_PRIVATE_URL}}` (Railway variable reference syntax) so it updates automatically if credentials rotate.

---

## Step 4 — Deploy

Click **Deploy** (or push to your GitHub branch). The `railway.toml` already sets the correct start command:

```
npm run deploy:seed; node dist/api/server.js
```

This runs the Node-based migration + idempotent seed, then starts the server. The `;` ensures the server starts even if the seed step fails. Re-deploys are safe — the seed skips ingestion if data already exists.

---

## Step 5 — Generate a public URL

After the deploy succeeds:

1. Click your service → **Settings** → **Networking**
2. Click **Generate Domain**
3. Your app is live at `https://forgeflow-memory-production.up.railway.app`

The React demo UI loads at the root URL. The API endpoints are on the same domain.

---

## Verify

```bash
curl https://<your-railway-url>/health
# → {"status":"ok"}
```

---

## Free tier limits

Railway's free tier gives you $5/month of credit. This stack (1 API container + Postgres) typically uses ~$2–3/month at demo traffic levels. The service sleeps after inactivity and wakes on the next request (~2s cold start).

---

## Re-seeding

To manually reset demo data:

1. In the Postgres query tab, run: `DELETE FROM reasoning_events; DELETE FROM recommendations;`
2. Redeploy — the seed runs again on startup
