/**
 * Verify → scorecard fold — the IO composition point that lets an MCP verify
 * seed/update the persistent scorecard from its deterministic criterion
 * verdicts. Lives in its own module (mirroring perf-drift.ts) because it
 * composes the run-side verdict shape with the scorecard reducer; it imports
 * scorecard.js + spec-schema.js + specs.js (the last is cycle-free — see the
 * comment below), the same direction run.ts already does.
 *
 * Semantics: both soft-scoring paths (`validity watch` and MCP verify) feed
 * the SAME reducer (`reconcileScorecard`) with the SAME observation field set,
 * so record_soft_scores works identically after either kind of tick.
 */
import {
  loadScorecard,
  loadSignals,
  mergeSignals,
  reconcileScorecard,
  saveScorecard,
  saveSignals,
  scorecardExistsButUnreadable,
  diffSignalTransitions,
  type Scorecard,
  type ScorecardSpec,
  type Signal,
  type SpecObservation,
} from './scorecard.js';
import { persistSignalTransitions } from './signal-lifecycle.js';
import { applyMaturityToScorecard, type MaturityAssessment } from './maturity.js';
import {
  demotingTaintsOf,
  evidenceTaintsOf,
  type CriterionVerdict,
  type Spec,
} from './spec-schema.js';
// Importing clearSpecProbation from ./specs.js is cycle-free: specs.ts imports
// only util/runs/spec-schema/git/compile-checks/types — NONE of those reach
// back into scorecard-fold. Verified at build time of this slice; if a future
// import of scorecard-fold is added to specs.ts's import graph, move this
// clearing to the MCP-server caller instead (and re-export the predicate).
import { clearSpecProbation } from './specs.js';

/**
 * PURE: build a tick observation for one spec from verify's mechanical
 * verdicts. Iterates the FROZEN spec's criteria (never the verdict list) so
 * severity/softThreshold are threaded from the spec and a criterion the run
 * never decided still lands as `unverifiable` — watch's `observeOnce` parity.
 *
 * Soft criteria are ALWAYS `unscored`: verify emits soft verdicts as
 * `unverifiable` placeholders (run.ts), and feeding that status through the
 * reducer would stomp a real prior agent score — only `unscored` takes the
 * Rule-1 carry-forward path. The placeholder's evidence taints (degraded
 * wrapper, unconfirmed render, …) DO flow through: they describe this tick's
 * capture fidelity, exactly like watch's readWrapperFidelity-based taint.
 */
export function observationFromVerdicts(spec: Spec, verdicts: CriterionVerdict[]): SpecObservation {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return {
    specId: spec.id,
    specVersion: spec.version,
    specHash: spec.hash,
    // Thread the bulk-onboarding probation marker (Phase C) so the reducer can
    // downgrade pass→fail to needs-review (low) on unconfirmed bulk specs. The
    // observation only carries the boolean "is this on probation?" facet — the
    // `since`/`batchId` provenance lives on the spec and is excluded from the
    // content hash.
    probation: spec.probation ? true : undefined,
    criteria: spec.criteria.map((c) => {
      const v = byId.get(c.id);
      if (c.tier === 'soft') {
        const taints = v ? evidenceTaintsOf(v) : [];
        return {
          id: c.id,
          tier: c.tier,
          status: 'unscored' as const,
          severity: c.severity,
          softThreshold: c.softThreshold,
          ...(taints.length > 0 ? { evidenceTaints: taints } : {}),
        };
      }
      if (!v) {
        return {
          id: c.id,
          tier: c.tier,
          status: 'unverifiable' as const,
          detail: 'no mechanical verdict produced',
          severity: c.severity,
          softThreshold: c.softThreshold,
        };
      }
      return {
        id: c.id,
        tier: c.tier,
        status: v.status,
        detail: v.detail,
        severity: c.severity,
        softThreshold: c.softThreshold,
        // Normalized so a legacy networkTainted-only verdict reads ['network'].
        evidenceTaints: evidenceTaintsOf(v),
      };
    }),
  };
}

