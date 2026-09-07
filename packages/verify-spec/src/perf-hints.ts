/**
 * Advisory performance tinting + heuristic fix hints (D2).
 *
 * ONE source of truth consumed by the sandbox report (threshold tinting), the
 * MCP verify text + `structuredContent.perf.hints`, and `validity watch`. Pure
 * functions over `PerformanceMetrics`; zero I/O.
 *
 * GATE INTEGRITY: everything here is advisory-only. Nothing in this module
 * constructs, mutates, or reads into a CriterionVerdict — the verdict lattice
 * (fail ⊐ unverifiable ⊐ pass) is structurally unreachable from these outputs.
 * `expect.performance` budgets remain the ONLY perf gate surface.
 */
import type { PerformanceMetrics } from './types.js';

/** Advisory tint level for one measured metric. NOT a verdict. */
export type PerfTintLevel = 'ok' | 'amber' | 'red';

export interface PerfThreshold {
  amber: number;
  red: number;
}

/**
 * Published advisory thresholds. Strictly-greater-than semantics
 * (value > amber ⇒ amber, value > red ⇒ red) so a commit of exactly 16ms —
 * one full 60fps frame — still reads as ok.
 *
 * Rationale (also stated in the report legend): 16ms = one 60fps frame budget;
 * 50ms = the RAIL long-task boundary; 50/200ms for cumulative re-render time =
 * a few dropped frames vs. a perceptible pause; 1s/3s for the coarse page
 * timings = RAIL's flow-of-thought boundary / Lighthouse's "poor" FCP — kept
 * generous because the dev-transform sandbox is unminified and unthrottled.
 *
 * `commitCount` is deliberately ABSENT: a count is not slow by itself
 * (a play-driven interaction legitimately commits many times); the
 * duration-weighted `excessive-rerenders` hint is the honest signal.
 */
export const PERF_THRESHOLDS: Readonly<Partial<Record<keyof PerformanceMetrics, PerfThreshold>>> = {
  mountMs: { amber: 16, red: 50 },
  updateMs: { amber: 16, red: 50 },
  updateTotalMs: { amber: 50, red: 200 },
  // readyMs is COMPONENT load+mount (harness boot subtracted — see
  // PerformanceMetrics.readyMs), so it runs an order of magnitude smaller than
  // the page-relative timings below and needs its own, tighter boundaries. The
  // old 1000/3000 pair was calibrated against the navigation-relative metric
  // and would now essentially never tint.
  readyMs: { amber: 300, red: 1000 },
  loadMs: { amber: 1000, red: 3000 },
  firstContentfulPaintMs: { amber: 1000, red: 3000 },
};

/** Tint one measured metric. Metrics without a published threshold read 'ok'. */
export function perfTint(metric: keyof PerformanceMetrics, value: number): PerfTintLevel {
  const t = PERF_THRESHOLDS[metric];
  if (!t) return 'ok';
  if (value > t.red) return 'red';
  if (value > t.amber) return 'amber';
  return 'ok';
}

export type PerfHintRule =
  | 'excessive-rerenders'
  | 'interaction-rerender-hotspot'
  | 'blocking-resources'
  | 'slow-mount'
  | 'slow-ready';

/**
 * Advisory finding derived mechanically from measured metrics. Never a verdict.
 * Severity vocabulary is 'info' | 'warn' ONLY — deliberately distinct from
 * Signal.severity and the criterion status vocabulary so it can't be confused
 * with either.
 */
export interface PerfHint {
  rule: PerfHintRule;
  severity: 'info' | 'warn';
  /** One-line, actionable, includes the numbers so it stands alone in text output. */
  message: string;
  /** The exact metric values the rule fired on (subset of PerformanceMetrics). */
  evidence: Record<string, number>;
}

/** Deterministic output cap per render (defensive; today only 5 rules exist). */
const MAX_HINTS_PER_RENDER = 4;

const ms = (v: number): string => `${Math.round(v)}ms`;

/**
 * Evaluate the hint rules against one render's measured metrics. Each rule
 * requires its own inputs to be present — missing metrics (native subset, old
 * run-metas) keep a rule silent, so `blocking-resources` structurally cannot
 * fire on native (no loadMs/FCP source). Output is warn-first then fixed rule
 * order, capped at MAX_HINTS_PER_RENDER. Evidence carries raw values; messages
 * round to whole ms.
 */
