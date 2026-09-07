/**
 * The scorecard — Validity's persistent "current state of truth" for the
 * continuous-watcher model.
 *
 * Validity isn't only a PR gate; the primary surface is a box that watches the
 * codebase and keeps each spec's verdict CURRENT, emitting signals (tasks) when
 * something drifts. The scorecard is the durable per-spec, per-criterion state
 * that the watcher diffs against on every tick to decide what changed. It lives
 * on disk in `.validity/` (committed by default, like spec.yaml).
 *
 * Design split (so the heart is unit-testable without a render):
 *   - `reconcileScorecard` is a PURE reducer: (previous scorecard + this tick's
 *     observations) → (next scorecard, signals). All transition logic lives here.
 *   - load/save are the thin IO shell.
 *
 * Two rules carry the gate-integrity invariant into the watcher:
 *   1. A deterministic tick reports soft criteria as `unscored` (the CLI has no
 *      model). `unscored` must NEVER overwrite a real prior soft score — only an
 *      agent score (or a fail/unverifiable observation) replaces a soft status.
 *      Otherwise every deterministic tick would erase the 71%.
 *   2. `unscored`/`unverifiable` never count as pass. The rollup verdict is
 *      `fail` if any hard/property fails, `partial` if anything is undecided,
 *      `pass` only when every criterion is decided-pass.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validityDir, ensureDir } from './runs.js';
import { writeFileAtomic } from './util.js';
import { applyEvidenceTaints, demotingTaintsOf, withEvidenceTaint } from './spec-schema.js';
import type { CriterionTier, EvidenceTaint, SpecCriterion } from './spec-schema.js';
import type { JudgeMode, PerformanceMetrics } from './types.js';

/** A criterion's standing in the scorecard. `unscored` = soft, no agent score yet. */
export type ScorecardStatus = 'pass' | 'fail' | 'unverifiable' | 'unscored';

export interface ScorecardCriterion {
  tier: CriterionTier;
  status: ScorecardStatus;
  detail?: string;
  /** ISO time this status was last observed. */
  at: string;
  /** Commit the status was observed at, when known. */
  sha?: string;
  /**
   * Soft only: the code changed (sha moved) since this soft score was set, so
   * the score may be outdated and wants re-scoring by an agent. Never set on
   * hard/property (those are re-decided mechanically every tick).
   */
  stale?: boolean;
  /**
   * Sign-off weight, carried from the frozen spec criterion. Absent ⇒ blocking
   * (see `criterionIsBlocking`). Only `advisory` criteria may fail without
   * blocking the spec's `signedOff` stop signal.
   */
  severity?: 'blocking' | 'advisory';
  /**
   * Soft only: minimum normalized score [0,1] a numeric soft `score` must reach
   * to count as a pass for sign-off. Carried from the frozen spec criterion.
   */
  softThreshold?: number;
  /** Optional numeric soft score [0,1] when a judge supplied one alongside the status. */
  score?: number;
  /** Identifier of the model/agent that scored this (soft) criterion, when known. */
  scoredBy?: string;
  /**
   * How this (soft) criterion was scored (A6). ADD-ONLY: stamped `'model'` by the
   * automated LLM judge (`validity judge`); absent for a host-agent / fresh-context
   * score (which reads through `selfScored`/session provenance instead). Lets the
   * dashboard distinguish an independent-model sign-off from a self-attested one.
   */
  judge?: JudgeMode;
  /** MCP session fingerprint that scored this criterion (A3), when known. */
  scoredBySession?: string;
  /**
   * Soft-scoring rubric version this criterion was scored under (E2.2).
   * ADD-ONLY provenance — never a gate input. See `RUBRIC_VERSION`.
   */
  rubricVersion?: string;
  /** True when `rubricVersion` was assumed by the server, not attested. */
  rubricVersionAssumed?: boolean;
  /** Evidence taints carried on this criterion's status (A3). See `evidenceTaintSchema`. */
  evidenceTaints?: EvidenceTaint[];
}

export interface ScorecardSpec {
  specVersion: number;
  specHash?: string;
  verdict: 'pass' | 'fail' | 'partial';
  /**
   * The single stop signal: true ⇔ every BLOCKING criterion passes (see
   * `computeSignedOff`). A NEW field PARALLEL to `verdict` — it does not change
   * the pass/fail/partial rollup semantics. Absent on scorecards written before
   * this field existed (read as "not signed off").
   */
  signedOff?: boolean;
  /** Hard+property coverage (pass+fail)/total, 0..100, or null when none. */
  coveragePercent: number | null;
  /**
   * Cached Validity Score for this spec (F1). Display cache ONLY — re-stamped
   * on every reducer write; consumers with the full scorecard recompute via
   * `computeSpecScore`, so a hand-edit can't persist.
   */
  validityScore?: number | null;
  /**
   * Cached DERIVED maturity assessment (spec-maturity ladder). Display cache
   * ONLY, same posture as `validityScore`: re-stamped by every surface that
   * runs the derivation (watch tick, MCP verify fold), always recomputable via
   * `assessMaturity` (maturity.ts), and NEVER authored — a hand-edit can't
   * survive the next tick and can't gate anything (no verdict/sign-off path
   * reads it). The structural shape mirrors `MaturityAssessment`; it is
   * declared structurally here (not imported) to keep scorecard.ts free of a
   * maturity.ts import cycle (maturity.ts imports Signal from this module).
   */
  maturity?: {
    level: 'probation' | 'dev' | 'team' | 'certified';
    blockersCount: number;
    blockers?: Array<{ kind: string; criterionId?: string; detail: string }>;
  };
  /**
   * Consecutive CLEAN verifications at the current `specHash`, counted once
   * per distinct commit — the certification predicate's stability input
   * (maturity.ts property 4). Clean = `signedOff` (every blocking criterion
   * passes untainted, thresholds met) AND no blocking soft score is stale.
   * Repeated ticks at the same sha with no relevant code change carry the
   * count forward unchanged, so an idle watcher cannot inflate it. Reset by
   * any unclean tick; restarted (count 1) by a clean tick after a re-freeze.
   * Reducer-owned fold state, same trust posture as `verdict` — committed
   * with the scorecard so CI runners see the same streak as local watchers.
   */
  cleanStreak?: { count: number; lastSha?: string };
  criteria: Record<string, ScorecardCriterion>;
  updatedAt: string;
}

export interface Scorecard {
  version: 1;
  updatedAt: string;
  specs: Record<string, ScorecardSpec>;
  /** Cached overall Validity Score (F1). Display cache; see `ScorecardSpec.validityScore`. */
  validityScore?: number | null;
}

/** What a single tick observed for one spec (from the deterministic engine and/or agent). */
export interface SpecObservation {
  specId: string;
  specVersion: number;
  specHash?: string;
  /**
   * Relevance-scoped staleness input (W3 #10): did THIS spec's own target files
   * change since the carried soft scores were set? When the caller supplies it
   * (e.g. watch, from `mapChangedFilesToSpecs`), it OVERRIDES the coarse global
   * sha-diff — so one unrelated commit no longer stales every spec's soft scores,
   * and a day of uncommitted edits to a relevant file does stale them. Omitted ⇒
   * fall back to the HEAD-keyed sha comparison (legacy callers).
   */
  codeChanged?: boolean;
  /**
   * Render-identity staleness override: the tick's rendered evidence is
   * byte-identical to the evidence the carried soft scores rest on (lean
   * verify's carry-forward rule, established via screenshot sha256). When
   * true, carried soft scores are NOT staled even if code moved — a commit
   * that provably didn't change the render can't invalidate a judge's score
   * of that same render. This is what lets a spec with blocking soft
   * criteria accumulate a clean streak across distinct commits and certify;
   * without it every distinct sha stales the soft gate and resets the streak.
   * Takes precedence over `codeChanged` and the sha fallback.
   */
  renderUnchanged?: boolean;
  /**
   * Set by callers for specs carrying a probation marker (bulk-created,
   * unconfirmed) — while true this observation may NEVER open a severity-high
   * signal. A pass→fail transition downgrades from `regression` (high) to
   * `needs-review` (low) so a wrong bulk spec can't poison the inbox before a
   * human confirms the spec. Cleared after the first clean human-confirmed pass.
   */
  probation?: boolean;
  criteria: Array<{
    id: string;
    tier: CriterionTier;
    /** `unscored` for soft criteria a deterministic tick can't score. */
    status: ScorecardStatus;
    detail?: string;
    /** Sign-off weight, carried from the frozen spec criterion. Absent ⇒ blocking. */
    severity?: 'blocking' | 'advisory';
    /** Soft only: minimum normalized score [0,1] to count as a pass for sign-off. */
    softThreshold?: number;
    /** Optional numeric soft score [0,1] when a judge supplied one. */
    score?: number;
    /** Identifier of the model/agent that scored this (soft) criterion. */
    scoredBy?: string;
    /**
     * Evidence taints carried from this tick's verdict (A3). Taints
     * re-originate at capture: these describe THIS tick's evidence, so on the
     * Rule-1 carry a demoting-taint-free observation replaces the carried set
     * (recovery) while a demoting-tainted one unions into it (no laundering).
     */
    evidenceTaints?: EvidenceTaint[];
  }>;
}

export type SignalKind =
  | 'regression' // a decided criterion went pass → fail
  | 'unverifiable' // a passing criterion can no longer be verified (spec rot / selector drift)
  | 'coverage-drop' // a spec's hard/property coverage fell
  | 'spec-changed' // the frozen spec content hash changed (informational; resets the baseline)
  | 'needs-scoring' // a soft criterion has no agent score yet
  | 'needs-rescoring' // a soft score is stale (code moved since it was set)
  | 'perf-drift' // a render's performance regressed vs. its timeline (D1; advisory)
  // a criterion failed on a bulk-created spec still on probation — confirm the spec
  // instead of treating it as a regression
  | 'needs-review'
  | 'recovered' // good news: a fail/unverifiable criterion is passing again
  // a spec's DERIVED maturity level went down between ticks (de-certified /
  // un-frozen / back on probation) — informational notice, never an open task
  // (the maturity chip + blockers list are the actionable surface)
  | 'maturity-drop'
  // a soft criterion passed N consecutive runs on identical evidence — a
  // machine-generated hard replacement is proposed (hardening engine, Phase C).
  // Advisory; never auto-applied — a human ratifies via spec_update.
  | 'hardening-candidate'
  // PROJECT-SCOPED standing signal (issue #17): soft criteria are tracked but
  // no scoring.judgeModel is configured, so needs-scoring / needs-rescoring
  // can NEVER drain — their accumulation without a judge reads as regressions
  // when the real fix is one config line. specId is the literal '*'.
  | 'judge-gap'
  // a signed `.ad` on-device journey no longer reaches its landmark when
  // `validity replay` re-executes it (agent-device divergence). Journey drift,
  // not a criterion verdict — see `replayDivergenceSignals` for the two close
  // paths that keep it drainable.
  | 'replay-divergence';

