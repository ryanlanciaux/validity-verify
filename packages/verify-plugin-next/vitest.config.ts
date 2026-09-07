import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live beside the sources they cover.
    include: ['src/**/*.test.ts'],
    // Keeps the worker's event loop serviceable between tests so birpc's
    // hardcoded 60s `onTaskUpdate` timeout can't fire on an answered call and
    // exit 1 with every test green. See vitest.setup.ts for the mechanism.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
