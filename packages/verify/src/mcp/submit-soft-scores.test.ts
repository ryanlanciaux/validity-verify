/**
 * Soft scores on submit (B3) + the end-to-end write-through acceptance.
 *
 * THE PRODUCT CLAIM under test: an agent that runs `validity__verify` and then
 * `validity__submit_report`, with `validity watch` NEVER having run, ends up
 * with a current scorecard — hard verdicts from the verify fold AND soft scores
 * from the submitted judgment — plus a receipt it can cite.
 *
 * The gate is not relaxed to get there: an uncited pass is still refused, and
 * a later `record_soft_scores` for the same run is idempotent.
 *
 * Hand-built run-metas, no Playwright/Vite (same harness as wrapper-taint.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foldVerifyIntoScorecard,
  loadScorecard,
  loadSignals,
  runDir,
  runMetaPathFor,
  writeSpec,
  type CriterionVerdict,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';
import { handleSubmitReport } from './server.js';
import { handleRecordSoftScores } from './scorecard-tools.js';

const RUN_ID = 'run_submit_soft_001';
const T1 = '2026-03-01T00:00:00.000Z';

function makeSpec(projectRoot: string): Spec {
  const spec: Spec = {
    id: 'spec-b3',
    version: 1,
    status: 'frozen',
    hash: 'hash-b3',
    source: { prompt: 'polish the card', createdBy: 'agent' },
    runtime: 'web',
    targets: { components: ['src/Card.tsx'] },
    criteria: [
      {
        id: 'AC-hard',
        text: 'no console errors',
        tier: 'hard',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
      { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
    ],
    createdAt: T1,
  };
  writeSpec(projectRoot, spec);
  return spec;
}

const VERIFY_VERDICTS: CriterionVerdict[] = [
  { id: 'AC-hard', tier: 'hard', status: 'pass', detail: '0 console errors' },
  // Verify emits soft criteria as placeholders — the agent's score fills them in.
  { id: 'AC-soft', tier: 'soft', status: 'unverifiable' },
];

function writeMeta(projectRoot: string): void {
  mkdirSync(resolve(runDir(projectRoot, RUN_ID), 'screenshots'), { recursive: true });
  const meta: RunMeta = {
    runId: RUN_ID,
    createdAt: T1,
    mode: 'isolation',
    prompt: 'polish the card',
    scenarios: [],
    specId: 'spec-b3',
    specVersion: 1,
    specHash: 'hash-b3',
    components: [
      {
        id: 'web-card',
        filePath: 'src/Card.tsx',
        screenshotPath: resolve(runDir(projectRoot, RUN_ID), 'screenshots', 'web-card__base.png'),
      },
    ],
    componentSources: {},
    criterionVerdicts: VERIFY_VERDICTS.map((v) => ({ ...v })),
    diff: { files: [] },
    report: { enabled: true, brand: 'none' },
  };
  writeFileSync(runMetaPathFor(projectRoot, RUN_ID), JSON.stringify(meta, null, 2));
}

/** The verify half of the loop: the fold the MCP verify performs, nothing else. */
function runVerifyFold(projectRoot: string, spec: Spec): void {
  writeMeta(projectRoot);
  foldVerifyIntoScorecard(projectRoot, { spec, verdicts: VERIFY_VERDICTS, now: T1 });
}

const submission = (projectRoot: string, over: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  projectRoot,
  verdict: 'pass' as const,
  scoredBy: 'test-judge-model',
  criteria: [
    {
      id: 'AC-soft',
      description: 'looks polished',
      status: 'pass' as const,
      reasoning: 'the card has even spacing and a legible heading in the screenshot',
      screenshotIds: ['web-card'],
    },
  ],
  ...over,
});

