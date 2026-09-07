/**
 * Evidence-taint + scorer-provenance behavior of the MCP server (A3), driven
 * through `handleSubmitReport` / `buildVerifyStructuredContent` with hand-built
 * run-metas (no Playwright/Vite — same approach as report-roundtrip.test.ts).
 * The load-bearing invariants: a demoting-tainted soft criterion can never be
 * scored up to `pass` (the clamp persists `unverifiable`, taints intact), a
 * non-evidence render is never a valid soft citation, and self-scoring is
 * flagged — never gated. Plus the B2 temporal-binding surface: classification
 * is display-only and never moves `signedOff`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUBRIC_VERSION,
  readRunMeta,
  readSpec,
  runDir,
  runMetaPathFor,
  writeSpec,
  type CriterionVerdict,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';
import {
  buildVerifyStructuredContent,
  formatUnmatchedFetchBlock,
  handlePlan,
  handleSubmitReport,
} from './server.js';
import { SESSION_FINGERPRINT } from './session-fingerprint.js';

const RUN_ID = 'run_taint_test_001';

function makeSpec(projectRoot: string): Spec {
  const spec: Spec = {
    id: 'spec-taint1',
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

describe('handleSubmitReport — evidence-taint clamp (A3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-taint-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("CAN'T FALSE-GREEN (end-to-end): an agent pass on a wrapper-tainted soft criterion persists as unverifiable, taint intact", async () => {
    const spec = makeSpec(projectRoot);
    const placeholder: CriterionVerdict = {
      id: 'AC-soft',
      tier: 'soft',
      status: 'unverifiable',
      detail: 'soft — score from the screenshot below — tainted: wrapper: no-entry-file',
      evidenceTaints: ['wrapper'],
    };
    writeMeta(projectRoot, { specId: spec.id, criterionVerdicts: [placeholder] });

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'the card looks great in the screenshot',
          screenshotIds: ['web-card'],
        },
      ],
    });

    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { signedOff: boolean; taintedCriteria?: unknown };
    expect(sc.signedOff).toBe(false);
    expect(sc.taintedCriteria).toEqual([{ id: 'AC-soft', taints: ['wrapper'] }]);

    const meta = readRunMeta(projectRoot, RUN_ID)!;
    const v = meta.criterionVerdicts!.find((c) => c.id === 'AC-soft')!;
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/evidence tainted: wrapper — pass withheld/);
    // Taints are NEVER erased by the overwrite.
    expect(v.evidenceTaints).toEqual(['wrapper']);
    // Scorer provenance is always recorded (session, even without a model id).
    expect(v.scoredBy).toEqual({
      session: SESSION_FINGERPRINT,
      rubricVersion: RUBRIC_VERSION,
      rubricVersionAssumed: true,
    });
  });

  it('a submitted fail on a tainted criterion is accepted as fail (strictening allowed)', async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
      ],
    });

    await handleSubmitReport({
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
    const v = meta.criterionVerdicts!.find((c) => c.id === 'AC-soft')!;
    expect(v.status).toBe('fail');
    expect(v.evidenceTaints).toEqual(['wrapper']);
  });

  it('legacy networkTainted clamps the same way (normalized to network)', async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', networkTainted: true },
      ],
    });

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'looks right',
          screenshotIds: ['web-card'],
        },
      ],
    });

    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('unverifiable');
    expect(meta.criterionVerdicts![0]!.detail).toMatch(/evidence tainted: network/);
    const sc = result.structuredContent as { taintedCriteria?: unknown };
    expect(sc.taintedCriteria).toEqual([{ id: 'AC-soft', taints: ['network'] }]);
  });

  it("BATTERY S3 (end-to-end): a fabricated-network 'pass' stays non-green at every surface — persisted unverifiable, signedOff false, report groups it under the network header", async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        {
          id: 'AC-soft',
          tier: 'soft',
          status: 'unverifiable',
          evidenceTaints: ['network'],
          networkProvenance: 'fabricated',
        },
      ],
    });

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'the empty state renders beautifully',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();

    // Persisted verdict: the phantom response never becomes a pass.
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('unverifiable');
    expect(meta.criterionVerdicts![0]!.evidenceTaints).toEqual(['network']);

    // structuredContent: gate shut, taint named, headline non-green.
    const sc = result.structuredContent as {
      signedOff: boolean;
      verdict: string;
      taintedCriteria?: unknown;
    };
    expect(sc.signedOff).toBe(false);
    expect(sc.verdict).not.toBe('pass');
    expect(sc.taintedCriteria).toEqual([{ id: 'AC-soft', taints: ['network'] }]);

    // Rendered report: the Not-validated network group is visible.
    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    expect(html).toContain('Network evidence was fabricated (permissive mock)');
  });
});

describe('handleSubmitReport — mechanical command verdicts are authoritative (A5 battery S4)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-cmd-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeCommandSpec(): Spec {
    const spec: Spec = {
      id: 'spec-cmd1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'refactor the card types', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        { id: 'AC-types', text: 'the repo typechecks', tier: 'property' },
        { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec);
    return spec;
  }

  it("BATTERY S4 (end-to-end): a failing typecheck command verdict survives an agent 'pass' with pretty screenshots — headline fail, signedOff false; unconfigured stays unverifiable, never pass", async () => {
    // Phase 1 — verify time recorded the configured `expect.command` FAIL
    // (run.test.ts proves prepareVerification writes this shape; here we prove
    // the submit_report half can never launder it).
    const spec = makeCommandSpec();
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        {
          id: 'AC-types',
          tier: 'property',
          status: 'fail',
          detail: "command 'typecheck' (`tsc --noEmit`) exited 2 (expected 0)",
        },
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable' },
      ],
    });

    const submission = {
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass' as const,
      criteria: [
        {
          id: 'AC-types',
          description: 'the repo typechecks',
          status: 'pass' as const,
          reasoning: 'the screenshots all look perfect',
        },
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass' as const,
          reasoning: 'clean spacing',
          screenshotIds: ['web-card'],
        },
      ],
    };
    const result = await handleSubmitReport(submission);
    expect(result.isError).toBeUndefined();

    // The mechanical fail is kept verbatim; the agent's pass never persists.
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts!.find((v) => v.id === 'AC-types')!.status).toBe('fail');

    // Headline verdict is forced to fail; the stop rule stays shut.
    const sc = result.structuredContent as { verdict: string; signedOff: boolean };
    expect(sc.verdict).toBe('fail');
    expect(sc.signedOff).toBe(false);

    // The rendered report shows the override, not the agent's claim.
    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    expect(html).toContain('Mechanical verdict kept: fail');

    // Phase 2 — UNCONFIGURED command: verify left `unverifiable`; a submitted
    // pass reads partial at best, never pass, and never signs off.
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [
        {
          id: 'AC-types',
          tier: 'property',
          status: 'unverifiable',
          detail: "command 'typecheck' is not configured (config.commands.typecheck)",
        },
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable' },
      ],
    });
    const result2 = await handleSubmitReport(submission);
    expect(result2.isError).toBeUndefined();
    const meta2 = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta2.criterionVerdicts!.find((v) => v.id === 'AC-types')!.status).toBe('unverifiable');
    const sc2 = result2.structuredContent as { verdict: string; signedOff: boolean };
    expect(sc2.verdict).toBe('partial');
    expect(sc2.signedOff).toBe(false);
  });
});

describe('handleSubmitReport — citable-screenshot-id floor (A3 §5.3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-cite-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeMetaWithRenders(spec: Spec): void {
    writeMeta(projectRoot, {
      specId: spec.id,
      components: [
        {
          id: 'comp-broken',
          filePath: 'src/A.tsx',
          screenshotPath: resolve(runDir(projectRoot, RUN_ID), 'screenshots', 'a.png'),
          renderError: 'RENDER_UNCONFIRMED: the device never confirmed this render',
        },
        {
          id: 'comp-skipped',
          filePath: 'src/B.tsx',
          screenshotPath: resolve(runDir(projectRoot, RUN_ID), 'screenshots', 'b.png'),
          screenshotSkipped: true,
        },
        {
          id: 'comp-ok',
          filePath: 'src/C.tsx',
          screenshotPath: resolve(runDir(projectRoot, RUN_ID), 'screenshots', 'c.png'),
        },
      ],
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    });
  }

  const submission = (ids: string[]) => ({
    runId: RUN_ID,
    projectRoot,
    verdict: 'pass' as const,
    criteria: [
      {
        id: 'AC-soft',
        description: 'looks polished',
        status: 'pass' as const,
        reasoning: 'clean layout',
        screenshotIds: ids,
      },
    ],
  });

  it('REJECTS a citation of an errored (unconfirmed) render — not evidence', async () => {
    writeMetaWithRenders(makeSpec(projectRoot));
    const result = await handleSubmitReport(submission(['comp-broken']));
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/unknown render id\(s\): comp-broken/);
    // The rejection names the ids that ARE valid.
    expect(text).toMatch(/comp-ok/);
  });

  it('REJECTS a citation of a cost-control-skipped screenshot (file does not exist)', async () => {
    writeMetaWithRenders(makeSpec(projectRoot));
    const result = await handleSubmitReport(submission(['comp-skipped']));
    expect(result.isError).toBe(true);
  });

  it('ACCEPTS a citation of a clean sibling render', async () => {
    writeMetaWithRenders(makeSpec(projectRoot));
    const result = await handleSubmitReport(submission(['comp-ok']));
    expect(result.isError).toBeUndefined();
  });
});

describe('handleSubmitReport — scorer provenance + self-scoring (A3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-sfp-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('flags selfScored when run-meta carries THIS session fingerprint (warning + structuredContent, never a block)', async () => {
    writeMeta(projectRoot, { sessionFingerprint: SESSION_FINGERPRINT });
    const result = await handleSubmitReport({ runId: RUN_ID, projectRoot, verdict: 'pass' });
    const sc = result.structuredContent as { selfScored: boolean };
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/scored in the same session that ran verify/);
    // Not a block — the report still rendered.
    expect(text).toMatch(/Report: file:\/\//);
    // Run-level provenance persisted for later readers (A6/report).
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.scoring?.selfScored).toBe(true);
  });

  it('no same-session claim when run-meta has no fingerprint (old run-meta / CLI verify)', async () => {
    writeMeta(projectRoot);
    const result = await handleSubmitReport({ runId: RUN_ID, projectRoot, verdict: 'pass' });
    const sc = result.structuredContent as { selfScored: boolean };
    expect(sc.selfScored).toBe(false);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).not.toMatch(/same session/);
  });

  it('stamps scoredBy (model + session) on scored soft verdicts and echoes it in structuredContent', async () => {
    writeMeta(projectRoot, {
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    });
    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'judge-model-9',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'nice spacing',
          screenshotIds: ['web-card'],
        },
      ],
    });
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    expect(meta.criterionVerdicts![0]!.scoredBy).toEqual({
      model: 'judge-model-9',
      session: SESSION_FINGERPRINT,
      rubricVersion: RUBRIC_VERSION,
      rubricVersionAssumed: true,
    });
    const sc = result.structuredContent as { scoredBy?: string };
    expect(sc.scoredBy).toBe('judge-model-9');
  });
});

describe('buildVerifyStructuredContent — taintedCriteria (A3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-svc-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('emits taintedCriteria only when non-empty', () => {
    const clean = buildVerifyStructuredContent(
      'run-1',
      [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      undefined,
      projectRoot,
      undefined,
    );
    expect(clean.verdict.taintedCriteria).toBeUndefined();

    const tainted = buildVerifyStructuredContent(
      'run-2',
      [
        { id: 'AC-1', tier: 'hard', status: 'unverifiable', evidenceTaints: ['network'] },
        { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
      ],
      undefined,
      projectRoot,
      undefined,
    );
    expect(tainted.verdict.taintedCriteria).toEqual([{ id: 'AC-1', taints: ['network'] }]);
  });

  it('normalizes the legacy networkTainted boolean into taintedCriteria', () => {
    const out = buildVerifyStructuredContent(
      'run-3',
      [{ id: 'AC-1', tier: 'hard', status: 'unverifiable', networkTainted: true }],
      undefined,
      projectRoot,
      undefined,
    );
    expect(out.verdict.taintedCriteria).toEqual([{ id: 'AC-1', taints: ['network'] }]);
  });

  it("CAN'T FALSE-GREEN: a demoting-tainted pass never signs off in the verify payload", () => {
    const out = buildVerifyStructuredContent(
      'run-4',
      // A pathological writer persisted `pass` alongside a demoting taint —
      // the sign-off guard must still refuse it.
      [{ id: 'AC-1', tier: 'hard', status: 'pass', evidenceTaints: ['wrapper'] }],
      undefined,
      projectRoot,
      undefined,
    );
    expect(out.verdict.signedOff).toBe(false);
    expect(out.verdict.status).not.toBe('pass');
  });
});

describe('temporal binding (B2) — submit_report surface + gate integrity', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-temporal-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const VERIFY_SHA = 'c'.repeat(40);

  /** A frozen spec with ONE soft criterion and a freeze-time git binding. */
  function makeBoundSpec(changedFiles: string[]): Spec {
    const spec: Spec = {
      id: 'spec-temporal1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      git: { sha: VERIFY_SHA, dirty: changedFiles.length > 0, changedFiles },
    };
    writeSpec(projectRoot, spec);
    return spec;
  }

  function metaOverrides(spec: Spec, diffPaths: string[]): Partial<RunMeta> {
    return {
      specId: spec.id,
      specVersion: spec.version,
      planId: spec.id,
      git: { sha: VERIFY_SHA, dirty: true },
      diff: { files: diffPaths.map((p) => ({ path: p, hunks: [] })) },
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    };
  }

  const passingSubmission = () => ({
    runId: RUN_ID,
    projectRoot,
    verdict: 'pass' as const,
    criteria: [
      {
        id: 'AC-soft',
        description: 'looks polished',
        status: 'pass' as const,
        reasoning: 'clean layout',
        screenshotIds: ['web-card'],
      },
    ],
  });

  it('GATE INTEGRITY: a frozen-mid-work run with all criteria passing STILL signs off — classification never touches the stop rule', async () => {
    // The spec was frozen while src/Card.tsx was already dirty, and this run's
    // diff touches the same file ⇒ frozen-mid-work. Not a git repo — the pure
    // overlap rule (rule 2) is ancestry-independent by design.
    const spec = makeBoundSpec(['src/Card.tsx']);
    writeMeta(projectRoot, metaOverrides(spec, ['src/Card.tsx']));

    const result = await handleSubmitReport(passingSubmission());
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as {
      signedOff: boolean;
      verdict: string;
      temporal?: { classification: string; reason: string; perSpec: unknown };
    };
    expect(sc.temporal?.classification).toBe('frozen-mid-work');
    expect(sc.temporal?.perSpec).toEqual([
      { specId: spec.id, version: 1, classification: 'frozen-mid-work' },
    ]);
    // The honesty pair, gate half: mid-work is a BADGE, not a gate.
    expect(sc.signedOff).toBe(true);
    expect(sc.verdict).toBe('pass');
  });

  it('a frozen-before-work run with a FAILING criterion still refuses sign-off (badge never rescues a fail)', async () => {
    const spec = makeBoundSpec([]); // clean tree at freeze
    writeMeta(projectRoot, metaOverrides(spec, ['src/Other.tsx']));

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'fail',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'fail',
          reasoning: 'spacing broken',
          screenshotIds: ['web-card'],
        },
      ],
    });
    const sc = result.structuredContent as {
      signedOff: boolean;
      temporal?: { classification: string };
    };
    // Equal freeze/verify shas but NOT a git repo → ancestry unanswerable →
    // honest `unknown` (never before-work without affirmative proof).
    expect(sc.temporal?.classification).toBe('unknown');
    expect(sc.signedOff).toBe(false);
  });

  it('classifies frozen-before-work in a REAL git repo (freeze at HEAD, disjoint work)', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 't@validity.local'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectRoot });
    writeFileSync(resolve(projectRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', 'README.md'], { cwd: projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    const spec: Spec = {
      id: 'spec-temporal2',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      git: { sha: head, dirty: false, changedFiles: [] },
    };
    writeSpec(projectRoot, spec);
    writeMeta(projectRoot, {
      specId: spec.id,
      specVersion: 1,
      planId: spec.id,
      git: { sha: head, dirty: true },
      diff: { files: [{ path: 'src/Card.tsx', hunks: [] }] },
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    });

    const result = await handleSubmitReport(passingSubmission());
    const sc = result.structuredContent as {
      signedOff: boolean;
      temporal?: { classification: string; freezeSha?: string; verifySha?: string };
    };
    expect(sc.temporal?.classification).toBe('frozen-before-work');
    expect(sc.temporal?.freezeSha).toBe(head.slice(0, 7));
    expect(sc.temporal?.verifySha).toBe(head.slice(0, 7));
    expect(sc.signedOff).toBe(true);
  });

  it('legacy spec without a binding → unknown; non-spec run → temporal key omitted', async () => {
    const spec = makeSpec(projectRoot); // no git binding (pre-B2 spec)
    writeMeta(projectRoot, {
      specId: spec.id,
      specVersion: 1,
      git: { sha: VERIFY_SHA, dirty: false },
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    });
    const withSpec = await handleSubmitReport(passingSubmission());
    const scSpec = withSpec.structuredContent as { temporal?: { classification: string } };
    expect(scSpec.temporal?.classification).toBe('unknown');

    // Non-spec run: no `temporal` key at all (omission discipline).
    writeMeta(projectRoot);
    const noSpec = await handleSubmitReport({ runId: RUN_ID, projectRoot, verdict: 'pass' });
    expect((noSpec.structuredContent as { temporal?: unknown }).temporal).toBeUndefined();
  });
});