/**
 * THE single predicate for clearing a bulk-created spec's probation — the
 * "first clean confirmed pass" rule (Phase C). True only when ALL of:
 *
 *   - the observation carries at least one hard/property criterion (a spec with
 *     only soft criteria has nothing blocking to confirm);
 *   - every BLOCKING hard/property criterion (`severity !== 'advisory'`) has
 *     status `'pass'` (a blocking `unverifiable` is not a clean pass);
 *   - no hard/property criterion has status `'fail'` (an advisory hard/property
 *     failure still blocks clearing — the spec is not clean);
 *   - no criterion (any tier) carries a demoting evidence taint (`network`,
 *     `wrapper`, `unconfirmed-render`) — a tainted pass is not a confirmed pass.
 *
 * Soft criteria are excluded from the hard/property fail/pass clauses on
 * purpose: a soft advisory failure does NOT block clearing (the onboarding
 * pass is incapable of manufacturing blocking red, by design). A soft
 * criterion's demoting taint DOES block clearing — e.g. a degraded wrapper
 * means the render fidelity is in question, so the pass cannot be confirmed.
 *
 * **Attended-only invariant:** this predicate must only ever be evaluated on
 * ATTENDED surfaces — the MCP verify fold (`foldVerifyIntoScorecard`) and
 * `verify --all`. It must NEVER be evaluated from a `validity watch` tick: an
 * unattended watcher pass is not a human-confirmed pass, and auto-clearing
 * probation on a background tick would defeat the entire downgrade (the next
 * background regression would fire `regression`-high again before a human ever
 * looked at the spec). Watch threads the `probation` flag into its
 * observations for the downgrade; it simply never calls this predicate.
 */
export function observationConfirmsProbationClear(obs: SpecObservation): boolean {
  const hardProperty = obs.criteria.filter((c) => c.tier !== 'soft');
  if (hardProperty.length === 0) return false;
  // Every BLOCKING hard/property criterion must be a clean pass.
  if (!hardProperty.every((c) => c.severity === 'advisory' || c.status === 'pass')) return false;
  // No hard/property criterion may be failing (covers advisory hard/property).
  if (hardProperty.some((c) => c.status === 'fail')) return false;
  // No criterion (any tier) may carry a demoting evidence taint — a tainted
  // pass is not a confirmed pass, regardless of which criterion carries it.
  if (obs.criteria.some((c) => demotingTaintsOf({ evidenceTaints: c.evidenceTaints }).length > 0))
    return false;
  return true;
}

/** A signal transition, projected to the facets a receipt needs to name it. */
export interface FoldSignalRef {
  kind: Signal['kind'];
  specId: string;
  criterionId?: string;
}

/**
 * What the fold DID — the agent-citable receipt.
 *
 * The fold is best-effort by design (a scorecard write failure must never fail
 * the verify), but "best-effort" used to mean SILENT: an agent that ran verify
 * + submit_report with no `validity watch` had no way to know whether the
 * project's standing state was actually updated. Every early return now names
 * itself here, and the MCP layer turns this into `structuredContent.receipt` +
 * one line of text.
 *
 * `written: false` is never an error condition on its own — a draft-spec verify
 * legitimately writes nothing. It is a FACT the agent gets to see.
 */
export interface FoldResult {
  /** Did the scorecard + signals actually get persisted? */
  written: boolean;
  /**
   * Why not, when `written` is false. Open union: the four cases this module
   * can produce are `draft-spec` (W2 #5 — drafts stay out of the durable
   * scorecard), `scorecard-unreadable` (W4 #11 — refuse to reconcile onto an
   * empty prior), `io-error` (the write threw), and `native-unverifiable`
   * (reserved for callers that fold nothing because the device produced no
   * confirmed render). Callers may add their own (URL mode's
   * `url-mode-no-mechanical-verdicts`), hence `string`.
   */
  reason?: 'draft-spec' | 'scorecard-unreadable' | 'io-error' | 'native-unverifiable' | string;
  /** The thrown message when `reason` is `io-error`. */
  error?: string;
  specId: string;
  /** Signals this fold newly OPENED (post-merge transitions). */
  signalsOpened: FoldSignalRef[];
  /** Signals this fold RESOLVED (post-merge transitions). */
  signalsResolved: FoldSignalRef[];
  /**
   * Did this fold append any OPEN/RESOLVE transition rows to the local drift
   * ledger (`.validity/history/signals.jsonl`)? False when nothing moved.
   */
  historyAppended: boolean;
  /** The reconciled scorecard — present only when `written`. */
  scorecard?: Scorecard;
  /** The signals produced by this fold — present only when `written`. */
  signals?: Signal[];
}

