/**
 * Spec maturity ladder — DERIVED trust levels over the existing machinery.
 *
 * Frozen specs span a huge trust range: never verified since freezing … proven
 * once, months ago, before the last refactor … every gate criterion passing on
 * fresh, untainted evidence at the current frozen content, repeatedly. The
 * ladder makes that range visible and tells a team exactly what stands between
 * a spec and the next rung:
 *
 *   0 probation — machine-drafted (bulk onboarding), unproven
 *   1 dev       — iterating against intent; soft criteria and self-scoring OK
 *   2 team      — frozen contract; hard checks gate PRs via `verify --all`
 *   3 certified — the contract is CURRENTLY PROVEN: every gate-relevant
 *                 criterion passes on untainted, fresh evidence at the current
 *                 frozen content, and has done so repeatedly (a clean streak
 *                 across distinct commits)
 *
 * THE core principle: **levels are DERIVED, never declared.** There is no
 * `maturity:` field in spec.yaml — every level is computed from properties the
 * system already records, so the ladder cannot be gamed by editing a field:
 *
 *   - L0 is the existing `probation` marker (set only by the bulk onboarding
 *     generator, cleared only via `clearSpecProbation` after a human-confirmed
 *     pass — `observationConfirmsProbationClear`, scorecard-fold.ts);
 *   - L1 is any non-probation spec that is not frozen;
 *   - L2 is `status === 'frozen'`;
 *   - L3 is frozen PLUS the certification predicate below.
 *
 * The certification predicate (a spec S is certified iff ALL of):
 *   1. S.status === 'frozen';
 *   2. S's gate has substance: at least one BLOCKING (`criterionIsBlocking`)
 *      criterion, of which at least one is hard/property. Blocking SOFT
 *      criteria are ALLOWED — they certify through evidence (property 3:
 *      scored, threshold-met, untainted, fresh) instead of being banned. The
 *      hard/property floor is the anti-Goodhart clause: an all-soft gate must
 *      not mint a certification whose every input is a model's say-so (the
 *      same reason `observationConfirmsProbationClear` refuses an all-soft
 *      spec);
 *   3. the scorecard — the durable, committed evidence — proves the CURRENT
 *      contract: the entry matches S's version and frozen hash, and every
 *      gate-relevant criterion is `pass` with no demoting evidence taint,
 *      soft scores meeting their threshold and not stale (code has not moved
 *      since they were set);
 *   4. stability: the reducer-maintained clean streak (`cleanStreak`,
 *      scorecard.ts — consecutive signed-off, fresh verifications at the
 *      current hash, counted once per distinct commit) has reached
 *      {@link CERTIFICATION_STABLE_RUNS}.
 *
 * Certification deliberately reads ONLY what Validity itself proves. Export
 * health — does the spec compile warning-free to Playwright/Maestro, are the
 * exported artifacts byte-fresh — is a SEPARATE, optional "portable" badge
 * (`assessSpecPortability`, @validity.ai/verify-web), surfaced only when the project
 * configures an `export` stanza. It never gates maturity, the score, or
 * sign-off: a spec's trust level must not depend on how well it translates to
 * another tool's format. (Historical note: L3 was originally "compiles
 * warning-free + byte-fresh artifacts", which made certification unreachable
 * for screenshot/perf/a11y/command checks and for native specs, and let an
 * exporter version bump silently de-certify every spec.)
 *
 * Property 2's hard/property floor is the anti-Goodhart floor: demoting EVERY
 * mechanical criterion to advisory must not leave a certification carried
 * entirely by soft scores.
 *
 * This module is PURE: the evidence (the spec's scorecard entry) is passed IN,
 * so the derivation unit-tests without IO and every caller (CLI, MCP, watch,
 * dashboard) shares one wiring — `assessSpecMaturity` in `@validity.ai/verify-web` —
 * and one answer.
 *
 * Demotion is symmetric and automatic: levels are recomputed, never sticky. A
 * version bump un-freezes (certification vanishes with frozenness); a failing
 * tick resets the clean streak; a stale soft score or a demoting evidence
 * taint de-certifies on the next derivation. A derived-level DROP between
 * ticks surfaces as a `maturity-drop` signal (informational, standalone
 * resolved — the maturity chip + blockers list are the actionable surface).
 */
import {
  criterionIsBlocking,
  demotingTaintsOf,
  type Spec,
  type SpecCriterion,
} from './spec-schema.js';
import { softThresholdMet } from './scorecard.js';
import type { Scorecard, ScorecardSpec, Signal } from './scorecard.js';

/** The four rungs. Order matters — see {@link MATURITY_RANK}. */
export type SpecMaturity = 'probation' | 'dev' | 'team' | 'certified';

