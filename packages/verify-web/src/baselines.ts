/**
 * Baseline screenshots + pixel diff vs. the last passing run.
 *
 * Flow:
 *   - After every render, if the render didn't error, `confirmBaseline()` is
 *     called to copy that screenshot to `.validity/baselines/{key}.png` — but
 *     only when no baseline exists yet (first-render write). The key is
 *     `{componentId}__{variantSlug}` — matching the existing screenshot
 *     filename inside each run dir.
 *   - On the NEXT render with the same key, `diffAgainstBaseline()` produces
 *     a pixel-diff PNG using `pixelmatch` and returns the mismatched-pixel
 *     count. The diff is written to the run dir (not the baseline dir) so it
 *     ships with the run-meta and report.
 *
 * Two distinct promotion paths, intentionally:
 *   - The RENDER LAYER uses `confirmBaseline()` — a write-if-missing gate. The
 *     first clean render establishes the baseline; every later render diffs
 *     against that established baseline rather than silently overwriting it.
 *     This keeps `validity accept` the only way to *re-baseline* an existing
 *     variant: the render layer never clobbers a baseline a user has accepted.
 *   - The ACCEPT COMMAND (`validity accept <run-id>`) uses `promoteBaseline()`
 *     — an unconditional, last-write-wins overwrite. This is the user-facing
 *     override to promote any run's screenshots as the new baseline.
 *
 * We don't gate either on the agent's verdict because the verdict isn't known
 * at verify time (`submit_report` arrives later); verdicts and baselines are
 * orthogonal. The worst case for the first-render write is an "ugly" screenshot
 * becoming the initial baseline, which the next run reports a zero-pixel diff
 * against until the user re-baselines via `validity accept`.
 *
 * The `pixelmatch` dep is used in headless Node — no DOM, just raw PNG
 * buffers via `pngjs`. We auto-resize the smaller image with whitespace
 * padding when dimensions don't match, since `pixelmatch` requires identical
 * dimensions and React components legitimately change height between renders
 * (e.g., loading vs. loaded). The pad bytes count as "changed" pixels which
 * is the right signal — the layout shifted.
 */