describe('handlePlan — repo-typecheck auto-attach (A5)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-plan-cmd-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeConfig(withCommands: boolean): void {
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, '.validity', 'config.ts'),
      `export default {\n` +
        `  renderMode: 'web' as const,\n` +
        `  framework: 'auto' as const,\n` +
        `  wrapper: './.validity/wrapper.gen.tsx',\n` +
        (withCommands ? `  commands: { typecheck: 'tsc --noEmit' },\n` : '') +
        `};\n`,
    );
  }

  function writeTsconfig(): void {
    writeFileSync(resolve(projectRoot, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  }

  async function plan(): Promise<{ spec: Spec; responseText: string }> {
    const result = await handlePlan({
      prompt: 'add a save button',
      criteria: [{ id: 'AC-1', description: 'a save button is visible' }],
      projectRoot,
    });
    const responseText = (result.content as Array<{ text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    const match = responseText.match(/Spec created \+ frozen: (spec-[a-z0-9-]+)@v/);
    expect(match).toBeTruthy();
    const spec = readSpec(projectRoot, match![1]!)!;
    expect(spec).toBeTruthy();
    return { spec, responseText };
  }

  it('attaches a blocking repo-typecheck property criterion when tsconfig + commands.typecheck exist', async () => {
    writeTsconfig();
    writeConfig(true);
    const { spec, responseText } = await plan();

    const auto = spec.criteria.find((c) => c.id === 'repo-typecheck');
    expect(auto).toBeDefined();
    expect(auto!.tier).toBe('property');
    // No severity → blocking by default: a type error blocks sign-off.
    expect(auto!.severity).toBeUndefined();
    expect(auto!.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
    expect(responseText).toContain('repo-typecheck was auto-attached');
  });

  it('does NOT attach without commands.typecheck in config', async () => {
    writeTsconfig();
    writeConfig(false);
    const { spec, responseText } = await plan();
    expect(spec.criteria.find((c) => c.id === 'repo-typecheck')).toBeUndefined();
    expect(responseText).not.toContain('repo-typecheck');
  });

  it('always auto-attaches a blocking repo-a11y-critical gate (no config prerequisite) and reports it', async () => {
    // No tsconfig, no commands → typecheck is NOT attached, but the a11y gate
    // needs no prerequisite (axe always runs in the sandbox), so it still is.
    writeConfig(false);
    const { spec, responseText } = await plan();
    const a11y = spec.criteria.find((c) => c.id === 'repo-a11y-critical');
    expect(a11y).toBeDefined();
    expect(a11y!.tier).toBe('property');
    // No severity → blocking: a critical a11y violation blocks sign-off.
    expect(a11y!.severity).toBeUndefined();
    expect(a11y!.checks).toEqual([
      { expect: { a11y: { severity: 'critical', maxViolations: 0 } } },
    ]);
    expect(responseText).toContain('repo-a11y-critical was auto-attached');
    // Independent of typecheck, which is absent here.
    expect(spec.criteria.find((c) => c.id === 'repo-typecheck')).toBeUndefined();
  });

  it('does NOT attach without a tsconfig.json', async () => {
    writeConfig(true);
    const { spec, responseText } = await plan();
    expect(spec.criteria.find((c) => c.id === 'repo-typecheck')).toBeUndefined();
    expect(responseText).not.toContain('repo-typecheck');
  });

  it('plan → immediate freeze stamps the freeze-time git binding (B2): sha is HEAD, dirty files listed', async () => {
    writeConfig(false);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 't@validity.local'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectRoot });
    writeFileSync(resolve(projectRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '-A'], { cwd: projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    writeFileSync(resolve(projectRoot, 'wip.txt'), 'in-flight\n'); // dirty at freeze

    const { spec } = await plan();
    expect(spec.status).toBe('frozen');
    expect(spec.git?.sha).toBe(head);
    expect(spec.git?.dirty).toBe(true);
    expect(spec.git?.changedFiles).toContain('wip.txt');
    // Binding is provenance, OUTSIDE the hash — the frozen hash still binds.
    expect(spec.hash).toMatch(/^sha256-/);
  });

  it('plan in a non-git project stamps no binding (legacy YAML shape preserved)', async () => {
    writeConfig(false);
    const { spec } = await plan();
    expect(spec.status).toBe('frozen');
    expect(spec.git).toBeUndefined();
  });
});

describe('handleSubmitReport — spec-context panel assembly (system tie-in)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-specctx-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a spec-bound run renders the "Part of spec" panel with maturity + certification blockers', async () => {
    const spec = makeSpec(projectRoot);
    writeMeta(projectRoot, {
      specId: spec.id,
      criterionVerdicts: [{ id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
    });

    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'fine',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();

    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    expect(html).toContain(`Part of spec ${spec.id}`);
    // Frozen all-soft spec: maturity derives to `team` with the
    // no-mechanical-anchor blocker — the panel names the path to certified.
    expect(html).toContain('To reach <strong>certified</strong>');
    expect(html).toContain('validity spec show spec-taint1');
    // The renderer runs after the timeline re-index, so this run appears as a dot.
    expect(html).toContain('report-spec-dot');
  });

  it('an unplanned run (no specId) renders no spec-context panel', async () => {
    writeMeta(projectRoot, {});
    const result = await handleSubmitReport({
      runId: RUN_ID,
      projectRoot,
      verdict: 'pass',
      criteria: [],
    });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, RUN_ID), 'report.html'), 'utf-8');
    expect(html).not.toContain('Part of spec');
  });
});

