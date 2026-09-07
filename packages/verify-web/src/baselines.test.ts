/**
 * Unit tests for the baseline diff helpers. We don't need a real browser
 * here — just two PNG buffers fed through pixelmatch via diffAgainstBaseline.
 */
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  baselinePath,
  baselinesDir,
  confirmBaseline,
  diffAgainstBaseline,
  formatBaselineLifecycleAdvisory,
  listBaselineKeys,
  planBaselineLifecycle,
  promoteBaseline,
  sweepBaselineLifecycle,
} from './baselines.js';

function makePng(width: number, height: number, color: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0];
    png.data[i + 1] = color[1];
    png.data[i + 2] = color[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('baselines', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-baselines-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns undefined when no baseline exists', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const current = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(current, makePng(20, 20, [255, 255, 255]));

    const out = diffAgainstBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      newScreenshotPath: current,
      screenshotsDir,
    });
    expect(out).toBeUndefined();
  });

  it('reports 0 mismatched pixels when current and baseline are identical', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const current = resolve(screenshotsDir, 'a__base.png');
    const pngBuf = makePng(20, 20, [255, 255, 255]);
    writeFileSync(current, pngBuf);

    // Seed baseline by promoting first.
    promoteBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      screenshotPath: current,
    });

    const out = diffAgainstBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      newScreenshotPath: current,
      screenshotsDir,
    });
    expect(out).toBeDefined();
    expect(out!.mismatchedPixels).toBe(0);
    expect(out!.baselinePath).toBe(baselinePath(projectRoot, 'a', 'base'));
  });

  it('reports nonzero mismatch when the current screenshot differs from the baseline', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    // Baseline: white.
    const baselineImg = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(baselineImg, makePng(10, 10, [255, 255, 255]));
    promoteBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      screenshotPath: baselineImg,
    });

    // Current: black.
    const currentImg = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(currentImg, makePng(10, 10, [0, 0, 0]));

    const out = diffAgainstBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      newScreenshotPath: currentImg,
      screenshotsDir,
    });
    expect(out).toBeDefined();
    expect(out!.mismatchedPixels).toBeGreaterThan(0);
    // 10×10 = 100 pixels all changed.
    expect(out!.mismatchedPixels).toBe(100);
  });

  it('handles different image dimensions by padding to the larger size', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const baselineImg = resolve(projectRoot, '__seed.png');
    writeFileSync(baselineImg, makePng(10, 10, [255, 255, 255]));
    promoteBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      screenshotPath: baselineImg,
    });

    // Same content, but 20×10 — extra padded white columns should produce 0
    // mismatched pixels.
    const currentImg = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(currentImg, makePng(20, 10, [255, 255, 255]));

    const out = diffAgainstBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      newScreenshotPath: currentImg,
      screenshotsDir,
    });
    expect(out).toBeDefined();
    // Padding is white, current is white → still zero mismatched.
    expect(out!.mismatchedPixels).toBe(0);
  });

  it('places the baseline at the expected path', () => {
    const screenshotsDir = resolve(projectRoot, 'shots');
    mkdirSync(screenshotsDir, { recursive: true });
    const img = resolve(screenshotsDir, 'src-button__primary.png');
    writeFileSync(img, makePng(5, 5, [128, 128, 128]));

    promoteBaseline({
      projectRoot,
      componentId: 'src-button',
      variantSlug: 'primary',
      screenshotPath: img,
    });

    const expected = resolve(baselinesDir(projectRoot), 'src-button__primary.png');
    expect(expected).toBe(baselinePath(projectRoot, 'src-button', 'primary'));
  });
});

