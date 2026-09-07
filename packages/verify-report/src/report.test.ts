import { describe, expect, it } from 'vitest';
import {
  renderHtmlReport,
  renderMarkdownReport,
  type ReportComponent,
  type ReportDiff,
  type ReportInput,
  type ReportRegressionDelta,
} from './report.js';

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const components: ReportComponent[] = overrides.components ?? [
    {
      id: 'web-clock',
      filePath: 'web/Clock.tsx',
      renders: [
        {
          scenarioId: undefined,
          screenshotDataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=',
        },
      ],
    },
  ];

  return {
    runId: 'run-2026-05-01-abc123',
    createdAt: '2026-05-01T12:34:56.000Z',
    prompt: 'Add a clock that shows the current time.',
    scenarios: [],
    components,
    brand: 'validity',
    viewCommand: 'npx http-server ./.validity/runs/run-2026-05-01-abc123',
    ...overrides,
  };
}

/**
 * Minimal `setup` block. Everything is deliberately boring so the tests below
 * isolate ONE variable: whether the app-manifest line paints and what it says.
 */
function baseSetup(overrides: Partial<NonNullable<ReportInput['setup']>> = {}) {
  return {
    status: 'unchanged' as const,
    bootstrapped: false,
    driftReasons: [],
    generatedFiles: [],
    warnings: [],
    durationMs: 12,
    ...overrides,
  };
}

