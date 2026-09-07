import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_ATTEMPTS_HARD_LIMIT,
  resolveRetryPolicy,
  runWithRetry,
  shouldRetry,
} from './retry.js';
import type { ValidityReport } from './types.js';

const baseReport = (verdict: ValidityReport['verdict']): ValidityReport => ({
  runId: 'r1',
  prompt: 'p',
  criteria: [],
  components: [],
  verdict,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('resolveRetryPolicy', () => {
  it('defaults to no retry', () => {
    expect(resolveRetryPolicy()).toEqual({ maxAttempts: 1, retryOnPartial: false });
  });

  it('reads config policy', () => {
    expect(
      resolveRetryPolicy({
        configPolicy: { maxAttempts: 3, retryOnPartial: true },
      }),
    ).toEqual({ maxAttempts: 3, retryOnPartial: true });
  });

  it('override beats config', () => {
    expect(
      resolveRetryPolicy({
        configPolicy: { maxAttempts: 3, retryOnPartial: true },
        override: { maxAttempts: 2, retryOnPartial: false },
      }),
    ).toEqual({ maxAttempts: 2, retryOnPartial: false });
  });

  it('clamps maxAttempts to the hard limit', () => {
    expect(resolveRetryPolicy({ override: { maxAttempts: 999 } }).maxAttempts).toBe(
      MAX_RETRY_ATTEMPTS_HARD_LIMIT,
    );
  });

  it('clamps non-positive maxAttempts to 1', () => {
    expect(resolveRetryPolicy({ override: { maxAttempts: 0 } }).maxAttempts).toBe(1);
    expect(resolveRetryPolicy({ override: { maxAttempts: -3 } }).maxAttempts).toBe(1);
  });
});

describe('shouldRetry', () => {
  const policy = { maxAttempts: 3, retryOnPartial: false };
  it('does not retry pass', () => {
    expect(shouldRetry(baseReport('pass'), policy, 1)).toBe(false);
  });
  it('retries fail', () => {
    expect(shouldRetry(baseReport('fail'), policy, 1)).toBe(true);
  });
  it('does not retry partial unless retryOnPartial', () => {
    expect(shouldRetry(baseReport('partial'), policy, 1)).toBe(false);
    expect(shouldRetry(baseReport('partial'), { maxAttempts: 3, retryOnPartial: true }, 1)).toBe(
      true,
    );
  });
  it('stops at maxAttempts', () => {
    expect(shouldRetry(baseReport('fail'), policy, 3)).toBe(false);
  });
});

describe('runWithRetry', () => {
  it('returns first pass', async () => {
    let calls = 0;
    const { report, attempts } = await runWithRetry({
      policy: { maxAttempts: 3, retryOnPartial: false },
      attempt: async () => {
        calls++;
        return baseReport('pass');
      },
    });
    expect(report.verdict).toBe('pass');
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('retries until success', async () => {
    let calls = 0;
    const { report, attempts } = await runWithRetry({
      policy: { maxAttempts: 3, retryOnPartial: false },
      attempt: async () => {
        calls++;
        return baseReport(calls < 3 ? 'fail' : 'pass');
      },
    });
    expect(report.verdict).toBe('pass');
    expect(attempts).toBe(3);
  });

  it('stops at maxAttempts even if still failing (no infinite loop)', async () => {
    let calls = 0;
    const { report, attempts } = await runWithRetry({
      policy: { maxAttempts: 2, retryOnPartial: false },
      attempt: async () => {
        calls++;
        return baseReport('fail');
      },
    });
    expect(report.verdict).toBe('fail');
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('invokes onRetry between attempts', async () => {
    const events: number[] = [];
    await runWithRetry({
      policy: { maxAttempts: 3, retryOnPartial: false },
      attempt: async () => baseReport('fail'),
      onRetry: (_prev, idx) => events.push(idx),
    });
    expect(events).toEqual([1, 2]);
  });
});