function signalRef(s: Signal): FoldSignalRef {
  return {
    kind: s.kind,
    specId: s.specId,
    ...(s.criterionId ? { criterionId: s.criterionId } : {}),
  };
}

function unwritten(specId: string, reason: string, error?: string): FoldResult {
  return {
    written: false,
    reason,
    ...(error ? { error } : {}),
    specId,
    signalsOpened: [],
    signalsResolved: [],
    historyAppended: false,
  };
}

/**
 * Fold one verify's deterministic verdicts into the persistent scorecard +
 * signal queue — the "deterministic tick" record_soft_scores requires.
 * Best-effort by design (mirrors refreshPerfDrift): a scorecard write failure
 * must never fail the verify itself, so IO errors return a `written: false`
 * receipt rather than throwing.
 *
 * Deliberately does NOT append score history: history is gated on the opt-in
 * `historyCommitted` knob and its `source` union ('watch' | 'soft-scores');
 * a verify tick adds no score information beyond what those two record.
 *
 * ONLY folds a FROZEN spec (W2 #5). A draft verify is advisory/exploratory: its
 * screenshots and mechanical verdicts are still shown to the agent, but folding
 * it would write a hashless, `signedOff:true` scorecard entry for a contract
 * that isn't locked — polluting the durable score and the stop signal with a
 * draft. The scorecard tracks the frozen contract; drafts stay out of it.
 */
