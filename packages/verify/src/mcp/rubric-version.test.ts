/**
 * Rubric-version stamping across the two scoring entry points (E2.2), plus the
 * native data-state hold's taint (E2.1).
 *
 * The property under test is "every judgment records how it was scored": a
 * soft verdict must carry the rubric it was produced under, and when the
 * submitter didn't declare one, the record must say the version was ASSUMED
 * rather than pass a server default off as an attestation.
 *
 * Same harness as wrapper-taint.test.ts: hand-built run-metas, no Playwright.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUBRIC_VERSION,
  readRunMeta,
  runDir,
  runMetaPathFor,
  writeSpec,
  type CriterionVerdict,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';
import { annotateNativeDataStateVerdicts, handleSubmitReport } from './server.js';

const RUN_ID = 'run_rubric_001';

function makeSpec(projectRoot: string, criteria?: Spec['criteria']): Spec {
  const spec: Spec = {
    id: 'spec-rub1',
    version: 1,
    status: 'frozen',
    source: { prompt: 'polish the card', createdBy: 'agent' },
    runtime: 'web',
    criteria: criteria ?? [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
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

const submission = (projectRoot: string, rubricVersion?: string) => ({
  runId: RUN_ID,
  projectRoot,
  verdict: 'pass' as const,
  ...(rubricVersion ? { rubricVersion } : {}),
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

describe('handleSubmitReport — rubric provenance (E2.2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-rubric-mcp-'));
    const spec = makeSpec(projectRoot);
    const soft: CriterionVerdict = { id: 'AC-soft', tier: 'soft', status: 'unverifiable' };
    writeMeta(projectRoot, { specId: spec.id, criterionVerdicts: [soft] });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stamps the CURRENT rubric as ASSUMED when the submitter declares none', async () => {
    const result = await handleSubmitReport(submission(projectRoot));
    expect(result.isError).toBeUndefined();

    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.scoring?.rubricVersion).toBe(RUBRIC_VERSION);
    expect(meta.scoring?.rubricVersionAssumed).toBe(true);

    const v = meta.criterionVerdicts!.find((c) => c.id === 'AC-soft')!;
    expect(v.scoredBy?.rubricVersion).toBe(RUBRIC_VERSION);
    expect(v.scoredBy?.rubricVersionAssumed).toBe(true);

    const sc = result.structuredContent as {
      rubricVersion: string;
      rubricVersionAssumed: boolean;
    };
    expect(sc.rubricVersion).toBe(RUBRIC_VERSION);
    expect(sc.rubricVersionAssumed).toBe(true);
  });

  it('records a DECLARED rubric verbatim and does not mark it assumed', async () => {
    const result = await handleSubmitReport(submission(projectRoot, '7'));

    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.scoring?.rubricVersion).toBe('7');
    expect(meta.scoring?.rubricVersionAssumed).toBe(false);
    expect(meta.criterionVerdicts![0]!.scoredBy?.rubricVersion).toBe('7');
    expect(meta.criterionVerdicts![0]!.scoredBy?.rubricVersionAssumed).toBe(false);

    const sc = result.structuredContent as { rubricVersionAssumed: boolean };
    expect(sc.rubricVersionAssumed).toBe(false);
  });

  it('the stamp is provenance only — it does not disturb the verdict or the stop rule', async () => {
    const result = await handleSubmitReport(submission(projectRoot, '7'));
    const sc = result.structuredContent as { verdict: string; signedOff: boolean };
    expect(sc.verdict).toBe('pass');
    expect(sc.signedOff).toBe(true);
  });
});

describe('annotateNativeDataStateVerdicts — the native hold is a TAINT, not just prose (E2.1)', () => {
  const spec = (): Spec => ({
    id: 'spec-nat1',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'native',
    criteria: [
      { id: 'AC-1', text: 'spinner while loading', tier: 'soft', dataState: 'loading' },
      { id: 'AC-2', text: 'card looks right', tier: 'soft' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('stamps data-state on the held criterion and demotes it, leaving the rest alone', () => {
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'soft', status: 'pass' },
      { id: 'AC-2', tier: 'soft', status: 'pass' },
    ];
    annotateNativeDataStateVerdicts(verdicts, spec());
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
    expect(verdicts[1]!.status).toBe('pass');
    expect(verdicts[1]!.evidenceTaints).toBeUndefined();
  });

  it('keeps the honest native-unsupported detail on an unexecuted placeholder', () => {
    const verdicts: CriterionVerdict[] = [{ id: 'AC-1', tier: 'soft', status: 'unverifiable' }];
    annotateNativeDataStateVerdicts(verdicts, spec());
    expect(verdicts[0]!.detail).toContain('not supported on native');
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
  });
});