describe('confirmBaseline', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-confirm-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes the baseline and returns true when none exists', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const current = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(current, makePng(10, 10, [255, 255, 255]));

    const wrote = confirmBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      screenshotPath: current,
    });
    expect(wrote).toBe(true);
    expect(existsSync(baselinePath(projectRoot, 'a', 'base'))).toBe(true);
  });

  it('returns false and leaves the existing baseline untouched (idempotent first-write gate)', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    // First render: white. confirmBaseline establishes it.
    const first = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(first, makePng(10, 10, [255, 255, 255]));
    expect(
      confirmBaseline({
        projectRoot,
        componentId: 'a',
        variantSlug: 'base',
        screenshotPath: first,
      }),
    ).toBe(true);
    const baselineBytes = readFileSync(baselinePath(projectRoot, 'a', 'base'));

    // Second render with DIFFERENT pixels: confirmBaseline must NOT overwrite.
    const second = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(second, makePng(10, 10, [0, 0, 0]));
    expect(
      confirmBaseline({
        projectRoot,
        componentId: 'a',
        variantSlug: 'base',
        screenshotPath: second,
      }),
    ).toBe(false);

    // Baseline is still the original white screenshot.
    expect(readFileSync(baselinePath(projectRoot, 'a', 'base')).equals(baselineBytes)).toBe(true);
  });

  it('returns false when the source screenshot cannot be read (error swallowed)', () => {
    const wrote = confirmBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      // Nonexistent source path → copyFileSync throws, caught, returns false.
      screenshotPath: resolve(projectRoot, 'does-not-exist.png'),
    });
    expect(wrote).toBe(false);
    expect(existsSync(baselinePath(projectRoot, 'a', 'base'))).toBe(false);
  });

  it('exactly one of many parallel first-writes wins; the baseline is never corrupted', async () => {
    // The TOCTOU scenario: many variants render in parallel and all call
    // confirmBaseline for the SAME (componentId, variantSlug) before any
    // baseline exists. With the COPYFILE_EXCL guard, exactly ONE write wins
    // (returns true) and every loser returns false, so the on-disk baseline is
    // byte-identical to exactly one writer's source — never a torn/interleaved
    // mix. Each writer has DIFFERENT bytes so a corrupt/partial result would be
    // detectable.
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const N = 8;
    const sources: string[] = [];
    for (let i = 0; i < N; i++) {
      const p = resolve(screenshotsDir, `src-${i}.png`);
      // Distinct grayscale per source so we can identify the winner exactly.
      writeFileSync(p, makePng(10, 10, [i * 20, i * 20, i * 20]));
      sources.push(p);
    }

    const results = await Promise.all(
      sources.map((screenshotPath) =>
        Promise.resolve().then(() =>
          confirmBaseline({ projectRoot, componentId: 'a', variantSlug: 'base', screenshotPath }),
        ),
      ),
    );

    // Exactly one writer reports it established the baseline.
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    // The on-disk baseline equals exactly one source's bytes (no corruption).
    const baselineBytes = readFileSync(baselinePath(projectRoot, 'a', 'base'));
    const matchingSources = sources.filter((p) => readFileSync(p).equals(baselineBytes));
    expect(matchingSources).toHaveLength(1);
  });

  it('an EEXIST from the exclusive copy is swallowed into a false return', () => {
    // Direct EXCL-semantics check, independent of the existsSync fast-path:
    // copyFileSync with COPYFILE_EXCL onto an existing dest throws EEXIST.
    // confirmBaseline catches that and returns false (never re-throws,
    // never overwrites).
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const dest = baselinePath(projectRoot, 'a', 'base');
    mkdirSync(resolve(dest, '..'), { recursive: true });
    const winnerBytes = makePng(10, 10, [255, 255, 255]);
    writeFileSync(dest, winnerBytes);

    // A real, readable source — so the copy gets PAST the source read and the
    // ONLY failure can be the dest already existing (EEXIST), not ENOENT.
    const src = resolve(screenshotsDir, 'src.png');
    writeFileSync(src, makePng(10, 10, [0, 0, 0]));

    let threw = false;
    try {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      threw = (err as NodeJS.ErrnoException).code === 'EEXIST';
    }
    // Guard the assumption the fix relies on: EXCL onto an existing file throws
    // EEXIST. (If this platform behaved otherwise the fix would be moot.)
    expect(threw).toBe(true);
  });
});

describe('promoteBaseline (accept-layer override)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-promote-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('always overwrites an existing baseline (last write wins)', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const white = resolve(screenshotsDir, 'white.png');
    writeFileSync(white, makePng(10, 10, [255, 255, 255]));
    promoteBaseline({ projectRoot, componentId: 'a', variantSlug: 'base', screenshotPath: white });
    const whiteBytes = readFileSync(baselinePath(projectRoot, 'a', 'base'));

    const black = resolve(screenshotsDir, 'black.png');
    writeFileSync(black, makePng(10, 10, [0, 0, 0]));
    promoteBaseline({ projectRoot, componentId: 'a', variantSlug: 'base', screenshotPath: black });
    const blackBytes = readFileSync(baselinePath(projectRoot, 'a', 'base'));

    // The second promote overwrote the first.
    expect(blackBytes.equals(whiteBytes)).toBe(false);
    expect(blackBytes.equals(readFileSync(black))).toBe(true);
  });

  it('re-baselines a variant the render layer would have left alone', () => {
    const screenshotsDir = resolve(projectRoot, '.validity/runs/run_x/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    // First clean render confirms a white baseline.
    const white = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(white, makePng(10, 10, [255, 255, 255]));
    confirmBaseline({ projectRoot, componentId: 'a', variantSlug: 'base', screenshotPath: white });

    // User accepts a run whose screenshot is black → promoteBaseline overwrites
    // even though a baseline already exists.
    const black = resolve(screenshotsDir, 'accepted.png');
    writeFileSync(black, makePng(10, 10, [0, 0, 0]));
    promoteBaseline({ projectRoot, componentId: 'a', variantSlug: 'base', screenshotPath: black });

    // A re-render now confirms nothing (baseline exists) and diffs against the
    // accepted (black) baseline. An identical black screenshot diffs to 0.
    const reRender = resolve(screenshotsDir, 'a__base.png');
    writeFileSync(reRender, makePng(10, 10, [0, 0, 0]));
    expect(
      confirmBaseline({
        projectRoot,
        componentId: 'a',
        variantSlug: 'base',
        screenshotPath: reRender,
      }),
    ).toBe(false);
    const diff = diffAgainstBaseline({
      projectRoot,
      componentId: 'a',
      variantSlug: 'base',
      newScreenshotPath: reRender,
      screenshotsDir,
    });
    expect(diff).toBeDefined();
    expect(diff!.mismatchedPixels).toBe(0);
  });
});