/** Ladder order for comparisons (drop detection, weighting). */
export const MATURITY_RANK: Record<SpecMaturity, number> = {
  probation: 0,
  dev: 1,
  team: 2,
  certified: 3,
};

/** Human labels for rendering surfaces (CLI column, dashboard chip). */
export const MATURITY_LEVELS: readonly SpecMaturity[] = [
  'probation',
  'dev',
  'team',
  'certified',
] as const;

/**
 * Stability threshold (predicate property 4): consecutive clean verifications
 * at distinct commits before a frozen spec certifies. 2 = the proof held
 * across at least one round of code churn, not just the tick that produced it.
 */
export const CERTIFICATION_STABLE_RUNS = 2;

export interface MaturityBlocker {
  kind:
    | 'probation-unclear' // L0→L1: needs first human-confirmed pass
    | 'not-frozen' // L1→L2: freeze the spec
    | 'empty-gate' // L2→L3: every criterion is advisory — nothing to certify
    | 'no-mechanical-anchor' // L2→L3: gate is all-soft — add a hard/property criterion
    | 'never-verified' // L2→L3: no scorecard evidence for this spec yet
    | 'evidence-outdated' // L2→L3: evidence is for an older version/hash — re-verify
    | 'criterion-unproven' // L2→L3: a gate criterion is not passing (fail/unverifiable/unscored)
    | 'evidence-tainted' // L2→L3: a gate pass carries a demoting evidence taint
    | 'soft-score-stale' // L2→L3: a gate soft score is stale — re-score
    | 'stability-pending'; // L2→L3: clean streak below CERTIFICATION_STABLE_RUNS
  criterionId?: string;
  detail: string;
}

export interface MaturityAssessment {
  level: SpecMaturity;
  /**
   * The hardening backlog: every actionable step between the current level and
   * `certified`, in ladder order. Empty ⇔ level === 'certified'.
   */
  blockers: MaturityBlocker[];
}

/**
 * Injected artifact check result — consumed by the PORTABILITY badge
 * (`assessSpecPortability`, @validity.ai/verify-web), not by certification.
 *   - `ok`      — manifest row exists for this spec@version/hash, every listed
 *                 file exists, and a fresh recompile matches byte-for-byte;
 *   - `missing` — no manifest row (or listed file absent) for the CURRENT
 *                 frozen content — run `validity spec export <id>`;
 *   - `drift`   — artifacts exist but disagree with a fresh recompile (hand
 *                 edit, stale spec, toolchain change) — `detail` says which.
 */
export interface MaturityArtifactCheck {
  status: 'ok' | 'missing' | 'drift';
  detail?: string;
}

/**
 * The durable evidence the certification predicate reads (properties 3–4).
 * `entry` is the spec's scorecard entry — the committed state of truth the
 * watcher maintains — or undefined when the spec has never been verified.
 */
export interface MaturityEvidence {
  entry?: ScorecardSpec;
  /** Stability threshold override (default {@link CERTIFICATION_STABLE_RUNS}). */
  stableRuns?: number;
}

/** Gate-relevant = participates in sign-off (absent severity ⇒ blocking). */
function gateRelevant(spec: Spec): SpecCriterion[] {
  return spec.criteria.filter((c) => criterionIsBlocking(c));
}

/**
 * The spec restricted to its gate-relevant hard/property criteria — the
 * population the EXPORT warning collectors run over (`spec export --all`
 * eligibility and the portability badge). Soft and advisory criteria are
 * excluded: soft criteria export as stubs by design (the exporters warn), and
 * advisory criteria never gate anything.
 */
export function exportGateSpec(spec: Spec): Spec {
  return {
    ...spec,
    criteria: gateRelevant(spec).filter((c) => c.tier !== 'soft'),
  };
}

/** Clip criterion text for blocker details (single line, bounded). */
function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Derive a spec's maturity level + the full hardening backlog. PURE given the
 * passed-in evidence — see the module header for the ladder and the
 * certification predicate. The blockers list every step to `certified` in
 * ladder order (probation → freeze → gate content → evidence → stability), so
 * `spec show` renders it as "N steps from certified" verbatim.
 */
