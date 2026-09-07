/**
 * Lean verify (C3) — presentation-only response shaping for `validity__verify`.
 *
 * `detail: 'lean'` trims the verify RESPONSE (never run-meta, screenshots on
 * disk, verdicts, or the gate) down to what's load-bearing for the next loop
 * iteration: proven verdicts + structuredContent stay whole; a screenshot is
 * omitted ONLY when dropping it provably hides nothing (all mechanical
 * verdicts pass, no soft criterion needs scoring, and the pixels are
 * byte-identical to the previous run's same-key screenshot — the exact image
 * the last score's citations pointed at). Soft criteria whose recorded score
 * rests on byte-identical evidence are CARRIED FORWARD explicitly, never
 * silently, and never presented as fresh scores.
 *
 * Everything here is pure (given file paths for hashing) so the false-green
 * surface is unit-testable without a sandbox: over-keeping is always the
 * failure mode, never under-keeping.
 */
import { demotingTaintsOf, type Spec } from '@validity.ai/verify-spec';
// Render-identity primitives live in @validity.ai/verify-spec (render-identity.ts) so
// the watch tick can feed the same byte-identity rule into the scorecard
// reducer; re-exported here for the existing mcp-server import surface.
import { type PrevRenderIndex } from '@validity.ai/verify-spec';

export {
  buildPrevRenderIndex,
  buildRenderIdentity,
  prevRunMatchesSpec,
  renderKeyFor,
  renderUnchangedForFold,
  screenshotsIdentical,
  type PrevRenderIndex,
  type RenderIdentity,
} from '@validity.ai/verify-spec';

export type VerifyDetail = 'full' | 'lean';

/**
 * Resolve the effective detail level. Explicit `detail` wins; legacy
 * `lean: true` is an alias for `'lean'`; otherwise AUTO: lean iff a frozen
 * spec is in scope AND at least one prior run of that spec exists (first
 * verify of a spec is always full — the agent must see everything once;
 * bare-prompt/plan-only runs have no history or carry-forward provenance, so
 * lean has nothing safe to drop and auto stays full).
 */
export function resolveVerifyDetail(opts: {
  detail?: VerifyDetail;
  /** Deprecated alias for `detail: 'lean'`. `detail` wins when both are set. */
  lean?: boolean;
  hasSpec: boolean;
  /**
   * Prior run of the spec AT THE SAME FROZEN HASH exists (loaded BEFORE this
   * run is indexed; see `prevRunMatchesSpec`). A re-frozen spec's first verify
   * has no same-hash history, so auto resolves full — the agent must see the
   * new contract's evidence once.
   */
  hasPriorRun: boolean;
}): { detail: VerifyDetail; autoSelected: boolean } {
  // Only the two known levels count as explicit — an out-of-enum string from a
  // non-validating MCP client falls through to auto instead of half-applying.
  if (opts.detail === 'full' || opts.detail === 'lean') {
    return { detail: opts.detail, autoSelected: false };
  }
  if (opts.lean === true) return { detail: 'lean', autoSelected: false };
  return {
    detail: opts.hasSpec && opts.hasPriorRun ? 'lean' : 'full',
    autoSelected: true,
  };
}

/** One-line provenance of the resolved detail level for the response header. */
export function detailHeaderLine(detail: VerifyDetail, autoSelected: boolean): string {
  if (detail === 'lean') {
    return autoSelected
      ? "Detail: lean (auto — this spec has prior runs; pass detail:'full' for every screenshot + source)"
      : "Detail: lean (requested; pass detail:'full' for every screenshot + source)";
  }
  return autoSelected ? 'Detail: full (auto)' : 'Detail: full (requested)';
}

/** A soft criterion whose recorded score provably still holds (see partition rules). */
export interface CarryForwardSoft {
  id: string;
  status: 'pass' | 'fail';
  detail?: string;
  /** Citation ids from the previous run — valid render ids in the CURRENT run too (rule 3). */
  screenshotCitations: string[];
  scoredInRunId: string;
}

/**
 * Partition a spec's soft criteria into CARRIED FORWARD vs OPEN. A criterion
 * may be carried forward ONLY when ALL of:
 *
 *   0. `prev` was built against the SAME frozen content (hash, or version for
 *      pre-hash provenance) — `buildPrevRenderIndex` returns no index across
 *      a re-freeze, so a score recorded against different criterion text can
 *      never launder in by id alone;
 *   1. the previous run's post-scoring verdicts contain it with status
 *      `pass` or `fail` (`unverifiable`/absent ⇒ OPEN) — and a `pass` must be
 *      untainted (a demoting-tainted pass is not evidence; belt-and-braces:
 *      the submit-time clamp already persists those as `unverifiable`);
 *   2. that verdict has non-empty `screenshotCitations` (pre-citation-era
 *      metas have none ⇒ OPEN ⇒ keep-all: the safe direction);
 *   3. every cited render id exists in the CURRENT run AND every current-run
 *      render under that id is byte-identical to the previous run's same-key
 *      screenshot (any missing/changed/unknown ⇒ OPEN).
 *
 * A carried-forward `fail` is allowed — it can only hold the gate red. A
 * carried-forward `pass` is evidence-equivalent to re-scoring an image that
 * provably did not change since it was scored.
 */
