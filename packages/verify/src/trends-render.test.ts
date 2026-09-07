import { describe, expect, it } from 'vitest';

import {
  renderTrendsBody,
  renderTrendsHtml,
  type TrendsInput,
  type TrendsTimelineEntry,
} from './trends-render.js';

function entry(overrides: Partial<TrendsTimelineEntry> = {}): TrendsTimelineEntry {
  return {
    runId: 'run-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    verdict: 'pass',
    coverageRatio: 1,
    source: 'local',
    ...overrides,
  };
}

function baseInput(overrides: Partial<TrendsInput> = {}): TrendsInput {
  return {
    projectName: 'demo',
    generatedAt: '2026-07-01T00:00:00.000Z',
    specs: [],
    ...overrides,
  };
}

describe('renderTrendsHtml — empty input', () => {
  it('renders a valid minimal page with the onboarding hint and no charts', () => {
    const html = renderTrendsHtml(baseInput());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('No spec history yet');
    expect(html).toContain('validity__verify');
    expect(html).not.toContain('<svg');
  });

  it('de-orphans the file artifact: the ACTUAL wordmark + a dashboard up-link + footer hint', () => {
    const html = renderTrendsHtml(baseInput());
    // Inlined wordmark (both theme variants, @validity.ai/verify-report's topbar), never a remote asset.
    expect(html).toContain('v-wm-dark');
    expect(html).toContain('v-wm-light');
    expect(html).toContain('alt="Validity"');
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).not.toContain('src="http');
    // Leftmost nav item: a "back to the dashboard" up-link, hidden until the
    // page is actually served (progressive enhancement — dead over file://).
    expect(html).toContain('↑ Project dashboard');
    expect(html).toContain('data-served-link hidden');
    // Footer hint points at the local signals queue, for readers without JS.
    expect(html).toContain('validity signals list');
  });

  it('is self-contained: every asset is inline data, a local anchor, or a served route — never external', () => {
    const html = renderTrendsHtml(baseInput());
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(
        u.startsWith('data:') || u.startsWith('#') || u.startsWith('/') || u.startsWith('.'),
        u.slice(0, 60),
      ).toBe(true);
    }
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);
    expect(html).not.toMatch(/url\(\s*["']?https?:\/\//);
  });
});

describe('renderTrendsBody — served variant (dashboard /trends)', () => {
  it('drops its own <h1> (the sub-page shell owns the heading) but keeps the sub-line + project name', () => {
    const body = renderTrendsBody(baseInput({ projectName: 'demo' }), { served: true });
    expect(body).not.toContain('<h1');
    expect(body).toContain('demo');
    expect(body).toContain('local only, nothing uploaded');
  });

  it('served empty state explains how a timeline appears — never "re-run validity trends"', () => {
    const body = renderTrendsBody(baseInput(), { served: true });
    expect(body).toContain('No spec history on this machine yet');
    expect(body).toContain('validity verify');
    expect(body).not.toContain('re-run');
  });

  it('file variant keeps its <h1> and file-oriented empty hint', () => {
    const body = renderTrendsBody(baseInput());
    expect(body).toContain('<h1 class="vp-title">');
    expect(body).toContain('validity__verify');
  });

  it('is byte-identical across two served calls with the same input', () => {
    const a = renderTrendsBody(baseInput(), { served: true });
    const b = renderTrendsBody(baseInput(), { served: true });
    expect(a).toBe(b);
  });
});

describe('renderTrendsHtml — old-shape timeline (graceful degrade)', () => {
  it('renders verdict + coverage but omits criterion strip / perf / score', () => {
    const html = renderTrendsHtml(
      baseInput({
        specs: [
          {
            specId: 'checkout',
            timeline: [
              entry({ runId: 'r1', coverageRatio: 0.8 }),
              entry({ runId: 'r2', coverageRatio: 1 }),
            ],
            signals: [],
          },
        ],
      }),
    );
    // verdict timeline (step line) + coverage sparkline present
    expect(html).toContain('Verdict timeline');
    expect(html).toContain('Hard/property coverage');
    // no criteria / perf / score sections
    expect(html).not.toContain('Per-criterion status');
    expect(html).not.toContain('Performance (advisory');
    expect(html).not.toContain('Validity Score at run time');
  });
});