describe('setup health — app manifest provenance', () => {
  it('paints the Setup panel for an otherwise-quiet run when a manifest exists', () => {
    const note =
      'App manifest v1 from @validity.ai/verify-plugin-vite@0.0.1 — records env dir + 3 client vars.';
    const html = renderHtmlReport(baseInput({ setup: baseSetup({ appManifest: note }) }));
    expect(html).toContain('setup-app-manifest');
    expect(html).toContain(note);
  });

  it('stays silent — panel and all — when there is no manifest', () => {
    const html = renderHtmlReport(baseInput({ setup: baseSetup() }));
    // The CSS rule always ships; what must be absent is the element.
    expect(html).not.toContain('<p class="setup-app-manifest">');
    expect(html).not.toContain('class="setup-health"');
  });

  it('escapes the note rather than trusting a path out of a user-controlled file', () => {
    const html = renderHtmlReport(
      baseInput({ setup: baseSetup({ appManifest: 'entry <img src=x onerror=alert(1)>' }) }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('never claims a mirror: the note is rendered verbatim, with no added wording', () => {
    // The record half ("records …") is produced before any sandbox exists, so
    // the renderer must not decorate it into a fidelity claim.
    const note = 'App manifest v1 from @validity.ai/verify-plugin-vite@0.0.1 — records entry src/main.tsx.';
    const html = renderHtmlReport(baseInput({ setup: baseSetup({ appManifest: note }) }));
    expect(html).toContain(`<p class="setup-app-manifest">${note.replace('—', '—')}</p>`);
    expect(html).not.toContain('mirrored');
  });
});

describe('renderHtmlReport', () => {
  it('renders the minimal happy path with run id, prompt, screenshot, view command, and wordmark', () => {
    const input = baseInput();
    const html = renderHtmlReport(input);

    // doctype declaration (case-insensitive — node spits it as `<!doctype` exactly)
    expect(html.toLowerCase()).toContain('<!doctype html');
    // run id renders verbatim somewhere in the document
    expect(html).toContain(input.runId);
    // prompt is HTML-escaped (apostrophe and ampersand survive but no raw HTML)
    expect(html).toContain('Add a clock that shows the current time.');
    // screenshot data URI inlined
    expect(html).toContain(input.components[0]!.renders[0]!.screenshotDataUrl!);
    // view command rendered verbatim in the footer
    expect(html).toContain(input.viewCommand);
    // wordmark is INLINED as a base64 data URI so the self-contained report
    // always shows branding offline / from file:// (no remote <img> fetch).
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).not.toContain('https://validity.ai/brand/wordmark');
  });

  it("brand 'none' suppresses the wordmark", () => {
    const html = renderHtmlReport(baseInput({ brand: 'none' }));
    expect(html).not.toContain('validity.ai/brand/wordmark');
    expect(html).not.toContain('class="report-wordmark');
  });

  it('omits the verdict hero when verdict is undefined', () => {
    const html = renderHtmlReport(baseInput());
    // `.report-hero-verdict` appears in the <style> CSS; the markup-form
    // attribute (`class="report-hero-verdict"`) never does when there's no verdict.
    expect(html).not.toContain('class="report-hero-verdict"');
  });

  it('renders the glyph-doubled verdict hero and summary when a backed verdict is set', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        summary: 'All criteria passed.',
        criteria: [{ description: 'c1', status: 'pass', reasoning: 'ok' }],
      }),
    );
    expect(html).toContain('class="report-hero report-hero--pass"');
    expect(html).toContain('class="report-hero-verdict"');
    // Glyph + word are adjacent (shape-doubled — color is never the sole carrier).
    expect(html).toContain('>●</span>Pass');
    expect(html).toContain('All criteria passed.');
    // The old 56px ring is gone; the count is a demoted supporting element.
    expect(html).not.toContain('class="report-ring"');
  });

  it('renders one diff carousel slide per file when a diff is present', () => {
    const diff: ReportDiff = {
      files: [
        {
          path: 'web/Clock.tsx',
          hunks: [
            {
              header: '@@ -1,3 +1,4 @@',
              lines: [
                { kind: 'context', text: 'export function Clock() {' },
                { kind: 'add', text: '  const now = new Date();' },
                { kind: 'context', text: '  return <div />;' },
              ],
            },
          ],
        },
        {
          path: 'web/styles.css',
          hunks: [
            {
              header: '@@ -10,2 +10,3 @@',
              lines: [
                { kind: 'context', text: 'body {' },
                { kind: 'add', text: '  font-family: sans-serif;' },
              ],
            },
          ],
        },
      ],
    };
    const html = renderHtmlReport(baseInput({ diff }));
    const matches = html.match(/data-diff-slide=/g) ?? [];
    expect(matches.length).toBe(2);
    expect(html).toContain('web/Clock.tsx');
    expect(html).toContain('web/styles.css');
  });

  it('renders fileNotes for the matching file slide', () => {
    const diff: ReportDiff = {
      files: [
        {
          path: 'web/Clock.tsx',
          hunks: [
            {
              header: '@@ -1,1 +1,1 @@',
              lines: [{ kind: 'add', text: 'noop' }],
            },
          ],
        },
      ],
    };
    const html = renderHtmlReport(
      baseInput({
        diff,
        fileNotes: { 'web/Clock.tsx': 'Wired the clock to update every second.' },
      }),
    );
    expect(html).toContain('Wired the clock to update every second.');
    expect(html).toContain('report-file-note');
  });

  it('renders a scenario tab for every scenario including base', () => {
    const components: ReportComponent[] = [
      {
        id: 'web-clock',
        filePath: 'web/Clock.tsx',
        renders: [
          {
            scenarioId: undefined,
            screenshotDataUrl: 'data:image/png;base64,AAAA',
          },
          {
            scenarioId: 'logged-in',
            screenshotDataUrl: 'data:image/png;base64,BBBB',
          },
          {
            scenarioId: 'logged-out',
            screenshotDataUrl: 'data:image/png;base64,CCCC',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('data-scenario-tab="base"');
    expect(html).toContain('data-scenario-tab="logged-in"');
    expect(html).toContain('data-scenario-tab="logged-out"');
    expect(html).toContain('>base<');
    expect(html).toContain('>logged-in<');
    expect(html).toContain('>logged-out<');
  });

  it('emits scenario prev/next nav buttons when there are multiple scenarios', () => {
    const components: ReportComponent[] = [
      {
        id: 'web-clock',
        filePath: 'web/Clock.tsx',
        renders: [
          { scenarioId: 'logged-in', screenshotDataUrl: 'data:image/png;base64,A' },
          { scenarioId: 'logged-out', screenshotDataUrl: 'data:image/png;base64,B' },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // The literal markup buttons (CSS class selectors and JS lookups also use
    // the same strings, so anchor on the full attribute pattern).
    expect(html).toContain('class="report-scenario-prev" data-scenario-prev');
    expect(html).toContain('class="report-scenario-next" data-scenario-next');
    expect(html).toContain('aria-label="Previous render"');
    expect(html).toContain('aria-label="Next render"');
    // The nav buttons share a row with the tabs in the markup.
    expect(html).toMatch(
      /<div class="report-scenario-bar">[\s\S]*?class="report-scenario-prev"[\s\S]*?class="report-scenario-tabs"/,
    );
  });

  it('omits scenario prev/next when there is only one scenario', () => {
    const components: ReportComponent[] = [
      {
        id: 'web-clock',
        filePath: 'web/Clock.tsx',
        renders: [{ scenarioId: undefined, screenshotDataUrl: 'data:image/png;base64,A' }],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // Buttons absent in markup. (The literal `data-scenario-prev` does appear
    // inside the inline JS that queries for it; we look for the rendered
    // <button> attribute pattern instead.)
    expect(html).not.toContain('class="report-scenario-prev"');
    expect(html).not.toContain('class="report-scenario-next"');
  });

  it('renders fixture-named tabs (one per fixture) when fixtures are used', () => {
    const components: ReportComponent[] = [
      {
        id: 'src-components-ui-button',
        filePath: 'src/components/ui/Button.tsx',
        renders: [
          { fixtureId: 'primary', screenshotDataUrl: 'data:image/png;base64,A' },
          { fixtureId: 'loading', screenshotDataUrl: 'data:image/png;base64,B' },
          { fixtureId: 'disabled', screenshotDataUrl: 'data:image/png;base64,C' },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('data-scenario-tab="primary"');
    expect(html).toContain('data-scenario-tab="loading"');
    expect(html).toContain('data-scenario-tab="disabled"');
  });

  it('renders a single fixture render directly without tabs (no switching needed)', () => {
    // Single render → just the screenshot inline. Tabs only appear when
    // there are 2+ renders to switch between (i.e., scenario fanout). With
    // stacked-fixture mode, even N fixtures collapse into 1 render.
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [
          {
            fixtureId: 'primary',
            screenshotDataUrl: 'data:image/png;base64,A',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // No tab markup for a 1-render component.
    expect(html).not.toContain('data-scenario-tab=');
    expect(html).not.toContain('class="report-scenario-prev"');
    // But the screenshot is present.
    expect(html).toContain('data:image/png;base64,A');
  });

  it('renders a stacked-fixture screenshot once with a caption listing fixture names', () => {
    const components: ReportComponent[] = [
      {
        id: 'src-components-ui-button',
        filePath: 'src/components/ui/Button.tsx',
        renders: [
          {
            stackedFixtureIds: ['primary', 'secondary', 'ghost'],
            screenshotDataUrl: 'data:image/png;base64,STACKED',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // No tabs / nav (single render).
    expect(html).not.toContain('data-scenario-tab=');
    // Caption present with each fixture name in a <code>.
    expect(html).toContain('Variants stacked');
    expect(html).toContain('<code>primary</code>');
    expect(html).toContain('<code>secondary</code>');
    expect(html).toContain('<code>ghost</code>');
    // The single screenshot embed is there.
    expect(html).toContain('data:image/png;base64,STACKED');
  });

  it('does NOT show a stack caption for non-stacked single renders', () => {
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [{ scenarioId: 'logged-in', screenshotDataUrl: 'data:image/png;base64,A' }],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // The phrase only appears in the markup form, not the CSS rules. The
    // `class="report-stack-caption"` *attribute* is the unambiguous marker.
    expect(html).not.toContain('Variants stacked');
    expect(html).not.toContain('class="report-stack-caption"');
  });

  it('keeps tabs + nav when there are 2+ separate renders (scenario fanout)', () => {
    // Multi-scenario components (no fixtures) still need the tabs+arrows so
    // users can switch between, e.g., logged-in vs logged-out.
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [
          { scenarioId: 'logged-in', screenshotDataUrl: 'data:image/png;base64,A' },
          { scenarioId: 'logged-out', screenshotDataUrl: 'data:image/png;base64,B' },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('data-scenario-tab="logged-in"');
    expect(html).toContain('data-scenario-tab="logged-out"');
    expect(html).toContain('class="report-scenario-prev"');
    expect(html).toContain('class="report-scenario-next"');
  });

  it('renders a paste-ready handler stub for each unmatched request (fabricated fallback body)', () => {
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [
          {
            scenarioId: undefined,
            screenshotDataUrl: 'data:image/png;base64,A',
            unmatchedRequests: [
              {
                method: 'GET',
                url: 'http://127.0.0.1:3001/billing/status',
                body: { status: 'ok' },
              },
              { method: 'POST', url: 'http://127.0.0.1:3001/orders?draft=1', body: {} },
            ],
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // The header names the provenance so a reader never mistakes it for real data.
    expect(html).toContain('answered by the fallback (fabricated data)');
    // GET stub: no `method`, origin generalized to `*`, body serialized to json.
    expect(html).toContain(
      '{ url: &quot;*/billing/status&quot;, json: {&quot;status&quot;:&quot;ok&quot;} },',
    );
    // Non-GET stub: carries `method`, query collapses to a trailing `*`.
    expect(html).toContain('{ method: &quot;POST&quot;, url: &quot;*/orders*&quot;, json: {} },');
  });

  it('falls back to the plain unmatched-URL list for run-metas without unmatchedRequests', () => {
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [
          {
            scenarioId: undefined,
            screenshotDataUrl: 'data:image/png;base64,A',
            unmatchedUrls: ['GET http://127.0.0.1:3001/legacy'],
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('Unmatched network requests');
    expect(html).toContain('GET http://127.0.0.1:3001/legacy');
    // No stub without the structured field.
    expect(html).not.toContain('Promote to a declared mock');
  });

  it('renders components vertically (no outer carousel paginating between them)', () => {
    const components: ReportComponent[] = [
      {
        id: 'a',
        filePath: 'a.tsx',
        renders: [{ scenarioId: undefined, screenshotDataUrl: 'data:image/png;base64,A' }],
      },
      {
        id: 'b',
        filePath: 'b.tsx',
        renders: [{ scenarioId: undefined, screenshotDataUrl: 'data:image/png;base64,B' }],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // Both components present, both as <section>s.
    expect(html).toContain('data-component="a"');
    expect(html).toContain('data-component="b"');
    // No data-component-slide marker (the old per-component carousel attribute).
    expect(html).not.toContain('data-component-slide=');
  });

  it('shows the empty-render notice when looksEmpty is set', () => {
    const components: ReportComponent[] = [
      {
        id: 'src-components-ui-button',
        filePath: 'src/components/ui/Button.tsx',
        renders: [
          {
            fixtureId: 'default',
            screenshotDataUrl: 'data:image/png;base64,A',
            looksEmpty: true,
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('class="report-render-empty-notice"');
    expect(html).toContain('This screenshot looks empty');
    // The notice includes the actionable hint with the file path.
    expect(html).toContain('src/components/ui/Button.tsx');
  });

  it('does NOT show the empty-render notice when looksEmpty is unset', () => {
    const components: ReportComponent[] = [
      {
        id: 'c',
        filePath: 'c.tsx',
        renders: [{ fixtureId: 'default', screenshotDataUrl: 'data:image/png;base64,A' }],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).not.toContain('class="report-render-empty-notice"');
  });

  it('renders the observational Performance panel from per-render metrics', () => {
    const components: ReportComponent[] = [
      {
        id: 'dash',
        filePath: 'Dash.tsx',
        renders: [
          {
            fixtureId: 'default',
            screenshotDataUrl: 'data:image/png;base64,A',
            performance: { readyMs: 420, mountMs: 3.4, updateMs: 12.1, commitCount: 2 },
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('class="report-render-performance"');
    expect(html).toContain('Time to ready');
    expect(html).toContain('420 ms');
    expect(html).toContain('Slowest re-render (update)');
    expect(html).toContain('12.1 ms');
    expect(html).toContain('React commits');
  });

  it('omits the Performance panel when no metrics were measured', () => {
    const components: ReportComponent[] = [
      { id: 'c', filePath: 'c.tsx', renders: [{ screenshotDataUrl: 'data:image/png;base64,A' }] },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).not.toContain('class="report-render-performance"');
  });

  it('tints over-threshold metric values amber/red and leaves ok values untinted (D2)', () => {
    const components: ReportComponent[] = [
      {
        id: 'dash',
        filePath: 'Dash.tsx',
        renders: [
          {
            fixtureId: 'default',
            screenshotDataUrl: 'data:image/png;base64,A',
            // mountMs 80 > 50 red; updateMs 20 > 16 amber; readyMs 120 ok
            // (readyMs is component-only now, so its ok band tops out at 300).
            // harnessBootMs is untinted by design — it is the sandbox's cost.
            performance: {
              readyMs: 120,
              mountMs: 80,
              updateMs: 20,
              commitCount: 2,
              harnessBootMs: 1400,
            },
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('report-perf-metric-value--red');
    expect(html).toContain('report-perf-metric-value--amber');
    // The ok value renders without a tint modifier class.
    expect(html).toContain('<span class="report-perf-metric-value">120 ms</span>');
    // Sandbox cold start is surfaced so a slow component can be told apart
    // from a cold harness — and is never tinted, however large.
    expect(html).toContain('Sandbox cold start');
    expect(html).toContain('<span class="report-perf-metric-value">1400 ms</span>');
    // Advisory framing: badge + published-threshold legend.
    expect(html).toContain('advisory — not a verdict');
    expect(html).toContain('class="report-perf-legend"');
    expect(html).toContain('Budget pass/fail lives in the Proven section only.');
  });

  it('renders the updateTotalMs row when present and omits it otherwise (old run-metas)', () => {
    const withTotal: ReportComponent[] = [
      {
        id: 'a',
        filePath: 'a.tsx',
        renders: [
          {
            screenshotDataUrl: 'data:image/png;base64,A',
            performance: { updateMs: 4, updateTotalMs: 9.5, commitCount: 3 },
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components: withTotal }));
    expect(html).toContain('Total re-render time');
    expect(html).toContain('9.5 ms');

    const withoutTotal: ReportComponent[] = [
      {
        id: 'a',
        filePath: 'a.tsx',
        renders: [
          {
            screenshotDataUrl: 'data:image/png;base64,A',
            performance: { updateMs: 4, commitCount: 3 },
          },
        ],
      },
    ];
    const htmlOld = renderHtmlReport(baseInput({ components: withoutTotal }));
    expect(htmlOld).not.toContain('Total re-render time');
  });

  it('renders perf hints with severity pills, and no hints list for calm metrics (D2)', () => {
    const hinting: ReportComponent[] = [
      {
        id: 'list',
        filePath: 'List.tsx',
        renders: [
          {
            screenshotDataUrl: 'data:image/png;base64,A',
            performance: { commitCount: 14, updateMs: 31.2, updateTotalMs: 122.4 },
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components: hinting }));
    expect(html).toContain('class="report-perf-hints"');
    expect(html).toContain('report-perf-hint-sev--warn');
    expect(html).toContain('excessive re-renders: 14 commits');

    const calm: ReportComponent[] = [
      {
        id: 'list',
        filePath: 'List.tsx',
        renders: [
          {
            screenshotDataUrl: 'data:image/png;base64,A',
            performance: { commitCount: 2, updateMs: 3 },
          },
        ],
      },
    ];
    const htmlCalm = renderHtmlReport(baseInput({ components: calm }));
    expect(htmlCalm).not.toContain('class="report-perf-hints"');
  });

  it("CAN'T FALSE-GREEN adjacent: the perf panel never speaks the verdict vocabulary", () => {
    // All-green and all-red inputs both stay advisory: no PASS/FAIL text, no
    // verdict pill markup, no verdict glyph inside the performance block.
    for (const performance of [
      { readyMs: 100, mountMs: 2, updateMs: 1, commitCount: 2 },
      {
        readyMs: 9000,
        loadMs: 9000,
        firstContentfulPaintMs: 4000,
        mountMs: 300,
        updateMs: 300,
        updateTotalMs: 3000,
        commitCount: 40,
      },
    ]) {
      const components: ReportComponent[] = [
        {
          id: 'x',
          filePath: 'x.tsx',
          renders: [{ screenshotDataUrl: 'data:image/png;base64,A', performance }],
        },
      ];
      const html = renderHtmlReport(baseInput({ components }));
      const start = html.indexOf('class="report-render-performance"');
      expect(start).toBeGreaterThan(-1);
      const block = html.slice(start, html.indexOf('</div>\n', html.indexOf('report-perf-legend')));
      expect(block).not.toContain('PASS');
      expect(block).not.toContain('FAIL');
      expect(block).not.toContain('report-pill');
      expect(block).not.toContain('✓');
    }
  });

  it('points the 2nd and 3rd identical variants at the first variant slug (not at each other)', () => {
    // Mirrors what `annotateIdenticalRenders` produces: when 3 renders of the
    // same component share bytes, only the FIRST is left untagged. Subsequent
    // ones reference that first slug, regardless of order. The report should
    // surface that linkage so the user fixes the root variant, not a duplicate.
    const components: ReportComponent[] = [
      {
        id: 'src-components-loginform',
        filePath: 'src/components/LoginForm.tsx',
        renders: [
          { scenarioId: 'logged-out', screenshotDataUrl: 'data:image/png;base64,A' },
          {
            scenarioId: 'invalid',
            screenshotDataUrl: 'data:image/png;base64,A',
            identicalTo: 'logged-out',
          },
          {
            scenarioId: 'unverified',
            screenshotDataUrl: 'data:image/png;base64,A',
            identicalTo: 'logged-out',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    // Two identical-notices total — one per duplicate, none on the seed.
    const matches = html.match(/class="report-render-identical-notice"/g) ?? [];
    expect(matches.length).toBe(2);
    // Both notices reference 'logged-out', not each other.
    const refs = html.match(/Pixels identical to[\s\S]*?<\/code>/g) ?? [];
    expect(refs.length).toBe(2);
    for (const ref of refs) {
      expect(ref).toContain('<code>logged-out</code>');
      expect(ref).not.toContain('<code>invalid</code>');
      expect(ref).not.toContain('<code>unverified</code>');
    }
  });

  it('shows the identical-screenshot notice when identicalTo is set', () => {
    const components: ReportComponent[] = [
      {
        id: 'src-components-loginform',
        filePath: 'src/components/LoginForm.tsx',
        renders: [
          { scenarioId: 'logged-out', screenshotDataUrl: 'data:image/png;base64,A' },
          {
            scenarioId: 'invalid',
            screenshotDataUrl: 'data:image/png;base64,A',
            identicalTo: 'logged-out',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('class="report-render-identical-notice"');
    expect(html).toContain('Pixels identical to');
    // The notice references the other variant.
    expect(html).toMatch(/identical[\s\S]*<code>logged-out<\/code>/);
  });

  it('escapes user-supplied HTML in the prompt', () => {
    const html = renderHtmlReport(baseInput({ prompt: "<script>alert('x')</script>" }));
    // The literal opening tag must not appear as actual HTML.
    expect(html).not.toContain("<script>alert('x')");
    // The escaped form must appear.
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty-state card when components is empty', () => {
    const html = renderHtmlReport(baseInput({ components: [] }));
    expect(html.toLowerCase()).toContain('no components were rendered');
    expect(html).toContain('report-empty');
  });

  it('renders a binary diff file with size instead of hunks', () => {
    const diff: ReportDiff = {
      files: [
        {
          path: 'public/logo.png',
          hunks: [],
          binary: true,
          byteSize: 4096,
        },
      ],
    };
    const html = renderHtmlReport(baseInput({ diff }));
    expect(html).toContain('Binary file changed (4 KB)');
  });

  it('shows the renderError banner instead of the image', () => {
    const components: ReportComponent[] = [
      {
        id: 'broken',
        filePath: 'web/Broken.tsx',
        renders: [
          {
            scenarioId: undefined,
            renderError: 'Component threw at mount: undefined is not a function',
          },
        ],
      },
    ];
    const html = renderHtmlReport(baseInput({ components }));
    expect(html).toContain('report-render-error');
    expect(html).toContain('undefined is not a function');
  });

  it('renders criterion cards when criteria are provided', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          {
            description: 'Clock shows current time',
            status: 'pass',
            reasoning: 'Screenshot matches expected layout.',
          },
          {
            description: 'Clock updates every second',
            status: 'unverifiable',
            reasoning: 'Static screenshot cannot prove tick behavior.',
            suggestion: 'Add a timing-based test.',
          },
        ],
      }),
    );
    expect(html).toContain('Per-criterion details');
    expect(html).toContain('Clock shows current time');
    expect(html).toContain('Add a timing-based test.');
    expect(html).toContain('report-pill-pass');
    expect(html).toContain('report-pill-unverifiable');
  });

  it('renders a "Scored from:" citation block when a criterion carries screenshotIds', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          {
            id: 'AC-1',
            description: 'Hero looks polished',
            status: 'pass',
            reasoning: 'Reads as clean.',
            screenshotIds: ['hero', 'hero-mobile'],
          },
        ],
      }),
    );
    expect(html).toContain('report-criterion-citations');
    expect(html).toContain('Scored from:');
    expect(html).toContain('<code>hero</code>');
    expect(html).toContain('<code>hero-mobile</code>');
  });

  it('renders no citation block when a criterion has no screenshotIds', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          { description: 'Hero looks polished', status: 'pass', reasoning: 'Reads as clean.' },
        ],
      }),
    );
    // class name appears in the inline CSS; assert no element carries it
    expect(html).not.toContain('class="report-criterion-citations"');
    expect(html).not.toContain('Scored from:');
  });

  it('escapes markup-bearing screenshot ids in the citation block', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          {
            description: 'Hero looks polished',
            status: 'pass',
            reasoning: 'Reads as clean.',
            screenshotIds: ['<img src=x onerror=alert(1)>'],
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the "Regression vs. last run" strip with a ↓ row for a regressed criterion', () => {
    const deltas: ReportRegressionDelta[] = [
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
      { criterionId: 'AC-2', previousStatus: 'pass', currentStatus: 'pass', delta: 'unchanged' },
    ];
    const html = renderHtmlReport(baseInput({ regressionDeltas: deltas }));
    expect(html).toContain('report-regression-strip');
    expect(html).toContain('Regression vs. last run of this spec');
    expect(html).toContain('report-regression-row--regressed');
    expect(html).toContain('↓');
    expect(html).toContain('AC-1');
    expect(html).toContain('pass → fail');
    // unchanged rows are not listed, but counted in the summary
    expect(html).toContain('1 regressed, 0 improved, 0 new, 1 unchanged');
    expect(html).not.toContain('report-regression-row--unchanged');
  });

  it('omits the regression strip when regressionDeltas is undefined', () => {
    const html = renderHtmlReport(baseInput());
    // class names appear in the inline CSS; assert no element carries them
    expect(html).not.toContain('class="report-regression-strip"');
    expect(html).not.toContain('Regression vs. last run');
  });

  it('omits the regression strip when every delta is unchanged', () => {
    const deltas: ReportRegressionDelta[] = [
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'pass', delta: 'unchanged' },
    ];
    const html = renderHtmlReport(baseInput({ regressionDeltas: deltas }));
    expect(html).not.toContain('class="report-regression-strip"');
  });

  it('escapes a markup-bearing criterionId in the regression strip', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: '<script>alert(1)</script>',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
      },
    ];
    const html = renderHtmlReport(baseInput({ regressionDeltas: deltas }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  // The strip's class names also appear in the inline <style> block, so scope
  // markup assertions to the rendered <ul> (never the whole document).
  function regressionList(html: string): string {
    const start = html.indexOf('<ul class="report-regression-list">');
    if (start === -1) return '';
    return html.slice(start, html.indexOf('</ul>', start) + '</ul>'.length);
  }

  it('renders a prior-run receipt (transition + reasoning excerpt + scorer change) for a soft delta', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: {
          status: 'pass',
          reasoning: 'The empty state read as clean and centered.',
          scoredBy: 'model-a',
        },
      },
    ];
    const list = regressionList(
      renderHtmlReport(
        baseInput({
          regressionDeltas: deltas,
          scoring: { judge: 'fresh-context', scoredBy: 'model-b' },
        }),
      ),
    );
    expect(list).toContain('report-regression-row--has-prior');
    expect(list).toContain('report-regression-prior');
    expect(list).toContain('pass → fail');
    // Prior reasoning excerpt is shown verbatim (short enough to survive the cap).
    expect(list).toContain('The empty state read as clean and centered.');
    // A scorer SWAP is made explicit so "different scorer" reads distinctly.
    expect(list).toContain('scored by model-a → model-b');
    expect(list).toContain('report-regression-scorer--changed');
  });

  it('prefers the per-criterion scorer over the run-level scorer for the change line', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: 'looked fine', scoredBy: 'model-a' },
      },
    ];
    const list = regressionList(
      renderHtmlReport(
        baseInput({
          regressionDeltas: deltas,
          // Run-level scorer is model-x, but the criterion's own scorer is model-c.
          scoring: { judge: 'fresh-context', scoredBy: 'model-x' },
          criterionVerdicts: [
            {
              id: 'AC-soft',
              tier: 'soft',
              status: 'fail',
              detail: 'regressed',
              scoredBy: { model: 'model-c', session: 'sess-1' },
            },
          ],
        }),
      ),
    );
    expect(list).toContain('scored by model-a → model-c');
    expect(list).not.toContain('model-x');
  });

  it('shows the scorer once (no arrow) when the scorer did not change', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: 'looked fine', scoredBy: 'model-a' },
      },
    ];
    const list = regressionList(
      renderHtmlReport(
        baseInput({
          regressionDeltas: deltas,
          scoring: { judge: 'fresh-context', scoredBy: 'model-a' },
        }),
      ),
    );
    expect(list).toContain('scored by model-a');
    expect(list).not.toContain('scored by model-a → ');
    expect(list).not.toContain('report-regression-scorer--changed');
  });

  it('truncates a long prior reasoning deterministically at 160 chars + ellipsis', () => {
    const long = 'x'.repeat(200);
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: long, scoredBy: 'model-a' },
      },
    ];
    const list = regressionList(renderHtmlReport(baseInput({ regressionDeltas: deltas })));
    expect(list).toContain('x'.repeat(160) + '…');
    expect(list).not.toContain('x'.repeat(161));
  });

  it('HTML-escapes a markup-bearing prior reasoning', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: "<img src=x onerror='alert(1)'>", scoredBy: 'model-a' },
      },
    ];
    const list = regressionList(renderHtmlReport(baseInput({ regressionDeltas: deltas })));
    expect(list).not.toContain("<img src=x onerror='alert(1)'>");
    expect(list).toContain('&lt;img src=x onerror=&#39;alert(1)&#39;&gt;');
  });

  it('leaves a delta row without prior rendering flat (no prior receipt) in a mixed list', () => {
    const deltas: ReportRegressionDelta[] = [
      // Hard/property row from verify time — no prior.
      { criterionId: 'AC-hard', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
      // Soft row enriched at submit time — carries prior.
      {
        criterionId: 'AC-soft',
        previousStatus: 'fail',
        currentStatus: 'pass',
        delta: 'improved',
        prior: { status: 'fail', reasoning: 'was broken', scoredBy: 'model-a' },
      },
    ];
    const list = regressionList(renderHtmlReport(baseInput({ regressionDeltas: deltas })));
    // Split into per-<li> chunks so we can inspect each row independently.
    const rows = list.split('<li ').slice(1);
    const hardRow = rows.find((r) => r.includes('AC-hard'))!;
    const softRow = rows.find((r) => r.includes('AC-soft'))!;
    // The hard row is present but flat: it must not gain a prior receipt.
    expect(hardRow).toBeDefined();
    expect(hardRow).not.toContain('has-prior');
    expect(hardRow).not.toContain('report-regression-prior');
    // The soft row carries the receipt.
    expect(softRow).toContain('has-prior');
    expect(softRow).toContain('was broken');
  });

  it('renders proven (deterministic) verdicts in their own section, separate from soft criteria', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          {
            description: 'Layout looks polished',
            status: 'pass',
            reasoning: 'Screenshot reads as clean.',
          },
        ],
        criterionVerdicts: [
          {
            id: 'AC-1',
            tier: 'hard',
            status: 'pass',
            detail: 'submit posts to /api/contact',
            checks: [
              {
                check: {
                  expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } },
                },
                status: 'pass',
                detail: 'POST /api/contact → 200',
              },
            ],
          },
          {
            id: 'AC-2',
            tier: 'property',
            status: 'fail',
            detail: 'console emitted errors',
          },
          // Soft verdicts must NOT appear in the proven section.
          { id: 'AC-3', tier: 'soft', status: 'unverifiable', detail: 'soft — score it' },
        ],
      }),
    );

    // The proven section exists and is titled distinctly from the soft table.
    expect(html).toContain('Proven (deterministic)');
    expect(html).toContain('report-proven');
    // Hard + property verdicts render with their ids and per-check detail.
    expect(html).toContain('AC-1');
    expect(html).toContain('AC-2');
    expect(html).toContain('POST /api/contact → 200');
    // A proven pass reads as proof, a proven fail reads as a hard fail.
    expect(html).toContain('proven · hard');
    expect(html).toContain('proven · property');
    expect(html).toContain('report-pill-pass');
    expect(html).toContain('report-pill-fail');
    // Soft verdict id is NOT surfaced in the proven section. (It may appear in
    // the "Not validated" section above — unscored soft placeholders are part
    // of the honest remainder — so scope the assertion to the proven section.)
    const provenSection = html.slice(
      html.indexOf('Proven (deterministic)'),
      html.indexOf('Per-criterion details'),
    );
    expect(provenSection).not.toContain('AC-3');

    // The proven section is ordered before the soft "Per-criterion details".
    const provenIdx = html.indexOf('Proven (deterministic)');
    const scoredIdx = html.indexOf('Per-criterion details');
    expect(provenIdx).toBeGreaterThan(-1);
    expect(scoredIdx).toBeGreaterThan(provenIdx);

    // The soft section is explicitly labelled as opinion, not proof.
    expect(html).toContain('opinion, not proof');
  });

  it('omits the proven section when there are no hard/property verdicts', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'pass', detail: 'soft only' }],
      }),
    );
    expect(html).not.toContain('Proven (deterministic)');
  });

  it('includes the coverage metric in the proven section when provided', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
        ],
        coverage: { ratio: 0.5, hardPropertyTotal: 2, verifiableCount: 1 },
      }),
    );
    expect(html).toContain('Coverage:');
    expect(html).toContain('1/2');
    expect(html).toContain('(50%)');
  });

  it('renders proven verdicts in the markdown report, separate from scored criteria', () => {
    const md = renderMarkdownReport(
      baseInput({
        criteria: [{ description: 'Looks good', status: 'pass', reasoning: 'clean' }],
        criterionVerdicts: [
          {
            id: 'AC-1',
            tier: 'hard',
            status: 'pass',
            detail: 'posts to /api/contact',
            checks: [
              {
                check: { expect: { console: { errors: 0 } } },
                status: 'pass',
                detail: '0 console errors',
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('## Proven (deterministic)');
    expect(md).toContain('`AC-1`');
    expect(md).toContain('0 console errors');
    // When proven verdicts exist, the soft checklist heading reads as "Scored".
    expect(md).toContain('## Scored criteria');
    const provenIdx = md.indexOf('## Proven (deterministic)');
    const scoredIdx = md.indexOf('## Scored criteria');
    expect(scoredIdx).toBeGreaterThan(provenIdx);
  });

  it('renders the diagnostics block when a render carries console/page/network errors', () => {
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'BrokenButton',
            filePath: 'src/BrokenButton.tsx',
            renders: [
              {
                screenshotDataUrl: 'data:image/png;base64,AAA=',
                pageErrors: [{ message: 'TypeError: Cannot read property foo of undefined' }],
                consoleErrors: [
                  { text: 'Warning: missing key', url: 'src/BrokenButton.tsx', lineNumber: 12 },
                ],
                networkErrors: [{ method: 'GET', url: 'http://api.test/missing', status: 500 }],
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('report-render-diagnostics');
    expect(html).toContain('Uncaught errors (1)');
    expect(html).toContain('TypeError: Cannot read property foo of undefined');
    expect(html).toContain('Console errors (1)');
    expect(html).toContain('Warning: missing key');
    expect(html).toContain('src/BrokenButton.tsx');
    expect(html).toContain('Failed network responses (1)');
    expect(html).toContain('http://api.test/missing');
    expect(html).toContain('500');
  });

  it('omits the diagnostics block when no diagnostic arrays are present', () => {
    const html = renderHtmlReport(baseInput());
    // The class selector appears once in the CSS rule itself; the actual
    // rendered <div> would be a second occurrence. Asserting against the
    // div tag is the precise check.
    expect(html).not.toContain('<div class="report-render-diagnostics"');
  });

  it('renders the git info strip in the header when input.git is set', () => {
    const html = renderHtmlReport(
      baseInput({
        git: { sha: 'abcdef1234567890', branch: 'feat/foo', dirty: true },
      }),
    );
    expect(html).toContain('class="report-header-git"');
    // 7-char short SHA
    expect(html).toContain('abcdef1');
    expect(html).toContain('feat/foo');
    expect(html).toContain('dirty');
  });

  it('omits the git strip when input.git is undefined', () => {
    const html = renderHtmlReport(baseInput());
    expect(html).not.toContain('class="report-header-git"');
  });

  it('ships the dashboard up-link in the header hidden and root-relative', () => {
    const html = renderHtmlReport(baseInput());
    // Present in the static markup, but shipped `hidden` so file:// / CI copies
    // stay inert; the reveal is the inline JS's job (asserted below).
    expect(html).toContain('class="report-header-dashlink"');
    expect(html).toContain('data-dashboard-link');
    expect(html).toContain('hidden');
    // Root-relative href: "/" resolves to the dashboard root regardless of the
    // served report's path depth (/run/<id>/report, /spec/<id>/report).
    expect(html).toContain('href="/"');
  });

  it('places the dashboard up-link in the page-chrome nav, not the run-identity column', () => {
    const html = renderHtmlReport(baseInput());
    const navIdx = html.indexOf('<nav class="v-nav">');
    const dashIdx = html.indexOf('class="report-header-dashlink"');
    const rowIdx = html.indexOf('class="report-header-row"');
    const metaIdx = html.indexOf('class="report-header-meta"');
    // Navigation lives in the shared topbar (one nav grammar across every
    // Validity surface) — so the up-link precedes the run-identity block and
    // is never nested inside the meta column.
    expect(navIdx).toBeGreaterThan(-1);
    expect(dashIdx).toBeGreaterThan(navIdx);
    expect(rowIdx).toBeGreaterThan(dashIdx);
    expect(metaIdx).toBeGreaterThan(dashIdx);
    // …and it is the nav's only item: the report has exactly one way back.
    expect(html.match(/class="report-header-dashlink"/g)).toHaveLength(1);
  });

  it('reveals the dashboard link over http(s) only, via a static protocol gate', () => {
    const html = renderHtmlReport(baseInput());
    // The gate is a static string constant — never built from input data.
    expect(html).toContain("location.protocol === 'http:'");
    expect(html).toContain("location.protocol === 'https:'");
    expect(html).toContain("removeAttribute('hidden')");
  });

  it('keeps the dashboard up-link even when brand is none (navigation, not branding)', () => {
    const html = renderHtmlReport(baseInput({ brand: 'none' }));
    expect(html).not.toContain('class="report-wordmark');
    expect(html).toContain('class="report-header-dashlink"');
    expect(html).toContain('data-dashboard-link');
  });

  it('shows the no-server project hint in the footer as a text command chip', () => {
    const html = renderHtmlReport(baseInput());
    // Always-visible plain-text counterpart to the header up-link, styled like
    // the viewCommand chip — a command, not a link (no href on this line).
    expect(html).toContain('<code>validity trends</code>');
    expect(html).toContain('class="report-footer-line"');
  });

  it('the zero-token receipt (2.2) appears verbatim in the footer, byte-identical across renders', () => {
    const html = renderHtmlReport(baseInput());
    expect(html).toContain('Deterministic checks re-verifiable at zero LLM cost — validity replay');
    // Byte-determinism: same input twice ⇒ identical output (no clock/randomness).
    expect(renderHtmlReport(baseInput())).toBe(html);
  });

  it('renders a11y violations as severity-tinted block (critical wins over serious)', () => {
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'Form',
            filePath: 'src/Form.tsx',
            renders: [
              {
                screenshotDataUrl: 'data:image/png;base64,A',
                a11yViolations: [
                  {
                    id: 'label',
                    impact: 'critical',
                    description: 'Form elements must have labels',
                    helpUrl: 'https://dequeuniversity.com/rules/axe/label',
                    nodes: 2,
                  },
                  {
                    id: 'color-contrast',
                    impact: 'serious',
                    description: 'Element has insufficient color contrast',
                    nodes: 1,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('report-render-a11y');
    expect(html).toContain('report-render-a11y--critical');
    expect(html).toContain('A11y violations (2)');
    expect(html).toContain('label');
    expect(html).toContain('color-contrast');
    expect(html).toContain('dequeuniversity.com');
  });

  it('renders a11y node details (selector + summary) and escapes the html snippet to text', () => {
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'Form',
            filePath: 'src/Form.tsx',
            renders: [
              {
                screenshotDataUrl: 'data:image/png;base64,A',
                a11yViolations: [
                  {
                    id: 'button-name',
                    impact: 'critical',
                    description: 'Buttons must have discernible text',
                    nodes: 1,
                    nodeDetails: [
                      {
                        target: 'button.save',
                        html: '<button class="save"><script>alert(1)</script>',
                        failureSummary: 'Element does not have inner text that is visible',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Per-node selector + rendered as text.
    expect(html).toContain('button.save');
    expect(html).toContain('Element does not have inner text that is visible');
    // The dangerous snippet must be HTML-ESCAPED, not injected as markup.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('omits the a11y block when there are no violations', () => {
    const html = renderHtmlReport(baseInput());
    expect(html).not.toContain('class="report-render-a11y');
  });

  it('never renders the removed visual-diff banner, even when baseline data is present', () => {
    // The visual diff was removed by design (specs are the first-class report
    // content). `baseline` stays in the input shape for run-meta/mechanical
    // consumers, but no banner, pixel count, or diff image may render from it.
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'a',
            filePath: 'a.tsx',
            renders: [
              {
                screenshotDataUrl: 'data:image/png;base64,A',
                baseline: {
                  sha: 'abcdef1234567890',
                  takenAt: '2026-01-01',
                  mismatchedPixels: 1234,
                  diffDataUrl: 'data:image/png;base64,DIFF',
                },
              },
            ],
          },
        ],
      }),
    );
    expect(html).not.toContain('report-render-baseline');
    expect(html).not.toContain('pixels differ');
    expect(html).not.toContain('report-baseline-diff');
    expect(html).not.toContain('data:image/png;base64,DIFF');
  });

  it('renders viewport name as a suffix in the render label', () => {
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'a',
            filePath: 'a.tsx',
            renders: [
              {
                scenarioId: 'logged-in',
                screenshotDataUrl: 'data:image/png;base64,A',
                viewport: { width: 375, height: 667, name: 'mobile' },
              },
              {
                scenarioId: 'logged-in',
                screenshotDataUrl: 'data:image/png;base64,B',
                viewport: { width: 1280, height: 800, name: 'desktop' },
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('logged-in · mobile');
    expect(html).toContain('logged-in · desktop');
  });
});

/**
 * "Environment blocked — verdicts withheld" banner (handoff-2026-07-28).
 *
 * An env-blocked run's criteria all land `unverifiable`, which on the page is
 * indistinguishable from a spec whose checks simply could not decide — so the
 * reader was left guessing whether their code was undecidable or their emulator
 * was wedged. The banner names the cause and prints the command.
 */
describe('renderHtmlReport — environment-blocked banner', () => {
  const blocked = {
    message: 'native verify: render not confirmed (status=unconfirmed)',
    cause: 'session-decay',
    fixCommand: 'kill $(cat daemon.pid)\nadb emu kill',
  };

  it('renders the banner, its message, its cause and the full fix command', () => {
    const html = renderHtmlReport(baseInput({ specError: blocked }));
    expect(html).toContain('class="report-section report-envblocked"');
    expect(html).toContain('Environment blocked — verdicts withheld');
    expect(html).toContain('render not confirmed (status=unconfirmed)');
    expect(html).toContain('<code>session-decay</code>');
    // The WHOLE recipe, not a clipped first line.
    expect(html).toContain('adb emu kill');
  });

  it('is omitted entirely when specError is absent', () => {
    const html = renderHtmlReport(baseInput());
    // The class name appears in the inline <style>; the markup form never does.
    expect(html).not.toContain('class="report-section report-envblocked"');
  });

  it('shape-doubles the status and keeps the glyph out of the accessibility tree', () => {
    const html = renderHtmlReport(baseInput({ specError: blocked }));
    // Hue is confirmation only — the glyph AND the word carry the meaning.
    expect(html).toContain('<span aria-hidden="true">◌</span> Environment blocked');
    expect(html).toContain('role="note"');
  });

  it('NEVER GREEN: the banner uses amber tokens, never the pass ones', () => {
    const html = renderHtmlReport(baseInput({ specError: blocked, verdict: 'pass' }));
    const rule = /\.report-envblocked\{[^}]*\}/.exec(html)?.[0] ?? '';
    expect(rule).toContain('--amb');
    // `--grn*` is the design system's pass family; the banner may never reach it.
    expect(rule).not.toContain('--grn');
    // No side-stripe accent (house rule): the tint is on the full frame.
    expect(rule).not.toMatch(/border-(left|right):/);
  });

  it('renders without a cause or a fix — the message alone is enough', () => {
    const html = renderHtmlReport(baseInput({ specError: { message: 'the sandbox died' } }));
    expect(html).toContain('Environment blocked — verdicts withheld');
    expect(html).toContain('the sandbox died');
    // Markup form, not the bare class name — the latter also lives in <style>.
    expect(html).not.toContain('class="report-envblocked-cause"');
    expect(html).not.toContain('class="report-envblocked-fixlabel"');
  });

  it('escapes HTML in the message, cause and fix command', () => {
    const html = renderHtmlReport(
      baseInput({
        specError: {
          message: "<script>alert('x')</script>",
          cause: '<b>c</b>',
          fixCommand: 'kill <pid> && echo "done"',
        },
      }),
    );
    expect(html).not.toContain("<script>alert('x')");
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;c&lt;/b&gt;');
    expect(html).toContain('kill &lt;pid&gt;');
  });

  it('does not touch the verdict hero — attribution is display-only', () => {
    const withBanner = renderHtmlReport(baseInput({ specError: blocked, verdict: 'fail' }));
    const without = renderHtmlReport(baseInput({ verdict: 'fail' }));
    expect(withBanner).toContain('class="report-hero report-hero--fail"');
    expect(without).toContain('class="report-hero report-hero--fail"');
  });
});

describe('renderMarkdownReport', () => {
  function mdInput(overrides: Partial<ReportInput> = {}): ReportInput {
    return {
      runId: 'run-test-001',
      createdAt: '2026-05-11T12:00:00.000Z',
      prompt: 'Build a dashboard.',
      scenarios: [],
      components: [
        {
          id: 'dashboard',
          filePath: 'src/Dashboard.tsx',
          renders: [
            {
              scenarioId: 'logged-in',
              screenshotDataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=',
            },
          ],
        },
      ],
      brand: 'validity',
      viewCommand: 'npx http-server ./.validity/runs/run-test-001',
      ...overrides,
    };
  }

  it('renders the prompt, run id, and inline screenshot data URL', () => {
    const md = renderMarkdownReport(mdInput());
    expect(md).toContain('Validity report');
    expect(md).toContain('run-test-001');
    expect(md).toContain('> Build a dashboard.');
    // data URL inlined directly (under 500 KB cutoff)
    expect(md).toContain('data:image/png;base64,iVBOR');
    // Heading for the component section
    expect(md).toContain('### dashboard');
  });

  it('falls back to relative path when screenshotDataUrl exceeds the inline budget', () => {
    // ~600 KB base64 payload pretending to be the screenshot data URL.
    const huge = 'data:image/png;base64,' + 'A'.repeat(600 * 1024);
    const md = renderMarkdownReport(
      mdInput({
        components: [
          {
            id: 'big',
            filePath: 'src/Big.tsx',
            renders: [{ scenarioId: 'base', screenshotDataUrl: huge }],
          },
        ],
      }),
    );
    expect(md).not.toContain(huge);
    expect(md).toContain('./screenshots/big__base.png');
  });

  it('mirrors the environment-blocked banner (HTML/markdown parity)', () => {
    const md = renderMarkdownReport(
      mdInput({
        specError: {
          message: 'native verify: render not confirmed',
          cause: 'session-decay',
          fixCommand: 'kill $(cat daemon.pid)\nadb emu kill',
        },
      }),
    );
    expect(md).toContain('◌ **Environment blocked — verdicts withheld**');
    expect(md).toContain('native verify: render not confirmed');
    expect(md).toContain('Cause: `session-decay`');
    expect(md).toContain('adb emu kill');
  });

  it('omits the environment-blocked mirror when specError is absent', () => {
    expect(renderMarkdownReport(mdInput())).not.toContain('Environment blocked');
  });

  it('renders criteria as a markdown checklist', () => {
    const md = renderMarkdownReport(
      mdInput({
        verdict: 'partial',
        criteria: [
          { description: 'Renders header', status: 'pass', reasoning: 'Header visible.' },
          {
            description: 'Updates every second',
            status: 'unverifiable',
            reasoning: 'Animation cannot be screenshot-tested.',
            suggestion: 'Add a Playwright e2e test',
          },
        ],
      }),
    );
    expect(md).toContain('## Acceptance criteria');
    expect(md).toContain('- [x] Renders header');
    expect(md).toContain('- [ ] Updates every second');
    expect(md).toContain('_(unverifiable)_');
    expect(md).toContain('**Suggestion:**');
  });

  it('renders the code diff in a ```diff fenced block with file headings', () => {
    const md = renderMarkdownReport(
      mdInput({
        diff: {
          files: [
            {
              path: 'src/Dashboard.tsx',
              hunks: [
                {
                  header: '@@ -1,2 +1,3 @@',
                  lines: [
                    { kind: 'context', text: 'export default function D() {' },
                    { kind: 'add', text: '  return <div>Hi</div>;' },
                  ],
                },
              ],
            },
          ],
        },
        fileNotes: { 'src/Dashboard.tsx': 'Added the JSX body.' },
      }),
    );
    expect(md).toContain('## Code changes');
    expect(md).toContain('### `src/Dashboard.tsx`');
    expect(md).toContain('> Added the JSX body.');
    expect(md).toContain('```diff');
    expect(md).toContain('+  return <div>Hi</div>;');
  });

  it('renders the diagnostics block as a collapsible <details> when present', () => {
    const md = renderMarkdownReport(
      mdInput({
        components: [
          {
            id: 'a',
            filePath: 'a.tsx',
            renders: [
              {
                screenshotDataUrl: 'data:image/png;base64,AAA=',
                consoleErrors: [{ text: 'whoops' }],
                pageErrors: [{ message: 'TypeError' }],
                networkErrors: [{ method: 'GET', url: '/api/x', status: 500 }],
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('<details><summary>Diagnostics</summary>');
    expect(md).toContain('Uncaught errors (1)');
    expect(md).toContain('TypeError');
    expect(md).toContain('Console errors (1)');
    expect(md).toContain('Failed network responses (1)');
  });

  it('renders the git info in the header line when set', () => {
    const md = renderMarkdownReport(
      mdInput({ git: { sha: 'abcdef1234', branch: 'main', dirty: false } }),
    );
    expect(md).toContain('`abcdef1`');
    expect(md).toContain('main');
  });

  it('renders a "Regression vs. last run" section listing changed criteria with prev → cur', () => {
    const deltas: ReportRegressionDelta[] = [
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
      {
        criterionId: 'AC-2',
        previousStatus: 'unverifiable',
        currentStatus: 'pass',
        delta: 'improved',
      },
      { criterionId: 'AC-3', currentStatus: 'pass', delta: 'new' },
      { criterionId: 'AC-4', previousStatus: 'pass', currentStatus: 'pass', delta: 'unchanged' },
    ];
    const md = renderMarkdownReport(mdInput({ regressionDeltas: deltas }));
    expect(md).toContain('## Regression vs. last run');
    expect(md).toContain('1 regressed, 1 improved, 1 new, 1 unchanged');
    // criterion ids pass through mdEscape (the hyphen is GFM-special)
    expect(md).toContain('- ↓ `AC\\-1` — pass → fail');
    expect(md).toContain('- ↑ `AC\\-2` — unverifiable → pass');
    expect(md).toContain('- + `AC\\-3` — new (not in previous run)');
    // unchanged criteria are not listed as rows
    expect(md).not.toContain('`AC\\-4`');
  });

  it('omits the regression section when regressionDeltas is undefined', () => {
    const md = renderMarkdownReport(mdInput());
    expect(md).not.toContain('## Regression vs. last run');
  });

  it('omits the regression section when every delta is unchanged', () => {
    const deltas: ReportRegressionDelta[] = [
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'pass', delta: 'unchanged' },
    ];
    const md = renderMarkdownReport(mdInput({ regressionDeltas: deltas }));
    expect(md).not.toContain('## Regression vs. last run');
  });

  it('escapes a markup-bearing criterionId in the regression section', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'a_b*c',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
      },
    ];
    const md = renderMarkdownReport(mdInput({ regressionDeltas: deltas }));
    // mdEscape backslash-escapes the GFM-special underscore and asterisk
    expect(md).toContain('a\\_b\\*c');
    expect(md).not.toContain('`a_b*c`');
  });

  it('mirrors the prior receipt (scorer change + prior reasoning) in the regression section', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: {
          status: 'pass',
          reasoning: 'The empty state read as clean.',
          scoredBy: 'model-a',
        },
      },
    ];
    const md = renderMarkdownReport(
      mdInput({
        regressionDeltas: deltas,
        scoring: { judge: 'fresh-context', scoredBy: 'model-b' },
      }),
    );
    expect(md).toContain('- ↓ `AC\\-soft` — pass → fail');
    expect(md).toContain('- _scored by model\\-a → model\\-b_');
    expect(md).toContain('- _prior:_ The empty state read as clean.');
  });

  it('shows the prior scorer once (no arrow) when the scorer is unchanged in markdown', () => {
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: 'looked fine', scoredBy: 'model-a' },
      },
    ];
    const md = renderMarkdownReport(
      mdInput({
        regressionDeltas: deltas,
        scoring: { judge: 'fresh-context', scoredBy: 'model-a' },
      }),
    );
    expect(md).toContain('- _scored by model\\-a_');
    expect(md).not.toContain('model\\-a →');
  });

  it('truncates the prior reasoning at 160 chars + ellipsis in markdown', () => {
    const long = 'y'.repeat(200);
    const deltas: ReportRegressionDelta[] = [
      {
        criterionId: 'AC-soft',
        previousStatus: 'pass',
        currentStatus: 'fail',
        delta: 'regressed',
        prior: { status: 'pass', reasoning: long, scoredBy: 'model-a' },
      },
    ];
    const md = renderMarkdownReport(mdInput({ regressionDeltas: deltas }));
    expect(md).toContain('y'.repeat(160) + '…');
    expect(md).not.toContain('y'.repeat(161));
  });
});

// ---------------------------------------------------------------------------
// C1 — per-criterion EVIDENCE line + header pill row
// ---------------------------------------------------------------------------

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

describe('renderHtmlReport — evidence line (C1)', () => {
  function evidenceInput(overrides: Partial<ReportInput> = {}): ReportInput {
    return baseInput({
      criteria: [
        {
          id: 'AC-soft',
          description: 'Looks polished',
          status: 'pass',
          tier: 'soft',
          reasoning: 'clean layout',
          screenshotIds: ['web-clock'],
        },
      ],
      evidence: {
        'AC-soft': {
          screenshotIds: ['web-clock'],
          mode: 'isolation',
          dataProvenance: ['declared-mock'],
          scoredBy: 'claude-x',
          selfScored: true,
        },
      },
      ...overrides,
    });
  }

  it('renders the evidence line with mode/data/judge chips when an evidence entry exists (HTML + MD)', () => {
    const input = evidenceInput();
    const html = renderHtmlReport(input);
    expect(html).toContain('report-evidence');
    expect(html).toContain('mode: isolation');
    expect(html).toContain('data: declared mock');
    expect(html).toContain('scored by: claude-x');

    const md = renderMarkdownReport(input);
    expect(md).toContain('Evidence: screenshots [`web-clock`](#web-clock)');
    expect(md).toContain('mode: isolation');
    expect(md).toContain('scored by: `claude-x` (self-scored)');
  });

  it('BYTE-REUSE: the thumbnail emits data-shot-ref and NO second copy of the base64 payload', () => {
    const html = renderHtmlReport(evidenceInput());
    expect(html).toContain('data-shot-ref="web-clock"');
    // The base64 payload appears exactly once — in the gallery <img>.
    const payload = TINY_PNG.slice('data:image/png;base64,'.length);
    const occurrences = html.split(payload).length - 1;
    expect(occurrences).toBe(1);
  });

  it('marks ONLY the first non-error render as data-shot-primary', () => {
    const html = renderHtmlReport(
      baseInput({
        components: [
          {
            id: 'web-clock',
            filePath: 'web/Clock.tsx',
            renders: [
              { scenarioId: 'broken', renderError: 'boom' },
              { scenarioId: 'ok', screenshotDataUrl: TINY_PNG },
              { scenarioId: 'ok-2', screenshotDataUrl: TINY_PNG },
            ],
          },
        ],
        evidence: { 'AC-1': { screenshotIds: ['web-clock'] } },
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      }),
    );
    const matches = html.match(/data-shot-primary=/g) ?? [];
    expect(matches.length).toBe(1);
    // The primary marker lands on the first NON-ERROR render ('ok'), which
    // renders after the errored pane ('broken') in the document.
    const primaryIdx = html.indexOf('data-shot-primary');
    expect(primaryIdx).toBeGreaterThan(html.indexOf('data-render-error="broken"'));
    expect(primaryIdx).toBeLessThan(html.indexOf('data-render-label="ok-2"'));
  });

  it("selfScored true → 'self-scored' badge; false → 'fresh-context'; absent → neither", () => {
    const withTrue = renderHtmlReport(evidenceInput());
    expect(withTrue).toContain('self-scored');

    const withFalse = renderHtmlReport(
      evidenceInput({
        evidence: {
          'AC-soft': { screenshotIds: ['web-clock'], scoredBy: 'judge-y', selfScored: false },
        },
      }),
    );
    expect(withFalse).toContain('fresh-context');
    expect(withFalse).not.toContain('>self-scored<');

    const withNeither = renderHtmlReport(
      evidenceInput({
        evidence: { 'AC-soft': { screenshotIds: ['web-clock'], scoredBy: 'judge-y' } },
      }),
    );
    expect(withNeither).not.toContain('>self-scored<');
    expect(withNeither).not.toContain('>fresh-context<');
  });

  it('legacy input (no evidence map) keeps the existing "Scored from:" block unchanged', () => {
    const html = renderHtmlReport(evidenceInput({ evidence: undefined }));
    expect(html).toContain('Scored from:');
    expect(html).not.toContain('class="report-evidence-thumb"');
  });

  it('an evidence entry supersedes the "Scored from:" block (same ids, richer presentation)', () => {
    const html = renderHtmlReport(evidenceInput());
    expect(html).not.toContain('Scored from:');
    expect(html).toContain('class="report-evidence-thumb"');
  });

  it('escapes markup-bearing scoredBy / taint strings in the evidence line', () => {
    const html = renderHtmlReport(
      evidenceInput({
        evidence: {
          'AC-soft': {
            screenshotIds: ['<img src=x onerror=alert(1)>'],
            scoredBy: '<script>alert(1)</script>',
            taints: ['<b>evil</b>'],
          },
        },
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('proven card keeps its per-check excerpt AND gains the evidence line (native mode label)', () => {
    const html = renderHtmlReport(
      baseInput({
        mode: 'native',
        criterionVerdicts: [
          {
            id: 'AC-1',
            tier: 'hard',
            status: 'pass',
            checks: [
              {
                check: { expect: { console: { errors: 0 } } },
                status: 'pass',
                detail: '0 console errors',
              },
            ],
          },
        ],
        evidence: { 'AC-1': { screenshotIds: ['web-clock'], mode: 'native' } },
      }),
    );
    // Check-log excerpt survives.
    expect(html).toContain('0 console errors');
    expect(html).toContain('report-proven-checks');
    // Evidence line with the native mode chip + the mechanical judge chip.
    expect(html).toContain('mode: native');
    expect(html).toContain('judge: mechanical');
  });

  it('caps evidence thumbnails at 4 with a "+N more" overflow marker', () => {
    const html = renderHtmlReport(
      evidenceInput({
        evidence: {
          'AC-soft': { screenshotIds: ['a', 'b', 'c', 'd', 'e', 'f'] },
        },
      }),
    );
    const thumbs = html.match(/report-evidence-thumb/g) ?? [];
    // 1 CSS occurrence-free count: class attribute occurrences only.
    expect(html.match(/class="report-evidence-thumb"/g)?.length).toBe(4);
    expect(html).toContain('+2 more');
    expect(thumbs.length).toBeGreaterThan(0);
  });
});

describe('renderHtmlReport — header pill row (presence-gated badges)', () => {
  it('renders UNPLANNED / temporal / validity-score / self-scored badges only when their slots are populated', () => {
    const bare = renderHtmlReport(baseInput());
    expect(bare).not.toContain('class="report-flag');

    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        unplanned: true,
        temporalBinding: 'frozen-mid-work',
        validityScore: { score: 87, asOf: '2026-07-01', formula: 'v1: weighted mix' },
        scoring: { judge: 'self', selfScored: true },
      }),
    );
    expect(html).toContain('report-verdict-row');
    expect(html).toContain('unplanned');
    expect(html).toContain('spec frozen mid-work');
    expect(html).toContain('validity score: 87');
    // Scoring provenance is NOT a flag pill any more — it belongs to the judged
    // lane (plan 1.3), where it sits beside the count it qualifies.
    expect(html).toContain('<div class="report-lane-note report-lane-note--amber"');
    expect(html).toContain('self-scored');
    // Honesty footnote for the temporal badge.
    expect(html).toContain('never changes a verdict');
  });

  it('temporal binding: frozen-before-work renders green, unknown renders neutral', () => {
    const before = renderHtmlReport(baseInput({ temporalBinding: 'frozen-before-work' }));
    expect(before).toContain('report-flag--green');
    expect(before).toContain('spec frozen before work');
    const unknown = renderHtmlReport(baseInput({ temporalBinding: 'unknown' }));
    expect(unknown).toContain('report-flag--neutral');
    expect(unknown).toContain('spec timing unknown');
  });

  it('partial unknown keeps the known chip and names the unknown count', () => {
    const html = renderHtmlReport(
      baseInput({
        temporalBinding: 'frozen-before-work',
        temporalPartial: true,
        temporalUnknownSpecs: ['spec-a', 'spec-b'],
      }),
    );
    expect(html).toContain('spec frozen before work (2 specs unknown)');
    expect(html).toContain('2 specs in this run could not be classified');
    const md = renderMarkdownReport(
      baseInput({
        temporalBinding: 'frozen-before-work',
        temporalPartial: true,
        temporalUnknownSpecs: ['spec-a', 'spec-b'],
      }),
    );
    expect(md).toContain('spec frozen before work (2 specs unknown)');
    expect(md).toContain('2 specs in this run could not be classified');
  });

  it('renders the tainted-evidence count badge from the criterion verdicts', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          { id: 'AC-1', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
          { id: 'AC-2', tier: 'hard', status: 'pass' },
        ],
      }),
    );
    expect(html).toContain('tainted evidence: 1');
  });

  it('markdown header carries the same badges', () => {
    const md = renderMarkdownReport(
      baseInput({
        unplanned: true,
        temporalBinding: 'frozen-mid-work',
        validityScore: { score: 42, asOf: '2026-07-01', formula: 'v1' },
        scoring: { judge: 'self', selfScored: true },
      }),
    );
    expect(md).toContain('**UNPLANNED**');
    expect(md).toContain('**spec frozen mid-work**');
    expect(md).toContain('Validity Score: **42**');
    // Provenance moved out of the badge row into the markdown lane line.
    expect(md).toContain('_(self-scored)_');
    expect(md).toContain('never changes a verdict');
  });
});

// ---------------------------------------------------------------------------
// C2 — "Not validated" section
// ---------------------------------------------------------------------------

describe('renderHtmlReport — Not validated section (C2)', () => {
  it('renders directly after the header, before the setup/prompt sections', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      }),
    );
    const headerIdx = html.indexOf('class="report-header"');
    const notValidatedIdx = html.indexOf('class="report-section report-notvalidated"');
    const promptIdx = html.indexOf('class="report-prompt"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(notValidatedIdx).toBeGreaterThan(headerIdx);
    expect(promptIdx).toBeGreaterThan(notValidatedIdx);
  });

  it('groups unverifiable criteria by taint; a criterion with two taints appears under both groups', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          {
            id: 'AC-both',
            tier: 'soft',
            status: 'unverifiable',
            evidenceTaints: ['network', 'wrapper'],
          },
          { id: 'AC-wrap', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
        ],
      }),
    );
    expect(html).toContain('Network evidence was fabricated (permissive mock)');
    expect(html).toContain('Rendered under a degraded wrapper clone');
    // AC-both is listed twice (once per taint group).
    expect((html.match(/AC-both/g) ?? []).length).toBe(2);
    expect((html.match(/AC-wrap/g) ?? []).length).toBe(1);
  });

  it('legacy networkTainted (no evidenceTaints) groups under the network header — backward compat', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          { id: 'AC-legacy', tier: 'hard', status: 'unverifiable', networkTainted: true },
        ],
      }),
    );
    expect(html).toContain('Network evidence was fabricated (permissive mock)');
    expect(html).toContain('AC-legacy');
  });

  it('renders notCovered dataStates/viewports as chips; omits the parts when absent', () => {
    const html = renderHtmlReport(
      baseInput({
        notCovered: { dataStates: ['empty (web-clock)'], viewports: ['mobile'] },
      }),
    );
    expect(html).toContain('Data states not rendered');
    expect(html).toContain('empty (web-clock)');
    expect(html).toContain('Viewports not covered');
    expect(html).toContain('mobile');

    const withoutViewports = renderHtmlReport(
      baseInput({ notCovered: { dataStates: ['empty (web-clock)'] } }),
    );
    expect(withoutViewports).not.toContain('Viewports not covered');
  });

  it('coverage floor: met → ✓; breached → BREACH pill; no floor → ratio only', () => {
    const base = {
      criterionVerdicts: [
        { id: 'AC-1', tier: 'hard' as const, status: 'pass' as const },
        { id: 'AC-2', tier: 'hard' as const, status: 'unverifiable' as const },
      ],
      coverage: { ratio: 0.5, hardPropertyTotal: 2, verifiableCount: 1 },
    };
    const met = renderHtmlReport(baseInput({ ...base, coverageFloorPercent: 40 }));
    expect(met).toContain('floor 40%');
    expect(met).toContain('✓');
    expect(met).not.toContain('BREACH');

    const breach = renderHtmlReport(baseInput({ ...base, coverageFloorPercent: 90 }));
    expect(breach).toContain('floor 90%');
    expect(breach).toContain('BREACH');

    const noFloor = renderHtmlReport(baseInput(base));
    expect(noFloor).toContain('Mechanically decided: 1/2 (50%)');
    expect(noFloor).not.toContain('floor');
  });

  it('renders the honest-empty line when a spec run has zero remainder', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        coverage: { ratio: 1, hardPropertyTotal: 1, verifiableCount: 1 },
        coverageFloorPercent: 70,
      }),
    );
    expect(html).toContain('Nothing outstanding');
  });

  it('non-spec legacy input (no criterionVerdicts/coverage/notCovered) → section absent entirely', () => {
    const html = renderHtmlReport(baseInput());
    expect(html).not.toContain('class="report-section report-notvalidated"');
    expect(html).not.toContain('Not validated');
  });

  it('markdown parity: ## Not validated with groups, floor line, and honest-empty state', () => {
    const md = renderMarkdownReport(
      baseInput({
        criterionVerdicts: [
          { id: 'AC-net', tier: 'hard', status: 'unverifiable', networkTainted: true },
        ],
        coverage: { ratio: 0, hardPropertyTotal: 1, verifiableCount: 0 },
        coverageFloorPercent: 70,
      }),
    );
    expect(md).toContain('## Not validated');
    expect(md).toContain('Network evidence was fabricated (permissive mock)');
    expect(md).toContain('`AC-net`');
    expect(md).toContain('**Coverage:** Mechanically decided: 0/1 (0%) — floor 70% **BREACH**');
    // Ordering: header → Not validated → Prompt.
    expect(md.indexOf('## Not validated')).toBeLessThan(md.indexOf('## Prompt'));

    const clean = renderMarkdownReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        coverage: { ratio: 1, hardPropertyTotal: 1, verifiableCount: 1 },
      }),
    );
    expect(clean).toContain('_Nothing outstanding');
  });
});

