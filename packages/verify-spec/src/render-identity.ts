/**
 * Render identity — byte-level "did this render actually change?" primitives
 * shared by lean verify (@validity.ai/verify, response trimming + soft-score
 * carry-forward) and the watch tick (@validity.ai/verify, staleness input).
 *
 * The load-bearing rule both consumers encode: a soft score rests on the
 * PIXELS the judge saw, so evidence proven byte-identical to what was scored
 * is still-valid evidence — a code change that provably didn't change the
 * render must not stale the score (and must not reset the certification
 * streak). Everything here is pure given file paths; the failure mode is
 * always "not proven identical" (keep/stale — the safe direction), never a
 * false identity.
 *
 * The fold input (`renderUnchangedForFold`) is scoped PER SPEC: a watch tick
 * renders whatever the working tree changed (`git diff HEAD`), so one run's
 * render set routinely carries sibling components — and, until excluded,
 * `.validity` infra — that have nothing to do with the spec being folded.
 * Identity is a statement about the spec's OWN target renders only; a dirty,
 * errored, or newly-added sibling must never stale this spec's carried scores
 * or reset its certification streak. Over-including a render in the target
 * filter is the safe error (an extra render can only stale, never fake
 * identity); under-including a changed target could fake a `true`, so the
 * matching mirrors how targets were SELECTED (`orderTargetsFirst` in run.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ComponentRender } from './types.js';
import type { CriterionVerdict } from './spec-schema.js';
import type { RunMeta } from './run.js';

/**
 * Stable cross-run key for a render: the screenshot basename sans `.png`
 * (`componentId__variantSlug`). Both the web sandbox and the native capture
 * path derive the filename deterministically from component id + scenario +
 * fixture + viewport + colorScheme (+ forced dataState), so the SAME variant
 * lands on the SAME key run after run — and distinct variants can never
 * collide (they'd have overwritten each other's PNG).
 */
export function renderKeyFor(r: Pick<ComponentRender, 'screenshotPath'>): string {
  return basename(r.screenshotPath).replace(/\.png$/i, '');
}

/**
 * Does the previous run's provenance bind to the CURRENT frozen content?
 * Carry-forward (and the auto-lean default) may never cross a re-freeze: a
 * soft pass scored against v1's criterion text is not evidence for v2's —
 * same criterion id, different contract. The binding is keyed on the frozen
 * content hash when both sides carry one; hash-less provenance (pre-hash
 * run-meta / hand-written spec) falls back to the spec VERSION, which is
 * immutable once frozen — a re-freeze always mints v+1, so an equal version
 * pins equal criterion text. Nothing provable on either axis ⇒ false ⇒ full
 * detail, every soft criterion OPEN (the safe direction).
 */
export function prevRunMatchesSpec(
  meta: Pick<RunMeta, 'specHash' | 'specVersion'> | undefined,
  spec: { hash?: string; version?: number } | undefined,
): boolean {
  if (!meta || !spec) return false;
  if (meta.specHash && spec.hash) return meta.specHash === spec.hash;
  return meta.specVersion != null && meta.specVersion === spec.version;
}

/** One previous-run render index, keyed for matching against the current run. */
export interface PrevRenderIndex {
  runId: string;
  createdAt: string;
  /** renderKey -> that run's screenshot path. EVIDENCE renders only. */
  shots: Map<string, string>;
  /**
   * renderKey -> the sha256 recorded in that run's meta at write time
   * (`stampScreenshotHashes`). The pruning fallback: when the previous run's
   * PNG is gone from disk, identity is established against this recorded
   * hash instead of degrading to 'unknown'. Optional — pre-hash run-metas
   * simply have no entries.
   */
  shotHashes?: Map<string, string>;
  /**
   * The previous run's POST-SCORING criterion verdicts (`submit_report`
   * re-persists run-meta after folding the agent's soft scores in).
   */
  verdicts: CriterionVerdict[];
}

/**
 * Build the previous-run index from its run-meta. Only EVIDENCE renders enter
 * `shots`: an errored, cost-control-skipped, or unconfirmed (native) render
 * has no screenshot file — or one that was never evidence — so nothing may be
 * proven identical to it (missing key ⇒ keep ⇒ safe).
 *
 * `currentSpec` is the re-freeze guard (see `prevRunMatchesSpec`): a previous
 * run whose provenance can't be bound to the CURRENT frozen content (different
 * hash/version, or nothing provable) yields NO index, so every soft criterion
 * partitions OPEN and no screenshot drop can cite it. Carried scores never
 * cross a re-freeze.
 */
