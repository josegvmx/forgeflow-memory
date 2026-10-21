# ── Stage 1: build ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: production ──────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output and runtime assets
COPY --from=builder /app/dist ./dist
COPY src/store/schema.sql ./src/store/schema.sql
COPY data ./data
COPY tests/seed.ts ./tests/seed.ts
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Install tsx for seed script (needed at runtime for seeding)
RUN npm install -g tsx

EXPOSE 3001

CMD ["node", "dist/api/server.js"]