export type SignalSeverity = 'high' | 'medium' | 'low' | 'info';

/** Terminal close-path that produced a non-open status. Add-only. */
export type SignalResolvedBy = 'pass' | 'freeze' | 'sweep' | 'suppress' | 'manual' | 'superseded';

/** Open work, a closed claim, or a parked claim waiting on a later code change. */
export type SignalStatus = 'open' | 'resolved' | 'suppressed';

export interface Signal {
  /** Stable id `${kind}:${specId}:${criterionId|'*'}` so re-firing updates in place. */
  id: string;
  kind: SignalKind;
  severity: SignalSeverity;
  specId: string;
  criterionId?: string;
  from?: ScorecardStatus;
  to?: ScorecardStatus;
  detail: string;
  /** Last-touched timestamp (open, re-fire, or resolve all restamp this). */
  at: string;
  /**
   * When this signal id FIRST opened. Preserved across re-fires by
   * {@link mergeSignals} so age is stable even as `at`/`detail` refresh. A
   * repeat regression therefore keeps its original episode start instead of
   * overwriting it (W1 #3).
   */
  openedAt?: string;
  /** When the signal flipped to `resolved` (set once, on close). */
  resolvedAt?: string;
  sha?: string;
  /** Perf timeline key this signal refers to (D1). Present only on `perf-drift`. */
  perfKey?: string;
  /**
   * `replay-divergence` only: the run-dir-relative `.ad` recording whose
   * on-device journey diverged. Carried in its OWN field rather than in
   * `criterionId` (which the id scheme reuses as its third segment) because a
   * journey is not a criterion — putting it there would make
   * {@link staleSignalReason}'s criterion-scoped rules fire on a criterion that
   * does not exist and auto-resolve every one of these on the next tick.
   * ADD-ONLY; absent on every other kind and on rows written before it existed.
   */
  recording?: string;
  /** `replay-divergence` only: the run whose signed recording diverged, when known. */
  runId?: string;
  /**
   * `hardening-candidate` only (maturity Phase C): the machine-generated
   * replacement criterion + the evidence fingerprint. `evidenceHash` doubles
   * as the DISMISSAL key — resolving the signal stores it, and the detector
   * never re-proposes while the evidence is unchanged. Declared structurally
   * (scorecard.ts must not import the detector); written only by
   * `computeHardeningSignals` with a real SpecCriterion payload.
   */
  hardening?: {
    evidenceHash: string;
    /** Consecutive stable passing runs observed. */
    runs: number;
    /** Ready-to-paste spec_update replacement criterion. */
    proposal: SpecCriterion;
  };
  /** Resolved / suppressed signals are kept (with status) so the dashboard can show recoveries. */
  status: SignalStatus;
  /**
   * Why this signal left `open`. Add-only; absent on open rows and on
   * pre-lifecycle rows. `suppress` pairs with `status: 'suppressed'`.
   */
  resolvedBy?: SignalResolvedBy;
  /**
   * Parked until the spec's files change past this sha (then reopens), or the
   * underlying claim clears (then resolves `pass` and never reopens).
   */
  suppressedUntil?: { sha: string; note?: string };
}

const SEVERITY: Record<SignalKind, SignalSeverity> = {
  regression: 'high',
  unverifiable: 'medium',
  'coverage-drop': 'medium',
  'spec-changed': 'info',
  'needs-scoring': 'low',
  'needs-rescoring': 'low',
  'perf-drift': 'low',
  'needs-review': 'low',
  recovered: 'info',
  'maturity-drop': 'info',
  'hardening-candidate': 'low',
  // First-class error state, not a hint: every staleness signal below it is
  // unactionable while the judge is missing.
  'judge-gap': 'medium',
  // Same rung as `unverifiable`, and for the same reason: something that used
  // to be demonstrable no longer is. Deliberately NOT 'high' — `high` means a
  // decided criterion went pass → fail, and it is the ONLY thing
  // `watch --fail-on-signal` gates on. A manual `validity replay` must not be
  // able to trip the watcher's CI gate, and a diverged journey is drift
  // evidence about a recording, not a criterion verdict. Also deliberately not
  // 'low': unlike `perf-drift` it is not advisory noise — the journey either
  // reaches its landmark or it does not, and somebody has to look.
  'replay-divergence': 'medium',
};

function signalId(kind: SignalKind, specId: string, criterionId?: string): string {
  return `${kind}:${specId}:${criterionId ?? '*'}`;
}

/** The one project-scoped standing signal id (issue #17). */
export const JUDGE_GAP_SIGNAL_ID = 'judge-gap:*:*';

/** Soft criteria across FROZEN specs — the population a judge would score. */
export function countTrackedSoftCriteria(
  specs: ReadonlyArray<{ status?: string; criteria: ReadonlyArray<{ tier: string }> }>,
): number {
  let n = 0;
  for (const s of specs) {
    if (s.status !== 'frozen') continue;
    for (const c of s.criteria) if (c.tier === 'soft') n += 1;
  }
  return n;
}

/**
 * The ONE wording for the judge-gap warning — dashboard print, watch ticks,
 * the web hero, and the standing signal all render this exact sentence so the
 * fix (a single config line) is named everywhere the symptom shows.
 */
export function judgeGapWarning(softCriteria: number): string {
  return (
    `no judge configured — ${softCriteria} soft ` +
    `${softCriteria === 1 ? 'criterion' : 'criteria'} can never re-score; ` +
    `add scoring.judgeModel to .validity/config.ts`
  );
}

/**
 * Reconcile the standing judge-gap signal (issue #17) against this tick's
 * reality. Returns fresh rows for {@link mergeSignals}:
 *   - gap present  → one OPEN signal (re-fires update in place; `openedAt` is
 *     preserved by mergeSignals);
 *   - gap absent   → a RESOLVED marker when an open one exists, else nothing.
 * `softCriteria === 0` and "judge configured" both count as no gap — staleness
 * signals are drainable (or nonexistent) in either case.
 */
export function judgeGapSignals(args: {
  existing: Signal[];
  judgeConfigured: boolean;
  softCriteria: number;
  now: string;
  sha?: string;
}): Signal[] {
  const open = args.existing.find((s) => s.id === JUDGE_GAP_SIGNAL_ID && s.status === 'open');
  if (!args.judgeConfigured && args.softCriteria > 0) {
    return [
      {
        id: JUDGE_GAP_SIGNAL_ID,
        kind: 'judge-gap',
        severity: SEVERITY['judge-gap'],
        specId: '*',
        detail: judgeGapWarning(args.softCriteria),
        at: args.now,
        openedAt: open?.openedAt ?? args.now,
        sha: args.sha,
        status: 'open',
      },
    ];
  }
  if (open) {
    return [
      {
        ...open,
        at: args.now,
        resolvedAt: args.now,
        status: 'resolved',
        resolvedBy: 'pass',
        detail: 'no longer applicable — a judge is configured (or nothing soft is tracked)',
      },
    ];
  }
  return [];
}

function emptyScorecard(now: string): Scorecard {
  return { version: 1, updatedAt: now, specs: {} };
}

/**
 * Rollup: fail if any hard/property fails; pass ONLY when every criterion is
 * explicitly decided-pass; everything else (undecided, soft-fail, or an unknown
 * status that slipped past TypeScript via deserialized JSON) is `partial`.
 *
 * The `every === 'pass'` test for the green case is deliberate (not a
 * fall-through `return 'pass'`): an unrecognized status must NEVER read as a
 * pass. This is the verdict sink, so it's where we make false-green impossible.
 */
export function rollupScorecardVerdict(
  criteria: Record<string, ScorecardCriterion>,
): 'pass' | 'fail' | 'partial' {
  const list = Object.values(criteria);
  if (list.some((c) => c.tier !== 'soft' && c.status === 'fail')) return 'fail';
  // Green only when every criterion is decided-pass AND carries no demoting
  // evidence taint — a tainted `pass` (network/wrapper/unconfirmed-render) can
  // never lift the rollup to green (belt-and-braces; the clamp should already
  // have demoted it).
  if (
    list.length > 0 &&
    list.every(
      (c) =>
        c.status === 'pass' && demotingTaintsOf({ evidenceTaints: c.evidenceTaints }).length === 0,
    )
  )
    return 'pass';
  return 'partial';
}

/**
 * The minimal per-criterion shape the stop rule reasons over. Decoupled from
 * `ScorecardCriterion` / `CriterionVerdict` on purpose so any caller (verify,
 * submit_report, the scorecard, a CLI tick) can project its own records into a
 * single canonical input and get the SAME sign-off answer.
 */
export interface SignOffCriterion {
  tier: CriterionTier;
  status: 'pass' | 'fail' | 'unverifiable' | 'unscored';
  severity?: 'blocking' | 'advisory';
  softThreshold?: number;
  /** Optional numeric soft score [0,1] when a judge supplied one. */
  score?: number;
  /** Evidence taints on this criterion (A3). A blocking demoting taint never signs off. */
  evidenceTaints?: EvidenceTaint[];
  /**
   * Soft only: true when this criterion's PASS was scored by the same session
   * that ran verify, or by an unproven judge claim (A6 deny-by-default). Never
   * set on hard/property (those are mechanical, never self-scored). Feeds the
   * gate ONLY when `requireFreshJudge` is on — absent this opt-in, the flag is
   * carried for display/audit but never changes the stop rule's answer.
   */
  selfScored?: boolean;
}

/**
 * The soft-threshold clause shared by `computeSignedOff` and the Validity
 * Score: met when no threshold is set, no numeric score was supplied, or the
 * score reaches the threshold. Extracted so the score can never read healthier
 * than the stop rule on the same data.
 */
export function softThresholdMet(c: { softThreshold?: number; score?: number }): boolean {
  return c.softThreshold == null || c.score == null || c.score >= c.softThreshold;
}

/** Options that narrow `computeSignedOff` beyond its unconditional defaults. */
export interface SignOffOptions {
  /**
   * Opt-in strict knob (default OFF — see `ValidityConfig.requireFreshJudge`).
   * When true, a blocking SOFT criterion whose pass is `selfScored` does NOT
   * count toward sign-off — it must come from a non-self-scored source
   * (fresh-context or model judge). Never mutates a verdict's displayed
   * status: a self-scored pass still RENDERS as `pass`, this only refuses to
   * let it satisfy the stop rule (never-false-green ⇒ never-hidden-red too).
   */
  requireFreshJudge?: boolean;
}