// ---------------------------------------------------------------------------
// Can't-false-green guards (verdict PRESENTATION integrity)
// ---------------------------------------------------------------------------

describe("renderHtmlReport — can't-false-green presentation guards", () => {
  it("CAN'T FALSE-GREEN: a networkTainted criterion with all-pass checks renders unverifiable + Not-validated row, never a pass pill", () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          {
            id: 'AC-net',
            tier: 'hard',
            status: 'unverifiable',
            networkTainted: true,
            checks: [
              {
                check: { expect: { network: { method: 'POST', url: '/api/x', status: '2xx' } } },
                status: 'pass',
                detail: 'POST /api/x → 200 (fabricated)',
              },
            ],
          },
        ],
      }),
    );
    // Listed in Not-validated under the network group.
    expect(html).toContain('Network evidence was fabricated (permissive mock)');
    // The card head shows the verdict status verbatim — the renderer must
    // never derive a greener pill from the checks array.
    const cardIdx = html.indexOf('class="report-criterion-card report-proven-card"');
    const cardHead = html.slice(cardIdx, html.indexOf('report-proven-checks', cardIdx));
    expect(cardHead).toContain('report-pill-unverifiable');
    expect(cardHead).not.toContain('report-pill-pass');
  });

  it('unknown taint strings render VISIBLY under a verbatim group header (never silently dropped)', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          {
            id: 'AC-future',
            tier: 'soft',
            status: 'unverifiable',
            // A future taint kind this renderer has never heard of.
            evidenceTaints: ['quantum-flakiness' as never],
          },
          { id: 'AC-plain', tier: 'soft', status: 'unverifiable' },
        ],
      }),
    );
    expect(html).toContain('quantum-flakiness');
    expect(html).toContain('AC-future');
    // The taint-less unverifiable criterion lands in the unknown group.
    expect(html).toContain('checks did not execute / unknown');
    expect(html).toContain('AC-plain');
    // Row count === unverifiable verdict count (nothing filtered).
    const rows = html.match(/class="report-notvalidated-row"/g) ?? [];
    expect(rows.length).toBe(2);
  });
});

