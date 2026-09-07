import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // See vitest.setup.ts: guards against the spurious `onTaskUpdate` RPC
    // timeout that exits 1 with a fully green suite.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