/**
 * THE stop rule. signedOff ⇔ every BLOCKING criterion passes:
 *  - hard/property: status === 'pass'
 *  - soft: status === 'pass' AND (softThreshold == null OR score == null OR score >= softThreshold)
 *    AND (requireFreshJudge is off OR this pass is not selfScored)
 * Advisory criteria (severity === 'advisory') are ignored — they may fail.
 * Empty list ⇒ false (nothing verified is never "done").
 * Unknown/unscored/unverifiable never count as pass (false-green impossible).
 *
 * This is the ONE function the whole loop's "done" signal comes from. Every
 * surface that reports `signedOff` MUST route through here so the bar can't
 * drift between verify, the scorecard, and submit_report.
 */
export function computeSignedOff(criteria: SignOffCriterion[], opts?: SignOffOptions): boolean {
  if (criteria.length === 0) return false;
  for (const c of criteria) {
    if (c.severity === 'advisory') continue; // advisory: never blocks
    // Belt-and-braces (A3): a blocking criterion carrying a demoting evidence
    // taint can never sign off, even if its status reads `pass` — the taint
    // clamp should have demoted it, but the gate refuses to trust a tainted pass.
    if (demotingTaintsOf({ evidenceTaints: c.evidenceTaints }).length > 0) return false;
    if (c.tier === 'soft') {
      if (c.status !== 'pass') return false;
      if (!softThresholdMet(c)) return false;
      // requireFreshJudge (opt-in): a blocking soft pass scored by the same
      // session that built the change (or an unproven judge claim) cannot
      // stand in for a fresh-context/model judgment. The criterion's rendered
      // status is untouched — only the stop rule refuses it.
      if (opts?.requireFreshJudge && c.selfScored) return false;
    } else {
      if (c.status !== 'pass') return false;
    }
  }
  return true;
}

/**
 * The blocking, soft, currently-passing criteria a `requireFreshJudge` gate
 * refused to count (the set `computeSignedOff` skipped over via `selfScored`).
 * Reads the exact same projected inputs `computeSignedOff` saw, so a caller
 * can never name a reason the stop rule disagrees with. Used to build the
 * human-readable "N soft passes are self-scored; requireFreshJudge is on"
 * sign-off reason — surface only, never re-gates anything itself.
 */
export function selfScoredSignOffBlockers(criteria: SignOffCriterion[]): SignOffCriterion[] {
  return criteria.filter(
    (c) => c.severity !== 'advisory' && c.tier === 'soft' && c.status === 'pass' && c.selfScored,
  );
}

/**
 * Rollup for `CriterionVerdict[]` (the verify-time shape; soft may be
 * unverifiable until host-scored). Distinct from `rollupScorecardVerdict`,
 * which folds the persistent scorecard's `unscored`-aware statuses; this one
 * speaks the verify verdict vocabulary (pass | fail | unverifiable) and adds a
 * `partial` bucket for the mixed case. Hard/property fails dominate; an all-pass
 * set is `pass`; an all-unverifiable set is `unverifiable`; anything else is
 * `partial`. Empty ⇒ `unverifiable` (nothing was decided).
 */
export function rollupCriterionVerdicts(
  verdicts: Array<{
    tier: CriterionTier;
    status: 'pass' | 'fail' | 'unverifiable';
    networkTainted?: boolean;
    evidenceTaints?: EvidenceTaint[];
  }>,
): 'pass' | 'fail' | 'partial' | 'unverifiable' {
  if (verdicts.length === 0) return 'unverifiable';
  if (verdicts.some((v) => v.tier !== 'soft' && v.status === 'fail')) return 'fail';
  // Green only when every verdict is a pass with no demoting evidence taint — a
  // tainted `pass` can never lift the rollup to green (belt-and-braces; A3).
  if (verdicts.every((v) => v.status === 'pass' && demotingTaintsOf(v).length === 0)) return 'pass';
  if (verdicts.every((v) => v.status === 'unverifiable')) return 'unverifiable';
  return 'partial';
}

/** Project a persisted scorecard criterion onto the stop-rule input shape. */
/** Append-only taint union for carries — `undefined ∪ [] = undefined` (no churn). */
function unionTaints(
  a: EvidenceTaint[] | undefined,
  b: EvidenceTaint[] | undefined,
): EvidenceTaint[] | undefined {
  let out = a;
  for (const t of b ?? []) out = withEvidenceTaint(out, t);
  return out;
}

function scorecardCriterionToSignOff(c: ScorecardCriterion): SignOffCriterion {
  return {
    tier: c.tier,
    status: c.status,
    severity: c.severity,
    softThreshold: c.softThreshold,
    score: c.score,
    evidenceTaints: c.evidenceTaints,
  };
}

/** Hard+property coverage percent (pass+fail over total), or null when none. */
export function coveragePercent(criteria: Record<string, ScorecardCriterion>): number | null {
  let total = 0;
  let decided = 0;
  for (const c of Object.values(criteria)) {
    if (c.tier === 'soft') continue;
    total += 1;
    if (c.status === 'pass' || c.status === 'fail') decided += 1;
  }
  if (total === 0) return null;
  return Math.round((decided / total) * 100);
}

/* ------------------------------------------------------------------ *
 * The Validity Score (F1) — ONE explainable repo-level number.        *
 * INFORMATIONAL ONLY: it is a `number | null`, never a member of the  *
 * verdict vocabulary, and no verdict/sign-off/gate code path reads    *
 * it. Data flows one way: verdicts → score.                           *
 * ------------------------------------------------------------------ */

export const VALIDITY_SCORE_VERSION = 2;

/**
 * The published formula — every rendering surface interpolates THIS constant,
 * so the description can't drift from the implementation.
 */
export const VALIDITY_SCORE_FORMULA =
  'Validity Score = weighted pass-rate over every blocking criterion in every tracked spec. ' +
  'Hard and property criteria weigh 2 (mechanically proven), soft criteria weigh 1. A criterion earns ' +
  'full credit only when it passes (a soft pass must also meet its numeric threshold, when set); a ' +
  'stale soft pass — code changed since it was scored — earns half credit; failing, unverifiable, ' +
  'and unscored criteria earn zero. Advisory criteria are excluded. Each spec is weighted by its ' +
  'derived maturity (certified 1.0 / team 0.9 / dev 0.6 / probation 0), so proven contracts count ' +
  'more and unconfirmed bulk drafts count nothing. Score = 100 × earned/possible, ' +
  'rounded (100 is shown only when everything passes). No tracked specs ⇒ no score, never 0 or 100. ' +
  'Informational only — the score never gates and is not a verdict.';

/**
 * Per-spec maturity multipliers for the POOLED score (v2). Applied to a spec's
 * earned AND possible weight, so a repo where every spec sits on the same rung
 * scores identically to v1 (the multiplier cancels) — the weighting only
 * shifts the pool when rungs differ. Probation is 0 by design: an unconfirmed
 * bulk draft must not move the number either way. A scorecard entry with no
 * cached maturity floors at 'team' (the conservative default — certification
 * is a positive claim; see fallbackMaturity in dashboard-snapshot.ts).
 * Proposed weights per the plan §9.1 — revisit against real scorecards.
 */
export const MATURITY_SCORE_WEIGHTS: Record<'probation' | 'dev' | 'team' | 'certified', number> = {
  probation: 0,
  dev: 0.6,
  team: 0.9,
  certified: 1,
};

/** The v2 per-spec multiplier — uncached entries floor at 'team'. */
export function maturityScoreWeight(
  level: 'probation' | 'dev' | 'team' | 'certified' | undefined,
): number {
  return MATURITY_SCORE_WEIGHTS[level ?? 'team'];
}

/**
 * Minimal projection any surface can score from (scorecard, CI results, …).
 * `ScorecardCriterion` is a structural superset, so `Object.values(criteria)`
 * feeds straight in.
 */
export interface ScoreCriterionInput {
  tier: CriterionTier;
  status: ScorecardStatus;
  /** Absent ⇒ blocking (matches `criterionIsBlocking`). */
  severity?: 'blocking' | 'advisory';
  softThreshold?: number;
  /** Judge's numeric [0,1], when present. */
  score?: number;
  stale?: boolean;
  /** Optional: a demoting-tainted pass earns 0 — the score never reads healthier than the stop rule. */
  evidenceTaints?: EvidenceTaint[];
}

export interface SpecScore {
  /** 0..100 integer, or null when `possibleWeight === 0` (nothing measurable). */
  score: number | null;
  /** Σ w·k over blocking criteria. */
  earnedWeight: number;
  /** Σ w over blocking criteria. */
  possibleWeight: number;
  /** Blocking soft criteria currently flagged stale. */
  staleSoftCount: number;
}

/** Hard/property = 2 (mechanically proven counts double); soft/unknown = 1. */
function scoreWeight(tier: CriterionTier): number {
  return tier === 'hard' || tier === 'property' ? 2 : 1;
}

/**
 * Credit per criterion: 1 for a fresh untainted pass meeting its threshold,
 * 0.5 for a stale (code-moved) pass, 0 for everything else — fail,
 * unverifiable, unscored, a below-threshold soft pass, a demoting-tainted
 * pass, or ANY unrecognized status that arrived via deserialized JSON (the
 * explicit-pass-only discipline of `rollupScorecardVerdict`).
 */
function scoreCredit(c: ScoreCriterionInput): number {
  if (c.status !== 'pass') return 0;
  if (!softThresholdMet(c)) return 0;
  if (demotingTaintsOf({ evidenceTaints: c.evidenceTaints }).length > 0) return 0;
  return c.stale ? 0.5 : 1;
}

/**
 * Rounding with the perfection clamp: 100 only when EVERY blocking criterion
 * earned full credit — 199/200 must not display as a perfect score while a
 * criterion fails. No symmetric clamp at 0 (rounding down is conservative).
 */
function roundedScore(earned: number, possible: number): number {
  if (earned === possible) return 100;
  return Math.min(99, Math.round((earned / possible) * 100));
}

/**
 * Per-spec Validity Score: the weighted pass-rate with freshness decay over
 * the BLOCKING criteria (advisory excluded from numerator and denominator).
 * See {@link VALIDITY_SCORE_FORMULA}.
 */
export function computeSpecScore(criteria: ScoreCriterionInput[]): SpecScore {
  let earned = 0;
  let possible = 0;
  let staleSoft = 0;
  for (const c of criteria) {
    if (c.severity === 'advisory') continue;
    const w = scoreWeight(c.tier);
    possible += w;
    earned += w * scoreCredit(c);
    if (c.tier === 'soft' && c.stale) staleSoft += 1;
  }
  return {
    score: possible === 0 ? null : roundedScore(earned, possible),
    earnedWeight: earned,
    possibleWeight: possible,
    staleSoftCount: staleSoft,
  };
}

export interface ValidityScore {
  version: typeof VALIDITY_SCORE_VERSION;
  /** Pooled 0..100 integer (the null case makes the function return null). */
  score: number;
  perSpec: Record<string, SpecScore>;
  blockingCriteriaCount: number;
  advisoryExcludedCount: number;
  staleSoftCount: number;
}