describe('submit_report writes soft scores through to the scorecard (B3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-b3-'));
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('E2E: verify → submit with a cited pass leaves hard verdicts AND soft scores, with no watch tick', async () => {
    const spec = makeSpec(projectRoot);
    runVerifyFold(projectRoot, spec);

    // After the verify fold alone: hard decided, soft still unscored + flagged.
    const afterVerify = loadScorecard(projectRoot)!.specs['spec-b3']!;
    expect(afterVerify.criteria['AC-hard']!.status).toBe('pass');
    expect(afterVerify.criteria['AC-soft']!.status).toBe('unscored');
    expect(
      loadSignals(projectRoot).some(
        (s) => s.kind === 'needs-scoring' && s.criterionId === 'AC-soft' && s.status === 'open',
      ),
    ).toBe(true);

    const result = await handleSubmitReport(submission(projectRoot));

    const entry = loadScorecard(projectRoot)!.specs['spec-b3']!;
    expect(entry.criteria['AC-hard']!.status).toBe('pass');
    expect(entry.criteria['AC-soft']!.status).toBe('pass');
    // Provenance is stamped exactly as record_soft_scores does.
    expect(entry.criteria['AC-soft']!.scoredBy).toBe('test-judge-model');
    expect(entry.criteria['AC-soft']!.scoredBySession).toBeTruthy();
    // The ask is answered: `needs-scoring` is no longer open.
    expect(
      loadSignals(projectRoot).some(
        (s) => s.kind === 'needs-scoring' && s.criterionId === 'AC-soft' && s.status === 'open',
      ),
    ).toBe(false);

    // …and the receipt says so truthfully.
    const receipt = (result.structuredContent as Record<string, any>).receipt;
    expect(receipt.softScoresApplied).toBe(1);
    expect(receipt.softScoresRejected).toEqual([]);
    expect(receipt.specId).toBe('spec-b3');
    const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('Ledger: 1 soft score(s) written to the scorecard for spec-b3');
  });

  it("CAN'T FALSE-GREEN: an UNCITED soft pass is refused and the row stays unscored", async () => {
    const spec = makeSpec(projectRoot);
    runVerifyFold(projectRoot, spec);

    const result = await handleSubmitReport(
      submission(projectRoot, {
        criteria: [
          {
            id: 'AC-soft',
            description: 'looks polished',
            status: 'pass',
            reasoning: 'trust me, it looks polished',
            // no screenshotIds
          },
        ],
      }),
    );

    expect(result.isError).toBe(true);
    // The scorecard never saw the pass.
    expect(loadScorecard(projectRoot)!.specs['spec-b3']!.criteria['AC-soft']!.status).toBe(
      'unscored',
    );
    // The receipt names the rejected criterion, machine-readably.
    const receipt = (result.structuredContent as Record<string, any>).receipt;
    expect(receipt.softScoresApplied).toBe(0);
    expect(receipt.softScoresRejected).toHaveLength(1);
    expect(receipt.softScoresRejected[0].criterionId).toBe('AC-soft');
    expect(receipt.softScoresRejected[0].reason).toContain('missing screenshot citations');
  });

  it('IDEMPOTENT: a later record_soft_scores for the same run does not double-open signals', async () => {
    const spec = makeSpec(projectRoot);
    runVerifyFold(projectRoot, spec);
    await handleSubmitReport(submission(projectRoot));

    const signalsAfterSubmit = loadSignals(projectRoot);
    const entryAfterSubmit = loadScorecard(projectRoot)!.specs['spec-b3']!.criteria['AC-soft']!;

    const record = await handleRecordSoftScores({
      specId: 'spec-b3',
      projectRoot,
      scoredBy: 'test-judge-model',
      scores: [
        {
          id: 'AC-soft',
          status: 'pass',
          reasoning: 'the card has even spacing and a legible heading in the screenshot',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(record.isError).toBeFalsy();

    const signalsAfterRecord = loadSignals(projectRoot);
    // `applySoftScores` replaces per criterion, so the second write neither
    // duplicates a signal id nor re-opens the one the submit just closed.
    expect(signalsAfterRecord).toHaveLength(signalsAfterSubmit.length);
    expect(new Set(signalsAfterRecord.map((s) => s.id)).size).toBe(signalsAfterRecord.length);
    expect(
      signalsAfterRecord.some(
        (s) => s.kind === 'needs-scoring' && s.criterionId === 'AC-soft' && s.status === 'open',
      ),
    ).toBe(false);
    // The score itself is unchanged (same status, still not stale).
    const entryAfterRecord = loadScorecard(projectRoot)!.specs['spec-b3']!.criteria['AC-soft']!;
    expect(entryAfterRecord.status).toBe(entryAfterSubmit.status);
    expect(entryAfterRecord.stale).toBeUndefined();
  });

  it('does NOT create a scorecard entry when no deterministic tick ever ran', async () => {
    // No fold: submit_report must not conjure standing state out of a
    // self-reported status — entry creation belongs to the mechanical tick.
    makeSpec(projectRoot);
    writeMeta(projectRoot);
    const result = await handleSubmitReport(submission(projectRoot));
    expect(loadScorecard(projectRoot)).toBeNull();
    const receipt = (result.structuredContent as Record<string, any>).receipt;
    expect(receipt.softScoresApplied).toBe(0);
  });
});
