/**
 * Thin adapter over `@validity.ai/verify-report` plus the small pure-logic/formatting
 * helpers the cli renderers share.
 *
 * `trends-render.ts` and `compare-render.ts` compose `@validity.ai/verify-report`
 * directly (`pageShell`, `topbar`, `sparkline`, `verdictStepLine`, …) — this
 * module no longer duplicates chrome or a chart kit for anyone. What remains
 * here has NO visual literal (no color, no font stack) of its own:
 *   - verdict/status vocabulary + the `vp-pill` class-name emitter (the
 *     pill recipe and the COLORS behind `vp-pill--*` live in
 *     `@validity.ai/verify-report` / {@link VP_BODY_CSS});
 *   - deterministic numeric/date formatting.
 *
 * PURE throughout: no fs, no process, no `Date.now()`/randomness/locale.
 */

import { BREAKPOINT_MOBILE, FONT_MONO, RECIPES, esc } from '@validity.ai/verify-report';

export { esc };

// ---------------------------------------------------------------------------
// Verdict / status vocabulary (display-only; can't-false-green)
// ---------------------------------------------------------------------------

/** The three known criterion statuses. Anything else renders as neutral. */
const KNOWN_STATUSES = new Set(['pass', 'fail', 'unverifiable']);

export type StatusClass = 'pass' | 'fail' | 'unverifiable' | 'unknown';

/**
 * Map an arbitrary status string to a display class. Only the exact string
 * `'pass'` earns the pass class — the display analog of the scorecard's
 * `every === 'pass'` rollup rule. A future/unknown status (e.g. a hand-edited
 * history row) falls through to `'unknown'` and can never render green.
 */
export function statusClassOf(status: string): StatusClass {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  if (status === 'unverifiable') return 'unverifiable';
  return 'unknown';
}

export function isKnownStatus(status: string): status is 'pass' | 'fail' | 'unverifiable' {
  return KNOWN_STATUSES.has(status);
}

/**
 * Glyph for a status. Shape-coded so the chart/table is legible without color:
 * ● pass, ✕ fail, ◌ unverifiable, ? unknown.
 */
export function statusGlyph(status: string): string {
  switch (statusClassOf(status)) {
    case 'pass':
      return '●';
    case 'fail':
      return '✕';
    case 'unverifiable':
      return '◌';
    default:
      return '?';
  }
}

export type RunVerdict = 'pass' | 'fail' | 'partial' | 'unknown';

/** Verdict pill class — only exact `'pass'` earns pass; partial/unknown share amber. */
export function verdictClassOf(verdict: string): 'pass' | 'fail' | 'partial' | 'unknown' {
  if (verdict === 'pass') return 'pass';
  if (verdict === 'fail') return 'fail';
  if (verdict === 'partial') return 'partial';
  return 'unknown';
}

/**
 * A small status/verdict pill (`<span>`), color + label, never color-only.
 * Kept at this exact class-name shape (`vp-pill`/`vp-pill--<klass>`) because
 * `dashboard/status-render.ts`, `spec-detail-render.ts`, `reports-render.ts`,
 * and `specs-render.ts` all call it directly. The COLOR behind each class
 * lives in {@link VP_BODY_CSS} (trends/compare's stylesheet) and, for the
 * dashboard's own pages, in the dashboard's own PAGE_CSS — this function
 * itself carries no literal.
 */
export function pill(label: string, klass: string): string {
  return `<span class="vp-pill vp-pill--${esc(klass)}">${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Numeric helpers (deterministic)
// ---------------------------------------------------------------------------

/** Round to 2 decimals for stable SVG coordinates (no float noise in output). */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Signed integer-ish millisecond formatting: `+12 ms`, `-3 ms`, `0 ms`. */
export function fmtSignedMs(delta: number): string {
  const rounded = Math.round(delta);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} ms`;
}

