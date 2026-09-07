import { defineConfig } from 'vitest/config';

// Pure string renderers — no browsers, no sandbox, no long synchronous
// stretches. Threads pool + the shared setup file, matching the repo posture.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'threads',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