export function buildPrevRenderIndex(
  meta: RunMeta | undefined,
  currentSpec: { hash?: string; version?: number } | undefined,
): PrevRenderIndex | undefined {
  if (!meta) return undefined;
  if (!prevRunMatchesSpec(meta, currentSpec)) return undefined;
  const shots = new Map<string, string>();
  const shotHashes = new Map<string, string>();
  for (const c of meta.components ?? []) {
    if (c.renderError || c.screenshotSkipped || c.renderConfirmation === 'unconfirmed') continue;
    const key = renderKeyFor(c);
    shots.set(key, c.screenshotPath);
    if (c.screenshotSha256) shotHashes.set(key, c.screenshotSha256);
  }
  return {
    runId: meta.runId,
    createdAt: meta.createdAt,
    shots,
    shotHashes,
    verdicts: meta.criterionVerdicts ?? [],
  };
}

/** sha256 of a file's bytes, or null when unreadable. */
function sha256FileOrNull(p: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * sha256 byte-identity of two PNGs; `'unknown'` when either file is
 * unreadable — which every consumer treats as "not proven identical" (keep
 * the screenshot, hold the criterion open).
 */
export function screenshotsIdentical(a: string, b: string): boolean | 'unknown' {
  const hashA = sha256FileOrNull(a);
  if (!hashA) return 'unknown';
  const hashB = sha256FileOrNull(b);
  if (!hashB) return 'unknown';
  return hashA === hashB;
}

/**
 * Stamp `screenshotSha256` onto each EVIDENCE render before run-meta is
 * persisted, so byte-identity can still be established after the run's PNGs
 * are pruned from disk (`buildRenderIdentity` falls back to the recorded
 * hash). Mutates in place. Errored/skipped/unconfirmed renders and unreadable
 * files stay unstamped — identity then reads 'unknown', the safe direction —
 * and an existing stamp is never recomputed (the file may have been pruned
 * since it was written).
 */
export function stampScreenshotHashes(
  components:
    | Array<
        Pick<
          ComponentRender,
          | 'screenshotPath'
          | 'renderError'
          | 'screenshotSkipped'
          | 'renderConfirmation'
          | 'screenshotSha256'
        >
      >
    | undefined,
): void {
  for (const c of components ?? []) {
    if (c.renderError || c.screenshotSkipped || c.renderConfirmation === 'unconfirmed') continue;
    if (c.screenshotSha256) continue;
    const hash = sha256FileOrNull(c.screenshotPath);
    if (hash) c.screenshotSha256 = hash;
  }
}

export interface RenderIdentity {
  /**
   * renderKey -> byte-identical to the previous run's same-key screenshot?
   * `false` covers both "pixels changed" and "no previous-run match" (new
   * variant / pruned file); `'unknown'` covers unreadable files and
   * non-evidence current renders. Only `true` ever permits a drop or a
   * carry-forward.
   */
  identity: Map<string, boolean | 'unknown'>;
  /** Current-run citation id -> renderKeys under that id (one id can cover several variants). */
  idsToKeys: Map<string, string[]>;
}

/** Hash the current run's renders against the previous-run index. */
export function buildRenderIdentity(
  current: ReadonlyArray<
    Pick<
      ComponentRender,
      'id' | 'screenshotPath' | 'renderError' | 'screenshotSkipped' | 'renderConfirmation'
    >
  >,
  prev: PrevRenderIndex | undefined,
): RenderIdentity {
  const identity = new Map<string, boolean | 'unknown'>();
  const idsToKeys = new Map<string, string[]>();
  for (const r of current) {
    const key = renderKeyFor(r);
    const keys = idsToKeys.get(r.id) ?? [];
    keys.push(key);
    idsToKeys.set(r.id, keys);
    const isEvidence =
      !r.renderError && !r.screenshotSkipped && r.renderConfirmation !== 'unconfirmed';
    if (!isEvidence) {
      identity.set(key, 'unknown');
      continue;
    }
    const prevPath = prev?.shots.get(key);
    if (!prevPath) {
      identity.set(key, false);
      continue;
    }
    let same = screenshotsIdentical(r.screenshotPath, prevPath);
    if (same === 'unknown') {
      // Pruning fallback: the previous run's PNG may be gone from disk, but
      // its sha256 was recorded in run-meta at write time — identity is
      // provable against the recorded hash. Only a readable CURRENT file can
      // upgrade 'unknown'; anything else stays 'unknown' (the safe direction).
      const recorded = prev?.shotHashes?.get(key);
      const current = recorded ? sha256FileOrNull(r.screenshotPath) : null;
      if (recorded && current) same = current === recorded;
    }
    identity.set(key, same);
  }
  return { identity, idsToKeys };
}

/**
 * Basename of a path with a JS/TS/React extension stripped, lowercased — the
 * unit a spec's `targets.components` match against. Mirrors `orderTargetsFirst`
 * (run.ts) and `mapChangedFilesToSpecs` (specs.ts), the two places that already
 * resolve a target string to a component file, so a render is matched here the
 * same way it was SELECTED as a target upstream. Handles both path separators
 * because a render's `filePath` is absolute on the web isolation path but
 * project-relative on the native path.
 */
function baseNameNoExt(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return base.replace(/\.(tsx|jsx|ts|js)$/i, '').toLowerCase();
}

/**
 * Does this render belong to one of the spec's target components? Targets may
 * be bare component NAMES (`ContactForm`) or project-relative PATHS
 * (`src/forms/ContactForm.tsx`); a render's `filePath` is the component source
 * (absolute on web, relative on native). Match on basename (the axis
 * `orderTargetsFirst` used to select these renders) with an exact
 * project-relative path as an additive second hit. Both axes only ADD matches —
 * the safe direction, since over-inclusion can at most stale the fold while
 * under-inclusion could hide a changed target behind an identical sibling.
 */
function renderIsTarget(
  r: Pick<ComponentRender, 'filePath'>,
  targetPaths: ReadonlySet<string>,
  targetBaseNames: ReadonlySet<string>,
): boolean {
  const norm = r.filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (targetPaths.has(norm)) return true;
  return targetBaseNames.has(baseNameNoExt(r.filePath));
}

/**
 * Fold-input render identity: TRUE only when a same-frozen-content previous
 * run exists and EVERY current evidence render OF THIS SPEC'S TARGETS is
 * byte-identical to its same-key screenshot. Feeds
 * `SpecObservation.renderUnchanged` (scorecard Rule 1) so a tick that provably
 * re-rendered the same pixels doesn't stale carried soft scores — the
 * commit-side of certification: a spec with blocking soft criteria can only
 * accumulate a clean streak across distinct commits if same-render commits
 * don't reset it. Returns undefined — never false — when nothing is provable,
 * so the reducer falls back to its codeChanged/sha inputs.
 *
 * PER-SPEC SCOPING (load-bearing): `current` is the WHOLE run's render set,
 * which on a watch tick carries sibling components and other working-tree churn
 * (see the file header). When the spec declares `targets.components`, identity
 * is proven over ONLY the renders matching those targets — a dirty/errored/new
 * sibling can no longer stale this spec's scores or reset its streak. A spec
 * with NO declared targets can't be scoped, so it falls back to the whole set
 * (the pre-scoping behavior — still the safe stale/keep direction). Semantics:
 *   - no matching target render in `current`  ⇒ undefined (nothing provable);
 *   - every target render byte-identical       ⇒ true, EVEN IF a sibling
 *     render changed, errored, or is new;
 *   - any target render not proven identical    ⇒ undefined.
 * The `true`-widening invariant is preserved: `true` requires a provable
 * previous run AND byte-identical target evidence, never a sibling's silence.
 */
export function renderUnchangedForFold(
  current: ReadonlyArray<
    Pick<
      ComponentRender,
      | 'id'
      | 'filePath'
      | 'screenshotPath'
      | 'renderError'
      | 'screenshotSkipped'
      | 'renderConfirmation'
    >
  >,
  prevMeta: RunMeta | undefined,
  spec: { hash?: string; version?: number; targets?: { components?: string[] } } | undefined,
): true | undefined {
  const prev = buildPrevRenderIndex(prevMeta, spec);
  if (!prev) return undefined;
  const targets = spec?.targets?.components ?? [];
  let scoped = current;
  if (targets.length > 0) {
    const targetPaths = new Set(targets.map((t) => t.replace(/\\/g, '/').replace(/^\.\//, '')));
    const targetBaseNames = new Set(targets.map(baseNameNoExt));
    scoped = current.filter((r) => renderIsTarget(r, targetPaths, targetBaseNames));
  }
  if (scoped.length === 0) return undefined;
  const { identity } = buildRenderIdentity(scoped, prev);
  for (const v of identity.values()) {
    if (v !== true) return undefined;
  }
  return true;
}