describe('renderHtmlReport — spec-context panel (system tie-in)', () => {
  const ctxInput = () =>
    baseInput({
      runId: 'run_current',
      specContext: {
        specId: 'spec-ac6d',
        version: 2,
        status: 'frozen',
        maturity: {
          level: 'team',
          blockers: ['clean streak 1/2 — one more clean verification at a new commit'],
        },
        cleanStreak: 1,
        openSignals: [{ kind: 'needs-scoring', severity: 'low', criterionId: 'AC-5' }],
        history: [
          { runId: 'run_old', createdAt: '2026-07-10T00:00:00Z', verdict: 'fail' },
          { runId: 'run_current', createdAt: '2026-07-17T00:00:00Z', verdict: 'pass' },
        ],
      },
    });

  it('renders identity, maturity, certification blockers, signals, and timeline', () => {
    const html = renderHtmlReport(ctxInput());
    expect(html).toContain('Part of spec spec-ac6d');
    expect(html).toContain('v2');
    expect(html).toContain('frozen');
    expect(html).toContain('team');
    expect(html).toContain('clean streak 1/2');
    expect(html).toContain('needs-scoring');
    expect(html).toContain('report-spec-dot--fail');
    expect(html).toContain('report-spec-dot--current');
    expect(html).toContain('validity spec show spec-ac6d');
    expect(html).toContain('validity trends');
  });

  it('omits the panel entirely on unplanned runs (no specContext)', () => {
    const html = renderHtmlReport(baseInput());
    expect(html).not.toContain('Part of spec');
    // Section markup absent (the CSS class definition rides along regardless).
    expect(html).not.toContain('<section class="report-section report-spec-context">');
  });

  it('orders the report spec-first: context and verdict sections precede screenshots and code diff', () => {
    const html = renderHtmlReport(ctxInput());
    const specAt = html.indexOf('Part of spec spec-ac6d');
    const screenshotsAt = html.indexOf('Rendered screenshots');
    const diffAt = html.indexOf('report-diffs');
    expect(specAt).toBeGreaterThan(-1);
    expect(specAt).toBeLessThan(screenshotsAt);
    if (diffAt !== -1) expect(screenshotsAt).toBeLessThan(diffAt);
  });

  it('leads with the spec panel: it precedes the Not-validated ledger and prompt', () => {
    const html = renderHtmlReport(
      baseInput({
        specContext: { specId: 'spec-ac6d' },
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      }),
    );
    const specAt = html.indexOf('class="report-section report-spec-context"');
    const notValidatedAt = html.indexOf('class="report-section report-notvalidated"');
    const promptAt = html.indexOf('class="report-prompt"');
    expect(specAt).toBeGreaterThan(-1);
    expect(notValidatedAt).toBeGreaterThan(specAt);
    expect(promptAt).toBeGreaterThan(notValidatedAt);
  });
});

