/**
 * Unit tests for the PURE pieces of the private report builder plus the
 * check-metadata producers (B3). No sandbox boot: synthetic specs/metas/results
 * in, structures + rendered HTML out. The base-comparison tests use a temp dir
 * (real runs.jsonl lines / a real throwaway git repo) — never a render. The
 * gate-integrity invariant — a hard FAIL can never render as a green report or
 * a green PR comment — is asserted explicitly, INCLUDING through the actual
 * GitHub Action renderer (`post-check.cjs`), so the check.json producer and
 * the PR-comment consumer can never drift.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readAttestation,
  runDir,
  runMetaPathFor,
  VALIDITY_SCORE_VERSION,
  verifyRunAttestation,
} from '@validity.ai/verify-spec';
import type { CriterionVerdict, RunMeta, Spec } from '@validity.ai/verify-spec';
import { renderHtmlReport } from '@validity.ai/verify-web';
import {
  buildRunReportHtml,
  writeRunReportHtml,
  buildCheckBaseComparison,
  buildCheckMetadata,
  buildCheckSpecSummaries,
  buildVerifyAllReportInput,
  combineSpecHashes,
  combinedVerdict,
  mergeBaseSha,
  parseRepoFromRemote,
  environmentFromRuns,
  evidenceFromRuns,
  resolveBaseValidityScore,
  scoringFromRuns,
  softAdvisoryCriteria,
  softCriteriaRows,
  tallyCounts,
  type CheckMetadata,
  type VerifyAllRun,
} from './report-render.js';
import type { SpecResult } from './commands/verify-all.js';

// The ACTUAL GitHub Action renderer — dependency-free CommonJS, require()d
// directly so these producer fixtures round-trip through the very code that
// posts the PR comment (no fixture-only shape drift possible).
const requireCjs = createRequire(import.meta.url);
const postCheck = requireCjs('../../verify-action/post-check.cjs') as {
  conclusionFor: (meta: CheckMetadata) => 'success' | 'failure' | 'neutral';
  commentBody: (meta: CheckMetadata, artifactUrl: string, detail: 'full' | 'compact') => string;
};

function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-aaaa',
    version: 1,
    status: 'frozen',
    source: { prompt: 'Build a contact form', createdBy: 'user' },
    runtime: 'web',
    criteria: [
      { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'looks polished', tier: 'soft' },
    ],
    hash: 'sha256-deadbeef',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeMeta(verdicts: CriterionVerdict[]): RunMeta {
  return {
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'isolation',
    prompt: 'Build a contact form',
    scenarios: [],
    components: [],
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    criterionVerdicts: verdicts,
  };
}

describe('parseRepoFromRemote', () => {
  it.each([
    ['git@github.com:spaceship/validity.git', 'spaceship/validity'],
    ['https://github.com/spaceship/validity.git', 'spaceship/validity'],
    ['https://github.com/spaceship/validity', 'spaceship/validity'],
    ['ssh://git@github.com/spaceship/validity.git', 'spaceship/validity'],
  ])('parses %s', (remote, expected) => {
    expect(parseRepoFromRemote(remote)).toBe(expected);
  });

  it('returns undefined for an unrecognized remote', () => {
    expect(parseRepoFromRemote('not-a-remote')).toBeUndefined();
  });
});

describe('combineSpecHashes', () => {
  it('returns the lone hash for a single spec', () => {
    expect(combineSpecHashes([makeSpec({ hash: 'sha256-abc' })])).toBe('sha256-abc');
  });

  it('is order-independent for multiple specs', () => {
    const a = makeSpec({ id: 'spec-a', hash: 'sha256-a' });
    const b = makeSpec({ id: 'spec-b', hash: 'sha256-b' });
    expect(combineSpecHashes([a, b])).toBe(combineSpecHashes([b, a]));
  });

  it('changes when the set changes', () => {
    const a = makeSpec({ id: 'spec-a', hash: 'sha256-a' });
    const b = makeSpec({ id: 'spec-b', hash: 'sha256-b' });
    expect(combineSpecHashes([a, b])).not.toBe(combineSpecHashes([a]));
  });
});

describe('softAdvisoryCriteria', () => {
  it('returns only soft criteria, as unverifiable advisory rows', () => {
    const rows = softAdvisoryCriteria(makeSpec());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'AC-2', status: 'unverifiable' });
    expect(rows[0]!.reasoning).toMatch(/advisory/i);
  });
});

describe('combinedVerdict', () => {
  const result = (criteria: SpecResult['criteria'], error?: string): SpecResult => ({
    specId: 'spec-aaaa',
    version: 1,
    error,
    criteria,
  });

  it('is fail when a hard criterion fails', () => {
    expect(combinedVerdict([result([{ id: 'AC-1', tier: 'hard', status: 'fail' }])])).toBe('fail');
  });

  it('is fail when a spec failed to render', () => {
    expect(combinedVerdict([result([], 'boom')])).toBe('fail');
  });

  it('is partial when a soft criterion is present (skipped in CLI)', () => {
    expect(
      combinedVerdict([
        result([
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ]),
      ]),
    ).toBe('partial');
  });

  it('is partial when a hard criterion is unverifiable', () => {
    expect(combinedVerdict([result([{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }])])).toBe(
      'partial',
    );
  });

  it('is pass only when every hard criterion passed and none are soft/unverifiable', () => {
    expect(combinedVerdict([result([{ id: 'AC-1', tier: 'hard', status: 'pass' }])])).toBe('pass');
  });
});

describe('tallyCounts', () => {
  it('sums statuses across specs', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ],
      },
      {
        specId: 'spec-b',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
      },
    ];
    expect(tallyCounts(results)).toEqual({ pass: 1, fail: 1, unverifiable: 0, skipped: 1 });
  });
});

describe('buildVerifyAllReportInput — gate integrity', () => {
  function run(
    spec: Spec,
    verdicts: CriterionVerdict[],
    criteria: SpecResult['criteria'],
  ): VerifyAllRun {
    return { spec, meta: makeMeta(verdicts), results: { specId: spec.id, version: 1, criteria } };
  }

  it('renders verdict=pass + a Proven section when the hard check passed', () => {
    const spec = makeSpec();
    const input = buildVerifyAllReportInput({
      runs: [
        run(
          spec,
          [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'POST /api/contact → 200' }],
          [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'skipped' },
          ],
        ),
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.verdict).toBe('partial'); // soft present ⇒ partial, never a clean pass in CI
    expect(input.criterionVerdicts?.[0]?.status).toBe('pass');
    const html = renderHtmlReport(input);
    expect(html).toContain('Proven (deterministic)');
    // The soft criterion is advisory, NOT proof.
    expect(html).toContain('Advisory');
  });

  it('a hard FAIL never renders as a green report', () => {
    const spec = makeSpec();
    const input = buildVerifyAllReportInput({
      runs: [
        run(
          spec,
          [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST observed' }],
          [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
        ),
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.verdict).toBe('fail');
    const html = renderHtmlReport(input);
    // The Fail verdict badge is present; coverage/proven still render the fail.
    expect(html).toContain('Fail');
  });

  it('FALSE-CONFIDENCE: an errored spec (meta:null) still counts against coverage and shows in the report', () => {
    // Regression: verdicts were read from run.meta only, so a spec whose render
    // or device setup failed contributed NOTHING to the HTML — its hard
    // criteria left the coverage denominator (which then read a reassuring
    // 100% with nothing decided) and never appeared in the "Not validated"
    // ledger, while --summary/--check-output reported the error correctly.
    const ok = makeSpec({ id: 'spec-ok' });
    const broken = makeSpec({ id: 'spec-broken' });
    const input = buildVerifyAllReportInput({
      runs: [
        run(
          ok,
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        ),
        {
          spec: broken,
          meta: null,
          results: {
            specId: broken.id,
            version: 1,
            error: 'native spec not verified: no booted iOS Simulator auto-discovered',
            criteria: [
              { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
              { id: 'AC-2', tier: 'soft', status: 'skipped' },
            ],
          },
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });

    // The undecided hard criterion is IN the verdict set, so coverage is
    // 1-of-2, not a clean 100%. Soft stays out of mechanical coverage.
    const ids = input.criterionVerdicts?.map((v) => v.id) ?? [];
    expect(ids).toContain('spec-broken/AC-1');
    expect(ids).not.toContain('spec-broken/AC-2');
    expect(input.coverage?.hardPropertyTotal).toBe(2);
    expect(input.coverage?.verifiableCount).toBe(1);

    // …and the reader is told WHY, on the page itself.
    const html = renderHtmlReport(input);
    expect(html).toContain('no booted iOS Simulator');
  });

  // ── Environment-blocked banner + fix-command fold (handoff-2026-07-28) ──
  //
  // The errored spec already reaches the page (test above). What it could not
  // say was WHY the environment failed or what to run — the reader saw a wall
  // of `unverifiable` and had to guess whether their code was undecidable or
  // their emulator was wedged.

  const brokenRun = (over: Partial<SpecResult> = {}): VerifyAllRun => ({
    spec: makeSpec({ id: 'spec-broken' }),
    meta: null,
    results: {
      specId: 'spec-broken',
      version: 1,
      error: 'native verify: render not confirmed (status=unconfirmed)',
      diagnosis: {
        cause: 'session-decay',
        symptom: 'Android snapshots are slow in this run: p95 2934ms over 209 captures.',
        detail: 'The session has degraded with age.',
        fixCommand: 'kill $(cat daemon.pid)\nadb emu kill',
        confidence: 'suspected',
      },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      ...over,
    },
  });

  it('populates specError from the errored run, with its cause + full fix recipe', () => {
    const input = buildVerifyAllReportInput({
      runs: [brokenRun()],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.specError).toEqual({
      message: 'spec-broken: native verify: render not confirmed (status=unconfirmed)',
      cause: 'session-decay',
      // The banner is where the WHOLE recipe belongs — the table clips, this
      // does not.
      fixCommand: 'kill $(cat daemon.pid)\nadb emu kill',
    });
    const html = renderHtmlReport(input);
    expect(html).toContain('Environment blocked — verdicts withheld');
    expect(html).toContain('session-decay');
    expect(html).toContain('adb emu kill');
  });

  it('omits specError entirely on a healthy run — the banner is presence-gated', () => {
    const input = buildVerifyAllReportInput({
      runs: [
        run(
          makeSpec(),
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        ),
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.specError).toBeUndefined();
    expect(renderHtmlReport(input)).not.toContain('report-envblocked"');
  });

  it('still banners an UNDIAGNOSED failure — the message alone is enough', () => {
    const input = buildVerifyAllReportInput({
      runs: [brokenRun({ diagnosis: undefined })],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.specError?.message).toContain('render not confirmed');
    expect(input.specError).not.toHaveProperty('cause');
    expect(input.specError).not.toHaveProperty('fixCommand');
    expect(renderHtmlReport(input)).toContain('Environment blocked — verdicts withheld');
  });

  it('names the first blocked spec and STATES the count when several were blocked', () => {
    const input = buildVerifyAllReportInput({
      runs: [
        brokenRun(),
        { ...brokenRun(), spec: makeSpec({ id: 'spec-broken-2' }) },
        { ...brokenRun(), spec: makeSpec({ id: 'spec-broken-3' }) },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    // One thing to fix, and nothing hidden about the rest.
    expect(input.specError?.message).toContain('spec-broken:');
    expect(input.specError?.message).toContain('+2 more specs blocked');
  });

  it('NEVER GREEN: the banner does not soften the verdict', () => {
    const input = buildVerifyAllReportInput({
      runs: [brokenRun()],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.verdict).toBe('fail');
  });

  it("folds the cause + first-line fix into the ledger row's detail", () => {
    const input = buildVerifyAllReportInput({
      runs: [brokenRun()],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    const detail = input.criterionVerdicts?.[0]?.detail ?? '';
    expect(detail).toContain('render not confirmed');
    expect(detail).toContain('[cause: session-decay — fix: kill $(cat daemon.pid)]');
    // Clipped to one command: the banner above carries the rest.
    expect(detail).not.toContain('adb emu kill');
  });

  it('leaves the ledger detail unchanged when nothing was diagnosed', () => {
    const input = buildVerifyAllReportInput({
      runs: [brokenRun({ diagnosis: undefined })],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.criterionVerdicts?.[0]?.detail).toBe(
      'native verify: render not confirmed (status=unconfirmed)',
    );
  });

  it('namespaces colliding criterion ids across multiple specs', () => {
    const a = makeSpec({ id: 'spec-a' });
    const b = makeSpec({ id: 'spec-b' });
    const input = buildVerifyAllReportInput({
      runs: [
        run(
          a,
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        ),
        run(
          b,
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
          [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        ),
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    const ids = input.criterionVerdicts?.map((v) => v.id) ?? [];
    expect(ids).toEqual(['spec-a/AC-1', 'spec-b/AC-1']);
  });
});

describe('buildVerifyAllReportInput — temporal-binding roll-up (B2)', () => {
  function runWithTemporal(spec: Spec, temporal: SpecResult['temporal']): VerifyAllRun {
    return {
      spec,
      meta: makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]),
      results: {
        specId: spec.id,
        version: 1,
        temporal,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      },
    };
  }

  const build = (runs: VerifyAllRun[]) =>
    buildVerifyAllReportInput({
      runs,
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });

  it('one mid-work spec makes the header chip mid-work (mid-work ⊐ unknown ⊐ before-work)', () => {
    const input = build([
      runWithTemporal(makeSpec({ id: 'spec-a' }), 'frozen-before-work'),
      runWithTemporal(makeSpec({ id: 'spec-b' }), 'frozen-mid-work'),
    ]);
    expect(input.temporalBinding).toBe('frozen-mid-work');
  });

  it('one unknown spec keeps the known classification (partial, does not collapse)', () => {
    const input = build([
      runWithTemporal(makeSpec({ id: 'spec-a' }), 'frozen-before-work'),
      runWithTemporal(makeSpec({ id: 'spec-b' }), 'unknown'),
    ]);
    expect(input.temporalBinding).toBe('frozen-before-work');
    expect(input.temporalPartial).toBe(true);
    expect(input.temporalUnknownSpecs).toEqual(['spec-b']);
  });

  it('all before-work → before-work; no classifications at all → chip omitted', () => {
    expect(
      build([runWithTemporal(makeSpec({ id: 'spec-a' }), 'frozen-before-work')]).temporalBinding,
    ).toBe('frozen-before-work');
    expect(
      build([runWithTemporal(makeSpec({ id: 'spec-a' }), undefined)]).temporalBinding,
    ).toBeUndefined();
  });

  it('GATE INTEGRITY: a mid-work classification never changes the verdict roll-up', () => {
    const input = build([runWithTemporal(makeSpec({ id: 'spec-a' }), 'frozen-mid-work')]);
    // All hard criteria passed — mid-work is a badge, not a verdict input.
    expect(input.verdict).toBe('pass');
  });
});

describe('CheckMetadata — B1 unplanned/enforcement fields stay additive', () => {
  const v1Json = JSON.stringify({
    verdict: 'pass',
    pass: true,
    coveragePercent: 100,
    counts: { pass: 1, fail: 0, unverifiable: 0, skipped: 0 },
    repo: null,
    sha: null,
    specHash: 'sha256-deadbeef',
    branch: null,
    prNumber: null,
  });

  it('pre-field JSON parses with both fields undefined (old artifacts stay honest)', () => {
    const meta = JSON.parse(v1Json) as CheckMetadata;
    expect(meta.unplanned).toBeUndefined();
    expect(meta.enforcement).toBeUndefined();
  });

  it('the populated shape round-trips', () => {
    const meta: CheckMetadata = {
      ...(JSON.parse(v1Json) as CheckMetadata),
      unplanned: false,
      enforcement: 'advisory',
    };
    const back = JSON.parse(JSON.stringify(meta)) as typeof meta;
    expect(back.unplanned).toBe(false);
    expect(back.enforcement).toBe('advisory');
  });
});

/* ------------------------------------------------------------------ *
 * B3 producers: buildCheckSpecSummaries / base comparison / metadata. *
 * ------------------------------------------------------------------ */

