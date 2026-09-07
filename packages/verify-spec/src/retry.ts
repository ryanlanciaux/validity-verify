import type { RetryOnFailureConfig, ValidityReport } from './types.js';

/** Hard cap to prevent runaway token spend on a misconfigured retry policy. */
export const MAX_RETRY_ATTEMPTS_HARD_LIMIT = 5;

export interface ResolveRetryArgs {
  /** Config-level retry policy (e.g. from .validity/config.ts). */
  configPolicy?: RetryOnFailureConfig;
  /** CLI/MCP-call-site override (takes precedence over `configPolicy`). */
  override?: RetryOnFailureConfig | { maxAttempts?: number; retryOnPartial?: boolean };
}

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  retryOnPartial: boolean;
}

export function resolveRetryPolicy(args: ResolveRetryArgs = {}): ResolvedRetryPolicy {
  const merged: { maxAttempts: number; retryOnPartial: boolean } = {
    maxAttempts: 1,
    retryOnPartial: false,
  };
  if (args.configPolicy) {
    merged.maxAttempts = args.configPolicy.maxAttempts;
    merged.retryOnPartial = args.configPolicy.retryOnPartial ?? false;
  }
  if (args.override) {
    if (typeof args.override.maxAttempts === 'number') {
      merged.maxAttempts = args.override.maxAttempts;
    }
    if (typeof args.override.retryOnPartial === 'boolean') {
      merged.retryOnPartial = args.override.retryOnPartial;
    }
  }
  // Clamp to [1, MAX_RETRY_ATTEMPTS_HARD_LIMIT].
  if (!Number.isFinite(merged.maxAttempts) || merged.maxAttempts < 1) merged.maxAttempts = 1;
  if (merged.maxAttempts > MAX_RETRY_ATTEMPTS_HARD_LIMIT) {
    merged.maxAttempts = MAX_RETRY_ATTEMPTS_HARD_LIMIT;
  }
  return merged;
}

export function shouldRetry(
  report: ValidityReport,
  policy: ResolvedRetryPolicy,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (report.verdict === 'pass') return false;
  if (report.verdict === 'fail') return true;
  // partial
  return policy.retryOnPartial;
}

export interface RunWithRetryArgs<T extends ValidityReport> {
  policy: ResolvedRetryPolicy;
  attempt: (attemptIndex: number, previous: T | null) => Promise<T>;
  onRetry?: (previous: T, attemptIndex: number) => void;
}

export async function runWithRetry<T extends ValidityReport>(
  args: RunWithRetryArgs<T>,
): Promise<{ report: T; attempts: number }> {
  let last: T | null = null;
  for (let i = 0; i < args.policy.maxAttempts; i++) {
    last = await args.attempt(i, last);
    if (!shouldRetry(last, args.policy, i + 1)) {
      return { report: last, attempts: i + 1 };
    }
    args.onRetry?.(last, i + 1);
  }
  // Should not reach here because the loop above returns when retries are exhausted,
  // but TS needs the assertion.
  return { report: last as T, attempts: args.policy.maxAttempts };
}