describe('formatUnmatchedFetchBlock', () => {
  it('returns empty when nothing was unmatched', () => {
    expect(formatUnmatchedFetchBlock('base', undefined, undefined)).toBe('');
    expect(formatUnmatchedFetchBlock('base', [], [])).toBe('');
  });

  it('emits a paste-ready stub per structured request, keyed to the fabricated body', () => {
    const block = formatUnmatchedFetchBlock(
      'base',
      [
        { method: 'GET', url: 'http://127.0.0.1:3001/billing/status', body: {} },
        { method: 'POST', url: 'http://127.0.0.1:3001/orders?draft=1', body: { ok: true } },
      ],
      undefined,
    );
    // Provenance is explicit — the reader must know the body is fabricated.
    expect(block).toContain(
      "under 'base' (answered by the fallback — the body is fabricated, not fetched)",
    );
    expect(block).toContain('paste the stub into .validity/config.ts');
    // GET: URL line + stub (no method, origin generalized, trailing comma).
    expect(block).toContain('\n  • GET http://127.0.0.1:3001/billing/status');
    expect(block).toContain('\n      { url: "*/billing/status", json: {} },');
    // POST: carries method; query collapses to a trailing `*`.
    expect(block).toContain('\n  • POST http://127.0.0.1:3001/orders?draft=1');
    expect(block).toContain('\n      { method: "POST", url: "*/orders*", json: {"ok":true} },');
  });

  it('falls back to the plain URL list (no stub) for run-metas without structured requests', () => {
    const block = formatUnmatchedFetchBlock('logged-in', undefined, [
      'GET http://127.0.0.1:3001/legacy',
    ]);
    expect(block).toContain("under 'logged-in' (handled by fallback):");
    expect(block).toContain('\n  • GET http://127.0.0.1:3001/legacy');
    expect(block).not.toContain('paste the stub');
  });

  it('prefers structured requests over the plain list when both are present', () => {
    const block = formatUnmatchedFetchBlock(
      'base',
      [{ method: 'GET', url: 'http://x/a', body: {} }],
      ['GET http://x/a'],
    );
    expect(block).toContain('paste the stub');
    expect(block).not.toContain('(handled by fallback):');
  });
});