function makeRun(over: {
  spec?: Spec;
  meta?: RunMeta | null;
  results?: Partial<SpecResult>;
}): VerifyAllRun {
  const spec = over.spec ?? makeSpec();
  const results: SpecResult = {
    specId: spec.id,
    version: spec.version,
    criteria: [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'skipped',
        detail: 'soft criterion — needs agent verify',
      },
    ],
    ...over.results,
  };
  const meta =
    over.meta !== undefined ? over.meta : makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
  return { spec, meta, results };
}

describe('buildCheckSpecSummaries', () => {
  it('joins criterion text from the spec and carries status/tier/detail from results', () => {
    const [summary] = buildCheckSpecSummaries([
      makeRun({
        results: {
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'expected POST, saw none' },
            { id: 'AC-2', tier: 'soft', status: 'skipped', detail: 'needs agent verify' },
          ],
        },
      }),
    ]);
    expect(summary!.specId).toBe('spec-aaaa');
    expect(summary!.version).toBe(1);
    expect(summary!.criteria).toHaveLength(2);
    expect(summary!.criteria[0]).toMatchObject({
      id: 'AC-1',
      text: 'submit works',
      tier: 'hard',
      status: 'fail',
      detail: 'expected POST, saw none',
    });
    expect(summary!.criteria[1]).toMatchObject({
      id: 'AC-2',
      text: 'looks polished',
      tier: 'soft',
      status: 'skipped',
    });
  });

  it('maps taints via evidenceTaintsOf (legacy networkTainted and evidenceTaints, deduped)', () => {
    const meta = makeMeta([
      { id: 'AC-1', tier: 'hard', status: 'unverifiable', networkTainted: true },
    ]);
    meta.criterionVerdicts![0]!.evidenceTaints = ['wrapper', 'network'];
    const [summary] = buildCheckSpecSummaries([
      makeRun({
        meta,
        results: { criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }] },
      }),
    ]);
    expect(summary!.criteria[0]!.taints).toEqual(['wrapper', 'network']);
  });

  it('derives taints:[network] from a networkTainted-only verdict (old run-meta)', () => {
    const [summary] = buildCheckSpecSummaries([
      makeRun({
        meta: makeMeta([
          { id: 'AC-1', tier: 'hard', status: 'unverifiable', networkTainted: true },
        ]),
        results: { criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }] },
      }),
    ]);
    expect(summary!.criteria[0]!.taints).toEqual(['network']);
  });

  it('omits the taints key for untainted verdicts and for rows with no verdict', () => {
    const [summary] = buildCheckSpecSummaries([makeRun({})]);
    expect(summary!.criteria[0]!.taints).toBeUndefined(); // untainted pass
    expect(summary!.criteria[1]!.taints).toBeUndefined(); // soft — no mechanical verdict
  });

  it('preserves rows on a render error (meta null) and carries error + temporal', () => {
    const [summary] = buildCheckSpecSummaries([
      makeRun({
        meta: null,
        results: {
          error: 'Vite sandbox failed: boom',
          temporal: 'frozen-mid-work',
          criteria: [
            {
              id: 'AC-1',
              tier: 'hard',
              status: 'unverifiable',
              detail: 'no mechanical verdict produced for this criterion',
            },
          ],
        },
      }),
    ]);
    expect(summary!.error).toBe('Vite sandbox failed: boom');
    expect(summary!.temporal).toBe('frozen-mid-work');
    expect(summary!.criteria[0]!.status).toBe('unverifiable');
  });
});