/**
 * Repo-level Validity Score. Criteria are POOLED across specs (one repo-wide
 * contract — a 1-criterion spec must not weigh like a 20-criterion one); the
 * per-spec sub-scores give the other view. Returns null (never 0, never 100)
 * when there is no scorecard, no specs, or only advisory criteria — an
 * unmeasured repo has no score.
 */
export function computeValidityScore(scorecard: Scorecard | null): ValidityScore | null {
  if (!scorecard) return null;
  const perSpec: Record<string, SpecScore> = {};
  let earned = 0;
  let possible = 0;
  let blocking = 0;
  let advisory = 0;
  let staleSoft = 0;
  for (const [specId, spec] of Object.entries(scorecard.specs)) {
    const inputs = Object.values(spec.criteria ?? {});
    const sub = computeSpecScore(inputs);
    perSpec[specId] = sub;
    // v2 maturity weighting: multiply the spec's earned AND possible weight by
    // its derived-level multiplier (per-spec sub-scores stay unweighted — the
    // pooled number is where cross-spec trust differences belong).
    const w = maturityScoreWeight(spec.maturity?.level);
    earned += w * sub.earnedWeight;
    possible += w * sub.possibleWeight;
    staleSoft += sub.staleSoftCount;
    for (const c of inputs) {
      if (c.severity === 'advisory') advisory += 1;
      else blocking += 1;
    }
  }
  if (possible === 0) return null;
  return {
    version: VALIDITY_SCORE_VERSION,
    score: roundedScore(earned, possible),
    perSpec,
    blockingCriteriaCount: blocking,
    advisoryExcludedCount: advisory,
    staleSoftCount: staleSoft,
  };
}

/**
 * PURE reducer. Folds a tick's observations into the previous scorecard and
 * emits the signals that the transitions produced. Specs not observed this tick
 * are carried forward untouched.
 */
export function reconcileScorecard(args: {
  prev: Scorecard | null;
  observations: SpecObservation[];
  now: string;
  sha?: string;
}): { scorecard: Scorecard; signals: Signal[] } {
  const { observations, now, sha } = args;
  const prev = args.prev ?? emptyScorecard(now);
  const nextSpecs: Record<string, ScorecardSpec> = { ...prev.specs };
  const signals: Signal[] = [];

  const open = (
    kind: SignalKind,
    specId: string,
    detail: string,
    criterionId?: string,
    from?: ScorecardStatus,
    to?: ScorecardStatus,
  ): void => {
    // `recovered` and `spec-changed` are STANDALONE resolved rows (good-news /
    // informational notices) — they are never open tasks, so they never block
    // "no open signals" and need no close path (W1 #2). Every other kind opens.
    const resolved = 'recovered' === kind || 'spec-changed' === kind;
    signals.push({
      id: signalId(kind, specId, criterionId),
      kind,
      severity: SEVERITY[kind],
      specId,
      criterionId,
      from,
      to,
      detail,
      at: now,
      openedAt: now,
      resolvedAt: resolved ? now : undefined,
      sha,
      status: resolved ? 'resolved' : 'open',
      ...(resolved ? { resolvedBy: kind === 'spec-changed' ? 'freeze' : 'pass' } : {}),
    });
  };

  // Emit a resolution marker that CLOSES an existing open signal in place.
  // `mergeSignals` drops it if no matching open signal exists, so the reducer
  // can fire these unconditionally without minting orphan "resolved" rows
  // (W1 #1/#2, W2 #6).
  const resolve = (
    kind: SignalKind,
    specId: string,
    detail: string,
    criterionId?: string,
    resolvedBy: SignalResolvedBy = 'pass',
  ): void => {
    signals.push(resolvedSignal(kind, specId, criterionId, now, sha, detail, resolvedBy));
  };

  for (const obs of observations) {
    const prevSpec = prev.specs[obs.specId];
    const prevCriteria = prevSpec?.criteria ?? {};
    const specChanged = Boolean(prevSpec && prevSpec.specHash !== obs.specHash);
    if (specChanged) {
      // The baseline IS genuinely rebuilt below (carry-forward is suppressed and
      // the criteria map comes only from THIS observation), so the copy is now
      // truthful (W2 #6 — the prior "baseline reset" claim was false). Emitted as
      // a resolved notice (see `open`), so it records the re-freeze without ever
      // becoming an open task.
      open(
        'spec-changed',
        obs.specId,
        `spec re-frozen (hash changed) — baseline rebuilt from new spec`,
      );
    }

    // On a re-freeze, criteria that left the spec are zombies: resolve any open
    // signals that referenced them so a renamed-because-failing criterion can't
    // wedge signedOff=false + a permanently-open regression (W2 #6). Carry-forward
    // of omitted prior criteria is suppressed below when specChanged, so the
    // criteria map is rebuilt from this observation alone.
    if (specChanged) {
      const liveIds = new Set(obs.criteria.map((c) => c.id));
      for (const [departedId, prevC] of Object.entries(prevCriteria)) {
        if (liveIds.has(departedId)) continue;
        const detail = `criterion "${departedId}" removed in re-freeze`;
        // Emit only the resolutions the departed criterion could actually have
        // had open, grounded in its prior status — keeps the raw stream lean
        // (mergeSignals would drop non-open markers anyway).
        if (prevC.status === 'fail') {
          resolve('regression', obs.specId, detail, departedId, 'freeze');
          // Probation downgrade: a needs-review opened on a bulk spec must also
          // close when the criterion departs in a re-freeze, so it can't wedge
          // open after the spec is re-frozen (Phase C).
          resolve('needs-review', obs.specId, detail, departedId, 'freeze');
        }
        if (prevC.status === 'unverifiable')
          resolve('unverifiable', obs.specId, detail, departedId, 'freeze');
        if (prevC.status === 'unscored')
          resolve('needs-scoring', obs.specId, detail, departedId, 'freeze');
        if (prevC.stale) resolve('needs-rescoring', obs.specId, detail, departedId, 'freeze');
      }
    }

    const nextCriteria: Record<string, ScorecardCriterion> = {};
    for (const c of obs.criteria) {
      const before = prevCriteria[c.id];

      // Rule 1: a deterministic tick's `unscored` must not erase a real prior
      // soft score. Carry the prior status forward; flag stale if code moved.
      // Guarded on the PRIOR tier being soft: a re-freeze can change a
      // criterion's tier (v1 hard → v2 soft) and the prior entry is then a
      // mechanical verdict, not a protected soft score — carrying it forward
      // would wedge the stale hard tier in the scorecard and applySoftScores
      // would reject valid soft scores against it. Rebuild from the
      // observation instead (fresh tier, `unscored`).
      if (
        c.status === 'unscored' &&
        before &&
        before.tier === 'soft' &&
        before.status !== 'unscored'
      ) {
        // Prefer relevance-scoped staleness (W3 #10): when the caller reports
        // whether THIS spec's files moved, trust it and don't stale on unrelated
        // commits; otherwise fall back to the coarse HEAD sha-diff. Cumulative —
        // `|| before.stale` keeps a flagged score stale until a re-score clears
        // it (applySoftScores sets `stale: undefined`); dropping that would let a
        // quiet, unrelated tick spuriously read a never-rescored score as fresh.
        const codeMoved =
          obs.renderUnchanged === true
            ? false
            : (obs.codeChanged ?? Boolean(sha && before.sha && sha !== before.sha));
        const stale = codeMoved || before.stale;
        // Keep the prior score/scoredBy (an `unscored` tick can't re-score), but
        // refresh the sign-off metadata (severity/softThreshold) from this
        // observation — the frozen spec, not the prior tick, owns those weights.
        nextCriteria[c.id] = {
          ...before,
          severity: c.severity ?? before.severity,
          softThreshold: c.softThreshold ?? before.softThreshold,
          stale: stale || undefined,
          // Taints re-originate at THIS tick's capture (A1). A tick that
          // itself observed a demoting taint UNIONS it into the carried entry
          // (a prior soft pass must not keep signing off under a now-degraded
          // wrapper, and a degraded capture can never launder an older taint
          // away). A tick whose OWN capture carries no demoting taint is
          // fresh, genuinely untainted evidence — it REPLACES the carried
          // set, so one transient degraded tick can't wedge the entry (and
          // the spec's sign-off) forever after the wrapper is fixed. Recovery
          // keys on the observation's own taints — the tool's capture
          // fidelity — never on an agent's say-so.
          evidenceTaints:
            demotingTaintsOf({ evidenceTaints: c.evidenceTaints }).length > 0
              ? unionTaints(before.evidenceTaints, c.evidenceTaints)
              : c.evidenceTaints,
        };
        if (stale && c.tier === 'soft') {
          open(
            'needs-rescoring',
            obs.specId,
            `soft criterion "${c.id}" may be outdated — code changed since it was scored`,
            c.id,
          );
        }
        continue;
      }

      const after: ScorecardCriterion = {
        tier: c.tier,
        status: c.status,
        detail: c.detail,
        at: now,
        sha,
        severity: c.severity,
        softThreshold: c.softThreshold,
        score: c.score,
        scoredBy: c.scoredBy,
        // Taint carry (A3): this tick's evidence taints land on the entry so
        // the sign-off guard and the soft-score clamp can see them. (The Rule-1
        // carry-forward branch above spreads `before`, keeping prior taints.)
        evidenceTaints: c.evidenceTaints,
      };
      nextCriteria[c.id] = after;

      const beforeStatus = before?.status;
      // Transition classification → signals.
      if (c.status === 'unscored') {
        // New criterion OR one whose tier just became soft in a re-freeze
        // (the prior mechanical entry is no valid soft score) — either way
        // no agent score exists yet.
        if (!before || before.tier !== 'soft') {
          open(
            'needs-scoring',
            obs.specId,
            `soft criterion "${c.id}" has no agent score yet`,
            c.id,
          );
        }
      } else if (beforeStatus === 'pass' && c.status === 'fail') {
        if (obs.probation) {
          // Probation downgrade (Phase C): a bulk-created, unconfirmed spec that
          // fails must not fire a high-severity regression — a wrong bulk spec
          // would poison the inbox before a human confirms it. Downgrade to
          // needs-review (low) so the queue surfaces it for confirmation instead.
          open(
            'needs-review',
            obs.specId,
            `"${c.id}" failed on a bulk-created spec awaiting confirmation — review the spec before trusting this as a regression (probation). ${c.detail ?? ''}`.trim(),
            c.id,
            'pass',
            'fail',
          );
        } else {
          open(
            'regression',
            obs.specId,
            `"${c.id}" regressed: pass → fail. ${c.detail ?? ''}`.trim(),
            c.id,
            'pass',
            'fail',
          );
        }
      } else if (beforeStatus === 'pass' && c.status === 'unverifiable') {
        open(
          'unverifiable',
          obs.specId,
          `"${c.id}" can no longer be verified (was passing). ${c.detail ?? ''}`.trim(),
          c.id,
          'pass',
          'unverifiable',
        );
      } else if (
        (beforeStatus === 'fail' || beforeStatus === 'unverifiable') &&
        c.status === 'pass'
      ) {
        open(
          'recovered',
          obs.specId,
          `"${c.id}" recovered: ${beforeStatus} → pass`,
          c.id,
          beforeStatus,
          'pass',
        );
      } else if (!before && c.status === 'fail') {
        open(
          'regression',
          obs.specId,
          `new criterion "${c.id}" is failing. ${c.detail ?? ''}`.trim(),
          c.id,
          undefined,
          'fail',
        );
      } else if (!before && c.status === 'unverifiable') {
        open(
          'unverifiable',
          obs.specId,
          `new criterion "${c.id}" is unverifiable. ${c.detail ?? ''}`.trim(),
          c.id,
          undefined,
          'unverifiable',
        );
      }
    }

    // Carry forward any prior criteria the observation OMITTED — but ONLY on a
    // same-hash partial tick. A same-hash tick should observe the whole spec; if
    // one is ever incomplete we must not silently drop a criterion (dropping a
    // failing/undecided one would relax the verdict toward green), so carrying it
    // forward is the conservative choice. On a re-freeze (`specChanged`) the
    // observation IS the whole new spec, so a prior-only criterion genuinely left
    // the spec — carrying it forward would resurrect a zombie (W2 #6).
    if (!specChanged) {
      for (const [id, prevC] of Object.entries(prevCriteria)) {
        if (!(id in nextCriteria)) nextCriteria[id] = prevC;
      }
    }

    const verdict = rollupScorecardVerdict(nextCriteria);
    const coverage = coveragePercent(nextCriteria);
    // `signedOff` is the loop's stop signal — computed here next to `verdict`
    // (which it does NOT change) so the watcher persists a current answer every
    // tick. Soft `unscored`/`unverifiable` never sign off (false-green safe).
    const signedOff = computeSignedOff(
      Object.values(nextCriteria).map(scorecardCriterionToSignOff),
    );
    // Certification stability input (maturity.ts property 4). Clean = the stop
    // rule holds AND no blocking soft score is stale (signedOff already refuses
    // tainted passes and unmet thresholds; staleness is the freshness clause it
    // deliberately ignores). Count once per DISTINCT commit: a clean tick at
    // the same sha with no relevant code change carries the count forward, so
    // an idle watcher re-ticking every 30s can't manufacture stability.
    const gateStale = Object.values(nextCriteria).some(
      (c) => c.severity !== 'advisory' && Boolean(c.stale),
    );
    const clean = signedOff && !gateStale;
    let cleanStreak = prevSpec?.cleanStreak;
    if (!clean) {
      cleanStreak = undefined;
    } else if (specChanged || !cleanStreak) {
      cleanStreak = { count: 1, lastSha: sha };
    } else if (obs.codeChanged === true || (sha && cleanStreak.lastSha !== sha)) {
      cleanStreak = { count: cleanStreak.count + 1, lastSha: sha ?? cleanStreak.lastSha };
    }
    if (
      prevSpec &&
      prevSpec.coveragePercent != null &&
      coverage != null &&
      coverage < prevSpec.coveragePercent
    ) {
      open(
        'coverage-drop',
        obs.specId,
        `coverage ${prevSpec.coveragePercent}% → ${coverage}% (more criteria became unverifiable)`,
      );
    } else if (
      prevSpec &&
      prevSpec.coveragePercent != null &&
      coverage != null &&
      coverage > prevSpec.coveragePercent
    ) {
      // Coverage strictly improved vs the prior tick — close any open
      // coverage-drop so the queue drains (W1 #2). Strict `>` (not `>=`) so a
      // quiet, unchanged tick emits nothing; a no-op if none is open.
      resolve('coverage-drop', obs.specId, `coverage recovered to ${coverage}%`);
    }

    nextSpecs[obs.specId] = {
      specVersion: obs.specVersion,
      specHash: obs.specHash,
      verdict,
      signedOff,
      coveragePercent: coverage,
      // Display cache (F1) — stamped AFTER verdict/signedOff, computed FROM
      // them (one-way data flow); every consumer with the full scorecard
      // recomputes, so a hand-edit can't persist past the next tick.
      validityScore: computeSpecScore(Object.values(nextCriteria)).score,
      // Maturity cache carries forward untouched: the reducer is criterion-
      // centric and never derives maturity (that needs evidence assembly the
      // wiring owns). `applyMaturityToScorecard` re-stamps it right after
      // every reconcile — see maturity.ts.
      maturity: prevSpec?.maturity,
      cleanStreak,
      criteria: nextCriteria,
      updatedAt: now,
    };
  }

  const scorecard: Scorecard = { version: 1, updatedAt: now, specs: nextSpecs };
  scorecard.validityScore = computeValidityScore(scorecard)?.score ?? null;
  return { scorecard, signals };
}

