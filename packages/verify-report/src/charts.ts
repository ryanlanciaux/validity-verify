/**
 * The shared chart kit — TanStack Charts rendered server-side.
 *
 * `createChartScene` + `renderChartSvg` are pure functions: no DOM, no
 * clocks, no randomness — the SVG string is byte-identical for identical
 * input, so charts are safe inside the attested, script-free artifacts.
 * Colors are CSS custom properties (var(--grn) …) so every chart follows the
 * token themes without re-rendering.
 */
import { createChartScene, defineChart, renderChartSvg } from '@tanstack/charts';
import { areaY } from '@tanstack/charts/area';
import { dot } from '@tanstack/charts/dot';
import { lineY } from '@tanstack/charts/line';
import { scaleLinear } from '@tanstack/charts-scales/linear';
import { esc } from './html.js';
import { FONT_MONO } from './tokens.js';

/** Definition options shared by every static chart: no interactivity. */
const STATIC = {
  focusRing: false,
  pointer: false,
  keyboard: false,
  animate: false,
  tooltip: false,
} as const;

/** Round to 2 decimals for stable percent-space SVG coordinates. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Inject a `<title>` as the SVG's first child — read before the aria-label by assistive tech. */
function withTitle(svg: string, titleText: string | undefined): string {
  if (!titleText) return svg;
  return svg.replace(/(<svg[^>]*>)/, `$1<title>${esc(titleText)}</title>`);
}

/** Contiguous non-null runs of a series, as `{start, length}` pairs. */
function segmentsOf(values: ReadonlyArray<number | null | undefined>): Array<{
  start: number;
  length: number;
}> {
  const out: Array<{ start: number; length: number }> = [];
  let start = -1;
  let length = 0;
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      if (length > 0) out.push({ start, length });
      length = 0;
      return;
    }
    if (length === 0) start = i;
    length += 1;
  });
  if (length > 0) out.push({ start, length });
  return out;
}

/** Index of the last non-null/undefined value, or -1 when every value is absent. */
function lastRealIndex(values: ReadonlyArray<number | null | undefined>): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && values[i] !== undefined) return i;
  }
  return -1;
}

export interface SparklineOptions {
  /** Accessible name for the series, e.g. "Validity score, last 12 runs". */
  ariaLabel: string;
  /** `<title>` summary read first by assistive tech; omitted when absent. */
  titleText?: string;
  /** Stroke color; defaults to the working green. */
  stroke?: string;
  width?: number;
  height?: number;
  /** Fixed y domain [lo, hi]; auto-scales over the non-null values when omitted. */
  yDomain?: [number, number];
}

/** The uniform inset (viewBox units) `defineChart({ margin })` applies below. */
const SPARK_MARGIN = 2;

/**
 * Inline trend line for stat cards and compact per-spec metrics: autoscaled
 * (or fixed via `yDomain`), no axes or grid. `null` entries break the line
 * into segments — a gap, never a plunge to zero — and an isolated
 * measurement (surrounded by gaps) still renders as a visible dot. The last
 * real value always carries an end dot (deduped against an isolated dot at
 * the same index).
 *
 * Dots are absolutely-positioned HTML overlays, not SVG marks: the SVG is
 * fluid-width with `preserveAspectRatio="none"` (it stretches non-uniformly
 * to fill its card), which would squash an SVG `<circle>` into an ellipse —
 * an HTML dot sized in real pixels stays a circle regardless of how the plot
 * beneath it stretches. Position math mirrors the chart's own `margin: 2`
 * inset so the overlay lines up with the plotted line underneath it.
 */
