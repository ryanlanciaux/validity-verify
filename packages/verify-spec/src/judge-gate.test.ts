import { describe, it, expect } from 'vitest';
import { buildSoftScoreGateContext, gateSoftScores } from './judge-gate.js';
import type { RunMeta } from './run.js';

/** A minimal run-meta carrying only the fields the gate reads. */
function metaFixture(): RunMeta {
  return {
    components: [
      { id: 'Button:default', filePath: 'src/Button.tsx' },
      { id: 'Button:empty', looksEmpty: true, filePath: 'src/Button.tsx' },
      { id: 'Other:default', filePath: 'src/widgets/Other.tsx' },
      // Interactive renders with a pre-interaction companion. `Pre:blank` is
      // blank BEFORE the click but real after it; `Pre:ok` is the reverse —
      // the pair pins that emptiness is never inherited in either direction.
      {
        id: 'Pre:blank',
        filePath: 'src/Pre.tsx',
        preInteractionScreenshotPath: '/runs/pre-blank.pre-interaction.png',
        preInteractionLooksEmpty: true,
      },
      {
        id: 'Pre:ok',
        filePath: 'src/Pre.tsx',
        looksEmpty: true,
        preInteractionScreenshotPath: '/runs/pre-ok.pre-interaction.png',
        preInteractionLooksEmpty: false,
      },
      { id: 'Errored:x', renderError: 'boom', filePath: 'src/Button.tsx' },
      { id: 'Skipped:x', screenshotSkipped: true, filePath: 'src/Button.tsx' },
    ],
    pages: [{ id: 'page:home' }, { id: 'page:err', errorMessage: 'nav failed' }],
  } as unknown as RunMeta;
}

function ctxFixture() {
  return buildSoftScoreGateContext({
    meta: metaFixture(),
    targetComponents: ['Button'],
    softCriterionIds: new Set(['AC-1', 'AC-2', 'AC-3', 'AC-4']),
  });
}

describe('buildSoftScoreGateContext', () => {
  it('collects citable ids, excludes errored/skipped, marks empties', () => {
    const ctx = ctxFixture();
    expect([...ctx.validScreenshotIds].sort()).toEqual([
      'Button:default',
      'Button:empty',
      'Other:default',
      'Pre:blank',
      'Pre:blank::pre',
      'Pre:ok',
      'Pre:ok::pre',
      'page:home',
    ]);
    expect([...ctx.emptyScreenshotIds].sort()).toEqual([
      'Button:empty',
      'Pre:blank::pre',
      'Pre:ok',
    ]);
    expect(ctx.renderComponentPathById.get('Button:default')).toBe('src/Button.tsx');
    expect(ctx.renderComponentPathById.get('Pre:ok::pre')).toBe('src/Pre.tsx');
  });

  it('never inherits emptiness between a render and its ::pre companion', () => {
    const ctx = ctxFixture();
    // Blank before the click, real after → only the companion is flagged.
    expect(ctx.emptyScreenshotIds.has('Pre:blank::pre')).toBe(true);
    expect(ctx.emptyScreenshotIds.has('Pre:blank')).toBe(false);
    // Real before the click, blank after → only the evidence shot is flagged,
    // so an initial-state criterion can still cite the pristine frame.
    expect(ctx.emptyScreenshotIds.has('Pre:ok')).toBe(true);
    expect(ctx.emptyScreenshotIds.has('Pre:ok::pre')).toBe(false);
  });

  it('rejects a soft pass citing a blank ::pre companion', () => {
    const r = gateSoftScores(
      [
        {
          id: 'AC-1',
          status: 'pass',
          reasoning: 'the initial state shows the form',
          screenshotIds: ['Pre:blank::pre'],
        },
      ],
      ctxFixture(),
    );
    expect(r.accepted).toEqual([]);
    expect(r.preRejected[0]?.id).toBe('AC-1');
  });

  it('accepts a soft pass citing a non-empty ::pre whose sibling went blank', () => {
    const r = gateSoftScores(
      [
        {
          id: 'AC-1',
          status: 'pass',
          reasoning: 'the initial state shows the form',
          screenshotIds: ['Pre:ok::pre'],
        },
      ],
      ctxFixture(),
    );
    expect(r.preRejected).toEqual([]);
    expect(r.accepted.map((s) => s.id)).toEqual(['AC-1']);
  });

  it('degrades to no citable ids when meta is null', () => {
    const ctx = buildSoftScoreGateContext({
      meta: null,
      targetComponents: [],
      softCriterionIds: new Set(['AC-1']),
    });
    expect(ctx.validScreenshotIds.size).toBe(0);
    expect(ctx.validIdHint).toMatch(/no citable screenshots/);
  });
});

describe('gateSoftScores', () => {
  it('accepts a soft pass citing a valid, non-empty render', () => {
    const r = gateSoftScores(
      [
        {
          id: 'AC-1',
          status: 'pass',
          reasoning: 'the label reads Save',
          screenshotIds: ['Button:default'],
        },
      ],
      ctxFixture(),
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.preRejected).toHaveLength(0);
    expect(r.accepted[0]).toMatchObject({
      id: 'AC-1',
      status: 'pass',
      detail: 'the label reads Save',
    });
  });

  it('rejects a soft pass with no citations (citation floor)', () => {
    const r = gateSoftScores(
      [{ id: 'AC-1', status: 'pass', reasoning: 'looks good' }],
      ctxFixture(),
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.preRejected[0]?.reason).toMatch(/pass missing screenshotIds/);
  });

  it('rejects a soft pass citing an unknown render id', () => {
    const r = gateSoftScores(
      [{ id: 'AC-1', status: 'pass', reasoning: 'x', screenshotIds: ['nope'] }],
      ctxFixture(),
    );
    expect(r.preRejected[0]?.reason).toMatch(/unknown render id/);
  });

  it('rejects a soft pass sourced only from a blank render', () => {
    const r = gateSoftScores(
      [{ id: 'AC-1', status: 'pass', reasoning: 'x', screenshotIds: ['Button:empty'] }],
      ctxFixture(),
    );
    expect(r.preRejected[0]?.reason).toMatch(/empty \(blank\) render/);
  });

  it('rejects any score missing reasoning', () => {
    const r = gateSoftScores([{ id: 'AC-2', status: 'fail', reasoning: '  ' }], ctxFixture());
    expect(r.preRejected[0]?.reason).toMatch(/missing reasoning/);
  });

  it('accepts fail/unverifiable without screenshot citations', () => {
    const r = gateSoftScores(
      [
        { id: 'AC-2', status: 'fail', reasoning: 'contrast is too low' },
        { id: 'AC-3', status: 'unverifiable', reasoning: 'motion cannot be shown in a still' },
      ],
      ctxFixture(),
    );
    expect(r.accepted).toHaveLength(2);
    expect(r.preRejected).toHaveLength(0);
  });

  it('does NOT citation-gate a pass on a non-soft id (handled downstream)', () => {
    const r = gateSoftScores(
      [{ id: 'HARD-1', status: 'pass', reasoning: 'mechanical' }],
      ctxFixture(),
    );
    // Not in softCriterionIds → the pass-citation floor is skipped here;
    // applySoftScores rejects the unknown/mechanical id later.
    expect(r.accepted).toHaveLength(1);
    expect(r.preRejected).toHaveLength(0);
  });

  it('flags a cross-component citation as advisory (not a reject)', () => {
    const r = gateSoftScores(
      [{ id: 'AC-4', status: 'pass', reasoning: 'x', screenshotIds: ['Other:default'] }],
      ctxFixture(),
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.citationWarnings[0]).toMatch(/outside this spec's targets/);
  });
});