describe('renderTrendsHtml — section presence when data is rich', () => {
  const rich = baseInput({
    currentScore: { score: 87.4, formula: 'coverage*freshness' },
    specs: [
      {
        specId: 'checkout',
        title: 'Checkout flow',
        current: { verdict: 'partial', signedOff: false, coveragePercent: 66.7 },
        timeline: [
          entry({
            runId: 'r1',
            verdict: 'fail',
            coverageRatio: 0.5,
            criteria: [{ id: 'c1', tier: 'hard', status: 'fail' }],
            score: 40,
            perf: { Cart__base__base__default: { mountMs: 12, updateMs: 4 } },
          }),
          entry({
            runId: 'r2',
            verdict: 'pass',
            coverageRatio: 1,
            criteria: [{ id: 'c1', tier: 'hard', status: 'pass' }],
            score: 90,
            perf: { Cart__base__base__default: { mountMs: 10, updateMs: 3 } },
          }),
        ],
        signals: [],
      },
    ],
  });

  it('renders every section including score header and perf', () => {
    const html = renderTrendsHtml(rich);
    expect(html).toContain('87'); // rounded current score
    expect(html).toContain('coverage*freshness');
    expect(html).toContain('Per-criterion status');
    expect(html).toContain('Performance (advisory');
    expect(html).toContain('Validity Score at run time');
    expect(html).toContain('Checkout flow');
    // perf key grouped by component prefix
    expect(html).toContain('Cart');
  });
});

describe('renderTrendsHtml — can-not-false-green', () => {
  it('unknown/fabricated verdicts and statuses never carry a pass class', () => {
    const html = renderTrendsHtml(
      baseInput({
        specs: [
          {
            specId: 's',
            timeline: [
              entry({
                runId: 'r1',
                verdict: 'unknown',
                coverageRatio: 0,
                criteria: [
                  { id: 'c1', tier: 'hard', status: 'unverifiable' },
                  { id: 'c2', tier: 'hard', status: 'passish' as never },
                ],
              }),
            ],
            signals: [],
          },
        ],
      }),
    );
    // the criterion cells should be unverifiable/unknown, never pass. Match the
    // cell markup form (`class="vp-cell vp-cell--X"`) so the stylesheet's own
    // `.vp-cell--pass` rule doesn't trip the assertion.
    expect(html).toContain('class="vp-cell vp-cell--unverifiable"');
    expect(html).toContain('class="vp-cell vp-cell--unknown"');
    expect(html).not.toContain('class="vp-cell vp-cell--pass"');
  });
});

describe('renderTrendsHtml — signals including recovered', () => {
  it('lists a recovered signal with resolved styling', () => {
    const html = renderTrendsHtml(
      baseInput({
        specs: [
          {
            specId: 's',
            timeline: [entry()],
            signals: [
              {
                id: 'recovered:s:c1',
                kind: 'recovered',
                severity: 'info',
                specId: 's',
                criterionId: 'c1',
                detail: 'c1 is passing again',
                at: '2026-06-02T00:00:00.000Z',
                status: 'resolved',
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('Signal history');
    expect(html).toContain('recovered');
    expect(html).toContain('c1 is passing again');
    expect(html).toContain('vp-signal--resolved');
  });

  it('lists a suppressed signal with suppressed styling, not the open class', () => {
    const html = renderTrendsHtml(
      baseInput({
        specs: [
          {
            specId: 's',
            timeline: [entry()],
            signals: [
              {
                id: 'regression:s:c1',
                kind: 'regression',
                severity: 'high',
                specId: 's',
                criterionId: 'c1',
                detail: 'parked',
                at: '2026-06-02T00:00:00.000Z',
                status: 'suppressed',
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('vp-signal--suppressed');
    expect(html).toContain('(suppressed)');
    expect(html).toContain('class="vp-signal vp-signal--suppressed"');
  });
});

describe('renderTrendsHtml — escaping + determinism', () => {
  it('escapes a spec id containing markup', () => {
    const html = renderTrendsHtml(
      baseInput({
        specs: [{ specId: '<script>alert(1)</script>', timeline: [entry()], signals: [] }],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is byte-identical for the same input', () => {
    const input = baseInput({
      specs: [{ specId: 's', timeline: [entry(), entry({ runId: 'r2' })], signals: [] }],
    });
    expect(renderTrendsHtml(input)).toBe(renderTrendsHtml(input));
  });

  it('every emitted <svg> has role=img and a <title>', () => {
    const input = baseInput({
      specs: [
        {
          specId: 's',
          timeline: [entry(), entry({ runId: 'r2', coverageRatio: 0.5 })],
          signals: [],
        },
      ],
    });
    const html = renderTrendsHtml(input);
    const svgs = html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg).toContain('role="img"');
      expect(svg).toContain('<title>');
    }
  });
});