/** One soft-criterion score from the host agent (the LLM scorer). */
export interface SoftScore {
  id: string;
  status: 'pass' | 'fail' | 'unverifiable';
  detail?: string;
  /**
   * Optional normalized score [0,1] the judge assigned. When the frozen spec set
   * a `softThreshold` for this criterion, the stop rule (`computeSignedOff`) also
   * requires `score >= softThreshold` — so a `pass` status with a below-threshold
   * score does NOT sign off. Omitted ⇒ the threshold is not enforced numerically
   * (status alone decides). Persisted onto the soft `ScorecardCriterion`.
   */
  score?: number;
}

/**
 * Apply agent soft scores to an EXISTING scorecard spec entry — a TARGETED
 * per-criterion merge, distinct from `reconcileScorecard` (which replaces a
 * spec's whole criteria set from a full tick observation). This is the back
 * half of the soft-scoring loop: a deterministic tick records hard/property +
 * leaves soft `unscored`; the agent then scores the soft ones and we fold just
 * those in, WITHOUT disturbing the mechanical verdicts.
 *
 * Gate integrity:
 *   - Only `soft` criteria can be scored here. A score targeting a hard/property
 *     criterion is REJECTED (mechanical verdicts are authoritative and can never
 *     be overridden by an agent — the same invariant submit_report enforces).
 *   - A score for an unknown criterion id is rejected.
 *   - Requires a prior scorecard entry for the spec (i.e. a tick has run): we
 *     never invent hard/property statuses here. Throws if absent so the caller
 *     can tell the agent to run a verify/watch tick first.
 */
export function applySoftScores(args: {
  prev: Scorecard;
  specId: string;
  scores: SoftScore[];
  now: string;
  sha?: string;
}): {
  scorecard: Scorecard;
  signals: Signal[];
  applied: string[];
  rejected: Array<{ id: string; reason: string }>;
} {
  const { prev, specId, scores, now, sha } = args;
  const entry = prev.specs[specId];
  if (!entry) {
    throw new Error(
      `no scorecard entry for "${specId}" — run a verify/watch tick first so the deterministic ` +
        `verdicts are recorded, then record soft scores on top.`,
    );
  }

  const criteria: Record<string, ScorecardCriterion> = { ...entry.criteria };
  const signals: Signal[] = [];
  const applied: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const score of scores) {
    // Reject a status outside the union (deserialized/agent input is untrusted).
    // Without this an unknown status would persist and slip past the verdict as
    // "not a fail" — a false-green vector. Rejected, not coerced.
    if (score.status !== 'pass' && score.status !== 'fail' && score.status !== 'unverifiable') {
      rejected.push({ id: score.id, reason: `invalid status "${String(score.status)}"` });
      continue;
    }
    // Duplicate ids would re-compare against the just-updated state and emit
    // spurious regression/recovered signals; take the FIRST, reject the rest.
    if (seen.has(score.id)) {
      rejected.push({ id: score.id, reason: 'duplicate id in scores (first occurrence applied)' });
      continue;
    }
    seen.add(score.id);
    const before = criteria[score.id];
    if (!before) {
      rejected.push({ id: score.id, reason: 'unknown criterion id for this spec' });
      continue;
    }
    if (before.tier !== 'soft') {
      rejected.push({
        id: score.id,
        reason: `tier "${before.tier}" is mechanical — agent scores only apply to soft criteria`,
      });
      continue;
    }
    // TAINT CLAMP (A3): an agent `pass` landing on an entry whose evidence is
    // demoting-tainted (degraded wrapper, fabricated network, unconfirmed
    // render) is stored `unverifiable` — the score attempt is recorded, but the
    // gate stays shut. Taints are NEVER erased by a score: they re-originate at
    // capture, so only a clean verify tick can drop them. Mirrors
    // submit_report's soft-override clamp; the signal comparison below uses the
    // CLAMPED status so no spurious `recovered` fires.
    const demoting = demotingTaintsOf({ evidenceTaints: before.evidenceTaints });
    const clamped = applyEvidenceTaints(score.status, before.evidenceTaints ?? []);
    criteria[score.id] = {
      tier: 'soft',
      status: clamped,
      detail:
        clamped !== score.status
          ? `[evidence tainted: ${demoting.join(', ')} — pass withheld]${score.detail ? ` ${score.detail}` : ''}`
          : score.detail,
      at: now,
      sha,
      // a fresh agent score is never stale.
      stale: undefined,
      // Preserve the sign-off weights carried from the frozen spec — the agent
      // score replaces the STATUS, not the criterion's blocking/threshold rules.
      severity: before.severity,
      softThreshold: before.softThreshold,
      // Carry the judge's numeric score when supplied so a `softThreshold` can be
      // enforced by the stop rule. Absent ⇒ undefined (threshold not numerically
      // gated). Note: scoredBy provenance is stamped by the MCP layer afterward.
      score: score.score,
      // Sticky taints (A3): carried onto the merged entry, never laundered.
      evidenceTaints: before.evidenceTaints,
    };
    applied.push(score.id);

    // A soft criterion just received an agent score → answer its open lifecycle
    // signals so the queue drains on the daily unscored→pass / rescore
    // transition (W1 #1). Emission is grounded in the PRIOR state so a plain
    // re-score of an already-current criterion emits nothing:
    //   - it was `unscored`      ⇒ close needs-scoring
    //   - it was flagged `stale` ⇒ close needs-rescoring
    if (before.status === 'unscored') {
      signals.push(
        resolvedSignal(
          'needs-scoring',
          specId,
          score.id,
          now,
          sha,
          `soft criterion "${score.id}" scored`,
        ),
      );
    }
    if (before.stale) {
      signals.push(
        resolvedSignal(
          'needs-rescoring',
          specId,
          score.id,
          now,
          sha,
          `soft criterion "${score.id}" re-scored`,
        ),
      );
    }

    if (before.status === 'pass' && clamped === 'fail') {
      signals.push({
        id: signalId('regression', specId, score.id),
        kind: 'regression',
        severity: SEVERITY.regression,
        specId,
        criterionId: score.id,
        from: 'pass',
        to: 'fail',
        detail: `soft criterion "${score.id}" regressed: pass → fail. ${score.detail ?? ''}`.trim(),
        at: now,
        openedAt: now,
        sha,
        status: 'open',
      });
    } else if (
      (before.status === 'fail' || before.status === 'unverifiable') &&
      clamped === 'pass'
    ) {
      signals.push({
        id: signalId('recovered', specId, score.id),
        kind: 'recovered',
        severity: SEVERITY.recovered,
        specId,
        criterionId: score.id,
        from: before.status,
        to: 'pass',
        detail: `soft criterion "${score.id}" recovered: ${before.status} → pass`,
        at: now,
        openedAt: now,
        resolvedAt: now,
        sha,
        status: 'resolved',
        resolvedBy: 'pass',
      });
    }
  }

  // Recompute the stop signal alongside the verdict so a fresh soft score can
  // flip the spec to signed-off (or unblock it) in the same merge.
  const signedOff = computeSignedOff(Object.values(criteria).map(scorecardCriterionToSignOff));
  // Certification streak fold (maturity property 4) — same rules as the
  // reconcile reducer's fold. A fresh re-score that makes the spec clean must
  // restart (or, at a distinct commit, advance) the streak in the SAME write;
  // leaving it to the next deterministic tick strands the streak wherever the
  // stale-score reset left it, and a spec with blocking soft criteria can
  // never accumulate the clean runs certification needs.
  const gateStale = Object.values(criteria).some(
    (c) => c.severity !== 'advisory' && Boolean(c.stale),
  );
  const clean = signedOff && !gateStale;
  let cleanStreak = entry.cleanStreak;
  if (!clean) {
    cleanStreak = undefined;
  } else if (!cleanStreak) {
    cleanStreak = { count: 1, lastSha: sha };
  } else if (sha && cleanStreak.lastSha !== sha) {
    cleanStreak = { count: cleanStreak.count + 1, lastSha: sha };
  }

  const nextSpec: ScorecardSpec = {
    ...entry,
    verdict: rollupScorecardVerdict(criteria),
    signedOff,
    cleanStreak,
    coveragePercent: coveragePercent(criteria),
    // Display cache (F1) — stamped after verdict/signedOff, never read by them.
    validityScore: computeSpecScore(Object.values(criteria)).score,
    criteria,
    updatedAt: now,
  };
  const scorecard: Scorecard = {
    version: 1,
    updatedAt: now,
    specs: { ...prev.specs, [specId]: nextSpec },
  };
  scorecard.validityScore = computeValidityScore(scorecard)?.score ?? null;
  return { scorecard, signals, applied, rejected };
}

