import { describe, expect, it } from 'vitest';
import {
  BREAKPOINT_MOBILE,
  CHART_CSS,
  COLOR_TOKENS,
  FONT_FACE_CSS,
  RECIPES,
  WORDMARK_DARK_DATA_URI,
  WORDMARK_LIGHT_DATA_URI,
  actionCard,
  barRow,
  chromeCss,
  componentCss,
  crumbs,
  esc,
  historyStrip,
  jumpTiles,
  kvRows,
  legendRows,
  lineChart,
  metaStrip,
  pageShell,
  pill,
  ratioBar,
  signalCard,
  sparkline,
  statGrid,
  statusPillKind,
  statusTone,
  steps,
  tokenCss,
  topbar,
  verdictHero,
  verdictStepLine,
} from './index.js';

describe('tokens', () => {
  it('every color token carries a light/dark pair', () => {
    for (const [name, pair] of Object.entries(COLOR_TOKENS)) {
      expect(pair.dark, `${name}.dark`).toBeTruthy();
      expect(pair.light, `${name}.light`).toBeTruthy();
    }
  });

  it('emits dark base, OS light layer, and explicit-choice layer', () => {
    const css = tokenCss();
    expect(css).toContain(':root{');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain(':root:not([data-theme])');
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain('--grn:#34d399;');
    expect(css).toContain('--grn:#0f9d63;');
  });

  it('is deterministic', () => {
    expect(tokenCss()).toBe(tokenCss());
  });
});

describe('never-false-green', () => {
  it('only the exact status pass maps to the pass tone', () => {
    expect(statusTone('pass')).toBe('pass');
    for (const s of [
      'Pass',
      'PASS',
      'passed',
      'partial',
      'unknown',
      'stale',
      'unverifiable',
      '',
      'green',
    ]) {
      expect(statusTone(s), s).not.toBe('pass');
    }
  });

  it('pill kind follows the same rule', () => {
    expect(statusPillKind('pass')).toBe('pass');
    expect(statusPillKind('partial')).toBe('warn');
    expect(statusPillKind('nonsense')).toBe('neutral');
  });
});

