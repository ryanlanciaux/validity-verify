/**
 * Regression tests for the shared CLI verify engine (verify --all / watch).
 *
 * REGRESSION (CLI verify path never threads setupResult): `verifyOneSpec`
 * used to call `prepareVerification` without a `setupResult`, so the wrapper
 * taint stamp and `meta.setup` persistence could never fire on CLI verifies —
 * CI run-metas silently lacked the honesty MCP verifies carry. The engine now
 * threads the signature-cached EnsureResult (read-only — CLI paths must not
 * run the writing orchestrator).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the sandbox (never boot Vite here) and the heavy core entry points;
// everything else in @validity.ai/verify-spec (readCachedEnsureResult and friends)
// stays real so the signature cache is read from actual fs.
vi.mock('@validity.ai/verify-web', () => ({ renderComponents: vi.fn() }));
vi.mock('@validity.ai/verify-spec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@validity.ai/verify-spec')>();
  return {
    ...actual,
    prepareVerification: vi.fn(async () => ({ runId: 'run-1', components: [] })),
    readRunMeta: vi.fn(() => null),
  };
});

import {
  prepareVerification,
  type EnsureResult,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { verifyOneSpec } from './verify-engine.js';

const spec = {
  id: 'spec-x',
  version: 1,
  hash: 'h',
  source: { prompt: 'do the thing' },
  criteria: [],
} as unknown as Spec;

const config = {} as ValidityConfig;

function writeSignature(root: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(
    resolve(root, '.validity/.shape-signature.json'),
    JSON.stringify({ schemaVersion: 1, validityVersion: '0.0.1', ...extra }, null, 2),
  );
}

describe('verifyOneSpec setup threading', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-verify-engine-'));
    vi.mocked(prepareVerification).mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('threads the signature-cached wrapper fidelity into prepareVerification (degraded taints CI runs)', async () => {
    writeSignature(root, {
      wrapperFidelity: {
        status: 'degraded',
        missingProviders: ['QueryClientProvider'],
        expectedProviders: ['QueryClientProvider'],
      },
    });
    await verifyOneSpec(root, config, spec);
    expect(prepareVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        setupResult: expect.objectContaining({
          status: 'unchanged',
          wrapperFidelity: expect.objectContaining({
            status: 'degraded',
            missingProviders: ['QueryClientProvider'],
            analyzed: 'signature-cache',
          }),
        }),
      }),
    );
  });

  it('passes setupResult: undefined when no signature cache exists (fail-open, no fake setup)', async () => {
    await verifyOneSpec(root, config, spec);
    expect(prepareVerification).toHaveBeenCalledWith(
      expect.objectContaining({ setupResult: undefined }),
    );
  });

  it('an explicitly-passed setupResult wins over the cache', async () => {
    writeSignature(root, {
      wrapperFidelity: { status: 'degraded', missingProviders: [], expectedProviders: [] },
    });
    const explicit = {
      status: 'fresh',
      bootstrapped: true,
      shapeSignature: {},
      driftReasons: [],
      generatedFiles: [],
      warnings: [],
      durationMs: 1,
    } as unknown as EnsureResult;
    await verifyOneSpec(root, config, spec, { setupResult: explicit });
    expect(prepareVerification).toHaveBeenCalledWith(
      expect.objectContaining({ setupResult: explicit }),
    );
  });
});
