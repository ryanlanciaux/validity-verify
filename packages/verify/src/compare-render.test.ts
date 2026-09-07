import { describe, expect, it } from 'vitest';

import { renderCompareHtml, type CompareInput, type CompareRun } from './compare-render.js';

function run(overrides: Partial<CompareRun> = {}): CompareRun {
  return {
    runId: 'runA',
    detail: 'full',
    renders: [],
    criteria: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<CompareInput> = {}): CompareInput {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    a: run({ runId: 'runA' }),
    b: run({ runId: 'runB' }),
    sameSpec: true,
    specHashChanged: false,
    ...overrides,
  };
}

describe('renderCompareHtml — pairing', () => {
  it('pairs a shared key into one row and buckets A-only / B-only as unpaired', () => {
    const html = renderCompareHtml(
      baseInput({
        a: run({
          renders: [
            { key: 'Cart__base', label: 'Cart', screenshotDataUrl: 'data:image/png;base64,AAA' },
            { key: 'OnlyA__base', label: 'OnlyA', screenshotDataUrl: 'data:image/png;base64,BBB' },
          ],
        }),
        b: run({
          renders: [
            { key: 'Cart__base', label: 'Cart', screenshotDataUrl: 'data:image/png;base64,CCC' },
            { key: 'OnlyB__base', label: 'OnlyB', screenshotDataUrl: 'data:image/png;base64,DDD' },
          ],
        }),
      }),
    );
    // three keys → three grid rows; count the cell markup form so the
    // stylesheet's own `.vp-grid-key` rule isn't included.
    expect((html.match(/class="vp-grid-key"/g) ?? []).length).toBe(3);
    expect(html).toContain('OnlyA__base');
    expect(html).toContain('OnlyB__base');
    expect(html).toContain('not rendered in this run');
  });
});

describe('renderCompareHtml — missing screenshots degrade loudly', () => {
  it('renders a metadata-only cell with the reason and never an <img>', () => {
    const html = renderCompareHtml(
      baseInput({
        a: run({
          renders: [
            {
              key: 'Cart__base',
              label: 'Cart',
              missingReason: 'screenshot skipped (definitively-red render)',
            },
          ],
        }),
        b: run({ renders: [] }),
      }),
    );
    expect(html).toContain('screenshot skipped (definitively-red render)');
    // No SCREENSHOT image — a missing shot never falls through to a stale/blank
    // <img>. (The inlined brand wordmark <img> in the page header is expected.)
    expect(html).not.toContain('class="vp-shot"');
  });
});

describe('renderCompareHtml — different specs', () => {
  it('shows the different-specs banner and omits the criteria delta table', () => {
    const html = renderCompareHtml(
      baseInput({
        sameSpec: false,
        a: run({ specId: 'x', criteria: [{ id: 'c1', tier: 'hard', status: 'pass' }] }),
        b: run({ specId: 'y', criteria: [{ id: 'c1', tier: 'hard', status: 'fail' }] }),
      }),
    );
    expect(html).toContain('verified DIFFERENT specs');
    expect(html).not.toContain('Criteria deltas');
  });
});

describe('renderCompareHtml — spec hash changed banner', () => {
  it('shows the amber same-spec-different-version banner', () => {
    const html = renderCompareHtml(baseInput({ sameSpec: true, specHashChanged: true }));
    expect(html).toContain('different frozen version');
  });
});

describe('renderCompareHtml — criteria deltas (can-not-false-green)', () => {
  it('renders pass → unverifiable as regressed ▼ (never improved) and a bogus status as unknown —', () => {
    const html = renderCompareHtml(
      baseInput({
        a: run({
          specId: 's',
          criteria: [
            { id: 'c1', tier: 'hard', status: 'pass' },
            { id: 'c2', tier: 'hard', status: 'pass' },
          ],
        }),
        b: run({
          specId: 's',
          criteria: [
            { id: 'c1', tier: 'hard', status: 'unverifiable' },
            { id: 'c2', tier: 'hard', status: 'bogus' },
          ],
        }),
      }),
    );
    // c1 pass→unverifiable is a regression, never an improvement/green
    expect(html).toContain('vp-delta--regressed">▼ regressed');
    expect(html).not.toContain('vp-delta--improved">▲');
    // c2 with an unknown status is never ranked — delta is em-dash unknown
    expect(html).toContain('vp-delta--unknown">— unknown');
  });
});

describe('renderCompareHtml — perf deltas', () => {
  it('computes ms + % delta and lists a one-sided metric as B only', () => {
    const html = renderCompareHtml(
      baseInput({
        a: run({ renders: [{ key: 'Cart__base', label: 'Cart', performance: { mountMs: 10 } }] }),
        b: run({
          renders: [
            { key: 'Cart__base', label: 'Cart', performance: { mountMs: 15, readyMs: 100 } },
          ],
        }),
      }),
    );
    expect(html).toContain('Performance deltas');
    expect(html).toContain('+5 ms');
    expect(html).toContain('+50%');
    expect(html).toContain('B only');
  });
});

describe('renderCompareHtml — escaping + determinism', () => {
  it('escapes a run id / label containing markup', () => {
    const html = renderCompareHtml(baseInput({ a: run({ runId: '<script>alert(1)</script>' }) }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is byte-identical for the same input', () => {
    const input = baseInput({
      a: run({ specId: 's', criteria: [{ id: 'c1', tier: 'hard', status: 'pass' }] }),
      b: run({ specId: 's', criteria: [{ id: 'c1', tier: 'hard', status: 'fail' }] }),
    });
    expect(renderCompareHtml(input)).toBe(renderCompareHtml(input));
  });
});