describe('mergeBaseSha + buildCheckBaseComparison', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-check-base-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function gitIn(args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  }

  it('mergeBaseSha returns undefined outside a git repo', () => {
    expect(mergeBaseSha(root, 'main')).toBeUndefined();
  });

  it('mergeBaseSha resolves the merge-base against a bare local ref', () => {
    gitIn(['init', '-q', '-b', 'main']);
    gitIn(['config', 'user.email', 'test@validity.local']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['config', 'commit.gpgsign', 'false']);
    gitIn(['commit', '-q', '--allow-empty', '-m', 'base']);
    const baseSha = gitIn(['rev-parse', 'HEAD']);
    gitIn(['checkout', '-q', '-b', 'feature']);
    gitIn(['commit', '-q', '--allow-empty', '-m', 'work']);
    // No `origin/main` in this throwaway repo — the bare-ref fallback resolves.
    expect(mergeBaseSha(root, 'main')).toBe(baseSha);
    expect(mergeBaseSha(root, 'nope')).toBeUndefined();
  });

  function writeHistoryLine(specId: string, line: object | string): void {
    const dir = resolve(root, '.validity', 'specs', specId);
    mkdirSync(dir, { recursive: true });
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    appendFileSync(resolve(dir, 'runs.jsonl'), text + '\n');
  }

  const BASE_SHA = 'a'.repeat(40);

  it('diffs current hard/property statuses against the LAST matching base entry', () => {
    // Legacy line (no sha) and a criteria-less line at the sha are both skipped.
    writeHistoryLine('spec-aaaa', {
      runId: 'run-legacy',
      createdAt: '2026-05-01T00:00:00.000Z',
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    writeHistoryLine('spec-aaaa', {
      runId: 'run-no-snapshot',
      createdAt: '2026-05-02T00:00:00.000Z',
      sha: BASE_SHA,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
    });
    writeHistoryLine('spec-aaaa', {
      runId: 'run-old',
      createdAt: '2026-05-03T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'fail',
      counts: { pass: 0, fail: 1, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
    });
    writeHistoryLine('spec-aaaa', {
      runId: 'run-base',
      createdAt: '2026-05-04T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-9', tier: 'soft', status: 'pass' }, // soft — filtered from the base side
      ],
    });

    const run = makeRun({
      results: {
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST observed' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' }, // soft — filtered from the current side
        ],
      },
    });
    const cmp = buildCheckBaseComparison({ projectRoot: root, baseSha: BASE_SHA, runs: [run] });
    expect(cmp.sha).toBe(BASE_SHA);
    expect(cmp.specs).toHaveLength(1);
    const entry = cmp.specs[0]!;
    expect(entry.baseRunId).toBe('run-base'); // LAST matching entry wins
    expect(entry.baseSpecVersion).toBe(1);
    expect(entry.deltas).toEqual([
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
    ]);
  });

  it('a criterion that stopped producing a verdict reads as pass → unverifiable (regressed)', () => {
    writeHistoryLine('spec-aaaa', {
      runId: 'run-base',
      createdAt: '2026-05-04T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    const run = makeRun({
      results: {
        criteria: [
          {
            id: 'AC-1',
            tier: 'hard',
            status: 'unverifiable',
            detail: 'no mechanical verdict produced for this criterion',
          },
        ],
      },
    });
    const cmp = buildCheckBaseComparison({ projectRoot: root, baseSha: BASE_SHA, runs: [run] });
    expect(cmp.specs[0]!.deltas).toEqual([
      {
        criterionId: 'AC-1',
        previousStatus: 'pass',
        currentStatus: 'unverifiable',
        delta: 'regressed',
      },
    ]);
  });

  it('omits specs with no runs.jsonl / no matching sha and tolerates malformed lines', () => {
    writeHistoryLine('spec-bbbb', 'not json {');
    writeHistoryLine('spec-bbbb', {
      runId: 'run-other',
      createdAt: '2026-05-01T00:00:00.000Z',
      sha: 'b'.repeat(40),
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    const runs = [
      makeRun({ spec: makeSpec({ id: 'spec-bbbb' }), results: { specId: 'spec-bbbb' } }),
      makeRun({ spec: makeSpec({ id: 'spec-none' }), results: { specId: 'spec-none' } }),
    ];
    const cmp = buildCheckBaseComparison({ projectRoot: root, baseSha: BASE_SHA, runs });
    expect(cmp.specs).toEqual([]); // resolved merge-base, no matching history ⇒ hint line
  });

  // ── Regression: "B3 'Changes vs base' never consults F2's committed history"
  // — the base comparison must also read `.validity/history/<specId>.jsonl`
  // (the `historyCommitted: true` feed), or the section stays dead in a fresh
  // CI checkout where the gitignored local runs.jsonl is empty.
  function writeCommittedHistoryLine(specId: string, line: object): void {
    const dir = resolve(root, '.validity', 'history');
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, `${specId}.jsonl`), JSON.stringify(line) + '\n');
  }

  it('falls back to the committed .validity/history feed when the local runs.jsonl has no base row (historyCommitted in CI)', () => {
    // Fresh-checkout shape: NO local specs/<id>/runs.jsonl — only the
    // committed feed carries a row at the merge-base sha.
    writeCommittedHistoryLine('spec-aaaa', {
      v: 1,
      specId: 'spec-aaaa',
      runId: 'run-committed',
      createdAt: '2026-05-04T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    const run = makeRun({
      results: { criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }] },
    });
    const cmp = buildCheckBaseComparison({ projectRoot: root, baseSha: BASE_SHA, runs: [run] });
    expect(cmp.specs).toHaveLength(1);
    expect(cmp.specs[0]!.baseRunId).toBe('run-committed');
    expect(cmp.specs[0]!.deltas).toEqual([
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
    ]);
  });

  it('prefers the local runs.jsonl row over the committed feed when both match the base sha', () => {
    writeHistoryLine('spec-aaaa', {
      runId: 'run-local',
      createdAt: '2026-05-04T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    writeCommittedHistoryLine('spec-aaaa', {
      v: 1,
      specId: 'spec-aaaa',
      runId: 'run-committed',
      createdAt: '2026-05-05T00:00:00.000Z',
      sha: BASE_SHA,
      specVersion: 1,
      verdict: 'fail',
      counts: { pass: 0, fail: 1, unverifiable: 0 },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
    });
    const run = makeRun({
      results: { criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }] },
    });
    const cmp = buildCheckBaseComparison({ projectRoot: root, baseSha: BASE_SHA, runs: [run] });
    expect(cmp.specs[0]!.baseRunId).toBe('run-local');
  });
});

