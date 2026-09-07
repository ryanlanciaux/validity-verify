import { describe, expect, it } from 'vitest';
import { evaluateVitestExit } from './vitest-exit-policy.mjs';

/** The real tail of a run that hit the artifact (trimmed, ANSI stripped). */
const ARTIFACT_OUTPUT = `
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4/node_modules/vitest/dist/chunks/rpc.js:53:10
 ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4/node_modules/vitest/dist/chunks/index.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17

 Test Files  59 passed (59)
      Tests  1351 passed (1351)
     Errors  1 error
   Duration  471.95s
`;

const REAL_FAILURE_OUTPUT = `
 FAIL  src/thing.test.ts > does the thing
AssertionError: expected 1 to be 2

 Test Files  1 failed | 58 passed (59)
      Tests  1 failed | 1350 passed (1351)
`;

describe('evaluateVitestExit', () => {
  it('suppresses a non-zero exit whose only error is the onTaskUpdate RPC timeout', () => {
    const result = evaluateVitestExit({ exitCode: 1, output: ARTIFACT_OUTPUT });
    expect(result.suppress).toBe(true);
    expect(result.unhandledCount).toBe(1);
  });

  it('strips ANSI colour before matching', () => {
    const coloured = ARTIFACT_OUTPUT.replace('Test Files', '\x1b[1mTest Files\x1b[22m');
    expect(evaluateVitestExit({ exitCode: 1, output: coloured }).suppress).toBe(true);
  });

  it('NEVER suppresses a genuine test failure', () => {
    const result = evaluateVitestExit({ exitCode: 1, output: REAL_FAILURE_OUTPUT });
    expect(result.suppress).toBe(false);
    expect(result.reason).toMatch(/failing tests/);
  });

  it('never suppresses a failure that also carries the artifact', () => {
    // A real failure must win even when an RPC timeout happens in the same run.
    const both = REAL_FAILURE_OUTPUT + ARTIFACT_OUTPUT;
    expect(evaluateVitestExit({ exitCode: 1, output: both }).suppress).toBe(false);
  });

  it('never suppresses an unhandled error from product code', () => {
    const productError = ARTIFACT_OUTPUT.replace(
      'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
      'Error: connect ECONNREFUSED 127.0.0.1:5173',
    );
    const result = evaluateVitestExit({ exitCode: 1, output: productError });
    expect(result.suppress).toBe(false);
    expect(result.reason).toMatch(/only 0 were RPC timeouts/);
  });

  it('never suppresses when only some unhandled errors are RPC timeouts', () => {
    const mixed = ARTIFACT_OUTPUT.replace(
      'Vitest caught 1 unhandled error',
      'Vitest caught 2 unhandled errors',
    );
    expect(evaluateVitestExit({ exitCode: 1, output: mixed }).suppress).toBe(false);
  });

  it('never suppresses a crash with no summary (config error, no test files)', () => {
    const result = evaluateVitestExit({
      exitCode: 1,
      output: 'No test files found, exiting with code 1',
    });
    expect(result.suppress).toBe(false);
    expect(result.reason).toMatch(/no result summary/);
  });

  it('never suppresses a non-zero exit it cannot explain', () => {
    const noErrors = `
 Test Files  59 passed (59)
      Tests  1351 passed (1351)
`;
    const result = evaluateVitestExit({ exitCode: 1, output: noErrors });
    expect(result.suppress).toBe(false);
    expect(result.reason).toMatch(/no unhandled errors/);
  });

  it('never suppresses a signal kill (SIGTERM/OOM)', () => {
    const result = evaluateVitestExit({
      exitCode: 143,
      output: ARTIFACT_OUTPUT,
      signal: 'SIGTERM',
    });
    expect(result.suppress).toBe(false);
    expect(result.reason).toMatch(/SIGTERM/);
  });

  it('honours VALIDITY_STRICT_VITEST', () => {
    const result = evaluateVitestExit({ exitCode: 1, output: ARTIFACT_OUTPUT, strict: true });
    expect(result.suppress).toBe(false);
  });

  it('leaves a successful run alone', () => {
    expect(evaluateVitestExit({ exitCode: 0, output: '' }).suppress).toBe(false);
  });
});
