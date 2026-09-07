/**
 * Decides whether a non-zero `vitest run` exit is a real failure or the known
 * event-loop-starvation artifact. Kept as a pure function so the rule — which
 * can turn a red run green — is auditable and covered by tests
 * (`vitest-exit-policy.test.mjs`). See `vitest-run.mjs` for the mechanism.
 */

/** Unhandled errors that are vitest's own reporting channel, not user code. */
const RPC_TIMEOUT =
  /\[vitest-(?:worker|pool)\]: Timeout calling "(?:onTaskUpdate|onCollected|onUserConsoleLog)"/g;
/** e.g. "Vitest caught 2 unhandled errors during the test run." */
const UNHANDLED_COUNT = /Vitest caught (\d+) unhandled error/;
/** The reporter's tallies, e.g. " Test Files  1 failed | 58 passed (59)". */
const SUMMARY_LINE = /^\s*(?:Test Files|Tests)\s+.*$/gm;

// eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * @param {object} input
 * @param {number} input.exitCode   vitest's exit code
 * @param {string} input.output     combined stdout+stderr
 * @param {string|null} [input.signal]  signal that killed vitest, if any
 * @param {boolean} [input.strict]  bypass suppression entirely
 * @returns {{suppress: boolean, reason: string, unhandledCount: number}}
 */
export function evaluateVitestExit({ exitCode, output, signal = null, strict = false }) {
  const no = (reason) => ({ suppress: false, reason, unhandledCount: 0 });

  if (exitCode === 0) return no('vitest already succeeded');
  if (strict) return no('VALIDITY_STRICT_VITEST=1 — suppression disabled');
  // A signal kill (SIGTERM/SIGKILL from a task runner or OOM) is never this
  // artifact, and leaves no trustworthy summary to reason about.
  if (signal) return no(`killed by ${signal}`);

  const clean = String(output).replace(ANSI, '');

  const summaries = clean.match(SUMMARY_LINE) ?? [];
  if (summaries.length === 0) {
    // No summary at all: a crash, a config error, or "no test files found".
    return no('vitest printed no result summary');
  }
  if (summaries.some((line) => line.includes('failed'))) {
    return no('vitest reported failing tests');
  }

  const unhandledCount = Number(clean.match(UNHANDLED_COUNT)?.[1] ?? 0);
  if (unhandledCount === 0) {
    // Non-zero with a clean summary and no unhandled errors — something we
    // don't understand. Never guess in the green direction.
    return no('non-zero exit with no unhandled errors to explain it');
  }

  const rpcTimeouts = (clean.match(RPC_TIMEOUT) ?? []).length;
  if (rpcTimeouts < unhandledCount) {
    return {
      suppress: false,
      reason: `${unhandledCount} unhandled error(s), only ${rpcTimeouts} were RPC timeouts`,
      unhandledCount,
    };
  }

  return {
    suppress: true,
    reason: `all ${unhandledCount} unhandled error(s) were vitest RPC-reporting timeouts`,
    unhandledCount,
  };
}
