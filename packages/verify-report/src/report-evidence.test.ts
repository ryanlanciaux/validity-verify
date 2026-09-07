/**
 * `buildEvidenceMap` (C1) — the per-criterion evidence assembly. The
 * load-bearing properties: hard/property citation ids are RECOVERED from the
 * renders that executed them, soft citations come from the persisted (floor-
 * validated) `screenshotCitations`, legacy run-metas (no taints / provenance /
 * scoredBy anywhere) produce sparser entries without ever throwing, and the
 * legacy `networkTainted` boolean normalizes into the `network` taint.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentRender, CriterionVerdict, RunMeta } from '@validity.ai/verify-spec';
import { buildEvidenceMap } from './report-evidence.js';

function render(over: Partial<ComponentRender> & { id: string }): ComponentRender {
  return {
    filePath: `src/${over.id}.tsx`,
    screenshotPath: `/tmp/${over.id}.png`,
    ...over,
  } as ComponentRender;
}

function meta(over: Partial<RunMeta> = {}): Parameters<typeof buildEvidenceMap>[0]['meta'] {
  return {
    mode: 'isolation',
    components: [],
    criterionVerdicts: [],
    ...over,
  };
}

describe('buildEvidenceMap', () => {
  it('recovers hard-criterion screenshot ids from the renders that executed it (two components → both cited)', () => {
    const verdict: CriterionVerdict = { id: 'AC-1', tier: 'hard', status: 'pass' };
    const map = buildEvidenceMap({
      meta: meta({
        components: [
          render({ id: 'card', criterionVerdicts: [{ ...verdict }] }),
          render({ id: 'list', criterionVerdicts: [{ ...verdict }] }),
          render({ id: 'unrelated' }),
        ],
        criterionVerdicts: [verdict],
      }),
      spec: null,
    });
    expect(map['AC-1']?.screenshotIds).toEqual(['card', 'list']);
    expect(map['AC-1']?.mode).toBe('isolation');
  });

  it('copies soft citations from screenshotCitations and derives the scoredBy display string (model ?? session)', () => {
    const map = buildEvidenceMap({
      meta: meta({
        scoring: { judge: 'self', selfScored: true },
        criterionVerdicts: [
          {
            id: 'AC-soft',
            tier: 'soft',
            status: 'pass',
            screenshotCitations: ['card'],
            scoredBy: { model: 'claude-x', session: 'sess-1' },
          },
          {
            id: 'AC-soft2',
            tier: 'soft',
            status: 'pass',
            screenshotCitations: ['card'],
            scoredBy: { session: 'sess-1' },
          },
        ],
      }),
      spec: null,
    });
    expect(map['AC-soft']?.screenshotIds).toEqual(['card']);
    expect(map['AC-soft']?.scoredBy).toBe('claude-x');
    expect(map['AC-soft']?.selfScored).toBe(true);
    // No model self-reported → the session fingerprint is the display string.
    expect(map['AC-soft2']?.scoredBy).toBe('sess-1');
  });

  it('unions data provenance + folds render confirmation downward (unconfirmed wins) over the cited renders', () => {
    const map = buildEvidenceMap({
      meta: meta({
        mode: 'native',
        components: [
          render({
            id: 'screen',
            dataProvenance: ['declared-mock'],
            renderConfirmation: 'confirmed',
          }),
          render({
            id: 'screen-2',
            dataProvenance: ['proxy-fallback', 'declared-mock'],
            renderConfirmation: 'unconfirmed',
          }),
        ],
        criterionVerdicts: [
          {
            id: 'AC-soft',
            tier: 'soft',
            status: 'unverifiable',
            screenshotCitations: ['screen', 'screen-2'],
          },
        ],
      }),
      spec: null,
    });
    expect(map['AC-soft']?.dataProvenance).toEqual(['declared-mock', 'proxy-fallback']);
    expect(map['AC-soft']?.renderConfirmation).toBe('unconfirmed');
    expect(map['AC-soft']?.mode).toBe('native');
  });

  it('old-shape run-meta (no provenance/taints/scoredBy anywhere) → ids + mode only, never throws', () => {
    const verdict: CriterionVerdict = { id: 'AC-1', tier: 'hard', status: 'pass' };
    const map = buildEvidenceMap({
      meta: {
        // No mode, no scoring — the pre-A2/A3/A4 shape.
        components: [render({ id: 'card', criterionVerdicts: [verdict] })],
        criterionVerdicts: [verdict, { id: 'AC-soft', tier: 'soft', status: 'unverifiable' }],
      },
      spec: null,
    });
    expect(map['AC-1']).toEqual({ mode: 'isolation', screenshotIds: ['card'] });
    expect(map['AC-soft']).toEqual({ mode: 'isolation' });
  });

  it("normalizes the legacy networkTainted boolean into the 'network' taint", () => {
    const map = buildEvidenceMap({
      meta: meta({
        criterionVerdicts: [
          { id: 'AC-net', tier: 'hard', status: 'unverifiable', networkTainted: true },
        ],
      }),
      spec: null,
    });
    expect(map['AC-net']?.taints).toEqual(['network']);
  });

  it("'native' mode passes through; absent mode falls back to 'isolation'", () => {
    const verdicts: CriterionVerdict[] = [{ id: 'AC-1', tier: 'hard', status: 'pass' }];
    expect(
      buildEvidenceMap({ meta: meta({ mode: 'native', criterionVerdicts: verdicts }), spec: null })[
        'AC-1'
      ]?.mode,
    ).toBe('native');
    expect(
      buildEvidenceMap({ meta: { criterionVerdicts: verdicts }, spec: null })['AC-1']?.mode,
    ).toBe('isolation');
  });
});
