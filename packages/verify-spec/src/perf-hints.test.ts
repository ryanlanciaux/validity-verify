/**
 * Truth tables for the advisory perf tinting + hint rules (D2). These are
 * advisory-only surfaces — no verdict at stake — but the boundaries are
 * published (report legend), so they're pinned exactly: strict `>` for tints,
 * the documented `>=` predicates for rules, warn-first ordering, and the
 * per-render cap.
 */
import { describe, expect, it } from 'vitest';
import {
  PERF_THRESHOLDS,
  computePerfHints,
  formatPerfHintsBlock,
  perfTint,
  type PerformanceMetrics,
} from './index.js';

describe('perfTint', () => {
  it('commit metrics: strictly greater-than 16/50 boundaries', () => {
    expect(perfTint('mountMs', 16)).toBe('ok');
    expect(perfTint('mountMs', 16.01)).toBe('amber');
    expect(perfTint('mountMs', 50)).toBe('amber');
    expect(perfTint('mountMs', 50.01)).toBe('red');
    expect(perfTint('updateMs', 16)).toBe('ok');
    expect(perfTint('updateMs', 51)).toBe('red');
  });

  it('cumulative re-render time: 50/200 boundaries', () => {
    expect(perfTint('updateTotalMs', 50)).toBe('ok');
    expect(perfTint('updateTotalMs', 50.01)).toBe('amber');
    expect(perfTint('updateTotalMs', 200)).toBe('amber');
    expect(perfTint('updateTotalMs', 200.01)).toBe('red');
  });

  it('page timings: 1000/3000 boundaries', () => {
    for (const metric of ['loadMs', 'firstContentfulPaintMs'] as const) {
      expect(perfTint(metric, 1000)).toBe('ok');
      expect(perfTint(metric, 1001)).toBe('amber');
      expect(perfTint(metric, 3000)).toBe('amber');
      expect(perfTint(metric, 3001)).toBe('red');
    }
  });

  // readyMs is component load+mount (harness boot subtracted), so it gets
  // tighter boundaries than the page-relative timings above — at 1000/3000 it
  // would essentially never tint.
  it('time to ready: 300/1000 boundaries, tighter than the page timings', () => {
    expect(perfTint('readyMs', 300)).toBe('ok');
    expect(perfTint('readyMs', 301)).toBe('amber');
    expect(perfTint('readyMs', 1000)).toBe('amber');
    expect(perfTint('readyMs', 1001)).toBe('red');
  });

  it('harness boot is never tinted — it is the sandbox cost, not the app', () => {
    expect(PERF_THRESHOLDS.harnessBootMs).toBeUndefined();
    expect(perfTint('harnessBootMs', 9999)).toBe('ok');
  });

  it('commitCount is never tinted (no published threshold)', () => {
    expect(PERF_THRESHOLDS.commitCount).toBeUndefined();
    expect(perfTint('commitCount', 9999)).toBe('ok');
  });
});