export function sparkline(
  values: ReadonlyArray<number | null | undefined>,
  options: SparklineOptions,
): string {
  const {
    ariaLabel,
    titleText,
    stroke = 'var(--grn)',
    width = 120,
    height = 26,
    yDomain,
  } = options;
  const nums = values.filter((v): v is number => v !== null && v !== undefined);

  if (nums.length === 0) {
    const emptyChart = defineChart(
      {
        marks: [],
        guides: true,
        x: { scale: scaleLinear, axis: false },
        y: { scale: scaleLinear, axis: false },
        margin: SPARK_MARGIN,
        theme: { background: 'transparent' },
      },
      STATIC,
    );
    const emptyScene = createChartScene(emptyChart, { width, height });
    const emptySvg = renderChartSvg(emptyScene, { ariaLabel, tabIndex: -1 }).replace(
      '<svg class="ts-chart"',
      '<svg preserveAspectRatio="none" class="ts-chart"',
    );
    return `<span class="vc-spark-wrap">${withTitle(emptySvg, titleText)}</span>`;
  }

  const chart = defineChart(
    {
      marks: [
        lineY(values as Array<number | null>, {
          stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.85,
        }),
      ],
      guides: true,
      x: { scale: scaleLinear, axis: false },
      y: {
        scale: scaleLinear,
        ...(yDomain ? { viewport: { domain: yDomain } } : {}),
        axis: false,
      },
      margin: SPARK_MARGIN,
      theme: { background: 'transparent' },
    },
    STATIC,
  );
  const scene = createChartScene(chart, { width, height });

  // Overlay dots take their coordinates from the laid-out scene, never from
  // re-derived math: TanStack owns the y scale (a constant series centers in
  // a degenerate domain, inference may pad), so mirroring the scale here
  // would drift — and did, before scene.points anchored it.
  const pointAt = new Map<number, { x: number; y: number }>();
  for (const p of scene.points ?? []) {
    if (typeof p.datumIndex === 'number') pointAt.set(p.datumIndex, { x: p.x, y: p.y });
  }
  const dotHtml: string[] = [];
  const dotAt = (i: number): string => {
    const p = pointAt.get(i);
    if (!p) return '';
    return `<span class="vc-spark-dot" style="left:${r2((p.x / width) * 100)}%;top:${r2((p.y / height) * 100)}%;background:${stroke}"></span>`;
  };
  // Isolated points (segment length 1) have nothing to connect them to a
  // line — draw them as a dot so the measurement stays visible.
  const segs = segmentsOf(values);
  for (const seg of segs) {
    if (seg.length === 1) dotHtml.push(dotAt(seg.start));
  }
  // End dot: the last real point, unless it was already dotted as isolated.
  const lastIdx = lastRealIndex(values);
  const lastIsIsolated = segs.some((s) => s.length === 1 && s.start === lastIdx);
  if (lastIdx >= 0 && !lastIsIsolated) dotHtml.push(dotAt(lastIdx));

  // The design stretches sparklines to their card's width; the renderer has
  // no preserveAspectRatio knob, so stamp it into the root element.
  const svg = renderChartSvg(scene, { ariaLabel, tabIndex: -1 }).replace(
    '<svg class="ts-chart"',
    '<svg preserveAspectRatio="none" class="ts-chart"',
  );
  return `<span class="vc-spark-wrap">${withTitle(svg, titleText)}${dotHtml.join('')}</span>`;
}

export interface LineChartOptions {
  /** Accessible name, e.g. "Validity score over 30 days, all specs". */
  ariaLabel: string;
  /** y domain floor/ceiling, e.g. [80, 100]. Inferred from data if omitted. */
  yDomain?: [number, number];
  /** Draw horizontal gridlines + y tick labels. Default true. */
  yAxis?: boolean;
  /** Left/right edge labels under the x axis, e.g. ["Jul 09", "Aug 07"]. */
  xEdgeLabels?: [string, string];
  /** Series color; defaults to the working green. */
  stroke?: string;
  /** Wash the area under the line (gradient to transparent). Default true. */
  area?: boolean;
  /** Mark the final point with a dot. Default true. */
  endDot?: boolean;
  width?: number;
  height?: number;
}

/**
 * The standard score-over-time panel chart: gridline y axis, gradient area
 * wash, 2px line, end dot, and edge date labels.
 */