describe('resolveBaseValidityScore (F1/B3 — the PR-comment score delta producer)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-base-score-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScoreLine(line: object): void {
    const dir = resolve(root, '.validity', 'history');
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, 'score.jsonl'), JSON.stringify(line) + '\n');
  }

  const BASE_SHA = 'a'.repeat(40);

  // Regression: "CheckMetadata.validityScore.base has no producer anywhere" —
  // verify-all now stamps `base` via this resolver, so the post-check.cjs
  // delta branch (`base N · ▲/▼`) is reachable.
  it('returns the LAST committed score recorded at the merge-base sha', () => {
    writeScoreLine({
      at: '2026-05-01T00:00:00.000Z',
      sha: BASE_SHA,
      score: 61,
      perSpec: {},
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    writeScoreLine({
      at: '2026-05-02T00:00:00.000Z',
      sha: 'b'.repeat(40),
      score: 90,
      perSpec: {},
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    writeScoreLine({
      at: '2026-05-03T00:00:00.000Z',
      sha: BASE_SHA,
      score: 72,
      perSpec: {},
      source: 'soft-scores',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    expect(resolveBaseValidityScore(root, BASE_SHA)).toBe(72);
  });

  it('is absent (undefined) when no row matches the sha, the score is null, or no history exists', () => {
    expect(resolveBaseValidityScore(root, BASE_SHA)).toBeUndefined();
    writeScoreLine({
      at: '2026-05-01T00:00:00.000Z',
      sha: 'b'.repeat(40),
      score: 90,
      perSpec: {},
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    writeScoreLine({
      at: '2026-05-02T00:00:00.000Z',
      sha: BASE_SHA,
      score: null,
      perSpec: {},
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    expect(resolveBaseValidityScore(root, BASE_SHA)).toBeUndefined();
  });

  it('SKIPS rows from an older scoreVersion — a formula change must not render as a delta', () => {
    writeScoreLine({
      at: '2026-05-01T00:00:00.000Z',
      sha: BASE_SHA,
      score: 61,
      perSpec: {},
      source: 'watch',
      // v1 (unweighted) row: comparing it against a v2 (maturity-weighted)
      // current score would present the formula change as a regression.
      scoreVersion: 1 as unknown as typeof VALIDITY_SCORE_VERSION,
    });
    expect(resolveBaseValidityScore(root, BASE_SHA)).toBeUndefined();
  });

  it('rides into CheckMetadata.validityScore.base and the ACTUAL post-check.cjs renders the delta', () => {
    writeScoreLine({
      at: '2026-05-01T00:00:00.000Z',
      sha: BASE_SHA,
      score: 61,
      perSpec: {},
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
    });
    const base = resolveBaseValidityScore(root, BASE_SHA);
    const run = makeRun({}); // non-empty specs ⇒ the fat body (which carries scoreLine)
    const meta = buildCheckMetadata({
      results: [run.results],
      runs: [run],
      gatePass: true,
      coveragePercent: 100,
      repo: 'o/r',
      sha: 'c'.repeat(40),
      specHash: 'sha256-x',
      branch: 'feat',
      prNumber: 12,
      enforcement: 'advisory',
      validityScore: { current: 80, ...(base !== undefined ? { base } : {}), scoreVersion: 1 },
    });
    const body = postCheck.commentBody(
      JSON.parse(JSON.stringify(meta)) as CheckMetadata,
      'https://example.test/artifact',
      'full',
    );
    expect(body).toContain('base 61');
  });
});

describe('buildCheckMetadata → the ACTUAL GitHub Action renderer (no drift)', () => {
  /** Serialize + parse — exactly what `--check-output` → `post-check.cjs` does. */
  function throughCheckJson(meta: CheckMetadata): CheckMetadata {
    return JSON.parse(JSON.stringify(meta)) as CheckMetadata;
  }

  it('keeps the nine v1 keys byte-identical in name and shape (back-compat lock)', () => {
    const run = makeRun({});
    const meta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: true,
        coveragePercent: 100,
        repo: 'acme/app',
        sha: 'deadbeef',
        specHash: 'sha256-deadbeef',
        branch: 'feature',
        prNumber: 7,
        enforcement: 'advisory',
      }),
    );
    expect(meta.schemaVersion).toBe(2);
    expect(meta).toMatchObject({
      verdict: 'partial', // soft present ⇒ partial
      pass: true,
      coveragePercent: 100,
      counts: { pass: 1, fail: 0, unverifiable: 0, skipped: 1 },
      repo: 'acme/app',
      sha: 'deadbeef',
      specHash: 'sha256-deadbeef',
      branch: 'feature',
      prNumber: 7,
      unplanned: false,
      enforcement: 'advisory',
    });
    expect(meta.specs).toHaveLength(1);
    expect(meta.base).toBeUndefined(); // absent, not null — presence-gated section
    expect(meta.validityScore).toBeUndefined(); // presence-gated — absent unless the producer supplies it
    // The real renderer treats this as v2 and its conclusion mirrors the gate.
    expect(postCheck.conclusionFor(meta)).toBe('neutral');
    const body = postCheck.commentBody(meta, 'http://artifact', 'full');
    expect(body).toContain('### Proven (deterministic)');
    expect(body).toContain('AC-1 — submit works');
    expect(body).toContain('### Scored (advisory — needs an agent verify)');
    expect(body).toContain('⏭️ not scored in CI');
  });

  it('threads validityScore (F1) through to the renderer, and it NEVER moves the conclusion', () => {
    const run = makeRun({
      results: {
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'boom' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ],
      },
    });
    const meta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: false,
        coveragePercent: 100,
        repo: null,
        sha: null,
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'advisory',
        validityScore: { current: 84, scoreVersion: 1 },
      }),
    );
    expect(meta.validityScore).toEqual({ current: 84, scoreVersion: 1 });
    // A high score beside a hard fail: the conclusion is still the gate's.
    expect(postCheck.conclusionFor(meta)).toBe('failure');
    expect(postCheck.commentBody(meta, '', 'full')).toContain('Validity Score: 84');
    // An unmeasurable score (current: null) renders no score line at all.
    const nullMeta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: false,
        coveragePercent: 100,
        repo: null,
        sha: null,
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'advisory',
        validityScore: { current: null, scoreVersion: 1 },
      }),
    );
    expect(postCheck.commentBody(nullMeta, '', 'full')).not.toContain('Validity Score');
  });

  it("CAN'T FALSE-GREEN: a hard-fail spec row always yields conclusion failure", () => {
    const run = makeRun({
      results: {
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'expected POST /contact, saw none' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ],
      },
    });
    const meta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: false, // hasHardFailure mirror — the producer feeds the exit gate's value
        coveragePercent: 100,
        repo: null,
        sha: null,
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'advisory',
      }),
    );
    expect(meta.verdict).toBe('fail');
    expect(postCheck.conclusionFor(meta)).toBe('failure');
    const body = postCheck.commentBody(meta, '', 'full');
    expect(body).toContain('## Validity — ❌ FAIL');
    expect(body).toContain('❌ fail');
    expect(body).toContain('expected POST /contact, saw none');
  });

  it('renders taints, temporal badge, strict badge, and base deltas end-to-end', () => {
    const meta = makeMeta([
      { id: 'AC-1', tier: 'hard', status: 'unverifiable', networkTainted: true },
    ]);
    const run = makeRun({
      meta,
      results: {
        temporal: 'frozen-mid-work',
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'unverifiable', detail: 'proxy-fabricated response' },
        ],
      },
    });
    const checkMeta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: true,
        coveragePercent: 0,
        repo: null,
        sha: 'deadbeef',
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'strict',
        base: {
          sha: 'a'.repeat(40),
          specs: [
            {
              specId: 'spec-aaaa',
              baseSpecVersion: 1,
              baseRunId: 'run-base',
              baseCreatedAt: '2026-05-04T00:00:00.000Z',
              deltas: [
                {
                  criterionId: 'AC-1',
                  previousStatus: 'pass',
                  currentStatus: 'unverifiable',
                  delta: 'regressed',
                },
              ],
            },
          ],
        },
      }),
    );
    const body = postCheck.commentBody(checkMeta, '', 'full');
    expect(body).toContain('⛓ network'); // evidenceTaintsOf-mapped taint in the Evidence column
    expect(body).toContain('`spec frozen mid-work`'); // report-pill vocabulary (worstTemporal)
    expect(body).toContain('`strict`');
    expect(body).toContain('### Changes vs base `aaaaaaa`');
    expect(body).toContain('❌ **regressed:** `spec-aaaa/AC-1` pass → unverifiable');
    // A tainted-unverifiable row never renders a green badge.
    const provenRows = body.split('\n').filter((l) => l.includes('AC-1 —'));
    for (const row of provenRows) expect(row).not.toContain('✅');
  });

  it('envBlocked is absent when nothing errored (backward compat: old CLI shape)', () => {
    const run = makeRun({});
    const meta = throughCheckJson(
      buildCheckMetadata({
        results: [run.results],
        runs: [run],
        gatePass: true,
        coveragePercent: 100,
        repo: null,
        sha: null,
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'advisory',
      }),
    );
    expect(meta.envBlocked).toBeUndefined();
    expect(postCheck.checkTitle(meta)).toBe('Validity — partial');
    expect(postCheck.commentBody(meta, '', 'full')).not.toContain('Environment blocked');
  });

  it('threads envBlocked through to the check title + PR-comment callout end-to-end', () => {
    const erroredSpec: Spec = { ...makeSpec(), id: 'spec-broken' };
    const erroredRun = makeRun({
      spec: erroredSpec,
      meta: null,
      results: {
        specId: 'spec-broken',
        error: 'Vite sandbox failed: ECONNREFUSED',
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      },
    });
    const okRun = makeRun({});
    const envBlocked = { count: 1, errors: ['Vite sandbox failed: ECONNREFUSED'] };
    const meta = throughCheckJson(
      buildCheckMetadata({
        results: [erroredRun.results, okRun.results],
        runs: [erroredRun, okRun],
        gatePass: false, // an errored spec always trips hasHardFailure — never softened
        coveragePercent: 50,
        repo: null,
        sha: null,
        specHash: 'sha256-deadbeef',
        branch: null,
        prNumber: null,
        enforcement: 'advisory',
        envBlocked,
      }),
    );
    expect(meta.envBlocked).toEqual(envBlocked);
    // check-run title names it, conclusion is still failure (attribution, not softening)
    expect(postCheck.checkTitle(meta)).toBe('Validity — fail (environment blocked — 1 spec)');
    expect(postCheck.conclusionFor(meta)).toBe('failure');
    const body = postCheck.commentBody(meta, '', 'full');
    expect(body).toContain('⚠ **Environment blocked — 1 spec produced no verdicts.**');
    expect(body).toContain('Vite sandbox failed: ECONNREFUSED');
  });
});