describe('computePerfHints', () => {
  it('returns [] for undefined and for pristine metrics', () => {
    expect(computePerfHints(undefined)).toEqual([]);
    expect(
      computePerfHints({
        loadMs: 300,
        firstContentfulPaintMs: 200,
        readyMs: 250,
        mountMs: 4,
        updateMs: 2,
        commitCount: 3,
      }),
    ).toEqual([]);
  });

  describe('excessive-rerenders', () => {
    it('fires on commitCount >= 10 && updateMs > 16, evidence = exactly the tested fields', () => {
      const [hint] = computePerfHints({ commitCount: 14, updateMs: 31.2 });
      expect(hint).toMatchObject({ rule: 'excessive-rerenders', severity: 'warn' });
      expect(hint!.evidence).toEqual({ commitCount: 14, updateMs: 31.2 });
      expect(hint!.message).toContain('14 commits');
      expect(hint!.message).toContain('worst update 31ms'); // rounded in prose
      expect(hint!.message).not.toContain('total re-render time'); // no updateTotalMs
    });

    it('enriches message + evidence with updateTotalMs when present', () => {
      const [hint] = computePerfHints({ commitCount: 14, updateMs: 31.2, updateTotalMs: 122.4 });
      expect(hint!.evidence).toEqual({ commitCount: 14, updateMs: 31.2, updateTotalMs: 122.4 });
      expect(hint!.message).toContain('(122ms total re-render time)');
    });

    it('does not fire at 9 commits or a 16ms worst update', () => {
      expect(computePerfHints({ commitCount: 9, updateMs: 40 })).toEqual([]);
      expect(computePerfHints({ commitCount: 20, updateMs: 16 })).toEqual([]);
    });
  });

  describe('interaction-rerender-hotspot', () => {
    it('fires when a >16ms update costs >= 3x the mount', () => {
      const [hint] = computePerfHints({ mountMs: 8, updateMs: 24 });
      expect(hint).toMatchObject({ rule: 'interaction-rerender-hotspot', severity: 'warn' });
      expect(hint!.evidence).toEqual({ updateMs: 24, mountMs: 8 });
      expect(hint!.message).toContain('24ms vs 8ms');
    });

    it('does not fire under 16ms, under 3x, or with mountMs 0', () => {
      expect(computePerfHints({ mountMs: 1, updateMs: 15 })).toEqual([]);
      expect(computePerfHints({ mountMs: 10, updateMs: 29 })).toEqual([]);
      expect(computePerfHints({ mountMs: 0, updateMs: 40 })).toEqual([]);
    });
  });

  describe('slow-mount', () => {
    it('fires above the 50ms long-task boundary, not at it', () => {
      expect(computePerfHints({ mountMs: 50 })).toEqual([]);
      const [hint] = computePerfHints({ mountMs: 80.6 });
      expect(hint).toMatchObject({ rule: 'slow-mount', severity: 'warn' });
      expect(hint!.evidence).toEqual({ mountMs: 80.6 });
      expect(hint!.message).toContain('81ms');
    });
  });

  describe('blocking-resources', () => {
    it('fires on a >=1000ms load-FCP gap with both inputs present', () => {
      const [hint] = computePerfHints({ loadMs: 2450, firstContentfulPaintMs: 1000 });
      expect(hint).toMatchObject({ rule: 'blocking-resources', severity: 'info' });
      expect(hint!.evidence).toEqual({ loadMs: 2450, firstContentfulPaintMs: 1000 });
      expect(hint!.message).toContain('1450ms after first paint');
    });

    it('does not fire on a 999ms gap or when either input is missing', () => {
      expect(computePerfHints({ loadMs: 1999, firstContentfulPaintMs: 1000 })).toEqual([]);
      expect(computePerfHints({ loadMs: 5000 })).toEqual([]);
      expect(computePerfHints({ firstContentfulPaintMs: 100 })).toEqual([]);
    });

    it('structurally cannot fire on the native metric subset', () => {
      // NativePerf carries readyMs/mountMs/updateMs/commitCount only.
      const native: PerformanceMetrics = { readyMs: 900, mountMs: 4, updateMs: 3, commitCount: 5 };
      expect(computePerfHints(native).some((h) => h.rule === 'blocking-resources')).toBe(false);
    });
  });

  describe('slow-ready', () => {
    it('fires above the red threshold, not at it', () => {
      expect(computePerfHints({ readyMs: 1000 })).toEqual([]);
      const [hint] = computePerfHints({ readyMs: 4200 });
      expect(hint).toMatchObject({ rule: 'slow-ready', severity: 'info' });
      expect(hint!.evidence).toEqual({ readyMs: 4200 });
      expect(hint!.message).toContain('4200ms');
    });

    // The old copy blamed "dev-transform overhead", which is now subtracted
    // out — pointing the reader at the harness would send them the wrong way.
    it('points at the component, not the harness', () => {
      const [hint] = computePerfHints({ readyMs: 4200 });
      expect(hint!.message).toContain('already subtracted');
      expect(hint!.message).not.toContain('includes dev-transform overhead');
    });
  });

  it('all rules firing: warn-first rule order, capped at 4', () => {
    const pathological: PerformanceMetrics = {
      loadMs: 9000,
      firstContentfulPaintMs: 4000,
      readyMs: 5000,
      mountMs: 60,
      updateMs: 300,
      commitCount: 40,
      updateTotalMs: 2000,
    };
    const hints = computePerfHints(pathological);
    expect(hints.length).toBe(4);
    expect(hints.map((h) => h.rule)).toEqual([
      'excessive-rerenders',
      'interaction-rerender-hotspot',
      'slow-mount',
      'blocking-resources',
    ]);
    expect(hints.map((h) => h.severity)).toEqual(['warn', 'warn', 'warn', 'info']);
  });
});

describe('formatPerfHintsBlock', () => {
  it('returns undefined for no hints', () => {
    expect(formatPerfHintsBlock([], 'base')).toBeUndefined();
  });

  it('carries the advisory header, label, glyphs, and arrow-note', () => {
    const hints = computePerfHints({ commitCount: 14, updateMs: 31.2, updateTotalMs: 122.4 });
    const block = formatPerfHintsBlock(hints, 'base')!;
    expect(block).toContain(
      "Perf hints under 'base' (advisory — measured in the sandbox, never part of the verdict):",
    );
    expect(block).toContain('▲ warn excessive re-renders');
    expect(block).toContain('→ These are heuristics from measured render timings.');
    expect(block).toContain('They do not affect any criterion verdict');
  });

  it('renders the info glyph for info hints', () => {
    const hints = computePerfHints({ loadMs: 2500, firstContentfulPaintMs: 1000 });
    const block = formatPerfHintsBlock(hints, 'empty')!;
    expect(block).toContain("under 'empty'");
    expect(block).toContain('· info page load finished');
  });
});
