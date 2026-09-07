#!/usr/bin/env node
/**
 * `vitest run` wrapper that makes the exit code mean what it says.
 *
 * THE PROBLEM
 *
 * Vitest workers talk to the main process over birpc with a **hardcoded 60s
 * timeout** (`DEFAULT_TIMEOUT` in vitest/dist/chunks/index.*.js — `timeout` is
 * read off an options object the worker builds internally, so there is no
 * config knob and no env var). After each task a worker issues an awaited
 * `onTaskUpdate` RPC and waits for the main process to answer.
 *
 * The heavy suites here (core's ts-morph parsing, sandbox's Babel/Vite work) do
 * long stretches of *synchronous* CPU work. Sync work drains only the microtask
 * queue — the loop never reaches the poll phase, so an already-delivered reply
 * sits unread in the port queue. When the worker finally yields, Node runs the
 * **timers phase before poll**, so birpc's now-overdue timer fires on a call
 * that was in fact already answered. It surfaces as:
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *      ❯ Object.onTimeoutError .../chunks/rpc.*.js
 *      ❯ Timeout._onTimeout .../chunks/index.*.js
 *
 * — a stack with zero user frames. Vitest counts it as an unhandled error and
 * exits **1 while every test passed**: "59 passed (59) / 1351 passed (1351) /
 * 1 error". That non-zero exit propagates through `pnpm -r`, so CI and task
 * runners report a red suite with nothing broken. It has been misdiagnosed as
 * an exit-code propagation bug in the pnpm wrapper repeatedly; it is not —
 * vitest genuinely exits non-zero.
 *
 * `vitest.setup.ts` yields the loop between tests, which shrinks the window a
 * lot but cannot close it: module **collection** (~143s across the core suite)
 * runs outside every hook, and individual tests legitimately run 25s+, so a
 * loaded machine can still stack up 60s of un-serviced loop. Observed directly:
 * three back-to-back core runs with the yields in place went 0, 0, then 1.
 *
 * WHAT THIS DOES
 *
 * Runs vitest, tees its output, and hands the result to `evaluateVitestExit`
 * (see vitest-exit-policy.mjs — a pure, unit-tested function). That policy
 * suppresses the non-zero exit **only** when the summary shows zero failures
 * AND every unhandled error vitest reported is an RPC timeout on its own
 * reporting channel. A real test failure, a missing summary, a signal kill, or
 * any other unhandled error propagates the original exit code untouched.
 *
 * Suppression is always announced on stderr, never silent. Set
 * `VALIDITY_STRICT_VITEST=1` to disable it and get vitest's raw exit code.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { evaluateVitestExit } from './vitest-exit-policy.mjs';

// Resolve from the *calling package* so each workspace runs its own vitest.
const require = createRequire(`${process.cwd()}/`);
const pkgPath = require.resolve('vitest/package.json');
const { bin } = require('vitest/package.json');
const vitestBin = new URL(typeof bin === 'string' ? bin : bin.vitest, `file://${pkgPath}`).pathname;

const child = spawn(process.execPath, [vitestBin, 'run', ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

let captured = '';
for (const [stream, sink] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on('data', (chunk) => {
    captured += chunk.toString();
    sink.write(chunk); // tee: the user still sees vitest's output live
  });
}

child.on('error', (err) => {
  console.error(`[vitest-run] failed to spawn vitest: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  const exitCode = code === null ? 1 : code;
  const { suppress, reason, unhandledCount } = evaluateVitestExit({
    exitCode,
    output: captured,
    signal,
    strict: process.env.VALIDITY_STRICT_VITEST === '1',
  });

  if (!suppress) process.exit(exitCode);

  console.error(
    [
      '',
      '[vitest-run] ------------------------------------------------------------',
      `[vitest-run] Vitest exited ${exitCode}, but every test passed and ${reason}.`,
      "[vitest-run] That is an event-loop starvation artifact in vitest's own",
      '[vitest-run] reporting channel, not a product failure — see',
      '[vitest-run] scripts/vitest-run.mjs for the mechanism.',
      `[vitest-run] Overriding the exit code to 0 (${unhandledCount} error(s) ignored).`,
      '[vitest-run] Re-run with VALIDITY_STRICT_VITEST=1 to see the raw exit code.',
      '[vitest-run] ------------------------------------------------------------',
      '',
    ].join('\n'),
  );
  process.exit(0);
});
