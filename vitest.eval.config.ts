import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';

loadDotenv(); // load .env so DATABASE_URL, API keys etc. are available

/**
 * Vitest config for the eval suite.
 *
 * Run with:  npm run test:eval
 *
 * Differences from the unit-test config:
 *   - Only picks up *.eval.ts files (tests/evals/)
 *   - 60s per-test timeout (embedding + LLM-as-judge calls are slow)
 *   - Runs tests sequentially (no parallel) to avoid rate-limit issues
 *   - Loads .env automatically via dotenv
 */
export default defineConfig({
  test: {
    environment:  'node',
    include:      ['tests/evals/**/*.eval.ts'],
    globals:      true,
    testTimeout:  60_000,
    hookTimeout:  60_000,
    pool:         'forks',
    poolOptions: {
      forks: { singleFork: true },   // sequential — one test at a time
    },
    env: {
      // Ensure dotenv is loaded; actual values come from .env file
      NODE_ENV: 'test',
    },
  },
});