export function lineChart(values: readonly number[], options: LineChartOptions): string {
  const {
    ariaLabel,
    yDomain,
    yAxis = true,
    xEdgeLabels,
    stroke = 'var(--grn)',
    area = true,
    endDot = true,
    width = 720,
    height = 190,
  } = options;
  const data = values as number[];
  const last = data.length - 1;

  const marks = [];
  if (area) {
    marks.push(areaY(data, { fill: 'url(#vwash)', stroke: 'none' }));
  }
  marks.push(
    lineY(data, {
      stroke,
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
  if (endDot && last >= 0) {
    marks.push(
      dot([last], {
        x: (i: number) => i,
        y: (i: number) => data[i],
        r: 3.5,
        fill: stroke,
        stroke: 'none',
      }),
    );
  }

  const chart = defineChart(
    {
      marks,
      x: { scale: scaleLinear, axis: false },
      y: {
        scale: scaleLinear,
        ...(yDomain ? { viewport: { domain: yDomain } } : {}),
        grid: yAxis,
        axis: yAxis
          ? { line: false, ticks: { size: 0, padding: 8 }, tickLabels: { fontSize: 9.5 } }
          : false,
      },
      gradients: [
        {
          id: 'vwash',
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 1,
          stops: [
            { offset: 0, color: stroke, opacity: 0.22 },
            { offset: 1, color: stroke, opacity: 0 },
          ],
        },
      ],
      margin: { top: 8, right: 8, bottom: xEdgeLabels ? 22 : 8, left: yAxis ? 34 : 8 },
      theme: {
        background: 'transparent',
        muted: 'var(--dim2)',
        grid: 'var(--grid)',
        foreground: 'var(--tx)',
      },
    },
    STATIC,
  );
  const scene = createChartScene(chart, { width, height });
  let svg = renderChartSvg(scene, { ariaLabel });
  if (xEdgeLabels) {
    // Edge date labels, hand-placed: the design labels only the first and
    // last day, which axis tick thinning cannot express.
    const yText = height - 5;
    const labels =
      `<text x="${yAxis ? 34 : 8}" y="${yText}" font-size="9.5" fill="var(--dim2)">${escapeXml(xEdgeLabels[0])}</text>` +
      `<text x="${width - 8}" y="${yText}" text-anchor="end" font-size="9.5" fill="var(--dim2)">${escapeXml(xEdgeLabels[1])}</text>`;
    svg = svg.replace('</svg>', `${labels}</svg>`);
  }
  return svg;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Verdict step-line — categorical (pass/mixed/fail bands), not a continuous
// numeric series, so it is hand-rolled percent-space SVG + HTML overlays
// (the same architecture TanStack itself renders to under the hood) rather
// than a chart-mark definition: there is no natural x/y scale for "which of
// three fixed bands", and the shape-glyph markers/version-break labels must
// stay crisp text, not distort with the fluid width. Deterministic, token
// colored, aria-label required — same discipline as {@link sparkline}.
// ---------------------------------------------------------------------------

export type RunVerdict = 'pass' | 'fail' | 'partial' | 'unknown';

export interface VerdictStepPoint {
  verdict: RunVerdict;
  /** A signed-off run gets a ring around its marker. */
  signedOff?: boolean;
  /** Hover text: runId + timestamp + verdict. */
  title: string;
  /**
   * When set, a dashed vertical rule is drawn just before this point and
   * labeled — used to mark a spec-version change (a baseline reset).
   */
  versionLabel?: string;
}

/**
 * Verdict step-line. Three bands top→bottom: pass / partial·unknown (mixed) /
 * fail. Markers are shape-coded (● pass, ◆ mixed, ✕ fail) AND color-coded, so
 * the series reads without color. A `signedOff` point gets a ring. Spec-
 * version changes draw a dashed vertical rule labeled `v{n}` (dashed is
 * semantic here — a baseline reset, not a gridline).
 */
export function verdictStepLine(points: readonly VerdictStepPoint[], ariaLabel: string): string {
  const title = `<title>${esc(ariaLabel)}</title>`;
  const frameStyle = 'height:96px';
  if (points.length === 0) {
    return (
      `<figure class="vc vc--step"><div class="vc-row"><div class="vc-frame" style="${frameStyle}">` +
      `<svg class="vc-svg" role="img" aria-label="${esc(ariaLabel)}" ` +
      `viewBox="0 0 100 100" preserveAspectRatio="none">${title}</svg>` +
      `</div></div></figure>`
    );
  }

  const n = points.length;
  const xFor = (i: number): number => r2(n === 1 ? 50 : (i / (n - 1)) * 100);
  // band 0 = pass (top), 1 = partial/unknown (middle), 2 = fail (bottom) —
  // inset from the frame edges so markers never clip.
  const BAND_Y = [10, 50, 90] as const;
  const bandOf = (v: RunVerdict): number => (v === 'pass' ? 0 : v === 'fail' ? 2 : 1);
  const yFor = (band: number): number => BAND_Y[band]!;

  const guides = BAND_Y.map(
    (y) =>
      `<line class="vc-grid" vector-effect="non-scaling-stroke" x1="0" y1="${y}" x2="100" y2="${y}" />`,
  ).join('');
  const bandLabels =
    `<span class="vc-tick" style="top:${BAND_Y[0]}%">pass</span>` +
    `<span class="vc-tick" style="top:${BAND_Y[1]}%">mixed</span>` +
    `<span class="vc-tick" style="top:${BAND_Y[2]}%">fail</span>`;

  // Step path: horizontal at each point's band, vertical connector to the next.
  const segs: string[] = [];
  points.forEach((p, i) => {
    const x = xFor(i);
    const y = yFor(bandOf(p.verdict));
    if (i === 0) {
      segs.push(`M ${x} ${y}`);
    } else {
      segs.push(`L ${x} ${yFor(bandOf(points[i - 1]!.verdict))}`);
      segs.push(`L ${x} ${y}`);
    }
  });
  const path = `<path class="vc-step-path" vector-effect="non-scaling-stroke" d="${segs.join(' ')}" />`;

  const markerGlyph = (v: RunVerdict): string => (v === 'pass' ? '●' : v === 'fail' ? '✕' : '◆');
  const markerClass = (v: RunVerdict): string =>
    v === 'pass' ? 'vc-mark--pass' : v === 'fail' ? 'vc-mark--fail' : 'vc-mark--mid';

  // Dashed vertical rules stay SVG (they span the plot); labels are HTML.
  const versionRules = points
    .map((p, i) => {
      if (!p.versionLabel) return '';
      const x = xFor(i);
      return (
        `<line vector-effect="non-scaling-stroke" x1="${x}" y1="0" x2="${x}" y2="100" ` +
        `stroke="var(--bd2)" stroke-width="1" stroke-dasharray="3 2" />`
      );
    })
    .join('');
  const versionLabels = points
    .map((p, i) => {
      if (!p.versionLabel) return '';
      return `<span class="vc-vlabel" style="left:${xFor(i)}%">${esc(p.versionLabel)}</span>`;
    })
    .join('');

  const markers = points
    .map((p, i) => {
      const x = xFor(i);
      const y = yFor(bandOf(p.verdict));
      const ring = p.signedOff ? ' vc-mark--ring' : '';
      return (
        `<span class="vc-mark ${markerClass(p.verdict)}${ring}" style="left:${x}%;top:${y}%" ` +
        `title="${esc(p.title)}">${markerGlyph(p.verdict)}</span>`
      );
    })
    .join('');

  return (
    `<figure class="vc vc--step">` +
    `<div class="vc-row">` +
    `<div class="vc-gutter" aria-hidden="true">${bandLabels}</div>` +
    `<div class="vc-frame" style="${frameStyle}">` +
    `<svg class="vc-svg" role="img" aria-label="${esc(ariaLabel)}" ` +
    `viewBox="0 0 100 100" preserveAspectRatio="none">${title}${guides}${versionRules}${path}</svg>` +
    `${versionLabels}${markers}` +
    `</div></div></figure>`
  );
}

/**
 * CSS for the hand-rolled chart chrome ({@link verdictStepLine}'s frame,
 * gutter, tick labels, step path, and shape-glyph markers). Token-driven —
 * included by {@link pageShell} automatically, so any surface composing the
 * design system's charts gets it for free. `sparkline`/`lineChart` need no
 * CSS of their own: TanStack bakes their colors into SVG presentation
 * attributes directly.
 */
export const CHART_CSS = `
  .vc-spark-wrap { position: relative; display: block; height: 100%; }
  .vc-spark-dot {
    position: absolute; width: 6px; height: 6px; border-radius: 50%;
    box-shadow: 0 0 0 2px var(--panel);
    transform: translate(-50%, -50%); pointer-events: none;
  }
  figure.vc { margin: 0; }
  .vc-row { display: flex; }
  .vc-gutter { position: relative; flex: 0 0 40px; }
  .vc-gutter .vc-tick {
    position: absolute; right: 10px; transform: translateY(-50%);
    font-size: 10px; line-height: 1; color: var(--dim2);
    font-family: ${FONT_MONO}; white-space: nowrap;
  }
  .vc-frame { position: relative; flex: 1 1 auto; min-width: 0; }
  .vc-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; display: block; }
  .vc-grid { stroke: var(--grid); stroke-width: 1; }
  .vc-step-path { fill: none; stroke: var(--dim2); stroke-width: 2; stroke-linejoin: round; }
  .vc-mark {
    position: absolute; transform: translate(-50%, -50%);
    font-size: 12px; line-height: 1; cursor: default;
  }
  .vc-mark--pass { color: var(--grn); }
  .vc-mark--fail { color: var(--red); }
  .vc-mark--mid { color: var(--amb); }
  .vc-mark--ring { box-shadow: 0 0 0 1.5px var(--dim2); border-radius: 999px; padding: 2px; }
  .vc-vlabel {
    position: absolute; top: -16px; transform: translateX(-50%);
    font-size: 9px; color: var(--dim2); font-family: ${FONT_MONO};
  }
`;