export function assessMaturity(spec: Spec, evidence: MaturityEvidence = {}): MaturityAssessment {
  const blockers: MaturityBlocker[] = [];

  // L0 — probation. Derived from the marker the bulk generator stamps; only
  // the existing confirmed-pass path (`clearSpecProbation`) lifts it, so this
  // assessment can never clear probation itself (A3 acceptance).
  const onProbation = Boolean(spec.probation);
  if (onProbation) {
    blockers.push({
      kind: 'probation-unclear',
      detail:
        'bulk-created spec awaiting its first human-confirmed clean pass — run a verify with ' +
        'every blocking hard/property criterion passing untainted; probation lifts automatically',
    });
  }

  // L1→L2 — frozen contract.
  const frozen = spec.status === 'frozen';
  if (!frozen) {
    blockers.push({
      kind: 'not-frozen',
      detail:
        spec.status === 'superseded'
          ? 'superseded — this version never freezes again; the successor spec carries the contract'
          : `status is '${spec.status}' — freeze the spec (validity__spec_freeze) to lock the contract`,
    });
  }

  // L2→L3 gate content (property 2). Computed for EVERY spec — including
  // unfrozen ones — so the backlog shows the whole climb early (hardening
  // while iterating beats hardening after freezing).
  const gate = gateRelevant(spec);
  if (gate.length === 0) {
    blockers.push({
      kind: 'empty-gate',
      detail:
        'every criterion is advisory — nothing participates in the gate. Certification requires ' +
        'at least one blocking criterion (an empty contract must not certify)',
    });
  } else if (gate.every((c) => c.tier === 'soft')) {
    blockers.push({
      kind: 'no-mechanical-anchor',
      detail:
        'every gate criterion is soft — certification requires at least one blocking ' +
        'hard/property criterion so the proof is anchored by a mechanical check, not only ' +
        'model scores (add checks via validity__spec_update)',
    });
  }

  // L2→L3 evidence (property 3): the scorecard entry proves the CURRENT
  // contract. When the entry is absent or belongs to older content, one
  // blocker says so — listing every criterion as unproven on top would be
  // noise (re-verifying is the single next step either way).
  const entry = evidence.entry;
  const entryCurrent =
    entry !== undefined &&
    entry.specVersion === spec.version &&
    (!spec.hash || !entry.specHash || entry.specHash === spec.hash);
  if (!entry) {
    blockers.push({
      kind: 'never-verified',
      detail:
        'no verified evidence for this spec yet — run a verify (validity__verify or ' +
        '`validity verify --all`) so the scorecard records a proof',
    });
  } else if (!entryCurrent) {
    blockers.push({
      kind: 'evidence-outdated',
      detail:
        `evidence is for spec v${entry.specVersion} — the spec is now v${spec.version}` +
        (spec.hash && entry.specHash && entry.specHash !== spec.hash ? ' (content changed)' : '') +
        '; re-verify to refresh the proof',
    });
  } else {
    for (const c of gate) {
      const sc = entry.criteria[c.id];
      if (!sc) {
        blockers.push({
          kind: 'criterion-unproven',
          criterionId: c.id,
          detail: `${c.id} ("${clip(c.text)}") has no recorded verdict — run a full verify`,
        });
        continue;
      }
      if (sc.status !== 'pass') {
        const why =
          sc.status === 'fail'
            ? 'is failing'
            : sc.status === 'unverifiable'
              ? 'is unverifiable (spec rot / selector drift)'
              : 'awaits an agent score (needs-scoring)';
        blockers.push({
          kind: 'criterion-unproven',
          criterionId: c.id,
          detail: `${c.id} ("${clip(c.text)}") ${why}`,
        });
        continue;
      }
      if (!softThresholdMet(sc)) {
        blockers.push({
          kind: 'criterion-unproven',
          criterionId: c.id,
          detail:
            `${c.id} passed but its score ${sc.score} is below the sign-off threshold ` +
            `${sc.softThreshold} — improve the UI or re-score`,
        });
        continue;
      }
      const taints = demotingTaintsOf(sc);
      if (taints.length > 0) {
        blockers.push({
          kind: 'evidence-tainted',
          criterionId: c.id,
          detail:
            `${c.id} passed on tainted evidence (${taints.join(', ')}) — ` +
            'fix the capture degradation and re-verify',
        });
        continue;
      }
      if (c.tier === 'soft' && sc.stale) {
        blockers.push({
          kind: 'soft-score-stale',
          criterionId: c.id,
          detail:
            `${c.id}'s soft score is stale — code changed since it was scored; ` +
            're-score it (needs-rescoring) to refresh the proof',
        });
      }
    }
  }

  // Property 4 — stability. Only once it is the NEXT actionable step (same
  // posture as the old artifact clause): while the evidence itself is missing,
  // stale, or failing, "wait for more clean runs" is noise.
  const contentProven = frozen && !onProbation && blockers.length === 0;
  if (contentProven) {
    const need = evidence.stableRuns ?? CERTIFICATION_STABLE_RUNS;
    const streak = entry?.cleanStreak?.count ?? 0;
    if (streak < need) {
      const remaining = need - streak;
      blockers.push({
        kind: 'stability-pending',
        detail:
          `${streak}/${need} consecutive clean verifications at distinct commits — ` +
          `certification holds after ${remaining} more clean pass${remaining === 1 ? '' : 'es'}`,
      });
    }
  }

  const level: SpecMaturity = onProbation
    ? 'probation'
    : !frozen
      ? 'dev'
      : blockers.length === 0
        ? 'certified'
        : 'team';
  return { level, blockers };
}