// Issue #18c: a judged run's per-criterion reasoning previously lived only in
// the signal queue — the report's soft rows must carry the judge's status,
// reasoning, and cited screenshots.
describe('softCriteriaRows (judged-aware)', () => {
  const judgedVerdict: CriterionVerdict = {
    id: 'AC-2',
    tier: 'soft',
    status: 'pass',
    detail: 'The page shows a large heading addressing the signed-in user by name.',
    scoredBy: { model: 'anthropic/claude-sonnet-5', session: 'validity-judge' },
    screenshotCitations: ['src-pages-homepage'],
  };

  it('renders a SCORED soft verdict with the judge status + reasoning + citations', () => {
    const rows = softCriteriaRows(makeSpec(), makeMeta([judgedVerdict]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'AC-2',
      status: 'pass',
      screenshotIds: ['src-pages-homepage'],
    });
    expect(rows[0]!.reasoning).toContain('large heading addressing the signed-in user');
  });

  it('keeps the advisory row for UNSCORED soft criteria (no scoredBy)', () => {
    const placeholder: CriterionVerdict = {
      id: 'AC-2',
      tier: 'soft',
      status: 'unverifiable',
      detail: 'soft criterion — not yet scored',
    };
    const rows = softCriteriaRows(makeSpec(), makeMeta([placeholder]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'AC-2', status: 'unverifiable' });
    expect(rows[0]!.reasoning).toMatch(/advisory/i);
  });

  it('matches softAdvisoryCriteria byte-for-byte when the meta is null (plain sweep parity)', () => {
    expect(softCriteriaRows(makeSpec(), null)).toEqual(softAdvisoryCriteria(makeSpec()));
  });

  it('buildVerifyAllReportInput threads the judged reasoning into input.criteria', () => {
    const spec = makeSpec();
    const meta = makeMeta([judgedVerdict]);
    const results: SpecResult = {
      specId: spec.id,
      version: spec.version,
      criteria: [{ id: 'AC-2', tier: 'soft', status: 'pass' }],
    };
    const input = buildVerifyAllReportInput({
      runs: [{ spec, meta, results }],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open x',
    });
    const soft = input.criteria!.find((c) => c.id === 'AC-2')!;
    expect(soft.status).toBe('pass');
    expect(soft.reasoning).toContain('large heading');
    // And the rendered HTML carries the reasoning (the run view surface).
    const html = renderHtmlReport(input);
    expect(html).toContain('large heading addressing the signed-in user');
  });
});