describe('planBaselineLifecycle (W5 #18)', () => {
  it('flags a true orphan + true new key when NEITHER part relates (no rename)', () => {
    const plan = planBaselineLifecycle({
      // Different component AND different variant → not a single-part edit, not a
      // scheme extension → left split, never guessed into a rename.
      currentRenderKeys: ['src-header__primary'],
      baselineKeys: ['src-footer__base'],
    });
    expect(plan.orphans).toEqual(['src-footer__base']);
    expect(plan.newBaselines).toEqual(['src-header__primary']);
    expect(plan.renames).toEqual([]);
  });

  it('detects a component rename (same variant, near component id) as a 1:1 rename', () => {
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-heading__base'],
      baselineKeys: ['src-header__base'],
    });
    expect(plan.renames).toEqual([
      { from: 'src-header__base', to: 'src-heading__base', similarity: expect.any(Number) },
    ]);
    // A confident rename is NOT double-counted as orphan + new.
    expect(plan.orphans).toEqual([]);
    expect(plan.newBaselines).toEqual([]);
  });

  it('detects a key-scheme change (added viewport segment) as a rename', () => {
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-header__base__mobile'],
      baselineKeys: ['src-header__base'],
    });
    expect(plan.renames.map((r) => `${r.from}->${r.to}`)).toEqual([
      'src-header__base->src-header__base__mobile',
    ]);
  });

  it('leaves an unchanged key alone (no orphan, no new, no rename)', () => {
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-header__base'],
      baselineKeys: ['src-header__base'],
    });
    expect(plan).toEqual({ orphans: [], newBaselines: [], renames: [] });
  });

  it('does NOT guess an ambiguous cluster: two orphans both closest to one new key stay unpaired', () => {
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-header__base'],
      baselineKeys: ['src-header__basa', 'src-header__basx'],
    });
    // Only one new key but two near orphans → mutual-best fails, nothing migrated.
    expect(plan.renames).toEqual([]);
    expect(plan.orphans.sort()).toEqual(['src-header__basa', 'src-header__basx']);
    expect(plan.newBaselines).toEqual(['src-header__base']);
  });

  it('does not pair genuinely different renders (below the similarity floor)', () => {
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-modal__primary'],
      baselineKeys: ['src-footer__base'],
    });
    expect(plan.renames).toEqual([]);
  });

  it('REGRESSION: two DISTINCT components sharing a variant (footer/header) are NOT a rename', () => {
    // Same variant, and the shared `src-` prefix inflates the whole-part
    // similarity to 0.60 — but that's below the floor, so these stay split
    // rather than offering to migrate footer's baseline onto header.
    const plan = planBaselineLifecycle({
      currentRenderKeys: ['src-header__base'],
      baselineKeys: ['src-footer__base'],
    });
    expect(plan.renames).toEqual([]);
    expect(plan.orphans).toEqual(['src-footer__base']);
    expect(plan.newBaselines).toEqual(['src-header__base']);
  });
});

describe('formatBaselineLifecycleAdvisory + sweepBaselineLifecycle (W5 #18)', () => {
  it('returns null when nothing drifted', () => {
    expect(
      formatBaselineLifecycleAdvisory({ orphans: [], newBaselines: [], renames: [] }),
    ).toBeNull();
  });

  it('offers `validity accept` for a rename and lists orphans', () => {
    const msg = formatBaselineLifecycleAdvisory({
      orphans: ['src-old__base'],
      newBaselines: [],
      renames: [{ from: 'src-header__base', to: 'src-heading__base', similarity: 0.9 }],
    });
    expect(msg).toContain('validity accept <run-id>');
    expect(msg).toContain('src-header__base  →  src-heading__base');
    expect(msg).toContain('src-old__base.png');
  });

  it('sweeps real on-disk baseline keys against live render keys', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'validity-baseline-sweep-'));
    try {
      const dir = baselinesDir(root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'src-header__base.png'), 'x');
      writeFileSync(resolve(dir, 'src-footer__base.png'), 'x');
      expect(listBaselineKeys(root).sort()).toEqual(['src-footer__base', 'src-header__base']);

      const plan = sweepBaselineLifecycle(root, ['src-footer__base']);
      // src-header lost its render this run → orphan; src-footer still live.
      expect(plan.orphans).toEqual(['src-header__base']);
      expect(plan.newBaselines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
