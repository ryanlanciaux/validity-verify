/**
 * Pure renderer for `validity compare <runA> <runB>` — a side-by-side view of
 * two verify runs: screenshots paired by render slug, a criteria verdict-delta
 * table, and a perf delta table.
 *
 * PURE: `renderCompareHtml(input) => string`, byte-identical for a given input.
 * No fs, no process — the `compare` command (Track 4's later slot) resolves the
 * two runs from `run-meta.json` (full) or the indexed timeline (metadata-only
 * degrade) and populates `CompareInput`.
 *
 * Missing evidence degrades LOUDLY: a cleaned-up screenshot renders as a
 * labeled placeholder (never a stale/blank image passed off as evidence), a
 * metadata-only run is badged, and unpaired renders are listed, not dropped.
 * Criteria deltas reuse core's audited `computeRegressionDeltas` lattice for
 * real comparisons and NEVER rank an unknown status — the display analog of the
 * verdict lattice, so a regression can't render as an improvement.
 */

import {
  computeRegressionDeltas,
  type CriterionVerdict,
  type PerformanceMetrics,
} from '@validity.ai/verify-spec';
import { pageShell, revealServedLinksScript, topbar } from '@validity.ai/verify-report';

import {
  VP_BODY_CSS,
  esc,
  fmtSignedMs,
  fmtSignedPct,
  isKnownStatus,
  pill,
  statusClassOf,
  statusGlyph,
  verdictClassOf,
} from './html-lib.js';

// ---------------------------------------------------------------------------
// Input types (Track 4's `compare` command populates these)
// ---------------------------------------------------------------------------

export interface CompareInput {
  /** ISO time the report was generated (from the caller, for determinism). */
  generatedAt: string;
  a: CompareRun;
  b: CompareRun;
  /** specId present on both AND equal. */
  sameSpec: boolean;
  /** Same spec but a different frozen version/hash ⇒ amber banner. */
  specHashChanged: boolean;
}

export interface CompareRun {
  runId: string;
  createdAt?: string;
  specId?: string;
  specVersion?: number;
  specHash?: string;
  mode?: 'isolation' | 'url' | 'native';
  verdict?: string;
  signedOff?: boolean;
  /** `full` = from run-meta (screenshots + perf); `summary` = indexed-timeline degrade. */
  detail: 'full' | 'summary';
  /** Empty when `detail === 'summary'`. */
  renders: CompareRenderCell[];
  /** Status kept as a raw string — the renderer maps only exact matches. */
  criteria: Array<{ id: string; tier: string; status: string; detail?: string }>;
}

export interface CompareRenderCell {
  /** Pairing key (component__variant slug or page id). Matched across sides. */
  key: string;
  /** Human label: component · scenario · fixture · viewport · theme. */
  label: string;
  /** Inlined base64 data URL; undefined ⇒ metadata-only cell. */
  screenshotDataUrl?: string;
  /** Why the screenshot is absent (skipped/cleaned/render error). */
  missingReason?: string;
  renderError?: string;
  performance?: PerformanceMetrics;
}

// ---------------------------------------------------------------------------
// Perf
// ---------------------------------------------------------------------------

const PERF_METRICS: Array<{ key: keyof PerformanceMetrics; label: string }> = [
  { key: 'mountMs', label: 'Initial render (mount)' },
  { key: 'updateMs', label: 'Slowest re-render (update)' },
  { key: 'readyMs', label: 'Time to ready' },
  { key: 'loadMs', label: 'Page load' },
  { key: 'firstContentfulPaintMs', label: 'First contentful paint' },
  { key: 'commitCount', label: 'React commits' },
];

// ---------------------------------------------------------------------------
// Header + banners
// ---------------------------------------------------------------------------

function renderRunMeta(run: CompareRun, side: 'A' | 'B'): string {
  const bits: string[] = [`<code>${esc(run.runId)}</code>`];
  if (run.createdAt) bits.push(esc(run.createdAt));
  if (run.specId) {
    bits.push(
      `spec <code>${esc(run.specId)}</code>${run.specVersion !== undefined ? ` v${run.specVersion}` : ''}`,
    );
  }
  if (run.specHash) bits.push(`hash <code>${esc(run.specHash.slice(0, 8))}</code>`);
  if (run.mode) bits.push(esc(run.mode));
  if (run.detail === 'summary')
    bits.push('<span class="vp-note">indexed summary — no screenshots on disk</span>');
  const verdict = run.verdict
    ? pill(run.verdict, verdictClassOf(run.verdict)) +
      (run.signedOff ? ' ' + pill('signed off', 'pass') : '')
    : '';
  return `
    <div class="vp-cmp-side">
      <div class="vp-section-label">Run ${side}</div>
      <div>${verdict}</div>
      <div class="vp-note">${bits.join(' · ')}</div>
    </div>`;
}