/**
 * Build a resolution marker for an existing open signal. `mergeSignals` applies
 * it ONLY when a matching open signal exists — it never mints an orphan
 * "resolved" row — so reducers can emit these unconditionally (W1 #1/#2, #6).
 */
function resolvedSignal(
  kind: SignalKind,
  specId: string,
  criterionId: string | undefined,
  now: string,
  sha?: string,
  detail = 'resolved',
  resolvedBy: SignalResolvedBy = 'pass',
): Signal {
  return {
    id: signalId(kind, specId, criterionId),
    kind,
    severity: SEVERITY[kind],
    specId,
    criterionId,
    detail,
    at: now,
    resolvedAt: now,
    sha,
    status: 'resolved',
    resolvedBy,
  };
}

/** How many resolved signals to retain (most-recent by resolve time) — W1 #3. */
export const RESOLVED_SIGNAL_RETENTION = 100;

/**
 * Cap the resolved backlog so `signals.json` can't grow without bound. Keeps
 * EVERY open signal plus the most-recent {@link RESOLVED_SIGNAL_RETENTION}
 * resolved ones (by `resolvedAt`, falling back to `at`). Preserves the input
 * order of the survivors so the dashboard's ordering is stable (W1 #3).
 */
export function pruneResolvedSignals(
  signals: Signal[],
  keep = RESOLVED_SIGNAL_RETENTION,
): Signal[] {
  const resolvedNewestFirst = signals
    .filter((s) => s.status === 'resolved')
    .sort((a, b) => (b.resolvedAt ?? b.at).localeCompare(a.resolvedAt ?? a.at));
  const keepResolved = new Set(resolvedNewestFirst.slice(0, keep));
  return signals.filter(
    (s) => s.status === 'open' || s.status === 'suppressed' || keepResolved.has(s),
  );
}

/**
 * Merge freshly-emitted signals into the stored set.
 *
 *  - An OPEN (or standalone `recovered`) signal (re-)inserts by id. Re-firing
 *    updates in place while PRESERVING the original `openedAt` so signal age is
 *    stable across ticks (W1 #3).
 *  - A `resolved` marker closes an existing open signal in place and is DROPPED
 *    when none is open — resolution markers never create orphan "resolved" rows
 *    (W1 #1/#2, #6). The exceptions are the STANDALONE resolved rows
 *    (`recovered` good-news, `spec-changed` notice), which always insert.
 *  - A `recovered` signal additionally resolves its matching open
 *    regression/unverifiable for that criterion (unchanged behaviour).
 */
const STANDALONE_RESOLVED: ReadonlySet<SignalKind> = new Set([
  'recovered',
  'spec-changed',
  'maturity-drop',
]);

export function mergeSignals(existing: Signal[], fresh: Signal[]): Signal[] {
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of fresh) {
    const prior = byId.get(s.id);
    // A suppressed prior is not reopened by a re-fire; a resolve marker
    // (condition cleared while parked) closes it as pass.
    if (prior?.status === 'suppressed') {
      if (s.status === 'resolved' && !STANDALONE_RESOLVED.has(s.kind)) {
        byId.set(s.id, {
          ...prior,
          status: 'resolved',
          detail: s.detail || prior.detail,
          at: s.at,
          resolvedAt: s.resolvedAt ?? s.at,
          sha: s.sha ?? prior.sha,
          resolvedBy: s.resolvedBy ?? 'pass',
          suppressedUntil: undefined,
          ...('hardening' in s ? { hardening: s.hardening } : {}),
        });
      } else if (s.status === 'open') {
        // Keep parked, but retain the latest claim text so a later reopen
        // can cite it (`reopened: … — <fresh detail>`).
        byId.set(s.id, {
          ...prior,
          detail: s.detail || prior.detail,
          at: s.at,
          sha: s.sha ?? prior.sha,
        });
      }
      continue;
    }
    if (s.status === 'resolved' && !STANDALONE_RESOLVED.has(s.kind)) {
      if (prior && prior.status === 'open') {
        byId.set(s.id, {
          ...prior,
          status: 'resolved',
          detail: s.detail || prior.detail,
          at: s.at,
          resolvedAt: s.resolvedAt ?? s.at,
          sha: s.sha ?? prior.sha,
          resolvedBy: s.resolvedBy ?? prior.resolvedBy,
          suppressedUntil: undefined,
          // A resolution marker that EXPLICITLY carries the `hardening`
          // property (even as undefined) updates it: the hardening engine's
          // auto-withdrawal strips the payload so a system withdrawal can
          // never read as a human dismissal (the dismissal check keys on a
          // RESOLVED row that kept its evidenceHash). Markers without the
          // property leave the prior payload untouched.
          ...('hardening' in s ? { hardening: s.hardening } : {}),
        });
      }
      continue;
    }
    if (s.status === 'suppressed') {
      if (prior && prior.status === 'open') {
        byId.set(s.id, {
          ...prior,
          status: 'suppressed',
          detail: s.detail || prior.detail,
          at: s.at,
          sha: s.sha ?? prior.sha,
          resolvedBy: 'suppress',
          suppressedUntil: s.suppressedUntil ?? prior.suppressedUntil,
        });
      }
      continue;
    }
    byId.set(s.id, {
      ...s,
      openedAt: prior?.openedAt ?? s.openedAt ?? s.at,
      resolvedAt: s.status === 'resolved' ? (s.resolvedAt ?? s.at) : undefined,
      resolvedBy: s.status === 'resolved' ? (s.resolvedBy ?? prior?.resolvedBy) : undefined,
      suppressedUntil: undefined,
    });
    if (s.kind === 'recovered' && s.criterionId) {
      // A recovery also closes any open needs-review for the same criterion
      // (Phase C probation): a criterion that was failing on a bulk spec and
      // is now passing again drains its probation signal alongside the
      // regression/unverifiable it would have closed.
      for (const kind of ['regression', 'unverifiable', 'needs-review'] as const) {
        const openId = signalId(kind, s.specId, s.criterionId);
        const p = byId.get(openId);
        if (p && (p.status === 'open' || p.status === 'suppressed'))
          byId.set(openId, {
            ...p,
            status: 'resolved',
            resolvedAt: s.at,
            resolvedBy: 'pass',
            at: s.at,
            suppressedUntil: undefined,
          });
      }
    }
  }
  return Array.from(byId.values());
}

/* ------------------------------------------------------------------ *
 * Stale-signal reconciliation — closing signals the current state      *
 * already answers. An open signal is a CLAIM about the present         *
 * ("this soft criterion has no score"); when the scorecard or the      *
 * current spec content contradicts that claim, the signal is stale     *
 * and must not sit in the inbox as if it were actionable. Two          *
 * consumers share ONE truth source (`staleSignalReason`):              *
 *   - the dashboard snapshot triages stale signals into the            *
 *     resolved/suppressed group for DISPLAY (read-only, no writes);    *
 *   - the watch tick calls `sweepStaleSignals` to CLOSE them in the    *
 *     ledger, so `watch --once` genuinely reconciles the inbox.        *
 * This is reconciliation, not policy: nothing here changes verdicts,   *
 * sign-off, or scoring — it only stops the queue from lying about      *
 * already-answered work.                                               *
 * ------------------------------------------------------------------ */

/**
 * The current-state context reconciliation reads: the persisted scorecard plus
 * the CURRENT on-disk spec content (id → version/criterion tiers). Structural
 * on purpose — callers project `Spec[]` (from `listSpecs`) into it without
 * this module importing the spec store.
 */
export interface SignalStateContext {
  scorecard: Scorecard | null;
  specs: Array<{
    id: string;
    version: number;
    criteria: Array<{ id: string; tier: CriterionTier }>;
  }>;
}

/**
 * Why an OPEN signal is stale (contradicted by current state), or `null` while
 * its claim still stands. Grounded rules only — every reason cites the state
 * that answers the signal:
 *
 *   - any criterion-scoped kind: the criterion no longer exists in the CURRENT
 *     spec content (left in a re-freeze / version bump);
 *   - `needs-scoring`: the scorecard records a decided status (already
 *     scored), or the criterion is hard/property in the current spec
 *     (machine-checked — an agent score is no longer the ask);
 *   - `needs-rescoring`: the recorded soft score is no longer flagged stale
 *     (a fresh score landed), or the same tier rules as needs-scoring;
 *   - `regression` / `needs-review`: the criterion currently PASSES
 *     (recovered, but the close was missed);
 *   - `unverifiable`: the criterion currently passes. (A current `fail` keeps
 *     it open — "can't verify" that became "verified failing" is still work.)
 *   - the spec exists in neither the scorecard nor `.validity/specs/`.
 *
 * Deliberately conservative: an unknown kind, a missing criterion entry, or a
 * still-failing criterion never reads as stale — suppression must never hide
 * live work (the display analog of the false-green rule).
 */