export function foldVerifyIntoScorecard(
  projectRoot: string,
  args: {
    spec: Spec;
    verdicts: CriterionVerdict[];
    sha?: string;
    now?: string;
    /**
     * Render-identity staleness override (SpecObservation.renderUnchanged):
     * pass true when EVERY current render is proven byte-identical to the
     * previous same-frozen-content run's evidence, so the reducer does not
     * stale carried soft scores on a same-render commit. Leave undefined
     * when nothing is provable.
     */
    renderUnchanged?: boolean;
    /**
     * Opt-in `historyCommitted` (§9.4), passed by the MCP caller that loaded
     * config. When true, signal OPEN/RESOLVE transitions this fold produced are
     * appended to the durable drift ledger — without it, MCP-originated
     * transitions never reach signals.jsonl and the dashboard trend drifts.
     */
    historyCommitted?: boolean;
    /**
     * Maturity derivation (spec-maturity ladder), wired by the caller through
     * the canonical wiring (`assessSpecMaturity`, @validity.ai/verify-web). A
     * callback (not a value) because the fold may clear probation on this very
     * tick: it is invoked AFTER that decision, with the spec as it now stands,
     * so the stamped level never lags the probation lift by a tick. The fold
     * passes the FRESHLY-RECONCILED scorecard entry as the second argument —
     * the certification predicate reads evidence (statuses, taints, clean
     * streak) from it, and the entry on disk is still pre-fold at this point,
     * so deriving from disk would lag the verify it describes. When present,
     * the fold stamps the scorecard's per-spec maturity cache and emits a
     * `maturity-drop` notice if the derived level fell vs the prior cache.
     * Optional so legacy callers are unaffected.
     */
    assessMaturity?: (spec: Spec, entry: ScorecardSpec | undefined) => MaturityAssessment;
    /**
     * Relevance-scoped staleness (W3 #10), the watch-parity input: did code
     * this spec actually depends on move since its scorecard entry was last
     * observed? Callers compute it with `codeChangedForSpec`
     * (spec-relevance.ts) — the SAME mapping `validity watch` uses — and leave
     * it undefined when the answer is unknown, so the reducer falls back to
     * its coarse HEAD-sha comparison. Never pass `false` on uncertainty.
     */
    codeChanged?: boolean;
  },
): FoldResult {
  if (args.spec.status !== 'frozen') return unwritten(args.spec.id, 'draft-spec');
  // Refuse to reconcile onto an empty prior when the scorecard exists but is
  // corrupt (W4 #11): this fold observes ONE spec, so an empty prior would drop
  // every other spec's entries. Skip the write; a later intact read recovers.
  if (scorecardExistsButUnreadable(projectRoot)) {
    return unwritten(args.spec.id, 'scorecard-unreadable');
  }
  try {
    const now = args.now ?? new Date().toISOString();
    const prev = loadScorecard(projectRoot);
    const observation = observationFromVerdicts(args.spec, args.verdicts);
    if (args.renderUnchanged === true) observation.renderUnchanged = true;
    if (args.codeChanged !== undefined) observation.codeChanged = args.codeChanged;
    const reconciled = reconcileScorecard({
      prev,
      observations: [observation],
      now,
      sha: args.sha,
    });
    let scorecard = reconciled.scorecard;
    let signals = reconciled.signals;
    // Probation clear (Phase C) — decided BEFORE the maturity stamp so the
    // derived level reflects the lift in the SAME fold (see below for why this
    // fold is an attended surface). Best-effort: a clear failure must never
    // fail the verify itself.
    let probationCleared = false;
    if (args.spec.probation && observationConfirmsProbationClear(observation)) {
      try {
        probationCleared = clearSpecProbation({ projectRoot, specId: args.spec.id });
      } catch {
        // best-effort — the fold proceeds; the next attended pass retries
      }
    }
    // Maturity cache + drop notice (spec-maturity ladder): derived AFTER the
    // probation decision (on the spec as it now stands) and stamped AFTER the
    // reconcile so the drop comparison reads the PRIOR cache, through the same
    // signal pipe as everything else.
    if (args.assessMaturity) {
      const effectiveSpec = probationCleared ? { ...args.spec, probation: undefined } : args.spec;
      const stamped = applyMaturityToScorecard({
        scorecard,
        assessments: new Map([
          [args.spec.id, args.assessMaturity(effectiveSpec, scorecard.specs[args.spec.id])],
        ]),
        now,
        sha: args.sha,
      });
      scorecard = stamped.scorecard;
      signals = [...signals, ...stamped.signals];
    }
    saveScorecard(projectRoot, scorecard);
    const existingSignals = loadSignals(projectRoot);
    const mergedSignals = mergeSignals(existingSignals, signals);
    saveSignals(projectRoot, mergedSignals);
    // Durable drift ledger (pillar 4), owned by the signal lifecycle module:
    // `persistSignalTransitions` reconciles parked (suppressed) rows for THIS
    // spec, appends the OPEN/RESOLVE transitions to the local
    // `history/signals.jsonl` feed unconditionally (`historyCommitted` only
    // governs whether that file is committed), and returns the final queue.
    // Without it an MCP verify that opens or closes a signal never lands in
    // the feed — the next tick reads it as already-open, so no transition
    // re-fires and the committed feed + dashboard trend drift permanently.
    const finalSignals = persistSignalTransitions(
      projectRoot,
      existingSignals,
      mergedSignals,
      now,
      args.sha,
      new Set([args.spec.id]),
    );
    // Transitions are computed for the receipt regardless of the commit knob:
    // the receipt NAMES them, so the agent can cite what moved.
    const { opened, resolved } = diffSignalTransitions(existingSignals, finalSignals);
    const historyAppended = opened.length > 0 || resolved.length > 0;
    // NOTE on the probation clear above: a bulk-created spec's first clean
    // human-confirmed pass lifts the marker. This fold is the MCP verify
    // surface — ATTENDED (the agent is observing a real verify it drove);
    // `validity watch` deliberately does NOT clear (an unattended watcher pass
    // is not a human-confirmed pass).
    return {
      written: true,
      specId: args.spec.id,
      signalsOpened: opened.map(signalRef),
      signalsResolved: resolved.map(signalRef),
      historyAppended,
      scorecard,
      signals,
    };
  } catch (err) {
    return unwritten(args.spec.id, 'io-error', (err as Error).message);
  }
}
