/**
 * Design tokens — the single source of truth for every Validity surface
 * (report.html, trends/compare pages).
 *
 * Dark is the base theme; light is a full-parity pair. Change a value here
 * and every artifact follows — no surface may re-declare a color, font stack,
 * radius, or breakpoint literal.
 *
 * Emitted CSS answers three cascade layers so one emitter serves both the
 * script-free static artifacts:
 *   1. `:root { dark }` — the base.
 *   2. `@media (prefers-color-scheme: light)` on `:root:not([data-theme])` —
 *      OS-following light, active only while no explicit choice is stamped.
 *   3. `[data-theme="light"]` / `[data-theme="dark"]` — the explicit choice a
 *      theme toggle stamps on <html>; wins over the media query in both
 *      directions. Without JS the attribute never appears and layers 1–2
 *      keep full light/dark parity on their own.
 */

/** One themed color: a dark/light pair. Every color must carry both. */
export interface TokenPair {
  dark: string;
  light: string;
}

/**
 * Color tokens, keyed by CSS custom-property name (sans `--`).
 * Names match the design file byte-for-byte so mock ↔ code review is 1:1.
 */
export const COLOR_TOKENS: Record<string, TokenPair> = {
  // Surfaces & structure
  bg: { dark: '#0b0d10', light: '#f5f5f3' },
  panel: { dark: '#13161a', light: '#ffffff' },
  panel2: { dark: '#181c21', light: '#fafaf8' },
  bd: { dark: '#242931', light: '#e3e3dd' },
  bd2: { dark: '#2e343d', light: '#d4d4cc' },
  // Text
  tx: { dark: '#e8ecf1', light: '#14171b' },
  dim: { dark: '#8d96a2', light: '#616873' },
  dim2: { dark: '#5e6771', light: '#8b929b' },
  // Status — green is earned only by the exact status `pass` (see statusTone)
  grn: { dark: '#34d399', light: '#0f9d63' },
  grnbg: { dark: 'rgba(52,211,153,.12)', light: 'rgba(15,157,99,.10)' },
  grnbd: { dark: 'rgba(52,211,153,.35)', light: 'rgba(15,157,99,.30)' },
  blu: { dark: '#60a5fa', light: '#2563eb' },
  blubg: { dark: 'rgba(96,165,250,.14)', light: 'rgba(37,99,235,.09)' },
  blubd: { dark: 'rgba(96,165,250,.35)', light: 'rgba(37,99,235,.30)' },
  amb: { dark: '#fbbf24', light: '#b45309' },
  ambbg: { dark: 'rgba(251,191,36,.12)', light: 'rgba(180,83,9,.10)' },
  ambbd: { dark: 'rgba(251,191,36,.35)', light: 'rgba(180,83,9,.30)' },
  red: { dark: '#f87171', light: '#dc2626' },
  redbg: { dark: 'rgba(248,113,113,.12)', light: 'rgba(220,38,38,.09)' },
  redbd: { dark: 'rgba(248,113,113,.35)', light: 'rgba(220,38,38,.30)' },
  vio: { dark: '#a78bfa', light: '#7c3aed' },
  viobg: { dark: 'rgba(167,139,250,.14)', light: 'rgba(124,58,237,.10)' },
  // Evidence canvas — the backdrop a captured screenshot is composited on.
  // Identical in both themes on purpose: the captured page has its OWN theme,
  // and tinting a transparent PNG to match ours would misrepresent the
  // evidence. White is the browser canvas the shot was actually taken against.
  shot: { dark: '#ffffff', light: '#ffffff' },
  // Chart scaffolding
  grid: { dark: 'rgba(255,255,255,.06)', light: 'rgba(0,0,0,.07)' },
  shadow: { dark: '0 1px 0 rgba(255,255,255,.02)', light: '0 1px 2px rgba(0,0,0,.04)' },
};

/**
 * Layout tokens: desktop base values with their ≤860px mobile overrides.
 * Consumed as vars so a media query swaps the whole layout in one place.
 */
export const LAYOUT_TOKENS: Record<string, { base: string; mobile: string }> = {
  pad: { base: '32px', mobile: '16px' },
  herocols: { base: 'repeat(4,1fr)', mobile: 'repeat(2,1fr)' },
  chartcols: { base: '1.5fr 1fr', mobile: '1fr' },
  heronum: { base: '46px', mobile: '40px' },
  h1: { base: '26px', mobile: '20px' },
  desk: { base: 'block', mobile: 'none' },
  deskflex: { base: 'flex', mobile: 'none' },
  mob: { base: 'none', mobile: 'block' },
  /** Verdict hero: verdict cell beside the score + sparkline pair. */
  herolay: { base: 'minmax(0,1.25fr) minmax(0,1fr)', mobile: '1fr' },
  /** Verdict word size — the loudest word in the product. */
  verdictnum: { base: '38px', mobile: '30px' },
  /** Jump-off tile row. */
  tilecols: { base: 'repeat(4,minmax(0,1fr))', mobile: 'repeat(2,minmax(0,1fr))' },
  /** Card grids (spec cards, action cards) — 3-up desktop, 1-up narrow. */
  cardcols: { base: 'repeat(3,minmax(0,1fr))', mobile: '1fr' },
};

/** The single responsive breakpoint of the system. */
export const BREAKPOINT_MOBILE = 860;

/** Content shell widths. */
export const SHELL = {
  /** Dashboard / overview / spec pages. */
  page: '1320px',
  /** The run report's reading column. */
  report: '1000px',
} as const;