describe('renderHtmlReport — header layout (flags never squeeze the summary)', () => {
  it('renders the summary blurb OUTSIDE the hero/count/flags flex row, full width', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        unplanned: true, // populates a flag so the badge row renders
        summary: 'A long verdict summary that must span the full content area.',
        criteria: [
          { description: 'c1', status: 'pass', reasoning: 'r' },
          { description: 'c2', status: 'pass', reasoning: 'r' },
        ],
      }),
    );
    // The blurb div must appear AFTER the summary flex row closes — it is a
    // sibling, not a child, so flag pills can never squeeze it.
    const summaryOpen = html.indexOf('<div class="report-summary">');
    const blurbAt = html.indexOf('<div class="report-summary-blurb">');
    expect(summaryOpen).toBeGreaterThan(-1);
    expect(blurbAt).toBeGreaterThan(summaryOpen);
    // The lane block is a supporting element, not the blurb host.
    const lanesOpen = html.indexOf('<div class="report-lanes">');
    const badgeOpen = html.indexOf('<div class="report-summary-badge">');
    expect(lanesOpen).toBeGreaterThan(-1);
    expect(badgeOpen).toBeGreaterThan(lanesOpen);
    expect(html.slice(lanesOpen, badgeOpen)).not.toContain('report-summary-blurb');
    // And the blurb comes after the flag row block.
    expect(blurbAt).toBeGreaterThan(badgeOpen);
    // The hero leads the band (loudest element, before the lanes).
    const heroOpen = html.indexOf('<div class="report-hero report-hero--pass">');
    expect(heroOpen).toBeGreaterThan(summaryOpen);
    expect(heroOpen).toBeLessThan(lanesOpen);
  });
});

