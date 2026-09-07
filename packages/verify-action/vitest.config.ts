import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The action ships a single dependency-free `post-check.cjs`; the test file
    // sits beside it (no `src/`), so match the package root, not `src/`.
    include: ['*.test.ts'],
    // See vitest.setup.ts: guards against the spurious `onTaskUpdate` RPC
    // timeout that exits 1 with a fully green suite.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
