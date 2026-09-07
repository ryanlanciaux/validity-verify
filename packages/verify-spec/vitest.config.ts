import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Keeps the worker's event loop serviceable between tests so birpc's
    // hardcoded 60s `onTaskUpdate` timeout can't fire on an answered call and
    // exit 1 with every test green. See the file for the full mechanism.
    setupFiles: ['../../vitest.setup.ts'],
    // run.test.ts exercises the real prepareVerification path: ts-morph cold
    // start, git invocation, filesystem I/O. Default 5s is nowhere near enough.
    //
    // 30s was still too tight and produced load-dependent false negatives: the
    // "renders EVERY declared target … (no silent drop)" cap-test parses 7
    // fixture files and was measured at 25.5s idle and 30.7s under a concurrent
    // lint — i.e. it failed on wall-clock, not on behaviour. Anything that fits
    // in 30s of CPU can exceed 30s of wall-clock on a loaded CI runner, so the
    // budget has to have real headroom over the work, not track it. 90s still
    // catches a genuine hang (these tests are seconds, not minutes) while
    // leaving contention room. Config-driven via `VITEST_TIMEOUT_MS`.
    testTimeout: Number(process.env.VITEST_TIMEOUT_MS) || 90_000,
    // Same reasoning for setup/teardown: the default 10s is thin for hooks that
    // build ts-morph fixture projects on a contended box.
    hookTimeout: Number(process.env.VITEST_TIMEOUT_MS) || 90_000,
  },
});