export function staleSignalReason(signal: Signal, ctx: SignalStateContext): string | null {
  if (signal.status !== 'open') return null;

  // Project-scoped standing signal: its specId is the literal '*' and matches
  // no spec by construction, so the spec-existence guard below would insta-
  // close it. Its lifecycle is owned by `judgeGapSignals` on the watch tick
  // (config knowledge lives there, not in this context).
  if (signal.kind === 'judge-gap') return null;

  const spec = ctx.specs.find((s) => s.id === signal.specId);
  const scoreEntry = ctx.scorecard?.specs[signal.specId];
  if (!spec && !scoreEntry) return 'spec no longer exists';

  const critId = signal.criterionId;
  if (!critId) return null; // spec-scoped kinds (coverage-drop) have live close paths

  const specCrit = spec?.criteria.find((c) => c.id === critId);
  const recorded = scoreEntry?.criteria?.[critId];

  // A criterion the CURRENT spec content no longer carries is a zombie — the
  // signal describes an earlier version's criterion layout.
  if (spec && !specCrit) {
    return `criterion no longer exists in the current spec (@v${spec.version})`;
  }

  switch (signal.kind) {
    case 'needs-scoring': {
      if (recorded && recorded.status !== 'unscored') {
        return `already scored — scorecard records "${recorded.status}"`;
      }
      if (specCrit && specCrit.tier !== 'soft') {
        return `criterion is ${specCrit.tier} in the current spec (@v${spec!.version}) — machine-checked, not agent-scored`;
      }
      return null;
    }
    case 'needs-rescoring': {
      if (recorded && recorded.status !== 'unscored' && recorded.stale !== true) {
        return 're-scored — the recorded score is no longer stale';
      }
      if (specCrit && specCrit.tier !== 'soft') {
        return `criterion is ${specCrit.tier} in the current spec (@v${spec!.version}) — machine-checked, not agent-scored`;
      }
      return null;
    }
    case 'regression':
    case 'needs-review':
    case 'unverifiable': {
      if (recorded && recorded.status === 'pass') {
        return 'recovered — the criterion currently passes';
      }
      return null;
    }
    case 'hardening-candidate': {
      // The proposal's whole premise is "this criterion is soft and gates" —
      // once it is hard/property (accepted) or advisory (demoted, reviewable
      // spec edit), the current spec content already answers the signal.
      if (specCrit && specCrit.tier !== 'soft') {
        return `already hardened — criterion is ${specCrit.tier} in the current spec (@v${spec!.version})`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Build resolution markers for every stale open signal (see
 * {@link staleSignalReason}). Feed the result to {@link mergeSignals}, which
 * closes matching open signals in place and drops markers with no match —
 * safe to call unconditionally on every tick.
 */
export function sweepStaleSignals(
  signals: Signal[],
  ctx: SignalStateContext,
  now: string,
  sha?: string,
): Signal[] {
  const markers: Signal[] = [];
  for (const s of signals) {
    if (s.status !== 'open') continue;
    const reason = staleSignalReason(s, ctx);
    if (reason === null) continue;
    markers.push({
      id: s.id,
      kind: s.kind,
      severity: s.severity,
      specId: s.specId,
      criterionId: s.criterionId,
      detail: `auto-resolved: ${reason}`,
      at: now,
      resolvedAt: now,
      sha,
      status: 'resolved',
      resolvedBy: 'sweep',
    });
  }
  return markers;
}

/**
 * Diff the queue before/after a merge into TRANSITIONS: signals that newly
 * opened (or re-opened) and signals that flipped to resolved this tick.
 * Steady-state re-fires — same id, still open — are NOT transitions, so
 * consumers (the on-signal actuation hook, the committed signal-history
 * feed) fire on state changes only, never on every tick. Pure.
 */
export function diffSignalTransitions(
  before: Signal[],
  after: Signal[],
): { opened: Signal[]; resolved: Signal[]; suppressed: Signal[] } {
  const prior = new Map(before.map((s) => [s.id, s.status]));
  const opened: Signal[] = [];
  const resolved: Signal[] = [];
  const suppressed: Signal[] = [];
  for (const s of after) {
    const was = prior.get(s.id);
    if (s.status === 'open' && was !== 'open') opened.push(s);
    else if (s.status === 'resolved' && (was === 'open' || was === 'suppressed')) resolved.push(s);
    else if (s.status === 'suppressed' && was === 'open') suppressed.push(s);
  }
  return { opened, resolved, suppressed };
}

/* ------------------------------------------------------------------ *
 * Perf drift (D1) — ADVISORY signals over the runs.jsonl perf         *
 * timeline. Deliberately NOT folded into `reconcileScorecard`: the    *
 * reducer is criterion-centric and must never need run history in     *
 * scope. Signals flow through the same `mergeSignals` pipe.           *
 * ------------------------------------------------------------------ */

/**
 * Median over the last 5 prior same-key entries. A rolling median tracks
 * intentional accepted perf changes within 5 runs without a baseline-accept
 * workflow; the known trade-off is that a slow boiling-frog degradation
 * never fires (the trends surface is the long-horizon answer).
 */
export const PERF_DRIFT_WINDOW = 5;
/** A median of 1-2 points is a coin flip — new render slots earn a baseline after 3 runs. */
export const PERF_DRIFT_MIN_SAMPLES = 3;
/** Relative breach: latest > median * 1.5 (the ">50%" rule). */
export const PERF_DRIFT_RELATIVE_FACTOR = 1.5;
/**
 * Absolute floors per metric — a breach requires BOTH the relative factor AND
 * `latest - median >= floor`, so sub-noise jitter (2ms → 3.5ms is +75% but
 * +1.5ms) never fires. 100ms for navigation-scale metrics (dev-hardware
 * jitter is tens of ms); 5ms for Profiler commit costs (1-20ms typical);
 * `commitCount` is a count, not ms: +3 commits AND +50% is a real re-render
 * change.
 *
 * `harnessBootMs` is deliberately ABSENT (hence `Partial`): it measures the
 * sandbox's own cold start, which swings by ~1s purely on whether Vite's cache
 * was warm. Reporting that as the app's perf drift is exactly the false-red the
 * metric split was introduced to kill. The detector's `floor === undefined`
 * guard skips any metric omitted here.
 */
export const PERF_DRIFT_FLOORS: Partial<Record<keyof PerformanceMetrics, number>> = {
  loadMs: 100,
  firstContentfulPaintMs: 100,
  readyMs: 100,
  mountMs: 5,
  updateMs: 5,
  updateTotalMs: 10,
  commitCount: 3,
};

/**
 * The structural slice of a `SpecRunSummary` the detector reads (structural on
 * purpose — run.ts imports this module, so importing run.ts back would cycle).
 */
export interface PerfHistoryEntry {
  runId: string;
  /** ISO run-creation time — orders "latest" (absent on pre-feature rows). */
  createdAt?: string;
  perf?: Record<string, PerformanceMetrics>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const fmtPerf = (metric: string, v: number): string =>
  metric === 'commitCount' ? String(Math.round(v * 10) / 10) : `${Math.round(v * 10) / 10}ms`;

/**
 * Detect perf drift in a spec's run timeline: the LATEST entry's metrics vs.
 * the median of the last `PERF_DRIFT_WINDOW` prior same-key entries. Pure and
 * deterministic. ADVISORY by construction: emits only `perf-drift` signals
 * (severity `low`, so `watch --fail-on-signal` — which gates on `high` — can
 * never trip on one), and reads no verdict surface.
 *
 * No-launder rule: a latest entry with no perf (URL run, pre-feature row,
 * dead instrumentation) fires nothing AND resolves nothing — absence of
 * measurement must never read as recovery. Recovery requires a measured,
 * in-range latest value for the same key. Rows are deduped by runId
 * (last-wins) so the submit_report re-append can't seed the current run's
 * own baseline, and ordered by `createdAt` so a late re-append of an OLDER
 * run can't become "latest".
 */
export function computePerfDriftSignals(args: {
  specId: string;
  /** Raw runs.jsonl rows, newest-last (`SpecRunSummary` satisfies this structurally). */
  history: PerfHistoryEntry[];
  /** Currently-stored signals (open + resolved) — used to emit recoveries in place. */
  existingSignals: Signal[];
  now: string;
  sha?: string;
}): Signal[] {
  const { specId, existingSignals, now, sha } = args;
  // Dedupe by runId, keep the LAST row per id (the scored re-append supersedes
  // the verify-time append), then order by RUN time, not file position:
  // runs.jsonl is append-ordered by WRITE time, and submit_report re-appends a
  // scored twin for an OLDER run after newer runs have landed — that twin must
  // not become "latest". Same comparator as the history.ts readers (createdAt
  // ascending, absent-createdAt pre-feature rows first, ties by runId).
  const byRun = new Map<string, PerfHistoryEntry>();
  for (const row of args.history) byRun.set(row.runId, row);
  const entries = Array.from(byRun.values()).sort(
    (a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.runId.localeCompare(b.runId),
  );
  const latest = entries.at(-1);
  if (!latest?.perf || Object.keys(latest.perf).length === 0) return [];
  const prior = entries.slice(0, -1);

  const signals: Signal[] = [];
  const cleanKeys = new Set<string>();
  for (const [perfKey, latestMetrics] of Object.entries(latest.perf)) {
    // Baseline: up to WINDOW prior entries that measured this key, newest first.
    const baseline: PerformanceMetrics[] = [];
    for (let i = prior.length - 1; i >= 0 && baseline.length < PERF_DRIFT_WINDOW; i--) {
      const p = prior[i]!.perf?.[perfKey];
      if (p) baseline.push(p);
    }
    const degraded: string[] = [];
    for (const [metric, value] of Object.entries(latestMetrics)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const floor = PERF_DRIFT_FLOORS[metric as keyof PerformanceMetrics];
      if (floor === undefined) continue;
      const samples = baseline
        .map((b) => b[metric as keyof PerformanceMetrics])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (samples.length < PERF_DRIFT_MIN_SAMPLES) continue;
      const med = median(samples);
      if (value > med * PERF_DRIFT_RELATIVE_FACTOR && value - med >= floor) {
        degraded.push(
          `${metric} ${fmtPerf(metric, med)} → ${fmtPerf(metric, value)} (median of last ${samples.length})`,
        );
      }
    }
    if (degraded.length > 0) {
      signals.push({
        id: signalId('perf-drift', specId, perfKey),
        kind: 'perf-drift',
        severity: SEVERITY['perf-drift'],
        specId,
        perfKey,
        detail: `perf drift: ${degraded.join(', ')} — advisory, does not gate`,
        at: now,
        sha,
        status: 'open',
      });
    } else {
      cleanKeys.add(perfKey);
    }
  }

  // Recovery: an open perf-drift whose key WAS measured this run and did not
  // degrade resolves in place. A key absent from the latest run (variant
  // removed / not rendered) stays open — conservative carry-forward.
  for (const s of existingSignals) {
    if (s.kind !== 'perf-drift' || s.specId !== specId || s.status !== 'open') continue;
    if (s.perfKey && cleanKeys.has(s.perfKey)) {
      signals.push({
        ...s,
        detail: 'recovered: metrics back within range of the trailing median',
        at: now,
        sha,
        status: 'resolved',
        resolvedBy: 'pass',
      });
    }
  }
  return signals;
}

/* ------------------------------------------------------------------ *
 * Replay divergence — the on-device journey lane's signal.            *
 *                                                                     *
 * `validity replay` re-executes a run's signed `.ad` recording on a    *
 * device. When the journey no longer reaches its landmark,            *
 * agent-device hands back a bounded divergence report; the CLI writes  *
 * that report into the run dir and appends the append-only ledger      *
 * (`.validity/runs/replay-divergence.jsonl`) as EVIDENCE. This is the  *
 * actionable STATE that sits on top of that evidence.                  *
 *                                                                     *
 * The whole point of this section is the pair: an open signal nothing  *
 * can close would inflate the dashboard's open count forever (which is *
 * exactly why the ledger shipped without one). So the kind exists here *
 * only WITH its two close paths:                                       *
 *                                                                     *
 *   (a) a later replay of the SAME recording reproduces — the journey  *
 *       holds again ({@link replayDivergenceSignals});                 *
 *   (b) a fresh verify publishes a NEW signed `.ad` for the spec — the *
 *       diverged recording is no longer the attested journey, so the   *
 *       claim is moot ({@link supersededReplayDivergenceSignals}).     *
 *                                                                     *
 * No-launder rule, mirrored from perf drift: a replay that could not   *
 * re-execute the journey (`unverifiable-now` — no device, unmet        *
 * secret, unsigned `.ad`) fires NOTHING and closes NOTHING. Absence of *
 * measurement is never recovery.                                       *
 * ------------------------------------------------------------------ */

/**
 * The id for one journey's divergence: `replay-divergence:<specId>:<file>`.
 *
 * Keyed on the spec AND the recording so the same journey diverging twice
 * updates ONE signal (re-fires merge in place, `openedAt` preserved) while two
 * different recordings for the same spec stay distinguishable.
 */
export function replayDivergenceSignalId(specId: string, recording: string): string {
  return signalId('replay-divergence', specId, recording);
}

/**
 * Reconcile one replayed journey into signal rows for {@link mergeSignals}.
 *
 *   - `diverged`   → one OPEN row (re-fires update in place — never a second row);
 *   - `reproduced` → a resolution marker, dropped by `mergeSignals` when
 *     nothing is open, so the caller fires it unconditionally.
 *
 * Anything else (the journey could not be re-executed) must not reach here —
 * see the no-launder rule above.
 */
export function replayDivergenceSignals(args: {
  specId: string;
  /** Run-dir-relative `.ad` that was replayed. */
  recording: string;
  outcome: 'diverged' | 'reproduced';
  detail: string;
  now: string;
  sha?: string;
  runId?: string;
}): Signal[] {
  const id = replayDivergenceSignalId(args.specId, args.recording);
  if (args.outcome === 'reproduced') {
    return [
      {
        id,
        kind: 'replay-divergence',
        severity: SEVERITY['replay-divergence'],
        specId: args.specId,
        recording: args.recording,
        detail: args.detail,
        at: args.now,
        resolvedAt: args.now,
        sha: args.sha,
        status: 'resolved',
        resolvedBy: 'pass',
      },
    ];
  }
  return [
    {
      id,
      kind: 'replay-divergence',
      severity: SEVERITY['replay-divergence'],
      specId: args.specId,
      recording: args.recording,
      ...(args.runId ? { runId: args.runId } : {}),
      detail: args.detail,
      at: args.now,
      openedAt: args.now,
      sha: args.sha,
      status: 'open',
    },
  ];
}

/**
 * Close path (b): a fresh verify published a NEW signed `.ad` for this spec, so
 * every open divergence about an EARLIER recording of the same spec is a claim
 * about a journey the spec no longer cites. Returns resolution markers for all
 * of them (`mergeSignals` drops any that are not open).
 *
 * Spec-scoped rather than file-scoped on purpose: recordings are published
 * under a fixed filename per run dir, so matching on the name alone would tie
 * resolution to a coincidence. What actually supersedes the diverged journey is
 * the act of recording a new one for the same contract.
 */
export function supersededReplayDivergenceSignals(args: {
  existing: Signal[];
  specId: string;
  /** The newly published recording, named in the resolution detail. */
  recording: string;
  now: string;
  sha?: string;
}): Signal[] {
  const markers: Signal[] = [];
  for (const s of args.existing) {
    if (s.kind !== 'replay-divergence' || s.specId !== args.specId || s.status !== 'open') continue;
    markers.push({
      ...s,
      detail:
        `superseded — a fresh verify published a new signed recording (${args.recording}) for ` +
        `${args.specId}, so the diverged journey is no longer the attested one. Replay the new run to re-check it.`,
      at: args.now,
      resolvedAt: args.now,
      sha: args.sha ?? s.sha,
      status: 'resolved',
      resolvedBy: 'superseded',
    });
  }
  return markers;
}

/* ------------------------------------------------------------------ *
 * IO shell.                                                           *
 * ------------------------------------------------------------------ */

export function scorecardPath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'scorecard.json');
}

export function signalsPath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'signals.json');
}

export function loadScorecard(projectRoot: string): Scorecard | null {
  const p = scorecardPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Scorecard;
  } catch {
    return null;
  }
}

/**
 * The scorecard file exists on disk but does NOT parse (W4 #11). Distinct from
 * "missing" (which `loadScorecard` also reports as `null`): a corrupt file must
 * NOT be treated as an empty scorecard, because reconciling a scoped tick's
 * observations onto an empty prior DROPS every other spec's entries (and their
 * soft scores). Write paths call this to refuse a reconcile-from-empty over a
 * file that's merely unreadable — the safe move is to skip the write and let the
 * next intact read recover.
 */
export function scorecardExistsButUnreadable(projectRoot: string): boolean {
  const p = scorecardPath(projectRoot);
  if (!existsSync(p)) return false;
  try {
    JSON.parse(readFileSync(p, 'utf-8'));
    return false;
  } catch {
    return true;
  }
}

export function saveScorecard(projectRoot: string, sc: Scorecard): void {
  ensureDir(validityDir(projectRoot));
  writeFileAtomic(scorecardPath(projectRoot), JSON.stringify(sc, null, 2) + '\n');
}

export function loadSignals(projectRoot: string): Signal[] {
  const p = signalsPath(projectRoot);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as Signal[]) : [];
  } catch {
    return [];
  }
}

