/**
 * D1's can't-false-green tests for the advisory `structuredContent.perf.drift`
 * key: a spec verify whose timeline shows screaming perf drift surfaces the
 * drift (nested under the SAME merged `perf` namespace as D2's hints) while
 * the `verdict` block — status, signedOff, everything — stays byte-identical
 * to the no-drift case. Old timelines without perf never fire.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  indexRunForSpec,
  refreshPerfDrift,
  loadSignals,
  type ComponentRender,
  type CriterionVerdict,
  type RunMeta,
} from '@validity.ai/verify-spec';
import { buildVerifyStructuredContent } from './server.js';

const SPEC_ID = 'checkout';

function metaFor(runId: string, mountMs: number | undefined): RunMeta {
  const components: ComponentRender[] | undefined =
    mountMs === undefined
      ? undefined
      : [
          {
            id: 'CheckoutForm',
            filePath: 'src/CheckoutForm.tsx',
            screenshotPath: '/tmp/CheckoutForm.png',
            performance: { mountMs },
          },
        ];
  return {
    runId,
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'isolation',
    prompt: 'demo',
    scenarios: [],
    diff: { files: [] },
    report: { enabled: false, brand: 'none' },
    specId: SPEC_ID,
    criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    components,
  };
}

/** Seed 5 steady runs then one with the given mount cost. */
function seedTimeline(projectRoot: string, latestMountMs: number | undefined): void {
  for (let i = 0; i < 5; i++) indexRunForSpec(projectRoot, metaFor(`run_${i}`, 5));
  indexRunForSpec(projectRoot, metaFor('run_latest', latestMountMs));
}

describe('structuredContent.perf.drift (D1, advisory-only)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-mcp-perf-drift-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const verdicts: CriterionVerdict[] = [{ id: 'AC-1', tier: 'hard', status: 'pass' }];

  it('surfaces open drift under the merged perf key while the verdict block stays byte-identical', () => {
    seedTimeline(projectRoot, 500); // 100x mount regression
    const drift = refreshPerfDrift(projectRoot, SPEC_ID).filter((s) => s.status === 'open');
    expect(drift).toHaveLength(1);

    const withDrift = buildVerifyStructuredContent(
      'run_latest',
      verdicts,
      undefined,
      projectRoot,
      SPEC_ID,
      undefined,
      false,
      drift,
    );
    const withoutDrift = buildVerifyStructuredContent(
      'run_latest',
      verdicts,
      undefined,
      projectRoot,
      SPEC_ID,
      undefined,
      false,
    );

    expect(withDrift.perf?.drift).toEqual([
      {
        perfKey: 'CheckoutForm__base__base__default',
        detail: expect.stringContaining('advisory, does not gate'),
      },
    ]);
    expect(withoutDrift.perf).toBeUndefined();
    // The screaming drift changes NOTHING gate-shaped: the verdict block is
    // deep-equal — same status, same signedOff, same everything.
    expect(withDrift.verdict).toEqual(withoutDrift.verdict);
    expect(withDrift.verdict.status).toBe('pass');
  });

  it('persists the drift signal to signals.json as low severity (never exit-code material)', () => {
    seedTimeline(projectRoot, 500);
    refreshPerfDrift(projectRoot, SPEC_ID);
    const stored = loadSignals(projectRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.kind).toBe('perf-drift');
    expect(stored[0]!.severity).toBe('low');
  });

  it('old runs.jsonl rows without perf never fire', () => {
    // A timeline written entirely by runs that captured no metrics (e.g.
    // pre-feature binaries): rows carry no `perf` key at all.
    for (let i = 0; i < 6; i++) indexRunForSpec(projectRoot, metaFor(`run_${i}`, undefined));

    expect(refreshPerfDrift(projectRoot, SPEC_ID)).toEqual([]);
    expect(loadSignals(projectRoot)).toEqual([]);
  });

  it('an in-range latest run resolves the open signal without touching the verdict block', () => {
    seedTimeline(projectRoot, 500);
    refreshPerfDrift(projectRoot, SPEC_ID);
    // A recovered follow-up run lands on the timeline.
    indexRunForSpec(projectRoot, metaFor('run_recovered', 5));
    const fresh = refreshPerfDrift(projectRoot, SPEC_ID);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.status).toBe('resolved');
    expect(loadSignals(projectRoot)[0]!.status).toBe('resolved');

    const open = fresh.filter((s) => s.status === 'open');
    const out = buildVerifyStructuredContent(
      'run_recovered',
      verdicts,
      undefined,
      projectRoot,
      SPEC_ID,
      undefined,
      false,
      open,
    );
    // No open drift → the merged perf key is omitted entirely.
    expect(out.perf).toBeUndefined();
    expect(out.verdict.status).toBe('pass');
  });
});
