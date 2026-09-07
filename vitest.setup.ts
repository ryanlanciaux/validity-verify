import { afterEach, beforeEach } from 'vitest';

/**
 * Shared setup: keep the worker's event loop serviceable between tests.
 *
 * WHY THIS EXISTS
 *
 * Vitest workers talk to the main process over birpc with a **hardcoded 60s
 * timeout** (`DEFAULT_TIMEOUT` in vitest/dist/chunks/index.*.js — there is no
 * config knob for it). After each task the worker issues an awaited
 * `onTaskUpdate` RPC and waits for the main process to answer.
 *
 * Several suites here (core's ts-morph parsing, sandbox's Vite/Babel compiles)
 * do long stretches of *synchronous* CPU work. Synchronous work drains only the
 * microtask queue — the event loop never reaches the poll phase, so an already-
 * delivered `onTaskUpdate` reply sits unread in the port's queue. When the
 * worker finally yields, Node runs the **timers phase before poll**, so birpc's
 * now-overdue 60s timer fires on a call that was in fact already answered.
 *
 * The failure surfaces as:
 *
 *     Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * with a stack containing no user frames (`Object.onTimeoutError` →
 * `Timeout._onTimeout`). Vitest counts it as an error and exits **1 while every
 * test passed** — "1351 passed (1351)" plus "1 error". That non-zero exit then
 * propagates up through `pnpm -r`, so CI and task runners report a red suite
 * with nothing actually broken. This has been misdiagnosed as an exit-code
 * propagation bug in the pnpm wrapper several times; it is not — vitest really
 * does exit non-zero.
 *
 * THE FIX
 *
 * Yield once per test so no un-serviced stretch of the loop can approach 60s.
 * `setImmediate` fires in the check phase, which the loop can only reach *after*
 * poll — so awaiting one guarantees a full cycle, and any pending RPC reply is
 * read and settled before its timer can fire.
 *
 * `beforeEach` is the load-bearing hook: the `onTaskUpdate` for test N is sent
 * after N's `afterEach` hooks run, so N+1's `beforeEach` is the first chance to
 * read the answer. `afterEach` is kept as cheap insurance for suites whose work
 * happens in teardown. Cost is a few microseconds per test.
 *
 * Note the diagnostic tell, if this ever regresses: *lowering* worker
 * concurrency makes it WORSE, not better. That rules out a leaked handle or
 * timer and points back at CPU contention stretching sync work past the 60s
 * wall-clock deadline. See also `--workspace-concurrency=1` on the root `test`
 * script, which stops `pnpm -r` from running several vitest pools at once.
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(yieldToEventLoop);
afterEach(yieldToEventLoop);