export function partitionSoftCriteria(opts: {
  spec: Spec;
  prev: PrevRenderIndex | undefined;
  identity: Map<string, boolean | 'unknown'>;
  currentIdsToKeys: Map<string, string[]>;
}): { carryForward: CarryForwardSoft[]; open: string[] } {
  const carryForward: CarryForwardSoft[] = [];
  const open: string[] = [];
  const prevById = new Map((opts.prev?.verdicts ?? []).map((v) => [v.id, v]));
  for (const c of opts.spec.criteria) {
    if (c.tier !== 'soft') continue;
    const prev = prevById.get(c.id);
    const statusHolds =
      prev !== undefined &&
      (prev.status === 'fail' || (prev.status === 'pass' && demotingTaintsOf(prev).length === 0));
    const citations = prev?.screenshotCitations ?? [];
    const evidenceUnchanged =
      citations.length > 0 &&
      citations.every((cited) => {
        const keys = opts.currentIdsToKeys.get(cited);
        return (
          keys !== undefined && keys.length > 0 && keys.every((k) => opts.identity.get(k) === true)
        );
      });
    if (statusHolds && evidenceUnchanged) {
      carryForward.push({
        id: c.id,
        status: prev!.status as 'pass' | 'fail',
        detail: prev!.detail,
        screenshotCitations: citations.slice(),
        scoredInRunId: opts.prev!.runId,
      });
    } else {
      open.push(c.id);
    }
  }
  return { carryForward, open };
}

/**
 * Per-render screenshot decision. `keep: false` requires EVERY keep-rule to
 * decline:
 *   K1 — any fail/unverifiable per-render verdict           ⇒ keep
 *   K2 — any soft criterion OPEN (evidence needed to score) ⇒ keep every clean render
 *   K3 — not provably byte-identical to the previous run    ⇒ keep
 *   K4 — no spec in scope + nothing mechanically proven     ⇒ keep
 * Presentation-only: gates whether the base64 rides in the response, never
 * the verdict, run-meta, baselines, or the gate.
 */
export function leanScreenshotDecision(opts: {
  detail: VerifyDetail;
  verdicts: ReadonlyArray<{ status: 'pass' | 'fail' | 'unverifiable' }>;
  identicalToPrev: boolean | 'unknown';
  anySoftOpen: boolean;
  specInScope: boolean;
}): { keep: boolean; reason?: string } {
  if (opts.detail !== 'lean') return { keep: true };
  if (opts.verdicts.some((v) => v.status !== 'pass')) return { keep: true }; // K1
  if (!opts.specInScope) {
    // K4 — explicit lean on a plan/bare run: with no mechanical verdicts
    // nothing was proven, keep everything (the shipped conservative rule).
    if (opts.verdicts.length === 0) return { keep: true };
    return { keep: false, reason: 'all mechanical checks passed' };
  }
  if (opts.anySoftOpen) return { keep: true }; // K2
  if (opts.identicalToPrev !== true) return { keep: true }; // K3
  return {
    keep: false,
    reason:
      'mechanical checks passed, no soft criterion needs scoring, and the pixels are byte-identical to the previous run',
  };
}

/**
 * URL mode has no spec, no mechanical verdicts, and no run history hook —
 * nothing can be proven unchanged, so no screenshot may be dropped. When lean
 * was requested anyway, say so once and behave as full; otherwise silent.
 */
export function urlModeDetailNotice(opts: {
  detail?: VerifyDetail;
  lean?: boolean;
}): string | null {
  const requested = opts.detail === 'lean' || (opts.detail === undefined && opts.lean === true);
  if (!requested) return null;
  return (
    "detail:'lean' has no effect in URL mode (no mechanical verdicts or spec history " +
    'to prove a render unchanged) — returning full detail.'
  );
}

/**
 * The `structuredContent.presentation` block (registry §9.1) — a sibling of
 * `verdict`, so loop drivers can see what was omitted and re-request it
 * mechanically (`detail: 'full'`) without parsing prose.
 */
export interface VerifyPresentation {
  detail: VerifyDetail;
  autoSelected: boolean;
  screenshotsShown: number;
  screenshotsTotal: number;
  omittedRenderIds: string[];
  carriedForwardSoft: string[];
}
