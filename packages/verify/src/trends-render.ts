/**
 * Pure renderer for `validity trends` — turns a project's spec-run history into
 * a single self-contained `trends.html`: per-spec verdict/coverage timelines,
 * a per-criterion strip, perf sparklines, an optional Validity Score line, and
 * the signal history (including recoveries).
 *
 * PURE: `renderTrendsHtml(input) => string`, byte-identical for a given input
 * (all timestamps come from `input`, never `Date.now()`). No fs, no process —
 * the `trends` command (Track 4's later slot) populates `TrendsInput` from
 * `runs.jsonl` / committed history / `scorecard.json` / `signals.json`.
 *
 * Every section renders ONLY when its data is present; a partial/old-shape
 * history degrades gracefully and never throws. Nothing here reads back into a
 * verdict — it is a display-only sink (see the F2 gate-integrity analysis).
 */

import type { CriterionTier, PerformanceMetrics, Signal } from '@validity.ai/verify-spec';
import {
  pageShell,
  revealServedLinksScript,
  sparkline,
  topbar,
  verdictStepLine,
  type VerdictStepPoint,
} from '@validity.ai/verify-report';

import {
  VP_BODY_CSS,
  esc,
  pill,
  r2,
  statusClassOf,
  statusGlyph,
  verdictClassOf,
  type RunVerdict,
} from './html-lib.js';

// ---------------------------------------------------------------------------
// Input types (Track 4's `trends` command populates these)
// ---------------------------------------------------------------------------

export interface TrendsInput {
  /** basename(projectRoot). */
  projectName: string;
  /** ISO time the report was generated (from the caller, for determinism). */
  generatedAt: string;
  /** Current overall Validity Score (F1). Absent ⇒ the score header self-omits. */
  currentScore?: { score: number; formula: string };
  specs: TrendsSpec[];
}

export interface TrendsSpec {
  specId: string;
  /** Spec title when the spec file still exists on this machine. */
  title?: string;
  /** Current standing from the scorecard. Absent ⇒ committed-history-only spec. */
  current?: {
    verdict: 'pass' | 'fail' | 'partial';
    signedOff?: boolean;
    coveragePercent: number | null;
  };
  /** Ascending by `createdAt`. */
  timeline: TrendsTimelineEntry[];
  /** This spec's signals (open + resolved), ascending by `at`. */
  signals: Signal[];
}

export interface TrendsTimelineEntry {
  runId: string;
  createdAt: string;
  specVersion?: number;
  verdict: RunVerdict;
  signedOff?: boolean;
  /** hard/property coverage ratio [0,1], or null when none. Null breaks the line. */
  coverageRatio: number | null;
  /** Status kept as a raw string — the renderer maps only exact matches. */
  criteria?: Array<{ id: string; tier: CriterionTier; status: string }>;
  /** Validity Score at run time (F1). Absent ⇒ omitted from the score line. */
  score?: number;
  /** Per-render perf metrics, keyed by core's opaque `perfKeyFor` output (D1). */
  perf?: Record<string, PerformanceMetrics>;
  source: 'local' | 'committed';
}

// ---------------------------------------------------------------------------
// Perf helpers
// ---------------------------------------------------------------------------

/** Cross-platform metric subset charted first; web-only metrics follow when present. */
const PERF_METRICS: Array<{ key: keyof PerformanceMetrics; label: string; unit: string }> = [
  { key: 'mountMs', label: 'Initial render (mount)', unit: 'ms' },
  { key: 'updateMs', label: 'Slowest re-render (update)', unit: 'ms' },
  { key: 'readyMs', label: 'Time to ready', unit: 'ms' },
  { key: 'loadMs', label: 'Page load', unit: 'ms' },
  { key: 'firstContentfulPaintMs', label: 'First contentful paint', unit: 'ms' },
];