/** Signed percentage: `+8%`, `-4%`. `null` when the base is 0 (undefined %). */
export function fmtSignedPct(from: number, to: number): string | null {
  if (from === 0) return null;
  const pct = Math.round(((to - from) / from) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

// ---------------------------------------------------------------------------
// Deterministic date formatting (UTC, hand-rolled month names — no locale)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Jan 5` (UTC). Falls back to the raw string when unparseable. */
export function fmtUtcDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `Jan 5, 2026` (UTC). Falls back to the raw string when unparseable. */
export function fmtUtcDayYear(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** `Jan 5, 14:32 UTC` — tooltip/table timestamp. Raw string when unparseable. */
export function fmtUtcMinute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

// ---------------------------------------------------------------------------
// vp-* component CSS (trends.html / compare.html body vocabulary) — the
// `.vp-*` class NAMES stay exactly as before (dashboard/page.ts splices this
// exact CSS, under this exact export name, around the reused trends body on
// the served `/trends` sub-page); only the token REFERENCES changed, from an
// ad-hoc palette to `@validity.ai/verify-report`'s token names, so trends.html /
// compare.html resolve correctly against `@validity.ai/verify-report`'s `pageShell`
// (which defines `--grn`/`--red`/`--amb`/`--dim`/`--panel`/… via `tokenCss()`).
// ---------------------------------------------------------------------------

export const VP_BODY_CSS = `
  code, pre { font-family: ${FONT_MONO}; font-size: 13px; }
  .vp-header { padding-bottom: 16px; border-bottom: 1px solid var(--bd); margin-bottom: 24px; }
  .vp-title { font-size: 20px; font-weight: 700; margin: 0; }
  .vp-sub { color: var(--dim); font-size: 13px; margin-top: 4px; }
  .vp-score { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .vp-score-formula { color: var(--dim); font-size: 12px; }

  .vp-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 4px; }
  .vp-section-heading { font-size: 16px; font-weight: 600; margin: 24px 0 8px; }

  .vp-spec { border: 1px solid var(--bd); border-radius: 10px; background: var(--panel); padding: 16px 18px; margin-bottom: 20px; }
  .vp-spec-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  .vp-spec-title { font-weight: 600; font-size: 15px; }
  .vp-spec-id { color: var(--dim); font-size: 12px; font-family: ${FONT_MONO}; }
  .vp-spec-standing { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
  .vp-note { color: var(--dim); font-size: 12px; margin: 4px 0; }

  .vp-chart { margin: 14px 0 4px; }
  .vp-chart-caption { font-size: 11px; color: var(--dim); margin-bottom: 4px; }
  .vp-last-label { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  /* @validity.ai/verify-report's sparkline() emits an SVG sized width/height: 100%,
     which needs a sized ancestor to resolve against — this is that ancestor. */
  .vp-spark { height: 44px; }
  .vp-perf-key { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--bd); }

  .vp-pill { ${RECIPES.pill}; white-space: nowrap; }
  .vp-pill--pass { background: var(--grnbg); color: var(--grn); }
  .vp-pill--fail { background: var(--redbg); color: var(--red); }
  .vp-pill--partial, .vp-pill--amber { background: var(--ambbg); color: var(--amb); }
  .vp-pill--unknown, .vp-pill--neutral { background: var(--panel2); color: var(--dim2); }

  table.vp-table { border-collapse: collapse; font-size: 12px; margin: 8px 0; width: 100%; }
  /* Wide run-history tables scroll inside themselves on small screens — the
     page body must never scroll horizontally. */
  @media (max-width: ${BREAKPOINT_MOBILE}px) {
    table.vp-table { display: block; overflow-x: auto; white-space: nowrap; }
  }
  table.vp-table th, table.vp-table td { border: 1px solid var(--bd); padding: 3px 6px; text-align: center; }
  table.vp-table th[scope="row"] { text-align: left; font-weight: 500; font-family: ${FONT_MONO}; }
  table.vp-table thead th { color: var(--dim); font-weight: 500; }

  .vp-cell { font-weight: 700; }
  .vp-cell--pass { color: var(--grn); }
  .vp-cell--fail { color: var(--red); }
  .vp-cell--unverifiable { color: var(--dim2); }
  .vp-cell--unknown { color: var(--dim2); }

  .vp-banner { border-radius: 8px; padding: 10px 14px; margin: 0 0 16px; font-size: 13px; }
  .vp-banner--warn { background: var(--redbg); color: var(--red); }
  .vp-banner--amber { background: var(--ambbg); color: var(--amb); }

  .vp-grid { display: grid; grid-template-columns: 160px 1fr 1fr; gap: 10px; align-items: start; }
  .vp-grid-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .vp-grid-key { font-family: ${FONT_MONO}; font-size: 12px; word-break: break-all; }
  .vp-shot { max-width: 100%; border: 1px solid var(--bd); border-radius: 6px; display: block; }
  .vp-shot-missing {
    border: 1px dashed var(--bd2); border-radius: 6px; padding: 16px;
    text-align: center; color: var(--dim); font-size: 12px;
  }

  .vp-cmp-sides { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 12px; }
  .vp-cmp-side { min-width: 220px; }

  .vp-signal { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 3px 0; border-top: 1px solid var(--bd); flex-wrap: wrap; }
  .vp-signal-at { color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vp-signal-detail { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .vp-signal--resolved { opacity: 0.7; }
  .vp-signal--suppressed { opacity: 0.7; font-style: italic; }

  .vp-delta--regressed { color: var(--red); }
  .vp-delta--improved { color: var(--grn); }
  .vp-delta--new { color: var(--blu); }
  .vp-delta--unchanged, .vp-delta--unknown { color: var(--dim); }

  .vp-empty { padding: 32px; text-align: center; border: 1px dashed var(--bd2); border-radius: 10px; color: var(--dim); }
  .vp-footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--bd); color: var(--dim); font-size: 12px; }
`;