// ---------------------------------------------------------------------------
// Trust/cohesion fixes — verdict hero, union count, no-false-green, receipts
// ---------------------------------------------------------------------------

describe('renderHtmlReport — two-lane headline (machine-verified vs. judged)', () => {
  it('never blends the lanes: a soft 3/3 cannot hide a mechanical fail', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'fail',
        criteria: [
          { id: 'S1', description: 's1', status: 'pass', reasoning: 'r' },
          { id: 'S2', description: 's2', status: 'pass', reasoning: 'r' },
          { id: 'S3', description: 's3', status: 'pass', reasoning: 'r' },
        ],
        criterionVerdicts: [{ id: 'H1', tier: 'hard', status: 'fail', detail: 'boom' }],
      }),
    );
    // Machine lane: 0/1, failing. Judged lane: 3/3, passing. Two numbers, never
    // averaged into one — the old blended counter said "3 / 4" for this run.
    expect(html).toContain('class="report-lane report-lane--machine report-lane--fail"');
    expect(html).toContain(
      '<span class="report-lane-glyph" aria-hidden="true">✕</span><span class="report-lane-tally">0<span class="report-lane-total">/1</span></span><span class="report-lane-word">fail</span>',
    );
    expect(html).toContain('class="report-lane report-lane--judged report-lane--pass"');
    expect(html).toContain(
      '<span class="report-lane-glyph" aria-hidden="true">●</span><span class="report-lane-tally">3<span class="report-lane-total">/3</span></span><span class="report-lane-word">pass</span>',
    );
    // The hero still states the true verdict.
    expect(html).toContain('class="report-hero report-hero--fail"');
    expect(html).toContain('>✕</span>Fail');
    // (the `--pass` modifier also lives in the <style>, so anchor on the element)
    expect(html).not.toContain('class="report-hero report-hero--pass"');
  });

  it('labels each lane with what it counts, and never blends them into one number', () => {
    const html = renderHtmlReport(
      baseInput({ criteria: [{ description: 'c', status: 'pass', reasoning: 'r' }] }),
    );
    expect(html).toContain('>Machine-verified</div>');
    expect(html).toContain('>Judged</div>');
    expect(html).toContain('Hard and property criteria decided mechanically');
    expect(html).toContain('Soft criteria scored from screenshots — opinion, not machine proof.');
    // The blended union counter is gone for good.
    expect(html).not.toContain('report-summary-count');
    expect(html).not.toContain('Criteria passed');
  });

  it('shape-doubles every lane status (glyph + word), never hue alone', () => {
    const partial = renderHtmlReport(
      baseInput({
        criterionVerdicts: [
          { id: 'H1', tier: 'hard', status: 'pass' },
          { id: 'H2', tier: 'hard', status: 'unverifiable' },
        ],
      }),
    );
    expect(partial).toContain('report-lane--machine report-lane--partial');
    expect(partial).toContain('>▲</span><span class="report-lane-tally">1');
    expect(partial).toContain('>partial</span>');
    // An empty lane reads ◌ / none — never an implied green.
    expect(partial).toContain('report-lane--judged report-lane--empty');
    expect(partial).toContain('>◌</span><span class="report-lane-tally">0');
    expect(partial).toContain('>none</span>');
  });

  it('omits the lanes entirely when there is neither a criterion nor a scoring stamp', () => {
    const html = renderHtmlReport(baseInput({ verdict: 'fail' }));
    expect(html).toContain('class="report-hero report-hero--fail"');
    expect(html).not.toContain('<div class="report-lanes">');
  });

  it('renders the judged lane for a scoring stamp even with zero soft criteria', () => {
    const html = renderHtmlReport(
      baseInput({ verdict: 'pass', scoring: { judge: 'self', selfScored: true } }),
    );
    expect(html).toContain('<div class="report-lanes">');
    expect(html).toContain('report-lane--judged report-lane--empty');
    expect(html).toContain('self-scored');
  });
});

describe('renderHtmlReport — no green without receipts (never-false-green)', () => {
  it('a pass with ZERO criteria and ZERO proven verdicts renders ◌ Unverified, never green', () => {
    const html = renderHtmlReport(baseInput({ verdict: 'pass', summary: 'looks done' }));
    expect(html).toContain('class="report-hero report-hero--unverified"');
    expect(html).toContain('>◌</span>Unverified');
    // (the `--pass` modifier also lives in the <style>, so anchor on the element)
    expect(html).not.toContain('class="report-hero report-hero--pass"');
    expect(html).toContain('no criteria or proven checks to back it');
  });

  it('a FAIL with zero evidence still renders Fail (only pass is demoted to unverified)', () => {
    const html = renderHtmlReport(baseInput({ verdict: 'fail' }));
    expect(html).toContain('class="report-hero report-hero--fail"');
    expect(html).toContain('>✕</span>Fail');
    expect(html).not.toContain('class="report-hero report-hero--unverified"');
  });

  it('a pass WITH backing evidence keeps rendering green (regression guard)', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        criterionVerdicts: [{ id: 'H1', tier: 'hard', status: 'pass' }],
      }),
    );
    expect(html).toContain('class="report-hero report-hero--pass"');
    expect(html).toContain('>●</span>Pass');
    expect(html).not.toContain('class="report-hero report-hero--unverified"');
  });
});

describe('renderHtmlReport — double-rendered hard criteria folded out', () => {
  it('a soft criterion duplicating a proven verdict id is dropped from Per-criterion details', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'proven detail' }],
        criteria: [
          {
            id: 'AC-1',
            description: 'copied hard criterion',
            status: 'pass',
            reasoning: 'copy-back',
          },
          { id: 'AC-9', description: 'genuine soft', status: 'pass', reasoning: 'r' },
        ],
      }),
    );
    // Proven section is authoritative for AC-1.
    expect(html).toContain('Proven (deterministic)');
    expect(html).toContain('proven detail');
    // The duplicated soft copy never renders in the per-criterion section.
    expect(html).toContain('genuine soft');
    expect(html).not.toContain('copied hard criterion');
    // Lanes read 1/1 machine + 1/1 judged — never an inflated judged 2/2.
    expect(html).toContain(
      '<span class="report-lane-glyph" aria-hidden="true">●</span><span class="report-lane-tally">1<span class="report-lane-total">/1</span></span>',
    );
    expect(
      html.match(/report-lane-tally">1<span class="report-lane-total">\/1<\/span>/g)?.length,
    ).toBe(2);
  });

  it('surfaces the "Mechanical verdict kept" override receipt in the Proven section', () => {
    // Mirrors submit_report: the agent submitted "pass" for a criterion a
    // property check FAILED; submit_report clamps the row to fail and prepends
    // a bracketed override note to its reasoning. The proven CriterionVerdict
    // carries only the mechanical detail, so the report must read the reshaped
    // reasoning and surface the receipt of the attempted false green.
    const html = renderHtmlReport(
      baseInput({
        verdict: 'fail',
        criterionVerdicts: [
          {
            id: 'AC-types',
            tier: 'property',
            status: 'fail',
            detail: "command 'typecheck' exited 2 (expected 0)",
          },
        ],
        criteria: [
          {
            id: 'AC-types',
            description: 'the repo typechecks',
            status: 'fail',
            reasoning:
              '[Mechanical verdict kept: fail. Agent submitted "pass", overridden by the deterministic check.] the screenshots all look perfect',
          },
        ],
      }),
    );
    // The override receipt is visible (this is the exact mcp-server S4 contract)…
    expect(html).toContain('Mechanical verdict kept: fail');
    // …rendered inside the Proven card (shape-doubled amber note), not the
    // per-criterion section (the duplicate soft row is folded out).
    expect(html).toContain('class="report-proven-override"');
    const provenIdx = html.indexOf('Proven (deterministic)');
    const detailsIdx = html.indexOf('Per-criterion details');
    expect(html.indexOf('Mechanical verdict kept: fail')).toBeGreaterThan(provenIdx);
    // No per-criterion section at all here (only the folded duplicate existed).
    expect(detailsIdx).toBe(-1);
    // The agent's original reasoning is not surfaced as a proven claim.
    expect(html).not.toContain('the screenshots all look perfect');

    // Markdown parity: the receipt rides the proven list item.
    const md = renderMarkdownReport(
      baseInput({
        verdict: 'fail',
        criterionVerdicts: [
          { id: 'AC-types', tier: 'property', status: 'fail', detail: 'tsc failed' },
        ],
        criteria: [
          {
            id: 'AC-types',
            description: 'the repo typechecks',
            status: 'fail',
            reasoning:
              '[Mechanical verdict kept: fail. Agent submitted "pass", overridden by the deterministic check.] pretty screenshots',
          },
        ],
      }),
    );
    expect(md).toContain('Mechanical verdict kept: fail');
  });

  it('a pure copy-back (no bracketed override note) still folds out entirely', () => {
    const html = renderHtmlReport(
      baseInput({
        criterionVerdicts: [{ id: 'AC-x', tier: 'hard', status: 'pass' }],
        criteria: [
          { id: 'AC-x', description: 'honest copy', status: 'pass', reasoning: 'looks good' },
        ],
      }),
    );
    expect(html).not.toContain('honest copy');
    expect(html).not.toContain('class="report-proven-override"');
  });
});