// ---------------------------------------------------------------------------
// Plan 1.4 — the CLI report must not hide the provenance the MCP report leads
// with. A `verify --all` over self-scored runs used to render NO provenance at
// all: the pill was lit only for `judge: 'model'` runs.
// ---------------------------------------------------------------------------

describe('scoringFromRuns (verify --all provenance)', () => {
  const run = (scoring?: RunMeta['scoring'], id = 'spec-aaaa'): VerifyAllRun => {
    const spec = makeSpec({ id });
    const meta = makeMeta([]);
    return {
      spec,
      meta: scoring ? { ...meta, scoring } : meta,
      results: { specId: id, version: 1, criteria: [] },
    };
  };

  it('returns undefined when no run carries a scoring stamp (plain sweep unchanged)', () => {
    expect(scoringFromRuns([run(), run(undefined, 'spec-bbbb')])).toBeUndefined();
  });

  it('surfaces a SELF-SCORED stamp — the case the CLI report used to drop entirely', () => {
    const scoring = { judge: 'agent' as const, scoredBy: 'claude', selfScored: true };
    expect(scoringFromRuns([run(scoring)])).toEqual(scoring);
  });

  it('lets the weakest claim win: one self-scored spec taints a model-judged merge', () => {
    const selfScored = { judge: 'agent' as const, scoredBy: 'claude', selfScored: true };
    const judged = { judge: 'model' as const, judgeModel: 'gpt-judge', selfScored: false };
    // Either order — a merged report must never average out to "model-judged".
    expect(scoringFromRuns([run(judged), run(selfScored, 'spec-bbbb')])).toEqual(selfScored);
    expect(scoringFromRuns([run(selfScored), run(judged, 'spec-bbbb')])).toEqual(selfScored);
  });

  it('prefers the independent model judge when nothing was self-scored', () => {
    const fresh = { judge: 'fresh-context' as const, selfScored: false };
    const judged = { judge: 'model' as const, judgeModel: 'gpt-judge', selfScored: false };
    expect(scoringFromRuns([run(fresh), run(judged, 'spec-bbbb')])).toEqual(judged);
  });
});

