import { defineConfig } from 'vitest/config';

/**
 * Separate vitest config so the regular `pnpm test` run never accidentally
 * picks up the e2e suite (which spends real Anthropic tokens).
 *
 * Trigger with `pnpm --filter validity test:e2e` (or `pnpm test:e2e` at the
 * repo root). Skipped automatically unless VALIDITY_E2E=1.
 */
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    // E2E hops the real network + an LLM. 5min per test is generous but
    // matches what we'd give a human running `validity validate` by hand.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // No parallelism — one test at a time keeps Anthropic rate limits sane
    // and makes failures easier to read.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