/* ------------------------------------------------------------------ *
 * Scorecard cache + maturity-drop signal.                              *
 *                                                                      *
 * The scorecard carries a per-spec `maturity` DISPLAY CACHE (same       *
 * posture as `validityScore`: re-stamped every derivation, always      *
 * recomputable, never authored, read by no gate). Stamping it here —   *
 * outside `reconcileScorecard` — keeps the reducer criterion-centric   *
 * and free of evidence-assembly knowledge, mirroring perf-drift's       *
 * "signals flow through the same mergeSignals pipe" split.             *
 * ------------------------------------------------------------------ */

/** The cached slice persisted on `ScorecardSpec.maturity`. */
export type CachedMaturity = NonNullable<ScorecardSpec['maturity']>;

/**
 * Build the standalone `maturity-drop` notice for a level that went DOWN, or
 * null when it held or climbed. Emitted as an already-resolved row (like
 * `spec-changed`): it records the demotion event in the ledger/dashboard
 * without ever becoming an open task — the chip + blockers list carry the
 * actionable work. Climbs are deliberately silent (the chip says it).
 */
export function maturityDropSignal(args: {
  specId: string;
  prev: SpecMaturity;
  next: SpecMaturity;
  blockers: MaturityBlocker[];
  now: string;
  sha?: string;
}): Signal | null {
  const { specId, prev, next, blockers, now, sha } = args;
  if (MATURITY_RANK[next] >= MATURITY_RANK[prev]) return null;
  const top = blockers[0];
  return {
    id: `maturity-drop:${specId}:*`,
    kind: 'maturity-drop',
    severity: 'info',
    specId,
    detail:
      `maturity dropped: ${prev} → ${next}` +
      (blockers.length > 0
        ? ` — ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` +
          (top ? ` (first: ${top.detail})` : '')
        : ''),
    at: now,
    openedAt: now,
    resolvedAt: now,
    sha,
    status: 'resolved',
  };
}

/**
 * Stamp fresh assessments onto the scorecard's per-spec maturity cache and
 * emit `maturity-drop` notices for every spec whose derived level fell vs the
 * PREVIOUS cache. Pure: returns a new scorecard + the signals; callers merge
 * the signals through `mergeSignals` and persist, exactly like the reducer's
 * own output. Specs without a scorecard entry are skipped (nothing to stamp —
 * their maturity is derived live by the rendering surfaces).
 */
export function applyMaturityToScorecard(args: {
  scorecard: Scorecard;
  assessments: ReadonlyMap<string, MaturityAssessment>;
  now: string;
  sha?: string;
}): { scorecard: Scorecard; signals: Signal[] } {
  const { scorecard, assessments, now, sha } = args;
  const signals: Signal[] = [];
  let changed = false;
  const nextSpecs: Record<string, ScorecardSpec> = { ...scorecard.specs };

  for (const [specId, assessment] of assessments) {
    const entry = nextSpecs[specId];
    if (!entry) continue;
    const prevLevel = entry.maturity?.level;
    if (prevLevel) {
      const drop = maturityDropSignal({
        specId,
        prev: prevLevel,
        next: assessment.level,
        blockers: assessment.blockers,
        now,
        sha,
      });
      if (drop) signals.push(drop);
    }
    const cached: CachedMaturity = {
      level: assessment.level,
      blockersCount: assessment.blockers.length,
      blockers: assessment.blockers,
    };
    if (JSON.stringify(entry.maturity) === JSON.stringify(cached)) continue;
    nextSpecs[specId] = { ...entry, maturity: cached };
    changed = true;
  }

  return {
    scorecard: changed ? { ...scorecard, specs: nextSpecs } : scorecard,
    signals,
  };
}

/**
 * Aggregate counts for the dashboard hero strip ("3 certified · 4 team ·
 * 2 dev · 1 probation") and the CLI summary line.
 */
export function tallyMaturity(levels: Iterable<SpecMaturity>): Record<SpecMaturity, number> {
  const tally: Record<SpecMaturity, number> = { probation: 0, dev: 0, team: 0, certified: 0 };
  for (const l of levels) tally[l] += 1;
  return tally;
}