describe('buildVerifyAllReportInput — provenance reaches the rendered CLI report', () => {
  const scoredVerdict: CriterionVerdict = {
    id: 'AC-2',
    tier: 'soft',
    status: 'pass',
    detail: 'The form looks polished.',
    scoredBy: { model: 'claude-opus-5' },
    screenshotCitations: ['src-form'],
  };

  function selfScoredRun(): VerifyAllRun {
    const spec = makeSpec();
    const meta: RunMeta = {
      ...makeMeta([scoredVerdict]),
      scoring: { judge: 'agent', scoredBy: 'claude-opus-5', selfScored: true },
    };
    return {
      spec,
      meta,
      results: {
        specId: spec.id,
        version: 1,
        criteria: [{ id: 'AC-2', tier: 'soft', status: 'pass' }],
      },
    };
  }

  it('renders the self-scored provenance in the judged lane and as a per-criterion chip', () => {
    const input = buildVerifyAllReportInput({
      runs: [selfScoredRun()],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open x',
    });
    expect(input.scoring).toEqual({
      judge: 'agent',
      scoredBy: 'claude-opus-5',
      selfScored: true,
    });
    expect(input.evidence?.['AC-2']).toMatchObject({ scoredBy: 'claude-opus-5', selfScored: true });

    const html = renderHtmlReport(input);
    // Run-level provenance, in the judged lane (never blended into the machine one).
    expect(html).toContain('report-lane--judged');
    expect(html).toContain('self-scored');
    // Per-criterion evidence chips.
    expect(html).toContain('scored by: claude-opus-5');
  });

  it('namespaces the merged evidence map per spec, keep-first on collision', () => {
    const a = selfScoredRun();
    const b = { ...selfScoredRun(), spec: makeSpec({ id: 'spec-bbbb' }) };
    const evidence = evidenceFromRuns([a, b]);
    expect(Object.keys(evidence).sort()).toEqual(['spec-aaaa/AC-2', 'spec-bbbb/AC-2']);
    // Single-run reports keep the bare id (no namespacing).
    expect(Object.keys(evidenceFromRuns([a]))).toEqual(['AC-2']);
  });

  it('an unscored CLI sweep says "not scored" — never an implied judgement', () => {
    const spec = makeSpec();
    const input = buildVerifyAllReportInput({
      runs: [
        {
          spec,
          meta: makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]),
          results: {
            specId: spec.id,
            version: 1,
            criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
          },
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open x',
    });
    expect(input.scoring).toBeUndefined();
    const html = renderHtmlReport(input);
    expect(html).toContain('not scored');
    expect(html).not.toContain('self-scored');
    expect(html).not.toContain('model-judged');
  });
});