export function computePerfHints(perf: PerformanceMetrics | undefined): PerfHint[] {
  if (!perf) return [];
  const hints: PerfHint[] = [];
  const { loadMs, firstContentfulPaintMs, readyMs, mountMs, updateMs, commitCount, updateTotalMs } =
    perf;

  if (typeof commitCount === 'number' && typeof updateMs === 'number') {
    if (commitCount >= 10 && updateMs > 16) {
      hints.push({
        rule: 'excessive-rerenders',
        severity: 'warn',
        message:
          `excessive re-renders: ${commitCount} commits, worst update ${ms(updateMs)}` +
          `${typeof updateTotalMs === 'number' ? ` (${ms(updateTotalMs)} total re-render time)` : ''}` +
          ' — check memoization (useMemo/useCallback/React.memo) and effect dependency arrays',
        evidence: {
          commitCount,
          updateMs,
          ...(typeof updateTotalMs === 'number' ? { updateTotalMs } : {}),
        },
      });
    }
  }

  if (typeof updateMs === 'number' && typeof mountMs === 'number') {
    // mountMs > 0 guard: a rounding-to-0 mount must not make every 16ms
    // update read as "≥3× mount".
    if (updateMs > 16 && mountMs > 0 && updateMs >= 3 * mountMs) {
      hints.push({
        rule: 'interaction-rerender-hotspot',
        severity: 'warn',
        message:
          `a re-render costs ${ms(updateMs)} vs ${ms(mountMs)} initial mount (≥3×) — ` +
          'interaction-triggered re-render hotspot; check state placement, unstable props, and list keys',
        evidence: { updateMs, mountMs },
      });
    }
  }

  if (typeof mountMs === 'number' && mountMs > 50) {
    hints.push({
      rule: 'slow-mount',
      severity: 'warn',
      message:
        `initial mount commit took ${ms(mountMs)} (>50ms long-task threshold) — ` +
        'heavy render work on mount; consider splitting the component or deferring below-the-fold work',
      evidence: { mountMs },
    });
  }

  if (typeof loadMs === 'number' && typeof firstContentfulPaintMs === 'number') {
    const gap = loadMs - firstContentfulPaintMs;
    if (gap >= 1000) {
      hints.push({
        rule: 'blocking-resources',
        severity: 'info',
        message:
          `page load finished ${ms(gap)} after first paint — ` +
          'heavy resources keep loading after first render (large images/scripts/waterfall fetches)',
        evidence: { loadMs, firstContentfulPaintMs },
      });
    }
  }

  if (typeof readyMs === 'number' && readyMs > PERF_THRESHOLDS.readyMs!.red) {
    hints.push({
      rule: 'slow-ready',
      severity: 'info',
      message:
        `component took ${ms(readyMs)} to become ready in the sandbox — ` +
        "the harness's own boot cost is already subtracted, so check the component's " +
        'own dynamic import and any data-fetch waterfall before first paint',
      evidence: { readyMs },
    });
  }

  // Rules are declared warn-first in rule order, so the evaluation order above
  // IS the output order; the cap just trims the tail deterministically.
  return hints.slice(0, MAX_HINTS_PER_RENDER);
}

const HINT_GLYPH: Record<PerfHint['severity'], string> = { warn: '▲', info: '·' };

/**
 * Plain-text block for the MCP tool output / watch. Mirrors
 * `formatDiagnosticsBlock`'s shape (header + bullets + trailing arrow-note).
 * Returns undefined when there are no hints. The "advisory — … never part of
 * the verdict" header is baked in HERE (not at call sites) so no surface can
 * present a hint as a criterion.
 */
export function formatPerfHintsBlock(hints: PerfHint[], label: string): string | undefined {
  if (hints.length === 0) return undefined;
  const lines: string[] = [
    `Perf hints under '${label}' (advisory — measured in the sandbox, never part of the verdict):`,
  ];
  for (const h of hints) {
    lines.push(`  ${HINT_GLYPH[h.severity]} ${h.severity} ${h.message}`);
  }
  lines.push(
    '  → These are heuristics from measured render timings. They do not affect any criterion verdict; fix them only if they match what you observe.',
  );
  return lines.join('\n');
}
