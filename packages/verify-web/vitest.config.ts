import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live beside the sources they cover (src/, src/browse/, src/exporters/,
    // src/fidelity/). Matching src/** rather than the default repo-wide glob keeps
    // `templates/` and `stubs/` — which ship in the tarball — out of the run.
    include: ['src/**/*.test.ts'],
    // This package does the heaviest synchronous work in the repo (Babel
    // transforms, Vite dev-server boots), which is exactly what starves the
    // worker's poll phase and trips birpc's hardcoded 60s `onTaskUpdate`
    // timeout — a spurious "1 error" that exits 1 with every test passing.
    // See vitest.setup.ts for the full mechanism.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