/** Group a perf timeline key back to its component id — the prefix before `__`. */
function componentOfPerfKey(perfKey: string): string {
  const idx = perfKey.indexOf('__');
  return idx === -1 ? perfKey : perfKey.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderStandingStrip(spec: TrendsSpec): string {
  const parts: string[] = [];
  if (spec.current) {
    parts.push(pill(spec.current.verdict, verdictClassOf(spec.current.verdict)));
    if (spec.current.signedOff) parts.push(pill('signed off', 'pass'));
    if (spec.current.coveragePercent !== null) {
      parts.push(
        `<span class="vp-note">coverage ${Math.round(spec.current.coveragePercent)}%</span>`,
      );
    }
  } else {
    parts.push(pill('history only', 'neutral'));
    parts.push('<span class="vp-note">spec file not present on this machine</span>');
  }
  return `<div class="vp-spec-standing">${parts.join(' ')}</div>`;
}

function renderVerdictTimeline(spec: TrendsSpec): string {
  const entries = spec.timeline;
  if (entries.length === 0) return '';

  const points: VerdictStepPoint[] = entries.map((e, i) => {
    const prev = i > 0 ? entries[i - 1] : undefined;
    const versionChanged =
      e.specVersion !== undefined &&
      prev?.specVersion !== undefined &&
      e.specVersion !== prev.specVersion;
    return {
      verdict: e.verdict,
      signedOff: e.signedOff,
      title: `${e.runId} · ${e.createdAt} · ${e.verdict}${e.signedOff ? ' · signed off' : ''}`,
      versionLabel: versionChanged ? `v${e.specVersion}` : undefined,
    };
  });

  const fails = entries.filter((e) => e.verdict === 'fail').length;
  const latest = entries[entries.length - 1]!.verdict;
  const summary = `Verdict over ${entries.length} run${entries.length === 1 ? '' : 's'}: latest ${latest}, ${fails} fail${fails === 1 ? '' : 's'} in window`;

  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Verdict timeline (● pass · ◆ partial/unknown · ✕ fail · ○ ring = signed off)</div>
      ${verdictStepLine(points, summary)}
    </div>`;
}

function renderCoverageSparkline(spec: TrendsSpec): string {
  const entries = spec.timeline;
  const values = entries.map((e) => (e.coverageRatio === null ? null : r2(e.coverageRatio * 100)));
  if (values.every((v) => v === null)) return '';

  const lastReal = [...values].reverse().find((v) => v !== null);
  const lastLabel = lastReal === undefined ? '' : `<span class="vp-last-label">${lastReal}%</span>`;
  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Hard/property coverage ${lastLabel}</div>
      <div class="vp-spark">${sparkline(values, {
        yDomain: [0, 100],
        height: 44,
        ariaLabel: `Coverage percent over ${entries.length} runs`,
        titleText: `Coverage over ${entries.length} runs, 0–100%`,
      })}</div>
    </div>`;
}

function renderCriterionStrip(spec: TrendsSpec): string {
  const withCriteria = spec.timeline.filter((e) => e.criteria && e.criteria.length > 0);
  if (withCriteria.length === 0) return '';

  // Cap columns to the newest 30 runs for layout sanity; full data is in the SVG.
  const cols = withCriteria.slice(-30);

  // Union of criterion ids across the shown columns, first-seen order (stable).
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const col of cols) {
    for (const c of col.criteria!) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        ids.push(c.id);
      }
    }
  }

  const headCells = cols
    .map((col, i) => `<th scope="col" title="${esc(col.runId)}">${i + 1}</th>`)
    .join('');

  const rows = ids
    .map((id) => {
      const cells = cols
        .map((col) => {
          const c = col.criteria!.find((x) => x.id === id);
          if (!c) return '<td class="vp-cell vp-cell--unknown">·</td>';
          const klass = statusClassOf(c.status);
          return `<td class="vp-cell vp-cell--${klass}" title="${esc(c.status)}">${statusGlyph(c.status)}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(id)}</th>${cells}</tr>`;
    })
    .join('');

  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Per-criterion status (newest ${cols.length} run${cols.length === 1 ? '' : 's'}; ● pass · ✕ fail · ◌ unverifiable · ? unknown)</div>
      <table class="vp-table">
        <thead><tr><th scope="col">criterion</th>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderPerfSparklines(spec: TrendsSpec): string {
  const entries = spec.timeline;
  if (!entries.some((e) => e.perf && Object.keys(e.perf).length > 0)) return '';

  // Union of perf keys, sorted for deterministic order.
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.perf) for (const k of Object.keys(e.perf)) keys.add(k);
  }
  const sortedKeys = [...keys].sort();

  const blocks: string[] = [];
  for (const key of sortedKeys) {
    // Only chart a key that appears in >= 2 entries (a single point isn't a trend).
    const presentCount = entries.filter((e) => e.perf && e.perf[key]).length;
    if (presentCount < 2) continue;

    const metricCharts: string[] = [];
    for (const m of PERF_METRICS) {
      const values = entries.map((e) => {
        const v = e.perf?.[key]?.[m.key];
        return typeof v === 'number' ? v : null;
      });
      if (values.filter((v) => v !== null).length < 2) continue;
      const lastReal = [...values].reverse().find((v) => v !== null);
      const lastLabel =
        lastReal === undefined ? '' : `<span class="vp-last-label">${lastReal} ${m.unit}</span>`;
      metricCharts.push(`
        <div class="vp-chart">
          <div class="vp-chart-caption">${esc(m.label)} ${lastLabel}</div>
          <div class="vp-spark">${sparkline(values, {
            height: 44,
            ariaLabel: `${m.label} for ${key} over ${entries.length} runs`,
            titleText: `${m.label} for ${key}, lower is better`,
          })}</div>
        </div>`);
    }
    if (metricCharts.length === 0) continue;
    blocks.push(`
      <div class="vp-perf-key">
        <div class="vp-section-label">${esc(componentOfPerfKey(key))} · <code>${esc(key)}</code></div>
        ${metricCharts.join('')}
      </div>`);
  }

  if (blocks.length === 0) return '';
  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Performance (advisory — never gates a verdict; lower is better)</div>
      ${blocks.join('')}
    </div>`;
}

function renderScoreLine(spec: TrendsSpec): string {
  const entries = spec.timeline;
  const values = entries.map((e) => (typeof e.score === 'number' ? e.score : null));
  if (values.every((v) => v === null)) return '';
  const lastReal = [...values].reverse().find((v) => v !== null);
  const lastLabel = lastReal === undefined ? '' : `<span class="vp-last-label">${lastReal}</span>`;
  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Validity Score at run time (freshness not applied) ${lastLabel}</div>
      <div class="vp-spark">${sparkline(values, {
        yDomain: [0, 100],
        height: 44,
        ariaLabel: `Validity Score over ${entries.length} runs`,
        titleText: `Validity Score at run time over ${entries.length} runs, 0–100`,
      })}</div>
    </div>`;
}

