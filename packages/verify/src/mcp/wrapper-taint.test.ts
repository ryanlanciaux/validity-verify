/**
 * A1's CAN'T-FALSE-GREEN suite: a soft "pass" scored from a render under a
 * DEGRADED wrapper clone must never survive to `signedOff` — the clamp keeps
 * it `unverifiable`, the report row says why, the headline verdict refuses a
 * clean green, and `structuredContent.setup.wrapperFidelity` routes the agent
 * to fix the SETUP. The companion tests prove the gate is the taint, not a
 * blanket block: `verified` fidelity changes nothing, and a submitted `fail`
 * is never masked.
 *
 * Same harness as server.test.ts: hand-built run-metas, no Playwright/Vite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRunMeta,
  runDir,
  runMetaPathFor,
  writeSpec,
  type CriterionVerdict,
  type EnsureResult,
  type RunMeta,
  type Spec,
  type WrapperFidelityInfo,
} from '@validity.ai/verify-spec';
import { handleSubmitReport } from './server.js';

const RUN_ID = 'run_wrapper_taint_001';

function fidelity(over: Partial<WrapperFidelityInfo> = {}): WrapperFidelityInfo {
  return {
    status: 'degraded',
    missingProviders: ['QueryClientProvider'],
    expectedProviders: ['QueryClientProvider', 'MemoryRouter'],
    analyzed: 'on-disk',
    ...over,
  };
}

function setupWith(wrapperFidelity: WrapperFidelityInfo): EnsureResult {
  return {
    status: 'unchanged',
    bootstrapped: false,
    driftReasons: [],
    generatedFiles: [],
    warnings: [],
    wrapperFidelity,
    durationMs: 1,
  } as unknown as EnsureResult;
}

function makeSpec(projectRoot: string): Spec {
  const spec: Spec = {
    id: 'spec-wrap1',
    version: 1,
    status: 'frozen',
    source: { prompt: 'polish the card', createdBy: 'agent' },
    runtime: 'web',
    criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  writeSpec(projectRoot, spec);
  return spec;
}

function writeMeta(projectRoot: string, over: Partial<RunMeta> = {}): void {
  mkdirSync(resolve(runDir(projectRoot, RUN_ID), 'screenshots'), { recursive: true });
  const meta: RunMeta = {
    runId: RUN_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'isolation',
    prompt: 'polish the card',
    scenarios: [],
    components: [
      {
        id: 'web-card',
        filePath: 'src/Card.tsx',
        screenshotPath: resolve(runDir(projectRoot, RUN_ID), 'screenshots', 'web-card__base.png'),
      },
    ],
    componentSources: {},
    diff: { files: [] },
    report: { enabled: true, brand: 'none' },
    ...over,
  };
  writeFileSync(runMetaPathFor(projectRoot, RUN_ID), JSON.stringify(meta, null, 2));
}

const passSubmission = (projectRoot: string) => ({
  runId: RUN_ID,
  projectRoot,
  verdict: 'pass' as const,
  criteria: [
    {
      id: 'AC-soft',
      description: 'looks polished',
      status: 'pass' as const,
      reasoning: 'the card looks great in the screenshot',
      screenshotIds: ['web-card'],
    },
  ],
});

describe("handleSubmitReport — wrapper-fidelity can't-false-green (A1)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-wrapper-taint-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("CAN'T FALSE-GREEN: a degraded wrapper's soft pass never survives to signedOff", async () => {
    const spec = makeSpec(projectRoot);
    const tainted: CriterionVerdict = {
      id: 'AC-soft',
      tier: 'soft',
      status: 'unverifiable',
      detail: 'soft — score from the screenshot — tainted: wrapper: missing QueryClientProvider',
      evidenceTaints: ['wrapper'],
    };
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [tainted],
      setup: setupWith(fidelity()),
    });

    const result = await handleSubmitReport(passSubmission(projectRoot));
    expect(result.isError).toBeUndefined();

    // 1. Persisted verdict clamped, taint intact.
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    const v = meta.criterionVerdicts!.find((c) => c.id === 'AC-soft')!;
    expect(v.status).toBe('unverifiable');
    expect(v.evidenceTaints).toEqual(['wrapper']);

    // 2. The loop stop rule stays shut and the headline refuses a clean green.
    const sc = result.structuredContent as {
      signedOff: boolean;
      verdict: string;
      setup?: { wrapperFidelity?: { status: string; missingProviders: string[] } };
    };
    expect(sc.signedOff).toBe(false);
    expect(sc.verdict).not.toBe('pass');
    expect(sc.verdict).toBe('partial');

    // 3. Loop drivers can route "fix setup, not component".
    expect(sc.setup?.wrapperFidelity?.status).toBe('degraded');
    expect(sc.setup?.wrapperFidelity?.missingProviders).toEqual(['QueryClientProvider']);

    // 4. The report row carries the taint prefix (never renders the raw pass).
    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    expect(html).toContain('[Evidence tainted: wrapper');

    // 5. The response text explains the downgrade.
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/verdict downgraded to partial/);
  });

  it('BATTERY S1 (report chain): the rendered report shows the wrapper taint group AND the setup panel naming the missing provider', async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
      ],
      setup: setupWith(fidelity()),
    });

    const result = await handleSubmitReport(passSubmission(projectRoot));
    expect(result.isError).toBeUndefined();

    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    // Not-validated groups the clamped criterion under the wrapper header.
    expect(html).toContain('Rendered under a degraded wrapper clone');
    // Setup panel routes the fix at the SETUP, naming the missing provider.
    expect(html).toContain('Wrapper fidelity: degraded');
    expect(html).toContain('Missing providers: QueryClientProvider');
    // Markdown twin carries the Not-validated surface too.
    const md = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.md'), 'utf-8');
    expect(md).toContain('Not validated');
    expect(md).toContain('degraded wrapper');
  });

  it("companion: 'verified' fidelity changes NOTHING — the same submission passes and signs off", async () => {
    const spec = makeSpec(projectRoot);
    const clean: CriterionVerdict = { id: 'AC-soft', tier: 'soft', status: 'unverifiable' };
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [clean],
      setup: setupWith(fidelity({ status: 'verified', missingProviders: [] })),
    });

    const result = await handleSubmitReport(passSubmission(projectRoot));
    const sc = result.structuredContent as { signedOff: boolean; verdict: string };
    expect(sc.verdict).toBe('pass');
    expect(sc.signedOff).toBe(true);
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
  });

  it('companion: a submitted fail on a tainted criterion stays fail (taint never masks a fail)', async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
      ],
      setup: setupWith(fidelity()),
    });

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'fail',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'fail',
          reasoning: 'spacing is broken',
          screenshotIds: ['web-card'],
        },
      ],
    });

    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('fail');
    expect(meta.criterionVerdicts![0]!.evidenceTaints).toEqual(['wrapper']);
    const sc = result.structuredContent as { verdict: string; signedOff: boolean };
    expect(sc.verdict).toBe('fail');
    expect(sc.signedOff).toBe(false);
  });

  it('no-spec run: a degraded wrapper still refuses a clean green (partial + note)', async () => {
    writeMeta(projectRoot, { setup: setupWith(fidelity()) });

    const result = await handleSubmitReport({ runId: RUN_ID, projectRoot, verdict: 'pass' });
    const sc = result.structuredContent as { verdict: string };
    expect(sc.verdict).toBe('partial');
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/degraded wrapper/);
  });

  it('no-spec run on URL mode is untouched (the web wrapper never rendered)', async () => {
    writeMeta(projectRoot, { mode: 'url', setup: setupWith(fidelity()) });

    const result = await handleSubmitReport({ runId: RUN_ID, projectRoot, verdict: 'pass' });
    const sc = result.structuredContent as { verdict: string };
    expect(sc.verdict).toBe('pass');
  });
});