export function saveSignals(projectRoot: string, signals: Signal[]): void {
  ensureDir(validityDir(projectRoot));
  // Cap the resolved backlog on the way to disk so the queue can't grow forever
  // (W1 #3). Open signals are always kept.
  const pruned = pruneResolvedSignals(signals);
  writeFileAtomic(signalsPath(projectRoot), JSON.stringify(pruned, null, 2) + '\n');
}

/* ------------------------------------------------------------------ *
 * Score history (F1) — the append-only trend feed under               *
 * `.validity/history/`. HISTORY POSTURE (§9.4): callers append ONLY   *
 * when `config.historyCommitted === true` (default off) — history is  *
 * an opt-in committed artifact, and a watch tick must never silently  *
 * change the repo's posture. When off, trends are recomputed from     *
 * timelines/scorecard instead.                                        *
 * ------------------------------------------------------------------ */

/** One appended score observation. The F2 trends surface charts these. */
export interface ScoreHistoryEntry {
  /** ISO timestamp. */
  at: string;
  /** Commit observed at, when known. */
  sha?: string;
  /** Pooled repo score. */
  score: number | null;
  /** Spec id → sub-score. */
  perSpec: Record<string, number | null>;
  /** Which loop appended it. */
  source: 'watch' | 'soft-scores';
  scoreVersion: typeof VALIDITY_SCORE_VERSION;
}

export function scoreHistoryPath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'history', 'score.jsonl');
}

/**
 * Ensure `.validity/.gitattributes` declares `history/*.jsonl merge=union` so
 * two branches appending history rows never conflict. Shared by every
 * `.validity/history/` appender (F1's score.jsonl, F2's per-spec timelines).
 * Best-effort: history is derived, never a source of truth.
 */
export function ensureHistoryMergeUnion(projectRoot: string): void {
  const line = 'history/*.jsonl merge=union';
  try {
    const path = resolve(validityDir(projectRoot), '.gitattributes');
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    if (existing.split('\n').some((l) => l.trim() === line)) return;
    ensureDir(validityDir(projectRoot));
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(path, `${prefix}${line}\n`);
  } catch {
    // Non-fatal — a merge conflict in derived history is recoverable by hand.
  }
}

/**
 * Append a score observation to `.validity/history/score.jsonl`. Call ONLY
 * when `config.historyCommitted === true` (§9.4 — see the section note).
 * Dedupes against the last line (same score, same sha, deep-equal perSpec) so
 * a 60-second watch loop doesn't write 1,440 identical rows a day. Best-effort
 * like `indexRunForSpec` — a write failure never fails the tick.
 */
export function appendScoreHistory(projectRoot: string, entry: ScoreHistoryEntry): void {
  try {
    const last = readScoreHistory(projectRoot, 1).at(-1);
    if (
      last &&
      last.score === entry.score &&
      last.sha === entry.sha &&
      JSON.stringify(last.perSpec) === JSON.stringify(entry.perSpec)
    ) {
      return;
    }
    ensureDir(resolve(validityDir(projectRoot), 'history'));
    ensureHistoryMergeUnion(projectRoot);
    appendFileSync(scoreHistoryPath(projectRoot), JSON.stringify(entry) + '\n');
  } catch {
    // Non-fatal — history is derived, never a source of truth.
  }
}

/** Read the last `limit` score entries, newest last. Tolerant: missing file ⇒ [], malformed lines dropped. */
export function readScoreHistory(projectRoot: string, limit = 200): ScoreHistoryEntry[] {
  const path = scoreHistoryPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as ScoreHistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((v): v is ScoreHistoryEntry => v !== null);
  } catch {
    return [];
  }
}