describe('renderHtmlReport — Not validated surfaces on unplanned soft-only runs', () => {
  it('renders the section when a soft criterion is unverifiable, even with no verdicts/coverage', () => {
    const html = renderHtmlReport(
      baseInput({
        unplanned: true,
        criteria: [
          {
            description: 'cannot verify animation',
            status: 'unverifiable',
            reasoning: 'static shot',
          },
        ],
      }),
    );
    expect(html).toContain('class="report-section report-notvalidated"');
    expect(html).toContain('cannot verify animation');
  });

  it('stays absent when every soft criterion passed and there are no verdicts', () => {
    const html = renderHtmlReport(
      baseInput({ criteria: [{ description: 'ok', status: 'pass', reasoning: 'r' }] }),
    );
    expect(html).not.toContain('class="report-section report-notvalidated"');
  });
});

describe('renderHtmlReport — scripts-disabled receipts', () => {
  it('marks the first diff carousel slide is-active at render time (readable with scripts off)', () => {
    const diff: ReportDiff = {
      files: [
        { path: 'a.tsx', hunks: [{ header: '@@', lines: [{ kind: 'add', text: 'x' }] }] },
        { path: 'b.tsx', hunks: [{ header: '@@', lines: [{ kind: 'add', text: 'y' }] }] },
      ],
    };
    const html = renderHtmlReport(baseInput({ diff }));
    expect(html).toMatch(/<div class="report-carousel-slide is-active" data-slide-index="0"/);
    // Exactly one slide is active statically.
    expect((html.match(/report-carousel-slide is-active/g) ?? []).length).toBe(1);
  });

  it('evidence thumbnails degrade to a labeled anchor link (no JS, no duplicated bytes)', () => {
    const html = renderHtmlReport(
      baseInput({
        criteria: [
          {
            id: 'AC-1',
            description: 'looks polished',
            status: 'pass',
            tier: 'soft',
            reasoning: 'clean',
            screenshotIds: ['web-clock'],
          },
        ],
        evidence: { 'AC-1': { screenshotIds: ['web-clock'] } },
      }),
    );
    // The anchor jumps to the embedded screenshot; the id is a visible label.
    expect(html).toContain('href="#component-web-clock"');
    expect(html).toContain('title="Jump to the web-clock screenshot"');
    expect(html).toMatch(/<a class="report-evidence-thumb"[^>]*>[\s\S]*?<code>web-clock<\/code>/);
  });
});

describe('renderHtmlReport — copy failing criteria as fix prompt (stretch)', () => {
  it('renders a hidden, JS-revealed button carrying a deterministic fix prompt', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'fail',
        criteria: [
          {
            id: 'S1',
            description: 'button too small',
            status: 'fail',
            reasoning: 'r',
            suggestion: 'make it 44px',
          },
        ],
        criterionVerdicts: [
          { id: 'H1', tier: 'hard', status: 'fail', detail: 'network never called' },
        ],
      }),
    );
    expect(html).toMatch(/<button[^>]*class="report-fix-prompt"[^>]*hidden/);
    expect(html).toContain('data-fix-prompt=');
    // Proven fail first, then the soft fail with its suggestion.
    expect(html).toContain('[H1] network never called');
    expect(html).toContain('[S1] button too small');
    expect(html).toContain('Suggestion: make it 44px');
    // The reveal + copy handler is wired in the inline JS.
    expect(html).toContain('button[data-fix-prompt]');
  });

  it('is absent when nothing failed', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        criteria: [{ description: 'ok', status: 'pass', reasoning: 'r' }],
      }),
    );
    expect(html).not.toContain('class="report-fix-prompt"');
  });
});

describe('renderMarkdownReport — textual glyphs, no emoji verdicts', () => {
  it('uses ● / ✕ / ◌ (never ✅❌⚠️) for proven and not-validated rows', () => {
    const md = renderMarkdownReport(
      baseInput({
        criterionVerdicts: [
          { id: 'H1', tier: 'hard', status: 'pass' },
          { id: 'H2', tier: 'hard', status: 'fail' },
        ],
        criteria: [{ id: 'S1', description: 's', status: 'unverifiable', reasoning: 'r' }],
      }),
    );
    expect(md).not.toContain('✅');
    expect(md).not.toContain('❌');
    expect(md).not.toContain('⚠️');
    expect(md).toContain('● `H1`');
    expect(md).toContain('✕ `H2`');
    expect(md).toContain('◌ `S1`');
  });

  it('demotes a receipt-less pass to Unverified in the markdown header', () => {
    const md = renderMarkdownReport(baseInput({ verdict: 'pass' }));
    expect(md).toContain('Verdict: **Unverified**');
    expect(md).toContain('treat as unverified');
    expect(md).not.toContain('Verdict: **Pass**');
  });
});

describe('renderHtmlReport — validated vs agent-attested split', () => {
  it('splits the counts into two lanes beside the hero: mechanical vs. judged', () => {
    const html = renderHtmlReport(
      baseInput({
        verdict: 'partial',
        criterionVerdicts: [
          { id: 'H1', tier: 'hard', status: 'pass' },
          { id: 'P1', tier: 'property', status: 'pass' },
        ],
        criteria: [{ id: 'S1', description: 's1', status: 'pass', tier: 'soft', reasoning: 'r' }],
      }),
    );
    // 2 mechanical verdicts, 1 de-duplicated soft criterion — separately.
    expect(html).toContain(
      '<span class="report-lane-tally">2<span class="report-lane-total">/2</span></span>',
    );
    expect(html).toContain(
      '<span class="report-lane-tally">1<span class="report-lane-total">/1</span></span>',
    );
    // The lanes sit beside the hero and never touch the verdict word.
    expect(html).toContain('class="report-hero report-hero--partial"');
    expect(html).toContain('>▲</span>Partial');
    const heroAt = html.indexOf('<div class="report-hero report-hero--partial">');
    expect(html.indexOf('<div class="report-lanes">')).toBeGreaterThan(heroAt);
  });

  it('counts only mechanical verdicts in the machine lane, only de-duped soft in the judged lane', () => {
    // A soft row duplicating a proven id is an agent copy-back — folded out of
    // the judged lane so a single proof is never counted twice.
    const html = renderHtmlReport(
      baseInput({
        verdict: 'pass',
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        criteria: [
          { id: 'AC-1', description: 'dup', status: 'pass', tier: 'soft', reasoning: 'r' },
        ],
      }),
    );
    expect(html).toContain('report-lane--machine report-lane--pass');
    expect(html).toContain(
      '<span class="report-lane-tally">1<span class="report-lane-total">/1</span></span>',
    );
    expect(html).toContain('report-lane--judged report-lane--empty');
    expect(html).toContain(
      '<span class="report-lane-tally">0<span class="report-lane-total">/0</span></span>',
    );
  });

  it('renders the agent-attested sign-off note (dashed, muted, worth a human check)', () => {
    const html = renderHtmlReport(
      baseInput({ verdict: 'pass', signOff: { signedOff: true, attested: true } }),
    );
    expect(html).toContain('class="report-signoff report-signoff--attested"');
    expect(html).toContain('signed off (agent-attested) — worth a human check');
    // The distinction is carried by the words, not a pass-green banner.
    expect(html).not.toContain('every blocking criterion proven mechanically');
  });

  it('renders the fully-mechanical sign-off note when nothing rests on a soft pass', () => {
    const html = renderHtmlReport(
      baseInput({ verdict: 'pass', signOff: { signedOff: true, attested: false } }),
    );
    expect(html).toContain('class="report-signoff report-signoff--proven"');
    expect(html).toContain('signed off — every blocking criterion proven mechanically');
    // The attested note text must not appear (the CSS comment references the
    // word, so anchor on the full note phrasing, not the bare token).
    expect(html).not.toContain('signed off (agent-attested)');
  });

  it('renders no sign-off note when signOff is absent or not signed off', () => {
    const absent = renderHtmlReport(baseInput({ verdict: 'pass' }));
    expect(absent).not.toContain('class="report-signoff');

    const notSignedOff = renderHtmlReport(
      baseInput({ verdict: 'fail', signOff: { signedOff: false, attested: false } }),
    );
    expect(notSignedOff).not.toContain('class="report-signoff');
  });

  it('mirrors the split and sign-off in markdown (agent-attested)', () => {
    const md = renderMarkdownReport(
      baseInput({
        verdict: 'partial',
        criterionVerdicts: [{ id: 'H1', tier: 'hard', status: 'pass' }],
        criteria: [{ id: 'S1', description: 's1', status: 'pass', tier: 'soft', reasoning: 'r' }],
        signOff: { signedOff: true, attested: true },
      }),
    );
    expect(md).toContain('● Machine-verified: **1/1** pass  ·  ● Judged: **1/1** pass');
    expect(md).toContain('✓ signed off (agent-attested) — worth a human check');
    expect(md).not.toContain('every blocking criterion proven mechanically');
  });

  it('mirrors the fully-mechanical sign-off in markdown and omits the lanes when empty', () => {
    const md = renderMarkdownReport(
      baseInput({
        verdict: 'pass',
        criterionVerdicts: [{ id: 'H1', tier: 'hard', status: 'pass' }],
        signOff: { signedOff: true, attested: false },
      }),
    );
    expect(md).toContain('● Machine-verified: **1/1** pass  ·  ◌ Judged: **0/0** none');
    expect(md).toContain('✓ signed off — every blocking criterion proven mechanically');

    const empty = renderMarkdownReport(baseInput({ verdict: 'fail' }));
    expect(empty).not.toContain('Machine-verified:');
    expect(empty).not.toContain('✓ signed off');
  });
});

describe('model-judged provenance (independent LLM judge)', () => {
  const modelScoring = {
    judge: 'model' as const,
    scoredBy: 'anthropic/claude-3-5-sonnet-latest',
    selfScored: false,
    judgeModel: 'anthropic/claude-3-5-sonnet-latest',
  };

  it('renders a model-judged header pill, not a fresh-context one', () => {
    const html = renderHtmlReport(baseInput({ scoring: modelScoring }));
    expect(html).toContain('model-judged');
    expect(html).toContain('Soft criteria scored by an independent model');
    // selfScored:false must NOT be mislabeled as a fresh-context subagent.
    expect(html).not.toContain('fresh-context');
  });

  it('names the independent model in the sign-off note (still attested/dashed)', () => {
    const html = renderHtmlReport(
      baseInput({ scoring: modelScoring, signOff: { signedOff: true, attested: true } }),
    );
    expect(html).toContain('signed off (model-judged)');
    expect(html).toContain('report-signoff--attested'); // unproven-by-machine → dashed frame
    // The visible note text must not fall back to the self-attested phrasing.
    expect(html).not.toContain('signed off (agent-attested)');
  });

  it('mirrors the model-judged provenance in markdown', () => {
    const md = renderMarkdownReport(
      baseInput({ scoring: modelScoring, signOff: { signedOff: true, attested: true } }),
    );
    expect(md).toContain('model-judged');
    expect(md).toContain('✓ signed off (model-judged)');
  });

  it('does NOT badge model-judged when the run was self-scored (no laundering)', () => {
    // A config `judge:'model'` the BUILDER self-scored stamps selfScored:true —
    // it must badge self-scored, never launder as an independent-model judge.
    const html = renderHtmlReport(
      baseInput({ scoring: { judge: 'model', scoredBy: 'builder', selfScored: true } }),
    );
    expect(html).not.toContain('model-judged');
    expect(html).toContain('self-scored');
  });
});