function renderSignalHistory(spec: TrendsSpec): string {
  if (spec.signals.length === 0) return '';
  const rows = spec.signals
    .map((s) => {
      const klass =
        s.kind === 'recovered'
          ? 'pass'
          : s.severity === 'high'
            ? 'fail'
            : s.severity === 'info'
              ? 'neutral'
              : 'amber';
      const resolved =
        s.status === 'resolved'
          ? ' vp-signal--resolved'
          : s.status === 'suppressed'
            ? ' vp-signal--suppressed'
            : '';
      const state =
        s.status === 'resolved'
          ? ' <span class="vp-note">(resolved)</span>'
          : s.status === 'suppressed'
            ? ' <span class="vp-note">(suppressed)</span>'
            : '';
      const crit = s.criterionId ? ` <code>${esc(s.criterionId)}</code>` : '';
      return `
        <div class="vp-signal${resolved}">
          <span class="vp-signal-at">${esc(s.at)}</span>
          ${pill(s.kind, klass)}
          <span class="vp-signal-detail">${esc(s.detail)}${crit}${state}</span>
        </div>`;
    })
    .join('');
  return `
    <div class="vp-chart">
      <div class="vp-chart-caption">Signal history</div>
      ${rows}
    </div>`;
}

function renderSpecSection(spec: TrendsSpec): string {
  const title = spec.title ? esc(spec.title) : esc(spec.specId);
  return `
    <section class="vp-spec" id="spec-${esc(spec.specId)}">
      <div class="vp-spec-head">
        <span class="vp-spec-title">${title}</span>
        <span class="vp-spec-id">${esc(spec.specId)}</span>
      </div>
      ${renderStandingStrip(spec)}
      ${renderVerdictTimeline(spec)}
      ${renderCoverageSparkline(spec)}
      ${renderCriterionStrip(spec)}
      ${renderPerfSparklines(spec)}
      ${renderScoreLine(spec)}
      ${renderSignalHistory(spec)}
    </section>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the trends BODY — header, per-spec sections, footer — WITHOUT the
 * document shell, so it can drop into either the self-contained `pageShell`
 * (the `validity trends` file artifact) or the dashboard's `renderSubPage` (the
 * served `/trends` route). Pure and deterministic — every timestamp comes from
 * `input`, never `Date.now()`; the served route sources `input.generatedAt`
 * from the dashboard snapshot's one sanctioned wall-clock read.
 *
 * `opts.served` swaps the file-only affordances for served ones: the sub-page
 * shell already supplies the wordmark/back header, so the body drops its own
 * `<h1>` (no duplicate top-level heading) and the empty state stops telling the
 * reader to "re-run validity trends" (the served page is already live).
 */
export function renderTrendsBody(input: TrendsInput, opts: { served?: boolean } = {}): string {
  const served = opts.served === true;
  const scoreBlock = input.currentScore
    ? `<div class="vp-score">${Math.round(input.currentScore.score)}<span class="vp-score-formula"> / 100 · ${esc(input.currentScore.formula)}</span></div>`
    : '';

  const specCount = `${input.specs.length} spec${input.specs.length === 1 ? '' : 's'}`;
  const header = served
    ? `
    <div class="vp-sub">${esc(input.projectName)} · generated ${esc(input.generatedAt)} · ${specCount} · local only, nothing uploaded</div>
    ${scoreBlock}`
    : `
    <header class="vp-header">
      <h1 class="vp-title">${esc(input.projectName)} — validity trends</h1>
      <div class="vp-sub">Generated ${esc(input.generatedAt)} · ${specCount} · local only, nothing uploaded</div>
      ${scoreBlock}
    </header>`;

  if (input.specs.length === 0) {
    const empty = served
      ? `<div class="vp-empty">No spec history on this machine yet — run <code>validity verify</code> against a frozen spec and its timeline appears here.</div>`
      : `<div class="vp-empty">
        No spec history yet — run <code>validity__verify</code> against a frozen spec, then re-run <code>validity trends</code>.
      </div>`;
    return `
      ${header}
      ${empty}`;
  }

  const sections = input.specs.map((s) => renderSpecSection(s)).join('\n');
  return `
    ${header}
    ${sections}
    <footer class="vp-footer">Display-only viewer. Verdicts are recomputed by the gates from live evidence — this page never feeds a pass/fail decision.</footer>`;
}

/**
 * The "back to the dashboard" up-link, leftmost in the topbar nav. Static
 * markup ships `hidden` (matching `report.html`'s `data-dashboard-link`
 * precedent, generalized as `@validity.ai/verify-report`'s `data-served-link`): a
 * self-contained file artifact is usually opened from `file://` or unpacked
 * from a CI artifact, where a root-relative `href="/"` resolves to nothing —
 * `revealServedLinksScript` reveals it only when the document is actually
 * served over http(s).
 */
const DASHBOARD_UP_LINK =
  'data-served-link hidden title="Open this project’s Validity overview — signals, specs, trends"';

/**
 * The full self-contained `validity trends` file artifact: `@validity.ai/verify-report`'s
 * token/chrome system (pageShell + topbar, the ACTUAL wordmark) around the
 * shared trends body. The only script the page ships is progressive
 * enhancement (theme toggle + the dashboard up-link reveal) — the page is
 * fully readable, and every chart fully legible, without JavaScript.
 */
export function renderTrendsHtml(input: TrendsInput): string {
  const body = `
    ${renderTrendsBody(input)}
    <div class="vp-note">See open signals: <code>validity signals list</code></div>`;
  return pageShell({
    title: `${input.projectName} — validity trends`,
    css: VP_BODY_CSS,
    header: topbar({
      nav: [{ label: '↑ Project dashboard', href: '/', attrs: DASHBOARD_UP_LINK }],
    }),
    body,
    scripts: [revealServedLinksScript],
  });
}