/** Radii vocabulary (px). Panels are 10, cards 8–9, chips 5–7, marks 2–4. */
export const RADII = {
  panel: 10,
  card: 9,
  block: 8,
  control: 7,
  chip: 6,
  tag: 5,
  badge: 4,
  bar: 3,
  mark: 2,
} as const;

/** Font stacks. IBM Plex is inlined via fonts.ts; stacks still carry fallbacks. */
export const FONT_SANS = `"IBM Plex Sans",system-ui,sans-serif`;
export const FONT_MONO = `"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace`;

/**
 * Type scale (px). Weight/tracking live beside size where they are intrinsic
 * to the style, mirroring the design file's usage.
 */
export const TYPE = {
  /** Page title (--h1 var handles the mobile drop). */
  h1: { size: 'var(--h1)', weight: 700, tracking: '-.02em' },
  /** Hero stat numerals (--heronum var handles the mobile drop). */
  heroNum: { size: 'var(--heronum)', weight: 600, tracking: '-.035em' },
  /** Run report verdict word. */
  verdict: { size: '34px', weight: 600, tracking: '-.03em' },
  /** Mobile-card score numeral. */
  scoreNum: { size: '30px', weight: 600, tracking: '-.03em' },
  /** Lane tally numerals (machine-verified / judged cards). */
  laneNum: { size: '26px', weight: 600, tracking: '-.03em' },
  /** Section headings ("Recent runs", "Verification history"). */
  section: { size: '16px', weight: 600 },
  /** Panel titles ("Validity score over time"). */
  panelTitle: { size: '14px', weight: 600 },
  /** Body prose. */
  body: { size: '13px', weight: 400 },
  /** Secondary prose / assertions. */
  small: { size: '12.5px', weight: 400 },
  /** Mono data cells (run ids, counts). */
  data: { size: '12px', weight: 400 },
  /** Mono metadata rows. */
  meta: { size: '11.5px', weight: 400 },
  /** Chrome captions (nav status, chart captions). */
  caption: { size: '11px', weight: 400 },
  /** Uppercase eyebrow labels. */
  label: { size: '10.5px', weight: 500, tracking: '.09em' },
  /** Pill/badge text. */
  pill: { size: '10.5px', weight: 600, tracking: '.06em' },
} as const;

/**
 * Shape-doubled status glyphs — color is confirmation, never the sole
 * carrier. Ship the glyph or the uppercase word beside every status color.
 */
export const GLYPHS = {
  pass: '●',
  fail: '✕',
  partial: '▲',
  unverifiable: '◌',
  unknown: '?',
} as const;

export type StatusTone = 'pass' | 'fail' | 'warn' | 'neutral';

/**
 * The never-false-green rule, as code: only the exact status `pass` maps to
 * the green tokens. Partial, unknown, stale, advisory, or any future status
 * falls through to amber or neutral — it can never masquerade as success.
 */
export function statusTone(status: string): StatusTone {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  if (status === 'partial' || status === 'advisory' || status === 'stale') return 'warn';
  return 'neutral';
}

/** CSS var triplet (fg / bg / bd) for a tone. Neutral has no wash border. */
export function toneVars(tone: StatusTone): { fg: string; bg: string; bd: string } {
  switch (tone) {
    case 'pass':
      return { fg: 'var(--grn)', bg: 'var(--grnbg)', bd: 'var(--grnbd)' };
    case 'fail':
      return { fg: 'var(--red)', bg: 'var(--redbg)', bd: 'var(--redbd)' };
    case 'warn':
      return { fg: 'var(--amb)', bg: 'var(--ambbg)', bd: 'var(--ambbd)' };
    default:
      return { fg: 'var(--dim2)', bg: 'var(--panel2)', bd: 'var(--bd2)' };
  }
}

function declarations(entries: Array<[string, string]>, indent = '  '): string {
  return entries.map(([k, v]) => `${indent}--${k}:${v};`).join('\n');
}

/**
 * Emit the token custom properties (colors + layout) as CSS.
 *
 * Deterministic: object-literal insertion order, no clocks, no randomness.
 * Safe for the script-free static artifacts (layers 1–2 need no JS) and for
 * the dashboard toggle (layer 3) alike.
 */
export function tokenCss(): string {
  const dark = declarations(Object.entries(COLOR_TOKENS).map(([k, v]) => [k, v.dark]));
  const light = declarations(
    Object.entries(COLOR_TOKENS).map(([k, v]) => [k, v.light]),
    '    ',
  );
  const lightExplicit = declarations(Object.entries(COLOR_TOKENS).map(([k, v]) => [k, v.light]));
  const layoutBase = declarations([
    // Font stacks as custom properties, so page CSS can say var(--sans) /
    // var(--mono) instead of re-declaring a stack.
    ['sans', FONT_SANS],
    ['mono', FONT_MONO],
    ...Object.entries(LAYOUT_TOKENS).map(([k, v]): [string, string] => [k, v.base]),
  ]);
  const layoutMobile = declarations(
    Object.entries(LAYOUT_TOKENS).map(([k, v]) => [k, v.mobile]),
    '    ',
  );
  return [
    `:root{\n${dark}\n${layoutBase}\n}`,
    // OS preference, honored until a toggle stamps an explicit choice.
    `@media (prefers-color-scheme: light){\n  :root:not([data-theme]){\n${light}\n  }\n}`,
    // Explicit choice — wins over the media query in both directions.
    `:root[data-theme="light"]{\n${lightExplicit}\n}`,
    `@media (max-width:${BREAKPOINT_MOBILE}px){\n  :root{\n${layoutMobile}\n  }\n}`,
  ].join('\n');
}