function renderBanners(input: CompareInput): string {
  if (!input.sameSpec) {
    return `<div class="vp-banner vp-banner--warn">These runs verified DIFFERENT specs — criteria are not comparable; screenshots are paired by slug only.</div>`;
  }
  if (input.specHashChanged) {
    return `<div class="vp-banner vp-banner--amber">Same spec, different frozen version — criteria matched by id across versions.</div>`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Screenshot grid
// ---------------------------------------------------------------------------

function renderShotCell(cell: CompareRenderCell | undefined): string {
  if (!cell) return `<div class="vp-shot-missing">not rendered in this run</div>`;
  if (cell.screenshotDataUrl) {
    return `<img class="vp-shot" src="${esc(cell.screenshotDataUrl)}" alt="${esc(cell.label)}" />`;
  }
  const reason = cell.renderError
    ? `render error: ${cell.renderError}`
    : (cell.missingReason ?? 'screenshot not available');
  return `<div class="vp-shot-missing">${esc(reason)}</div>`;
}

function renderScreenshotGrid(input: CompareInput): string {
  const aByKey = new Map(input.a.renders.map((c) => [c.key, c]));
  const bByKey = new Map(input.b.renders.map((c) => [c.key, c]));
  const keys = [...new Set([...aByKey.keys(), ...bByKey.keys()])].sort();
  if (keys.length === 0) return '';

  const rows = keys
    .map((key) => {
      const a = aByKey.get(key);
      const b = bByKey.get(key);
      const label = a?.label ?? b?.label ?? key;
      return `
        <div class="vp-grid-key">${esc(label)}<div class="vp-note"><code>${esc(key)}</code></div></div>
        <div>${renderShotCell(a)}</div>
        <div>${renderShotCell(b)}</div>`;
    })
    .join('');

  return `
    <section class="vp-chart">
      <h2 class="vp-section-heading">Screenshots</h2>
      <div class="vp-grid">
        <div class="vp-grid-head">render</div>
        <div class="vp-grid-head">Run A</div>
        <div class="vp-grid-head">Run B</div>
        ${rows}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Criteria delta table
// ---------------------------------------------------------------------------

type DeltaDir = 'regressed' | 'improved' | 'unchanged' | 'new' | 'removed' | 'unknown';

interface DeltaRow {
  id: string;
  tier: string;
  aStatus?: string;
  bStatus?: string;
  dir: DeltaDir;
}

const DIR_GLYPH: Record<DeltaDir, string> = {
  regressed: '▼',
  improved: '▲',
  new: '●',
  unchanged: '·',
  removed: '—',
  unknown: '—',
};

/** Regressions first, then new, improved, unchanged, then removed/unknown. */
const DIR_ORDER: Record<DeltaDir, number> = {
  regressed: 0,
  new: 1,
  improved: 2,
  unchanged: 3,
  removed: 4,
  unknown: 5,
};

/**
 * Per-criterion deltas from A (previous) to B (current). Real comparisons —
 * both statuses in the known union — go through core's audited
 * `computeRegressionDeltas` lattice; any row touching an unknown status gets
 * `unknown`/`—` and is NEVER ranked, so a fabricated status can't invert a
 * regression.
 */
function computeDeltaRows(input: CompareInput): DeltaRow[] {
  const aById = new Map(input.a.criteria.map((c) => [c.id, c]));
  const bById = new Map(input.b.criteria.map((c) => [c.id, c]));
  const ids = [...new Set([...aById.keys(), ...bById.keys()])].sort();

  // Audited deltas only over ids where BOTH sides carry a known status.
  const bothKnownIds = ids.filter((id) => {
    const a = aById.get(id);
    const b = bById.get(id);
    return a && b && isKnownStatus(a.status) && isKnownStatus(b.status);
  });
  const prev = bothKnownIds.map(
    (id) => ({ id, tier: aById.get(id)!.tier, status: aById.get(id)!.status }) as CriterionVerdict,
  );
  const cur = bothKnownIds.map(
    (id) => ({ id, tier: bById.get(id)!.tier, status: bById.get(id)!.status }) as CriterionVerdict,
  );
  const audited = new Map(computeRegressionDeltas(cur, prev).map((d) => [d.criterionId, d.delta]));

  return ids.map((id) => {
    const a = aById.get(id);
    const b = bById.get(id);
    const tier = b?.tier ?? a?.tier ?? '';
    let dir: DeltaDir;
    if (audited.has(id)) {
      dir = audited.get(id)! as DeltaDir;
    } else if (a && !b) {
      dir = 'removed';
    } else if (!a && b && isKnownStatus(b.status)) {
      dir = 'new';
    } else {
      // Some status is unknown/unrankable — never ranked.
      dir = 'unknown';
    }
    return { id, tier, aStatus: a?.status, bStatus: b?.status, dir };
  });
}

function renderDeltaGroup(title: string, rows: DeltaRow[]): string {
  if (rows.length === 0) return '';
  const sorted = [...rows].sort((x, y) => {
    const d = DIR_ORDER[x.dir] - DIR_ORDER[y.dir];
    return d !== 0 ? d : x.id.localeCompare(y.id);
  });
  const body = sorted
    .map((r) => {
      const aCell = r.aStatus
        ? `<span class="vp-cell vp-cell--${statusClassOf(r.aStatus)}">${statusGlyph(r.aStatus)} ${esc(r.aStatus)}</span>`
        : '<span class="vp-note">—</span>';
      const bCell = r.bStatus
        ? `<span class="vp-cell vp-cell--${statusClassOf(r.bStatus)}">${statusGlyph(r.bStatus)} ${esc(r.bStatus)}</span>`
        : '<span class="vp-note">—</span>';
      return `
        <tr>
          <th scope="row">${esc(r.id)}</th>
          <td>${aCell}</td>
          <td>${bCell}</td>
          <td class="vp-delta--${r.dir}">${DIR_GLYPH[r.dir]} ${r.dir}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="vp-chart">
      <div class="vp-section-label">${esc(title)}</div>
      <table class="vp-table">
        <thead><tr><th scope="col">criterion</th><th scope="col">Run A</th><th scope="col">Run B</th><th scope="col">Δ</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderCriteriaDelta(input: CompareInput): string {
  if (!input.sameSpec) return '';
  const rows = computeDeltaRows(input);
  if (rows.length === 0) return '';
  const proven = rows.filter((r) => r.tier === 'hard' || r.tier === 'property');
  const scored = rows.filter((r) => r.tier === 'soft');
  const other = rows.filter((r) => r.tier !== 'hard' && r.tier !== 'property' && r.tier !== 'soft');
  const summarySourced =
    input.a.detail === 'summary' || input.b.detail === 'summary'
      ? `<div class="vp-note">One side is an indexed summary — statuses come from the timeline snapshot.</div>`
      : '';
  return `
    <section class="vp-chart">
      <h2 class="vp-section-heading">Criteria deltas (A → B)</h2>
      ${summarySourced}
      ${renderDeltaGroup('Proven (hard/property)', proven)}
      ${renderDeltaGroup('Scored (soft)', scored)}
      ${renderDeltaGroup('Other', other)}
    </section>`;
}

// ---------------------------------------------------------------------------
// Perf delta table
// ---------------------------------------------------------------------------

function renderPerfDelta(input: CompareInput): string {
  const aByKey = new Map(input.a.renders.filter((c) => c.performance).map((c) => [c.key, c]));
  const bByKey = new Map(input.b.renders.filter((c) => c.performance).map((c) => [c.key, c]));
  const keys = [...new Set([...aByKey.keys(), ...bByKey.keys()])].sort();
  if (keys.length === 0) return '';

  const rows: string[] = [];
  for (const key of keys) {
    const aPerf = aByKey.get(key)?.performance;
    const bPerf = bByKey.get(key)?.performance;
    for (const m of PERF_METRICS) {
      const av = aPerf?.[m.key];
      const bv = bPerf?.[m.key];
      const aNum = typeof av === 'number' ? av : undefined;
      const bNum = typeof bv === 'number' ? bv : undefined;
      if (aNum === undefined && bNum === undefined) continue;

      let deltaCell: string;
      if (aNum !== undefined && bNum !== undefined) {
        const diff = bNum - aNum;
        const pct = fmtSignedPct(aNum, bNum);
        // Higher = slower = worse (lower is better for these metrics).
        const dir = diff > 0 ? 'regressed' : diff < 0 ? 'improved' : 'unchanged';
        deltaCell = `<span class="vp-delta--${dir}">${fmtSignedMs(diff)}${pct ? ` (${pct})` : ''}</span>`;
      } else {
        deltaCell = `<span class="vp-note">${aNum !== undefined ? 'A only' : 'B only'}</span>`;
      }
      rows.push(`
        <tr>
          <th scope="row"><code>${esc(key)}</code></th>
          <td>${esc(m.label)}</td>
          <td>${aNum !== undefined ? aNum : '—'}</td>
          <td>${bNum !== undefined ? bNum : '—'}</td>
          <td>${deltaCell}</td>
        </tr>`);
    }
  }
  if (rows.length === 0) return '';

  return `
    <section class="vp-chart">
      <h2 class="vp-section-heading">Performance deltas (A → B)</h2>
      <div class="vp-note">Observational only — lower is better; no thresholds, no verdict.</div>
      <table class="vp-table">
        <thead><tr><th scope="col">render</th><th scope="col">metric</th><th scope="col">A</th><th scope="col">B</th><th scope="col">Δ</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Not-compared remainder (honest-remainder discipline)
// ---------------------------------------------------------------------------

function renderNotCompared(input: CompareInput): string {
  const notes: string[] = [];
  const missingShots =
    input.a.renders.filter((c) => !c.screenshotDataUrl).length +
    input.b.renders.filter((c) => !c.screenshotDataUrl).length;
  if (missingShots > 0)
    notes.push(
      `${missingShots} render${missingShots === 1 ? '' : 's'} without a screenshot on disk`,
    );
  if (!input.sameSpec) notes.push('criteria not compared (different specs)');
  if (input.a.detail === 'summary' || input.b.detail === 'summary')
    notes.push('one side is an indexed summary (no screenshots, no perf)');
  if (input.a.renders.every((c) => !c.performance) && input.b.renders.every((c) => !c.performance))
    notes.push('no performance metrics captured on either side');
  if (notes.length === 0) return '';
  return `
    <section class="vp-chart">
      <h2 class="vp-section-heading">Not compared</h2>
      <ul class="vp-note">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </section>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** See {@link ../trends-render.js}'s identical constant — same up-link contract. */
const DASHBOARD_UP_LINK =
  'data-served-link hidden title="Open this project’s Validity dashboard — health, signals, specs, trends"';

/**
 * The full self-contained `validity compare` file artifact: `@validity.ai/verify-report`'s
 * token/chrome system (pageShell + topbar, the ACTUAL wordmark) around the
 * side-by-side comparison body. The only script the page ships is progressive
 * enhancement (theme toggle + the dashboard up-link reveal).
 */
export function renderCompareHtml(input: CompareInput): string {
  const title = `validity compare — ${input.a.runId} vs ${input.b.runId}`;
  const body = `
    <header class="vp-header">
      <h1 class="vp-title">validity compare</h1>
      <div class="vp-sub">Generated ${esc(input.generatedAt)} · local only, nothing uploaded</div>
      <div class="vp-cmp-sides">
        ${renderRunMeta(input.a, 'A')}
        ${renderRunMeta(input.b, 'B')}
      </div>
    </header>
    ${renderBanners(input)}
    ${renderScreenshotGrid(input)}
    ${renderCriteriaDelta(input)}
    ${renderPerfDelta(input)}
    ${renderNotCompared(input)}
    <footer class="vp-footer">Display-only viewer. Verdicts are recomputed by the gates from live evidence — this page never feeds a pass/fail decision.</footer>
    <div class="vp-note">See open signals: <code>validity signals list</code></div>`;

  return pageShell({
    title,
    css: VP_BODY_CSS,
    header: topbar({
      nav: [{ label: '↑ Project dashboard', href: '/', attrs: DASHBOARD_UP_LINK }],
    }),
    body,
    scripts: [revealServedLinksScript],
  });
}