import {
  readdirSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Project-relative location for baselines. Auto-gitignored. */
export function baselinesDir(projectRoot: string): string {
  return resolve(projectRoot, '.validity', 'baselines');
}

/** Stable filename for the baseline of a given (componentId, variantSlug). */
export function baselinePath(
  projectRoot: string,
  componentId: string,
  variantSlug: string,
): string {
  return resolve(baselinesDir(projectRoot), `${componentId}__${variantSlug}.png`);
}

/** Stable filename for a diff PNG, written to the run dir. */
export function diffPathFor(
  screenshotsDir: string,
  componentId: string,
  variantSlug: string,
): string {
  return resolve(screenshotsDir, `${componentId}__${variantSlug}.diff.png`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Read a PNG file and return the parsed `PNG` instance (with `data`, `width`,
 * `height`). Returns undefined on read or parse failure — baselines are
 * best-effort and must never break a render.
 */
function readPng(path: string): PNG | undefined {
  try {
    const buf = readFileSync(path);
    return PNG.sync.read(buf);
  } catch {
    return undefined;
  }
}

/**
 * Resize a PNG to (width, height) by padding with white. Used when the
 * baseline and current screenshots have different dimensions, since
 * `pixelmatch` rejects mismatched sizes. The pad pixels register as
 * "changed" which correctly signals "the layout differs."
 */
function padToSize(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  // Fill white (255,255,255,255).
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  const minW = Math.min(png.width, width);
  const minH = Math.min(png.height, height);
  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      const src = (y * png.width + x) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = png.data[src]!;
      out.data[dst + 1] = png.data[src + 1]!;
      out.data[dst + 2] = png.data[src + 2]!;
      out.data[dst + 3] = png.data[src + 3]!;
    }
  }
  return out;
}

export interface BaselineDiffResult {
  /** Path of the baseline that was compared against. */
  baselinePath: string;
  /** Number of pixels that differ. 0 = byte-identical (after any padding). */
  mismatchedPixels: number;
  /** Path of the written diff PNG. */
  diffPath: string;
  /** Filesystem mtime of the baseline file, ISO. */
  takenAt: string;
}

/**
 * If a baseline exists for `(componentId, variantSlug)`, compute a pixel
 * diff between it and the new screenshot and write a diff PNG to the run dir.
 * Returns undefined when no baseline exists (or anything in the pipeline
 * fails — best-effort). Never throws.
 */
export function diffAgainstBaseline(args: {
  projectRoot: string;
  componentId: string;
  variantSlug: string;
  newScreenshotPath: string;
  screenshotsDir: string;
}): BaselineDiffResult | undefined {
  try {
    const bPath = baselinePath(args.projectRoot, args.componentId, args.variantSlug);
    if (!existsSync(bPath)) return undefined;

    const baseline = readPng(bPath);
    const current = readPng(args.newScreenshotPath);
    if (!baseline || !current) return undefined;

    const width = Math.max(baseline.width, current.width);
    const height = Math.max(baseline.height, current.height);
    const a = padToSize(baseline, width, height);
    const b = padToSize(current, width, height);
    const diff = new PNG({ width, height });

    const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
      threshold: 0.1,
      includeAA: false,
    });

    const diffPath = diffPathFor(args.screenshotsDir, args.componentId, args.variantSlug);
    ensureDir(dirname(diffPath));
    writeFileSync(diffPath, PNG.sync.write(diff));

    // Use mtime of the baseline file as "takenAt". Cheap and stable; mirrors
    // what `validity accept` writes when promoting screenshots.
    let takenAt = new Date().toISOString();
    try {
      const stat = statSync(bPath);
      takenAt = stat.mtime.toISOString();
    } catch {
      // Fall back to now.
    }

    return {
      baselinePath: bPath,
      mismatchedPixels: mismatched,
      diffPath,
      takenAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Render-layer baseline gate: copy the current screenshot to the baseline dir
 * ONLY when no baseline exists yet for this `(componentId, variantSlug)`. The
 * first clean render establishes the baseline; every later render diffs against
 * that established baseline instead of overwriting it. Re-baselining an
 * existing variant is reserved for `validity accept` (which uses
 * `promoteBaseline`).
 *
 * Returns `true` when it wrote the initial baseline, `false` when a baseline
 * already existed or the write failed. Failures are swallowed — a missing
 * baseline just means no diff next time, which is the same as the first-run
 * state.
 *
 * CONCURRENCY: the existsSync pre-check is NOT relied on for correctness — it's
 * only a fast path to skip the copy + return `false` without touching the disk.
 * The actual write uses `COPYFILE_EXCL`, which makes the copy fail with EEXIST
 * if the destination appeared between the check and the write. That closes the
 * TOCTOU window where two variants rendering in parallel (e.g. a single
 * renderComponents call fanning out specs × fixtures) would both see "no
 * baseline" and then both write, racing to clobber each other's bytes. With
 * EXCL, exactly ONE writer wins (returns `true`); every loser sees EEXIST and
 * returns `false`, leaving the winner's baseline intact.
 */
export function confirmBaseline(args: {
  projectRoot: string;
  componentId: string;
  variantSlug: string;
  screenshotPath: string;
}): boolean {
  try {
    const dest = baselinePath(args.projectRoot, args.componentId, args.variantSlug);
    // Fast path only — not the correctness guard (see COPYFILE_EXCL below).
    if (existsSync(dest)) return false;
    ensureDir(dirname(dest));
    try {
      copyFileSync(args.screenshotPath, dest, fsConstants.COPYFILE_EXCL);
      return true;
    } catch (err) {
      // A concurrent render won the race and created the baseline between our
      // existsSync and this copy — EEXIST is the expected, non-fatal outcome:
      // the established baseline is kept, we just report "didn't write".
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  } catch {
    // Non-fatal.
    return false;
  }
}

/**
 * Accept-layer baseline override: copy the current screenshot to the baseline
 * dir unconditionally (last write wins). Used by `validity accept <run-id>` to
 * re-baseline a variant from a chosen run. The render layer (web and native)
 * must NOT use this — it uses `confirmBaseline` so it never clobbers an
 * accepted baseline (which would let a real regression self-heal into green).
 *
 * Safe to call repeatedly: copying is idempotent. Failures are swallowed — a
 * missing baseline just means no diff next time, which is the same as the
 * first-run state.
 */
export function promoteBaseline(args: {
  projectRoot: string;
  componentId: string;
  variantSlug: string;
  screenshotPath: string;
}): void {
  try {
    const dest = baselinePath(args.projectRoot, args.componentId, args.variantSlug);
    ensureDir(dirname(dest));
    copyFileSync(args.screenshotPath, dest);
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ *
 * Baseline lifecycle (W5 #18).                                       *
 *                                                                    *
 * A baseline is keyed `<componentId>__<variantSlug>.png`. When a     *
 * component is renamed or the variant key-scheme changes (a viewport *
 * or theme segment is added), the OLD key stops being rendered and   *
 * its PNG orphans — while the NEW key has no baseline, so the very    *
 * next render self-establishes as known-good and a real regression   *
 * is baked in with a zero-pixel diff. This sweep compares this run's *
 * live render keys against the baselines on disk, flags orphans, and *
 * pairs an orphan with a baseline-less new key when they're a strong *
 * 1:1 near-match (a rename) so the tool can OFFER `validity accept`   *
 * to migrate the baseline instead of silently re-establishing it.    *
 * ------------------------------------------------------------------ */

/** The `<componentId>__<variantSlug>` keys of the baseline PNGs on disk. */
export function listBaselineKeys(projectRoot: string): string[] {
  const dir = baselinesDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -'.png'.length));
  } catch {
    return [];
  }
}

/** A confident orphan→new pairing: the same baseline, re-keyed. */
export interface BaselineRename {
  from: string;
  to: string;
  /** Normalized similarity [0,1] of the two keys (higher = more confident). */
  similarity: number;
}

export interface BaselineLifecyclePlan {
  /** Baseline keys with no live render this run and no rename match. */
  orphans: string[];
  /** Live render keys with no baseline yet and no rename match. */
  newBaselines: string[];
  /** Orphan→new pairs a rename would migrate (strong, mutual-best, 1:1). */
  renames: BaselineRename[];
}

/** Levenshtein edit distance (small, pure — keys are short filenames). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** Similarity in [0,1]: 1 − normalized edit distance over the longer string. */
function keySimilarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - editDistance(a, b) / longer;
}

/** Split a `componentId__variantSlug` key at the FIRST `__` (the variant may
 *  carry its own `__`-joined segments — viewport/theme/dataState). */
function keyParts(key: string): { comp: string; variant: string } {
  const i = key.indexOf('__');
  return i === -1
    ? { comp: key, variant: '' }
    : { comp: key.slice(0, i), variant: key.slice(i + 2) };
}

/**
 * Minimum similarity of the CHANGED half of a single-part rename. Component ids
 * share a directory prefix (`src-…`), so the whole-part metric runs high — the
 * bar is tuned against that: a real re-slug `src-header`→`src-heading` (0.73)
 * clears it, while two DISTINCT components sharing a variant,
 * `src-footer`→`src-header` (0.60), fall just below and stay split into
 * orphan + new. Conservative on purpose — a wrong rename would offer to migrate
 * a stale baseline over a real one. (The unambiguous scheme-extension case —
 * `…__base` ↔ `…__base__mobile` — bypasses this floor entirely at 0.95.)
 */
export const BASELINE_RENAME_SIMILARITY = 0.65;

/**
 * Structural rename confidence for an (orphan, newKey) pair, or `null` when they
 * are not a confident rename. Two shapes qualify — both localize the change to
 * ONE recognizable edit, which is what a rename or a key-scheme tweak actually
 * is (as opposed to two unrelated renders that merely share a substring):
 *   1. SCHEME extension/truncation: one key is the other plus a trailing
 *      `__segment` (e.g. `…__base` ↔ `…__base__mobile` when a viewport axis is
 *      added). Highest confidence — the shared key is an exact prefix.
 *   2. SINGLE-PART edit: exactly one of {componentId, variant} is IDENTICAL and
 *      the other is a near-match ≥ {@link BASELINE_RENAME_SIMILARITY} (a file
 *      rename keeps the variant; a variant re-slug keeps the component).
 */
function renameConfidence(orphan: string, newKey: string): number | null {
  if (orphan === newKey) return null;
  if (newKey.startsWith(orphan + '__') || orphan.startsWith(newKey + '__')) return 0.95;
  const o = keyParts(orphan);
  const n = keyParts(newKey);
  if (o.variant === n.variant && o.comp !== n.comp) {
    const s = keySimilarity(o.comp, n.comp);
    return s >= BASELINE_RENAME_SIMILARITY ? s : null;
  }
  if (o.comp === n.comp && o.variant !== n.variant) {
    const s = keySimilarity(o.variant, n.variant);
    return s >= BASELINE_RENAME_SIMILARITY ? s : null;
  }
  return null;
}

/** Top candidate for `key` in `pool` (by confidence), and whether it's a
 *  STRICT winner — no other candidate ties it. A tie means "ambiguous, don't
 *  guess", so the pair is left unmatched. */
function topCandidate(
  key: string,
  pool: string[],
): { key: string; confidence: number; strict: boolean } | null {
  let best: { key: string; confidence: number } | null = null;
  let tie = false;
  for (const other of pool) {
    const confidence = renameConfidence(key, other);
    if (confidence == null) continue;
    if (!best || confidence > best.confidence) {
      best = { key: other, confidence };
      tie = false;
    } else if (confidence === best.confidence) {
      tie = true;
    }
  }
  return best ? { ...best, strict: !tie } : null;
}

/**
 * PURE lifecycle planner (unit-testable without disk). Orphans and new keys are
 * the set differences; a rename is a MUTUAL, STRICT, structural best-match
 * between an orphan and a baseline-less new key (see {@link renameConfidence}).
 * "Mutual" = each is the other's top candidate; "strict" = neither side has a
 * tie for the top — so an ambiguous cluster (two orphans equally close to one
 * new key) is left split into orphans + new rather than guessed. Deterministic.
 */
export function planBaselineLifecycle(args: {
  currentRenderKeys: string[];
  baselineKeys: string[];
}): BaselineLifecyclePlan {
  const current = new Set(args.currentRenderKeys);
  const baseline = new Set(args.baselineKeys);
  const orphans = [...args.baselineKeys].filter((k) => !current.has(k)).sort();
  const news = [...args.currentRenderKeys].filter((k) => !baseline.has(k)).sort();

  const renames: BaselineRename[] = [];
  const pairedOrphans = new Set<string>();
  const pairedNews = new Set<string>();
  for (const orphan of orphans) {
    const forward = topCandidate(orphan, news);
    if (!forward || !forward.strict) continue;
    const back = topCandidate(forward.key, orphans);
    // Mutual + strict both ways: the new key's own unambiguous top orphan is
    // THIS orphan. Anything less is left unpaired.
    if (!back || !back.strict || back.key !== orphan) continue;
    renames.push({ from: orphan, to: forward.key, similarity: forward.confidence });
    pairedOrphans.add(orphan);
    pairedNews.add(forward.key);
  }

  return {
    orphans: orphans.filter((k) => !pairedOrphans.has(k)),
    newBaselines: news.filter((k) => !pairedNews.has(k)),
    renames,
  };
}

/**
 * Human-facing advisory for a lifecycle plan, or `null` when nothing drifted.
 * Names the likely renames (offering `validity accept` to migrate the baseline)
 * and lists true orphans that can be pruned. Advisory only — never a gate.
 */
export function formatBaselineLifecycleAdvisory(plan: BaselineLifecyclePlan): string | null {
  if (plan.renames.length === 0 && plan.orphans.length === 0) return null;
  const lines: string[] = [];
  if (plan.renames.length > 0) {
    lines.push(
      `Baseline key(s) look renamed — re-baseline with \`validity accept <run-id>\` to migrate:`,
    );
    for (const r of plan.renames) lines.push(`  ${r.from}  →  ${r.to}`);
  }
  if (plan.orphans.length > 0) {
    lines.push(
      `Orphaned baseline(s) with no live render (safe to delete from .validity/baselines/):`,
    );
    for (const o of plan.orphans) lines.push(`  ${o}.png`);
  }
  return lines.join('\n');
}

/**
 * IO wrapper: sweep the on-disk baselines against this run's live render keys.
 * Best-effort — a missing baselines dir just yields an all-new plan.
 */
export function sweepBaselineLifecycle(
  projectRoot: string,
  currentRenderKeys: string[],
): BaselineLifecyclePlan {
  return planBaselineLifecycle({
    currentRenderKeys,
    baselineKeys: listBaselineKeys(projectRoot),
  });
}