describe('charts', () => {
  const vals = [86, 88, 87, 91, 90, 93, 92, 95, 94, 96, 94, 97];

  it('sparkline renders deterministic token-colored SVG with an accessible name', () => {
    const a = sparkline(vals, { ariaLabel: 'score trend' });
    expect(a).toBe(sparkline(vals, { ariaLabel: 'score trend' }));
    expect(a).toContain('aria-label="score trend"');
    expect(a).toContain('var(--grn)');
    expect(a).toContain('viewBox="0 0 120 26"');
  });

  it('lineChart renders grid, gradient wash, end dot, and edge labels', () => {
    const svg = lineChart(vals, {
      ariaLabel: 'Validity score over time',
      yDomain: [80, 100],
      xEdgeLabels: ['Jul 09', 'Aug 07'],
    });
    expect(svg).toBe(
      lineChart(vals, {
        ariaLabel: 'Validity score over time',
        yDomain: [80, 100],
        xEdgeLabels: ['Jul 09', 'Aug 07'],
      }),
    );
    expect(svg).toContain('y-grid');
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('<circle');
    expect(svg).toContain('Jul 09');
    expect(svg).toContain('Aug 07');
    expect(svg).toContain('aria-label="Validity score over time"');
  });

  it('charts carry no absolute colors — only tokens', () => {
    const svg = lineChart(vals, { ariaLabel: 'x' });
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('sparkline carries a <title> when titleText is given', () => {
    const svg = sparkline(vals, { ariaLabel: 'score trend', titleText: 'score trend, 0-100' });
    expect(svg).toContain('<title>score trend, 0-100</title>');
  });

  it('sparkline breaks the line at nulls into separate segments (a gap, never a plunge to zero)', () => {
    const svg = sparkline([1, 2, null, 3, 4], { ariaLabel: 'x' });
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
  });

  it('sparkline renders an isolated point (surrounded by gaps) as a visible dot, not an invisible 1-point line', () => {
    const svg = sparkline([1, null, 3], { ariaLabel: 'x' });
    // Dots are HTML overlays (not SVG <circle>s) so a fluid, non-uniformly
    // stretched sparkline never squashes the marker into an ellipse.
    expect((svg.match(/class="vc-spark-dot"/g) ?? []).length).toBe(2);
    // No rendered stroke connects the two isolated points to each other.
    expect(svg).not.toMatch(/d="M[^"]*L/);
  });

  it('sparkline renders a valid, empty labeled chart when every value is null', () => {
    const svg = sparkline([null, null], { ariaLabel: 'x' });
    expect(svg).toContain('aria-label="x"');
    expect(svg).not.toContain('vc-spark-dot');
  });

  it('sparkline is deterministic for the same input', () => {
    const a = sparkline([1, 5, null, 3], { ariaLabel: 'x', titleText: 't' });
    const b = sparkline([1, 5, null, 3], { ariaLabel: 'x', titleText: 't' });
    expect(a).toBe(b);
  });

  it('sparkline respects a fixed yDomain', () => {
    const svg = sparkline([50, 50], { ariaLabel: 'x', yDomain: [0, 100] });
    expect(svg).toContain('viewBox="0 0 120 26"');
  });

  describe('verdictStepLine', () => {
    it('is an accessible <svg> with shape-coded, token-colored markers', () => {
      const svg = verdictStepLine(
        [
          { verdict: 'pass', title: 'r1', signedOff: true },
          { verdict: 'fail', title: 'r2' },
          { verdict: 'partial', title: 'r3' },
        ],
        'verdicts',
      );
      expect(svg).toContain('role="img"');
      expect(svg).toContain('aria-label="verdicts"');
      expect(svg).toContain('<title>verdicts</title>');
      // markers present for all three shapes, doubled by color-tone classes
      // (CHART_CSS maps vc-mark--pass/fail/mid to token colors below)
      expect(svg).toContain('●');
      expect(svg).toContain('✕');
      expect(svg).toContain('◆');
      expect(svg).toContain('vc-mark--pass');
      expect(svg).toContain('vc-mark--fail');
      expect(svg).toContain('vc-mark--mid');
      // per-point hover title on the HTML marker overlay
      expect(svg).toContain('title="r1"');
      // signed-off ring
      expect(svg).toContain('vc-mark--ring');
    });

    it('CHART_CSS colors the shape-glyph markers from tokens only', () => {
      expect(CHART_CSS).toContain('.vc-mark--pass { color: var(--grn); }');
      expect(CHART_CSS).toContain('.vc-mark--fail { color: var(--red); }');
      expect(CHART_CSS).toContain('.vc-mark--mid { color: var(--amb); }');
      expect(CHART_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    it('draws a dashed version rule when a versionLabel is set', () => {
      const svg = verdictStepLine(
        [
          { verdict: 'pass', title: 'r1' },
          { verdict: 'pass', title: 'r2', versionLabel: 'v2' },
        ],
        'v',
      );
      expect(svg).toContain('>v2<');
      expect(svg).toContain('stroke-dasharray');
    });

    it('renders a valid empty chart for no points', () => {
      const svg = verdictStepLine([], 'empty');
      expect(svg).toContain('role="img"');
      expect(svg).not.toContain('<path');
    });

    it('escapes the aria-label and per-point hover title', () => {
      const svg = verdictStepLine([{ verdict: 'pass', title: '<b>' }], '<a>');
      expect(svg).toContain('aria-label="&lt;a&gt;"');
      expect(svg).toContain('title="&lt;b&gt;"');
      expect(svg).not.toContain('<b>');
    });

    it('is deterministic for the same input', () => {
      const points = [
        { verdict: 'pass' as const, title: 'r1' },
        { verdict: 'fail' as const, title: 'r2' },
      ];
      expect(verdictStepLine(points, 'v')).toBe(verdictStepLine(points, 'v'));
    });
  });
});

describe('components', () => {
  it('escapes user strings', () => {
    expect(pill('<script>', 'neutral')).toContain('&lt;script&gt;');
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('history strip maps p/f/u and nothing else to colors', () => {
    const strip = historyStrip('pfux');
    expect(strip).toContain('v-hist--pass');
    expect(strip).toContain('v-hist--fail');
    expect(strip.match(/v-hist--unv/g)).toHaveLength(2);
  });

  it('crumbs render mono, separated, with a dim "here" and no dead links', () => {
    const html = crumbs([{ label: 'Validity report' }, { label: 'this run', here: true }]);
    expect(html).toContain('v-crumbs');
    expect(html).toContain('<span class="v-crumb-sep">/</span>');
    expect(html).toContain('<span class="v-crumb-here">this run</span>');
    expect(html).not.toContain('<a ');
    expect(crumbs([{ label: 'spec', href: '#spec' }])).toContain('<a href="#spec">spec</a>');
  });

  it('RECIPES are the single copy of each recipe — componentCss aliases them', () => {
    const css = componentCss();
    for (const [name, decls] of Object.entries(RECIPES)) {
      // Every rule that carries a recipe's look is BUILT from the recipe —
      // never a hand-copied twin (checked by containment; the shared sheet
      // interpolates the constants).
      expect(css, name).toContain(decls);
    }
    // Recipes are token-driven — no literal colors may leak in.
    expect(Object.values(RECIPES).join(';')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('stat grid renders label/value cells', () => {
    const html = statGrid([
      { label: 'Validity score', value: '94.2', suffix: 'avg', tone: 'pass' },
    ]);
    expect(html).toContain('v-statgrid');
    expect(html).toContain('Validity score');
    expect(html).toContain('v-tone--pass');
  });

  it('ratioBar drops empty lanes so a zero-member tier leaves no hairline', () => {
    const html = ratioBar([
      { width: '60%', color: 'var(--grn)' },
      { width: '0%', color: 'var(--red)' },
      { width: '40%', color: 'var(--dim2)' },
    ]);
    expect(html).toContain('width:60%');
    expect(html).toContain('width:40%');
    expect(html).not.toContain('var(--red)');
    expect(html).toContain('class="v-ratio"');
    expect(ratioBar([{ width: '1%', color: 'var(--grn)' }], { runs: true })).toContain(
      'v-ratio--runs',
    );
  });

  it('legendRows pair a swatch with a readable label, count and percentage', () => {
    const html = legendRows([
      { label: 'Proven · hard', color: 'var(--grn)', count: '114', pct: '46%' },
    ]);
    expect(html).toContain('v-legend-swatch');
    expect(html).toContain('Proven · hard');
    expect(html).toContain('114');
    expect(html).toContain('46%');
  });

  it('barRow links only when a target exists', () => {
    const seg = [{ width: '100%', color: 'var(--grn)' }];
    expect(
      barRow({ id: 'spec-96ec', segments: seg, count: '24 runs', href: '/spec/spec-96ec' }),
    ).toContain('<a class="v-barrow" href="/spec/spec-96ec"');
    const plain = barRow({ id: 'spec-96ec', segments: seg, count: '24 runs' });
    expect(plain).toContain('<div class="v-barrow"');
    expect(plain).not.toContain('<a ');
  });

  it('signalCard is never pass-toned and escapes its strings', () => {
    const html = signalCard({
      title: '<b>coverage gap</b>',
      body: 'no run below 768px',
      tone: 'warn',
      age: '3d',
    });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('var(--amb)');
    expect(html).not.toContain('var(--grn)');
    expect(html).toContain('3d');
  });

  it('steps mark the rail state and close the last connector', () => {
    const html = steps([
      { title: 'Clean pass', body: 'counted', meta: '4m ago', state: 'done' },
      { title: 'One more', body: 'pending', meta: 'pending', state: 'next' },
      { title: 'Certified', body: 'holds', meta: '—', state: 'future' },
    ]);
    expect(html).toContain('v-step--done');
    expect(html).toContain('v-step--next');
    expect(html).toContain('v-step--future v-step--last');
    expect(html.match(/v-step-ring/g)).toHaveLength(3);
  });

  it('kvRows render uppercase keys beside their values', () => {
    const html = kvRows([{ k: 'version', v: 'v1 · frozen' }]);
    expect(html).toContain('v-kv-k');
    expect(html).toContain('v1 · frozen');
  });
});

describe('verdictHero', () => {
  const base = {
    glyph: '●',
    word: 'Healthy',
    label: 'Project health',
    tone: 'pass' as const,
    reason: 'every tracked spec is passing.',
    score: { label: 'Validity score', value: '92', suffix: '/ 100', tone: 'pass' as const },
  };

  it('doubles the verdict as glyph + word, with the glyph hidden from readers', () => {
    const html = verdictHero(base);
    expect(html).toContain('<div class="v-hero-word v-tone--pass">Healthy</div>');
    expect(html).toContain('aria-hidden="true">●</span>');
  });

  it('tints the verdict cell green ONLY for the pass tone', () => {
    expect(verdictHero(base)).toContain('v-hero-verdict--pass');
    for (const tone of ['fail', 'warn'] as const) {
      const html = verdictHero({ ...base, tone, word: 'Failing' });
      expect(html, tone).toContain(`v-hero-verdict--${tone}`);
      expect(html, tone).not.toContain('v-hero-verdict--pass');
    }
    // Neutral earns no wash at all rather than borrowing another tone's.
    expect(verdictHero({ ...base, tone: 'neutral' })).not.toContain('v-hero-verdict--');
  });

  it('renders the trend cell only when a sparkline is supplied', () => {
    expect(verdictHero(base)).not.toContain('v-hero-spark');
    const html = verdictHero({
      ...base,
      trend: { label: 'Score trend', spark: '<svg/>', caption: '12 observations' },
    });
    expect(html).toContain('v-hero-spark');
    expect(html).toContain('12 observations');
  });

  it('escapes the reason and the verdict word, and passes `sub` through as HTML', () => {
    const html = verdictHero({
      ...base,
      word: '<b>x</b>',
      reason: 'a & b <script>',
      sub: '<code>abc1234</code>',
    });
    expect(html).toContain('a &amp; b &lt;script&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('<code>abc1234</code>');
  });

  it('is deterministic', () => {
    expect(verdictHero(base)).toBe(verdictHero(base));
  });
});

describe('jumpTiles', () => {
  const tile = { label: 'Specs', value: '6', suffix: 'of 8 tracked' };

  it('links the whole tile when it has a destination, and stays a div when it does not', () => {
    expect(jumpTiles([{ ...tile, href: '/specs' }])).toContain('<a class="v-tile" href="/specs">');
    const inert = jumpTiles([tile]);
    expect(inert).toContain('<div class="v-tile">');
    // No affordance without a destination.
    expect(inert).not.toContain('v-tile-go');
  });

  it('keeps the numeral neutral unless a tone is asked for (a count is not a verdict)', () => {
    expect(jumpTiles([tile])).toContain('<span class="v-tile-num">6</span>');
    expect(jumpTiles([{ ...tile, tone: 'warn' }])).toContain('v-tile-num v-tone--warn');
    expect(jumpTiles([{ ...tile, tone: 'text' }])).toContain('<span class="v-tile-num">6</span>');
  });

  it('reserves the visual row so tiles in a grid stay aligned', () => {
    expect(jumpTiles([tile])).toContain('<div class="v-tile-visual"></div>');
    expect(jumpTiles([{ ...tile, visual: '<span class="v-ratio"></span>' }])).toContain(
      '<div class="v-tile-visual"><span class="v-ratio"></span></div>',
    );
  });

  it('escapes every plain-text field', () => {
    const html = jumpTiles([
      { label: '<a>', value: '<b>', suffix: '<c>', sub: '<d>', foot: '<e>', href: '"x' },
    ]);
    for (const raw of ['<a>', '<b>', '<c>', '<d>', '<e>']) expect(html).not.toContain(raw);
    expect(html).toContain('href="&quot;x"');
  });
});

describe('actionCard', () => {
  const base = {
    glyph: '✕',
    tone: 'fail' as const,
    kind: 'regression',
    detail: 'AC-2 flipped pass → fail',
    age: '2h',
  };

  it('doubles severity as glyph + tone class, and can never be pass-toned', () => {
    const html = actionCard(base);
    expect(html).toContain('v-action-glyph v-tone--fail');
    expect(html).toContain('v-action--fail');
    expect(html).not.toContain('v-tone--pass');
  });

  it('renders as a list item with caller attrs when asked', () => {
    const html = actionCard({ ...base, tag: 'li', attrs: 'class="x" data-signal-id="s1"' });
    expect(html).toContain('<li class="x" data-signal-id="s1">');
    expect(html).toContain('</li>');
  });

  it('links to its target when given an href, and stays inert otherwise', () => {
    expect(actionCard({ ...base, href: '#sig-1' })).toContain('href="#sig-1"');
    expect(actionCard(base)).toContain('<span class="v-action v-action--fail">');
  });

  it('escapes the detail but passes the pre-built locator through', () => {
    const html = actionCard({ ...base, detail: '<script>', locator: '<code>a/b</code>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('<code>a/b</code>');
  });
});

describe('metaStrip', () => {
  it('renders mono key/value pairs, escaping keys and trusting value HTML', () => {
    const html = metaStrip([{ k: 'HEAD & tip', v: '<code>abc1234</code>' }]);
    expect(html).toContain('<div class="v-strip">');
    expect(html).toContain('<span class="v-strip-k">HEAD &amp; tip</span>');
    expect(html).toContain('<span class="v-strip-v"><code>abc1234</code></span>');
  });

  it('is deterministic and empty-safe', () => {
    expect(metaStrip([])).toBe('<div class="v-strip"></div>');
  });
});

describe('chrome', () => {
  it('topbar carries the ACTUAL wordmark in both theme variants', () => {
    const html = topbar({ brandHref: '/' });
    expect(html).toContain(WORDMARK_DARK_DATA_URI.slice(0, 64));
    expect(html).toContain(WORDMARK_LIGHT_DATA_URI.slice(0, 64));
    expect(html).toContain('alt="Validity"');
  });

  it('theme toggle ships hidden (progressive enhancement)', () => {
    expect(topbar({})).toContain('data-theme-toggle hidden');
  });

  it('the theme toggle keeps an accessible name when mobile hides its label', () => {
    expect(topbar({})).toContain('aria-label="Toggle theme"');
    expect(chromeCss()).toContain('.v-themetoggle [data-theme-label]{display:none}');
  });

  it('narrow chrome WRAPS the nav instead of truncating it', () => {
    const css = chromeCss();
    const mobile = css.slice(css.indexOf(`@media (max-width:${BREAKPOINT_MOBILE}px)`));
    // A scroller with a hidden scrollbar reads as a cut-off bug: every
    // destination stays reachable, on a second topbar row if need be.
    expect(mobile).toContain('flex-wrap:wrap');
    expect(mobile).not.toContain('overflow-x:auto');
    expect(mobile).not.toContain('white-space:nowrap');
    // The row can only grow if the topbar stops being pinned to one line.
    expect(mobile).toContain('height:auto');
  });

  it('brand:false drops the wordmark but keeps navigation', () => {
    const html = topbar({ brand: false, nav: [{ label: 'up', href: '/' }] });
    expect(html).not.toContain(WORDMARK_DARK_DATA_URI.slice(0, 64));
    expect(html).not.toContain('v-brand');
    expect(html).toContain('href="/"');
  });

  it('the live status dot is green only in the confirmed live state', () => {
    expect(topbar({ live: { text: 'watching · 6 specs' } })).toContain('data-live-state="live"');
    const idle = topbar({ live: { text: 'connecting…', id: 'conn', state: 'idle' } });
    expect(idle).toContain('id="conn"');
    expect(idle).toContain('data-live-state="idle"');
    // The idle dot resolves to the neutral token, never the pass green.
    expect(chromeCss()).toContain(
      '.v-live[data-live-state="idle"] .v-live-dot{background:var(--dim2)}',
    );
  });

  it('pageShell is self-contained: fonts + tokens inline, no external requests', () => {
    const doc = pageShell({ title: 'T', body: '<p>x</p>' });
    expect(doc).toContain('@font-face');
    expect(doc).toContain('--bg:#0b0d10;');
    expect(doc).toContain('<meta name="color-scheme" content="dark light"/>');
    // No external fetches: every src/href is inline data or a local anchor.
    const urls = [...doc.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const u of urls) {
      expect(
        u.startsWith('data:') || u.startsWith('#') || u.startsWith('/') || u.startsWith('.'),
        u.slice(0, 60),
      ).toBe(true);
    }
    // License notices contain inert URLs; only resource references make requests.
    expect(doc).not.toMatch(/(?:src|href)=["']https?:\/\//);
    expect(doc).not.toMatch(/url\(\s*["']?https?:\/\//);
  });

  it('pageShell is deterministic', () => {
    const opts = { title: 'T', body: '<p>x</p>' } as const;
    expect(pageShell(opts)).toBe(pageShell(opts));
  });
});

describe('fonts', () => {
  it('inlines IBM Plex Sans and Mono as data URIs', () => {
    expect(FONT_FACE_CSS).toContain('IBM Plex Sans');
    expect(FONT_FACE_CSS).toContain('IBM Plex Mono');
    expect(FONT_FACE_CSS).toContain('data:font/woff2;base64,');
    expect(FONT_FACE_CSS).not.toContain('fonts.googleapis.com');
    expect(FONT_FACE_CSS).toContain('Copyright 2019 IBM Corp.');
    expect(FONT_FACE_CSS).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(FONT_FACE_CSS).toContain('THE FONT SOFTWARE IS PROVIDED');
    expect(pageShell({ title: 'License check', body: '' })).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    );
  });
});