describe('attestation footer', () => {
  const stamp = {
    digest: 'sha256-' + 'a'.repeat(64),
    signature: 'c2lnbmF0dXJlLWJ5dGVz',
    publicKey: 'cHVibGljLWtleS1ieXRlcw==',
  };

  it('prints the digest, signature, and public key IN FULL', () => {
    const html = renderHtmlReport(baseInput({ attestation: stamp }));
    expect(html).toContain(stamp.digest);
    expect(html).toContain(stamp.signature);
    expect(html).toContain(stamp.publicKey);
    expect(html).toContain('validity attest verify');
  });

  it('lives in the footer, after every section — never in the header', () => {
    const html = renderHtmlReport(baseInput({ attestation: stamp }));
    const block = html.indexOf('<div class="report-attest">');
    expect(block).toBeGreaterThan(html.indexOf('<footer'));
    expect(block).toBeGreaterThan(html.indexOf('report-header'));
    // Nothing above the footer may carry the digest.
    expect(html.slice(0, html.indexOf('<footer'))).not.toContain(stamp.digest);
  });

  it('claims tamper-evidence, never authorship (non-goal: PKI/identity)', () => {
    const html = renderHtmlReport(baseInput({ attestation: stamp }));
    expect(html).toContain('unmodified since Validity wrote them');
    expect(html).toContain('does not prove who ran them');
  });

  it('renders nothing when the run is unsigned', () => {
    expect(renderHtmlReport(baseInput())).not.toContain('<div class="report-attest">');
  });

  it('changes ONLY the stamp values — everything else stays byte-identical', () => {
    const signed = renderHtmlReport(baseInput({ attestation: stamp }));
    const other = renderHtmlReport(
      baseInput({ attestation: { ...stamp, signature: 'ZGlmZmVyZW50' } }),
    );
    const marker = '<div class="report-attest">';
    expect(signed.slice(0, signed.indexOf(marker))).toBe(other.slice(0, other.indexOf(marker)));
    expect(signed.slice(signed.indexOf('</footer>'))).toBe(other.slice(other.indexOf('</footer>')));
    expect(other).not.toBe(signed);
  });

  it('adds nothing above the footer that an unsigned run lacks', () => {
    const cut = (html: string): string => html.slice(0, html.indexOf('<footer'));
    expect(cut(renderHtmlReport(baseInput({ attestation: stamp })))).toBe(
      cut(renderHtmlReport(baseInput())),
    );
  });

  it('escapes the stamp values (they are printed verbatim)', () => {
    const html = renderHtmlReport(
      baseInput({ attestation: { ...stamp, publicKey: '<script>x</script>' } }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

/* ------------------------------------------------------------------ *
 * Environment channel + run-dir evidence sections.                    *
 * ------------------------------------------------------------------ */

describe('setup panel — render environment facts', () => {
  it('says nothing (and paints no panel) for the steady state: web target, cold Vite, clean scan', () => {
    const html = renderHtmlReport(
      baseInput({ environment: { target: 'web', devServer: 'cold', tailwindShim: false } }),
    );
    // The whole panel stays suppressed — a boring environment is not news, and
    // the report's bytes must not grow for it.
    expect(html).not.toContain('setup-env-list');
    expect(html).not.toContain('class="setup-health"');
  });

  it('is byte-identical to a report with no environment at all when the environment is boring', () => {
    const withEnv = renderHtmlReport(
      baseInput({ environment: { target: 'web', devServer: 'cold', tailwindShim: true } }),
    );
    expect(withEnv).toBe(renderHtmlReport(baseInput()));
  });

  it('opens the panel for a non-web target and names what actually rendered', () => {
    const html = renderHtmlReport(
      baseInput({ environment: { target: 'expo-web', devServer: 'cold', tailwindShim: false } }),
    );
    expect(html).toContain('setup-env-list');
    expect(html).toContain('How this run was rendered.');
    expect(html).toContain('react-native-web composes the app onto DOM nodes');
  });

  it('opens the panel for a reused browse server and says the pre-scan state was UNOBSERVABLE', () => {
    const html = renderHtmlReport(
      baseInput({
        environment: { target: 'web', devServer: 'reused-browse', tailwindShim: false },
      }),
    );
    // Never-false-green: an absent depScanFailure on this path must not read as
    // "the scan was clean".
    expect(html).toContain('not observable from this run');
  });

  it('surfaces the dep-scan abort with the WORD "aborted", not hue alone', () => {
    const html = renderHtmlReport(
      baseInput({
        environment: {
          target: 'web',
          devServer: 'cold',
          tailwindShim: false,
          depScanFailure: 'Could not resolve "aws-sdk" (from src/y.ts:1:0)',
        },
      }),
    );
    expect(html).toContain('setup-env--warn');
    expect(html).toContain('aborted — Could not resolve &quot;aws-sdk&quot;');
    expect(html).toContain('demoting dep-scan taint');
  });

  it('renders the app-manifest mirrored/recorded line verbatim, without gloss', () => {
    const line =
      'app manifest present (v1, @validity.ai/verify-plugin-vite@0.1.0); mirrored: envDir (3 client vars); recorded: plugins (2)';
    const html = renderHtmlReport(
      baseInput({
        environment: { target: 'web', devServer: 'cold', tailwindShim: false, appManifest: line },
      }),
    );
    expect(html).toContain(line);
  });

  it('renders the environment block alongside an existing setup panel, without displacing it', () => {
    const html = renderHtmlReport(
      baseInput({
        setup: baseSetup({ bootstrapped: true }),
        environment: { target: 'next-web', devServer: 'cold', tailwindShim: true },
      }),
    );
    expect(html).toContain('Validity auto-configured this project for you.');
    expect(html).toContain('setup-env-list');
    expect(html).toContain('v4 scan shim emitted');
  });

  it('escapes hostile environment strings', () => {
    const html = renderHtmlReport(
      baseInput({
        environment: {
          target: 'web',
          devServer: 'cold',
          tailwindShim: false,
          appManifest: '<script>x</script>',
        },
      }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

/** A fully-populated divergence, so every branch of the section has input. */
function baseDivergence(
  overrides: Partial<NonNullable<ReportInput['replayDivergence']>> = {},
): NonNullable<ReportInput['replayDivergence']> {
  return {
    observedAt: '2026-08-06T09:00:00.000Z',
    recording: 'recording.ad',
    step: 4,
    kind: 'selector-miss',
    action: 'press',
    causeMessage: 'no element matched text "Continue"',
    causeCode: 'ELEMENT_NOT_FOUND',
    causeHint: 'the onboarding screen may have been skipped',
    suggestions: [
      { selector: 'id=cta-primary', basis: 'id', role: 'button', label: 'Get started' },
      { selector: 'text=Get started', basis: 'label' },
    ],
    suggestionCount: 5,
    resumeCommand: 'agent-device replay recording.ad --from 4 --plan-digest sha256-deadbeef',
    repairHint: 'record-and-heal',
    ...overrides,
  };
}

describe('journey drift section (replay-divergence.json)', () => {
  it('renders nothing when there is no divergence — absence adds zero bytes', () => {
    // Assert on the MARKUP, not the class name: the stylesheet always ships
    // every rule, so `report-drift` appears in <style> regardless.
    expect(renderHtmlReport(baseInput())).not.toContain(
      '<section class="report-section report-drift"',
    );
    expect(renderMarkdownReport(baseInput())).not.toContain('Journey drift');
  });

  it('leads with the shape-doubled fact and frames it as post-signing, non-gating', () => {
    const html = renderHtmlReport(baseInput({ replayDivergence: baseDivergence() }));
    expect(html).toContain('Journey drift');
    // Glyph AND word — hue is never the sole carrier.
    expect(html).toContain('▲');
    expect(html).toContain('Diverged — diverged at step 4 (press) — selector-miss');
    expect(html).toContain('report-flag--amber');
    // The framing is the feature: advisory, post-attestation, gate-inert.
    expect(html).toContain('after</strong> this run was signed');
    expect(html).toContain('changes no verdict');
  });

  it('prints the ranked suggestions in upstream order and the resume command VERBATIM', () => {
    const html = renderHtmlReport(baseInput({ replayDivergence: baseDivergence() }));
    expect(html).toContain('Ranked selector suggestions (top 2 of 5)');
    expect(html.indexOf('id=cta-primary')).toBeLessThan(html.indexOf('text=Get started'));
    expect(html).toContain(
      'agent-device replay recording.ad --from 4 --plan-digest sha256-deadbeef',
    );
  });

  it('surfaces a REFUSED resume as a reason instead of a command nobody can run', () => {
    const html = renderHtmlReport(
      baseInput({
        replayDivergence: baseDivergence({
          resumeCommand: undefined,
          resumeRefusedReason: 'the skipped range touches runtime control flow',
        }),
      }),
    );
    expect(html).not.toContain('--plan-digest');
    expect(html).toContain('Resume refused by agent-device');
    expect(html).toContain('the skipped range touches runtime control flow');
  });

  it('states that Validity never heals the recording for you', () => {
    const html = renderHtmlReport(baseInput({ replayDivergence: baseDivergence() }));
    expect(html).toContain('Validity never heals a recording for you');
  });

  it('says the screen could not be read when there are no suggestions', () => {
    const html = renderHtmlReport(
      baseInput({
        replayDivergence: baseDivergence({
          suggestions: [],
          suggestionCount: undefined,
          screenUnavailableReason: 'the app was not foregrounded',
        }),
      }),
    );
    expect(html).toContain('No selector suggestions — the app was not foregrounded');
  });

  it('never renders a verdict pill for drift (it is not a criterion result)', () => {
    const html = renderHtmlReport(baseInput({ replayDivergence: baseDivergence() }));
    const start = html.indexOf('report-drift"');
    const section = html.slice(start, html.indexOf('</section>', start));
    expect(section).not.toContain('report-pill-pass');
    expect(section).not.toContain('report-pill-fail');
  });

  it('mirrors into markdown with the same advisory framing and a copyable resume fence', () => {
    const md = renderMarkdownReport(baseInput({ replayDivergence: baseDivergence() }));
    expect(md).toContain('## Journey drift _(advisory)_');
    expect(md).toContain('▲ **Diverged**');
    expect(md).toContain('**after** this run was signed');
    expect(md).toContain('agent-device replay recording.ad --from 4 --plan-digest sha256-deadbeef');
  });

  it('is deterministic — the same input renders the same bytes', () => {
    const input = baseInput({ replayDivergence: baseDivergence() });
    expect(renderHtmlReport(input)).toBe(renderHtmlReport(baseInput({ ...input })));
  });

  it('escapes hostile divergence text', () => {
    const html = renderHtmlReport(
      baseInput({ replayDivergence: baseDivergence({ causeMessage: '<script>x</script>' }) }),
    );
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('device evidence section (device-evidence.json / replay-device-evidence.json)', () => {
  const groups: NonNullable<ReportInput['deviceEvidence']> = [
    {
      file: 'device-evidence.json',
      phase: 'verify',
      records: [
        {
          kind: 'perf-metrics',
          status: 'captured',
          command: 'agent-device perf metrics --json',
          capturedAt: '2026-08-06T08:00:00.000Z',
          platform: 'ios',
          device: 'iPhone 17 Pro',
          scoring: 'advisory-evidence-only',
        },
        {
          kind: 'network-dump',
          status: 'unavailable',
          errorCode: 'SESSION_NOT_FOUND',
          unavailableReason: 'no attached session',
        },
      ],
    },
    {
      file: 'replay-device-evidence.json',
      phase: 'replay',
      records: [{ kind: 'perf-frames', status: 'captured', truncated: true, note: '90000 bytes' }],
    },
  ];

  it('renders nothing when there is no device evidence — absence adds zero bytes', () => {
    // Markup, not class name — the stylesheet always ships every rule.
    expect(renderHtmlReport(baseInput())).not.toContain(
      '<section class="report-section report-devevidence"',
    );
    expect(renderMarkdownReport(baseInput())).not.toContain('Device evidence');
  });

  it('states, in the page itself, that nothing here is scored', () => {
    const html = renderHtmlReport(baseInput({ deviceEvidence: groups }));
    expect(html).toContain('Device evidence');
    expect(html).toContain('<strong>Not scored.</strong>');
    expect(html).toContain('No threshold anywhere in Validity reads these numbers');
    // "not captured" is explicitly disclaimed as not-a-failure.
    expect(html).toContain('is not a failure');
  });

  it('renders one compact evidenceSummaryLine-style row per record, grouped by source file', () => {
    const html = renderHtmlReport(baseInput({ deviceEvidence: groups }));
    expect(html).toContain('captured (agent-device perf metrics --json)');
    expect(html).toContain('not captured [SESSION_NOT_FOUND] — no attached session');
    expect(html).toContain('captured, payload withheld (90000 bytes)');
    expect(html).toContain('device-evidence.json');
    expect(html).toContain('replay-device-evidence.json');
    expect(html).toContain('captured during this run');
    expect(html).toContain('captured after a replay');
  });

  it('tallies without a verdict, and borrows NO verdict color or glyph', () => {
    const html = renderHtmlReport(baseInput({ deviceEvidence: groups }));
    expect(html).toContain('3 records · 2 captured, 1 not captured');
    const start = html.indexOf('report-devevidence"');
    const section = html.slice(start, html.indexOf('</section>', start));
    for (const forbidden of [
      'report-pill-pass',
      'report-pill-fail',
      'report-flag--green',
      '●',
      '✕',
    ]) {
      expect(section).not.toContain(forbidden);
    }
  });

  it('preserves the file order (verify before replay) rather than sorting', () => {
    const html = renderHtmlReport(baseInput({ deviceEvidence: groups }));
    expect(html.indexOf('device-evidence.json')).toBeLessThan(
      html.indexOf('replay-device-evidence.json'),
    );
  });

  it('mirrors into markdown with the same neutral framing', () => {
    const md = renderMarkdownReport(baseInput({ deviceEvidence: groups }));
    expect(md).toContain('## Device evidence _(advisory)_');
    expect(md).toContain('**Not scored**');
    // The command lives in a code span so markdown escaping cannot mangle it.
    expect(md).toContain('- `perf-metrics` — captured — `agent-device perf metrics --json`');
    expect(md).toContain(
      '- `network-dump` — not captured `SESSION_NOT_FOUND` — no attached session',
    );
    expect(md).toContain('3 records · 2 captured, 1 not captured');
  });

  it('is deterministic — the same input renders the same bytes', () => {
    const input = baseInput({ deviceEvidence: groups });
    expect(renderHtmlReport(input)).toBe(renderHtmlReport(baseInput({ ...input })));
  });
});