describe('writeRunReportHtml attestation chain', () => {
  const previousHome = process.env.VALIDITY_HOME;
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-report-attest-')));
    process.env.VALIDITY_HOME = resolve(root, 'validity-home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.VALIDITY_HOME;
    else process.env.VALIDITY_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  /** Seed a run dir + run-meta on disk — attestRun signs what is PERSISTED. */
  function seed(): { spec: Spec; meta: RunMeta } {
    const spec = makeSpec();
    const meta = { ...makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]), specId: spec.id };
    mkdirSync(runDir(root, meta.runId), { recursive: true });
    writeFileSync(runMetaPathFor(root, meta.runId), JSON.stringify(meta, null, 2));
    return { spec, meta };
  }

  it('signs the run, prints the digest in the FOOTER, and signs the report bytes', () => {
    const { spec, meta } = seed();
    const dest = writeRunReportHtml({ projectRoot: root, spec, meta });
    const record = readAttestation(runDir(root, meta.runId))!;
    const html = readFileSync(dest, 'utf-8');

    expect(html).toContain(record.digest);
    expect(html).toContain(record.signature);
    expect(html).toContain(record.publicKey);
    // Footer, not header — another worker owns the header.
    expect(html.indexOf('<div class="report-attest">')).toBeGreaterThan(html.indexOf('<footer'));
    expect(record.report?.file).toBe('report.html');
    expect(
      verifyRunAttestation({ dir: runDir(root, meta.runId), runMeta: meta }).mismatches,
    ).toEqual([]);
  });

  it('is deterministic — identical inputs render identical bytes', () => {
    const { spec, meta } = seed();
    const first = readFileSync(writeRunReportHtml({ projectRoot: root, spec, meta }), 'utf-8');
    const second = readFileSync(writeRunReportHtml({ projectRoot: root, spec, meta }), 'utf-8');
    expect(second).toBe(first);
  });

  it('editing one byte of the rendered report breaks the chain', () => {
    const { spec, meta } = seed();
    const dest = writeRunReportHtml({ projectRoot: root, spec, meta });
    writeFileSync(dest, `${readFileSync(dest, 'utf-8')} `);
    const result = verifyRunAttestation({ dir: runDir(root, meta.runId), runMeta: meta });
    expect(result.mismatches.map((m) => m.field)).toContain('report:report.html');
  });

  it('the transient (no-write) render reuses the on-disk stamp, never a new one', () => {
    const { spec, meta } = seed();
    writeRunReportHtml({ projectRoot: root, spec, meta });
    const attestationPath = resolve(runDir(root, meta.runId), 'attestation.json');
    const record = readAttestation(runDir(root, meta.runId))!;
    const before = readFileSync(attestationPath, 'utf-8');
    expect(buildRunReportHtml({ projectRoot: root, spec, meta })).toContain(record.digest);
    expect(readFileSync(attestationPath, 'utf-8')).toBe(before);
  });

  it('renders no attestation block for a run that was never signed', () => {
    const spec = makeSpec();
    const meta = makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    expect(buildRunReportHtml({ projectRoot: root, spec, meta })).not.toContain(
      '<div class="report-attest">',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Environment channel + run-dir evidence, end to end through the CLI. *
 * ------------------------------------------------------------------ */

describe('environmentFromRuns (merged-report environment)', () => {
  const envRun = (env: RunMeta['environment']): VerifyAllRun => ({
    spec: makeSpec(),
    meta: { ...makeMeta([]), environment: env },
    results: { specId: 'spec-contact', version: 1, criteria: [] },
  });

  it('is undefined when no run recorded one (native/URL sweeps, legacy run-metas)', () => {
    expect(environmentFromRuns([envRun(undefined)])).toBeUndefined();
    expect(environmentFromRuns([])).toBeUndefined();
  });

  it('lets the WEAKEST claim win — a dep-scan abort outranks a clean run', () => {
    const clean = { target: 'web' as const, devServer: 'cold' as const, tailwindShim: false };
    const aborted = { ...clean, depScanFailure: 'Could not resolve "aws-sdk"' };
    expect(environmentFromRuns([envRun(clean), envRun(aborted)])).toEqual(aborted);
  });

  it('prefers an UNOBSERVABLE (reused-browse) run over a clean cold one', () => {
    const clean = { target: 'web' as const, devServer: 'cold' as const, tailwindShim: false };
    const reused = {
      target: 'web' as const,
      devServer: 'reused-browse' as const,
      tailwindShim: false,
    };
    expect(environmentFromRuns([envRun(clean), envRun(reused)])).toEqual(reused);
  });

  it('falls back to the first recorded environment, deterministically', () => {
    const a = { target: 'web' as const, devServer: 'cold' as const, tailwindShim: true };
    const b = { target: 'next-web' as const, devServer: 'cold' as const, tailwindShim: false };
    expect(environmentFromRuns([envRun(a), envRun(b)])).toEqual(a);
  });

  it('propagates run-meta.environment onto the report input (render → run-meta → report)', () => {
    const spec = makeSpec();
    const environment = {
      target: 'expo-web' as const,
      devServer: 'cold' as const,
      tailwindShim: false,
      depScanFailure: 'Could not resolve "aws-sdk" (from src/y.ts:1:0)',
    };
    const input = buildVerifyAllReportInput({
      runs: [
        {
          spec,
          meta: { ...makeMeta([]), environment },
          results: { specId: spec.id, version: 1, criteria: [] },
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.environment).toEqual(environment);
  });

  it('omits the field entirely when nothing recorded an environment', () => {
    const spec = makeSpec();
    const input = buildVerifyAllReportInput({
      runs: [{ spec, meta: makeMeta([]), results: { specId: spec.id, version: 1, criteria: [] } }],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input).not.toHaveProperty('environment');
  });
});

describe('environment + run-dir evidence reach the rendered CLI report', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-report-env-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(over: Partial<RunMeta> = {}): { spec: Spec; meta: RunMeta } {
    const spec = makeSpec();
    const meta: RunMeta = {
      ...makeMeta([{ id: 'AC-1', tier: 'hard', status: 'pass' }]),
      specId: spec.id,
      ...over,
    };
    mkdirSync(runDir(root, meta.runId), { recursive: true });
    writeFileSync(runMetaPathFor(root, meta.runId), JSON.stringify(meta, null, 2));
    return { spec, meta };
  }

  it('propagates run-meta.environment into the report input and onto the page', () => {
    const { spec, meta } = seed({
      environment: {
        target: 'expo-web',
        devServer: 'cold',
        tailwindShim: false,
        depScanFailure: 'Could not resolve "aws-sdk" (from src/y.ts:1:0)',
      },
    });
    const input = buildVerifyAllReportInput({
      runs: [{ spec, meta, results: { specId: spec.id, version: 1, criteria: [] } }],
      createdAt: '2026-01-01T00:00:00.000Z',
      viewCommand: 'open report.html',
    });
    expect(input.environment).toEqual(meta.environment);
    const html = buildRunReportHtml({ projectRoot: root, spec, meta });
    expect(html).toContain('setup-env-list');
    expect(html).toContain('react-native-web composes the app onto DOM nodes');
    expect(html).toContain('aborted — Could not resolve');
  });

  it('renders the drift + device-evidence sections from the run dir when the sidecars exist', () => {
    const { spec, meta } = seed();
    const dir = runDir(root, meta.runId);
    writeFileSync(
      resolve(dir, 'replay-divergence.json'),
      JSON.stringify({
        schema: 1,
        observedAt: '2026-08-06T09:00:00.000Z',
        recording: 'recording.ad',
        divergence: {
          kind: 'selector-miss',
          step: 4,
          action: 'press',
          suggestions: [{ selector: 'id=cta', basis: 'id' }],
          resume: { allowed: true, from: 4, planDigest: 'sha256-deadbeef' },
        },
      }),
    );
    writeFileSync(
      resolve(dir, 'device-evidence.json'),
      JSON.stringify({
        schema: 1,
        records: [
          {
            kind: 'perf-metrics',
            status: 'captured',
            command: 'agent-device perf metrics --json',
            scoring: 'advisory-evidence-only',
          },
        ],
      }),
    );

    const html = buildRunReportHtml({ projectRoot: root, spec, meta });
    expect(html).toContain('Journey drift');
    expect(html).toContain(
      'agent-device replay recording.ad --from 4 --plan-digest sha256-deadbeef',
    );
    expect(html).toContain('Device evidence');
    expect(html).toContain('captured (agent-device perf metrics --json)');
    // Advisory, never a verdict: the page says so in both sections, and the
    // headline verdict is untouched by either.
    expect(html).toContain('after</strong> this run was signed');
    expect(html).toContain('<strong>Not scored.</strong>');
  });

  it('adds zero bytes when the run dir holds no sidecars', () => {
    const { spec, meta } = seed();
    const html = buildRunReportHtml({ projectRoot: root, spec, meta });
    expect(html).not.toContain('<section class="report-section report-drift"');
    expect(html).not.toContain('<section class="report-section report-devevidence"');
  });

  it('is deterministic with sidecars present — same inputs, same bytes', () => {
    const { spec, meta } = seed({
      environment: { target: 'web', devServer: 'reused-browse', tailwindShim: false },
    });
    writeFileSync(
      resolve(runDir(root, meta.runId), 'device-evidence.json'),
      JSON.stringify({ records: [{ kind: 'perf-frames', status: 'unavailable' }] }),
    );
    expect(buildRunReportHtml({ projectRoot: root, spec, meta })).toBe(
      buildRunReportHtml({ projectRoot: root, spec, meta }),
    );
  });
});
