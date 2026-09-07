/**
 * Dashboard data layer — one pure-ish assembler that turns the on-disk
 * `.validity/` state into a typed JSON snapshot.
 *
 * Trends, compare, and the GitHub Action comment read this snapshot. Fields
 * are ADDED over time (`health`, signal `triage`, spec `specStatus`) — never
 * renamed.
 *
 * Tolerance contract: a missing or corrupt file contributes its empty/null shape
 * here; {@link buildDashboardSnapshot} never throws. A corrupt scorecard.json must
 * not take the dashboard down — it surfaces the empty-shape view until the next
 * intact write recovers.
 *
 * Triage layer (health redesign): every open signal is checked against the
 * CURRENT scorecard + spec content via `staleSignalReason` — a signal whose
 * claim is already answered (scored, criterion removed in a re-freeze,
 * recovered) is triaged `stale` and rendered as auto-resolved, never as open
 * work. The remaining open signals split into `actionable` (needs a human/agent
 * to restore health) and `informational` (advisory; never gates). The `health`
 * block folds tracked-spec verdicts + actionable signals into ONE verdict so
 * the page can answer "is my project OK?" in its first line.
 *
 * Determinism boundary: this assembler performs the ONE sanctioned wall-clock
 * read in the whole dashboard pipeline — `generatedAt` and the per-signal
 * `ageMs` derived from it. Every downstream renderer is PURE over the emitted
 * snapshot (no `Date.now()`, no locale), so identical snapshot input yields
 * byte-identical HTML; the served page changes over time only because THIS
 * input carries the live clock (ages must tick), which is intentional, not a
 * renderer-determinism violation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readInflightMarkers, type InflightMarker } from './inflight.js';
import { readSignalHistory, type SignalHistoryRow } from './history.js';
import type { HistoryRunRow } from './history.js';
import { gitCommitsBehind, gitHeadSha } from './git.js';
import { listSpecs } from './specs.js';
import type { EvidenceTaint, Spec } from './spec-schema.js';
import { readSpecRunHistory, type SpecRunSummary } from './run.js';
import { runDir } from './runs.js';
import type { RunOrigin } from './run-origin.js';
import { CERTIFICATION_STABLE_RUNS } from './maturity.js';
import {
  computeSignedOff,
  computeSpecScore,
  computeValidityScore,
  countTrackedSoftCriteria,
  judgeGapWarning,
  loadScorecard,
  loadSignals,
  readScoreHistory,
  rollupScorecardVerdict,
  staleSignalReason,
  type ScoreHistoryEntry,
  type Scorecard,
  type ScorecardCriterion,
  type ScorecardSpec,
  type Signal,
  type SignalKind,
  type SignalResolvedBy,
  type SignalSeverity,
  type SignalStateContext,
} from './scorecard.js';
import { loadWatchState } from './watch-state.js';
import { tallyMaturity, type MaturityAssessment, type SpecMaturity } from './maturity.js';

export const DASHBOARD_SNAPSHOT_VERSION = 1 as const;

/** Per-criterion projection surfaced on the dashboard. */
export interface DashboardCriterion {
  id: string;
  tier: string;
  status: 'pass' | 'fail' | 'unverifiable' | 'unscored';
  stale: boolean;
  severity: 'blocking' | 'advisory';
  score: number | null;
  detail: string | null;
  /** Criterion text from the CURRENT spec.yaml, when the id still exists there. */
  text: string | null;
  /**
   * ADD-ONLY: the verdict's evidence taints, carried straight from the
   * scorecard entry. Used by {@link computeDashboardHealth} to derive the
   * env-blocked "suspected" cluster (an `unverifiable` criterion tainted by
   * `network`/`wrapper`/`unconfirmed-render` points at a broken sandbox/
   * device, not a genuine regression) — see `DashboardHealth.environment`.
   */
  evidenceTaints?: EvidenceTaint[];
}

/**
 * Where a scorecard entry's spec stands in the CURRENT spec store:
 *   - `frozen`   — tracked; counts toward health and the score population;
 *   - `drifted`  — was frozen, now a draft after a version bump (re-freeze to track);
 *   - `draft`    — a non-frozen spec that somehow acquired a scorecard entry;
 *   - `orphaned` — a scorecard entry whose spec no longer exists on disk.
 */
export type DashboardSpecStatus = 'frozen' | 'drifted' | 'draft' | 'orphaned';

/** Per-spec projection surfaced on the dashboard. */
export interface DashboardSpec {
  specId: string;
  specVersion: number;
  verdict: 'pass' | 'fail' | 'partial';
  signedOff: boolean;
  /**
   * DISPLAY-ONLY, ADD-ONLY: true ⇔ the recomputed `signedOff` holds AND at
   * least one BLOCKING criterion is `soft` — a pass an agent scored, not one a
   * mechanical check proved. Lets the dashboard mark an attested green (worth a
   * human check) apart from a mechanically-proven one; it never gates and never
   * alters `signedOff`.
   */
  attestedSignOff?: boolean;
  /**
   * DISPLAY-ONLY, ADD-ONLY: true ⇔ `attestedSignOff` AND every blocking soft
   * pass it rests on was scored by the automated model judge (`judge === 'model'`).
   * Lets the dashboard mark an INDEPENDENT-model sign-off apart from a
   * self-attested one. Never gates.
   */
  signOffModelJudged?: boolean;
  coveragePercent: number | null;
  /** Recomputed via {@link computeSpecScore}, never trusts the stamped display cache. */
  validityScore: number | null;
  updatedAt: string;
  criteria: DashboardCriterion[];
  /** True ⇔ the spec is frozen on disk — the population health/score covers. */
  tracked: boolean;
  specStatus: DashboardSpecStatus;
  /** First line of the spec's source prompt (truncated) — a human name for the card. */
  title: string | null;
  /** Newest run indexed for this spec on THIS machine, with report availability. */
  latestRun: { runId: string; createdAt: string; hasReport: boolean } | null;
  /**
   * DERIVED maturity (probation/dev/team/certified) + the hardening backlog
   * for the drawer checklist (ADD-ONLY field). From the injected live assessor
   * when available, else the scorecard cache / the conservative fallback (see
   * {@link fallbackMaturity}); null only for orphaned entries with no spec.
   */
  maturity: MaturityAssessment | null;
  /**
   * ADD-ONLY: verdict tally over this spec's INDEXED runs on this machine
   * (`specs/<id>/runs.jsonl`, deduped by runId). Drives the overview's
   * runs-per-spec lanes. `null` when the timeline is empty — a spec with no
   * runs renders no bar rather than an all-zero one.
   */
  runTally: { pass: number; fail: number; partial: number; unknown: number; total: number } | null;
  /**
   * ADD-ONLY: the reducer-owned clean streak (consecutive signed-off, fresh
   * verifications at DISTINCT commits) beside the threshold certification
   * needs. Surfaced structurally so the spec page's certification stepper
   * reads real state instead of regexing a maturity blocker's prose.
   * `count: 0` when the streak was reset or never started.
   */
  cleanStreak: { count: number; need: number } | null;
  /** ADD-ONLY (see {@link DashboardSpecDetail}); absent on older snapshots. */
  detail?: DashboardSpecDetail;
}

/**
 * ADD-ONLY (dashboard publish): everything the `/spec/<id>` detail page needs
 * that used to be read from disk at serve time — the spec's metadata rows, its
 * deduped run timeline with report availability + ledger scores, and the
 * per-criterion history strips — embedded in the snapshot so a STATIC render
 * (`.validity/dashboard/index.html`) can build every spec detail from the
 * snapshot alone: no disk reads, no live server.
 */
export interface DashboardSpecDetail {
  /** Right-hand metadata rows (author/runtime/frozen-at/targets). */
  meta: Array<{ k: string; v: string }>;
  /** Run timeline, newest first, with report availability + ledger score. */
  runs: Array<{
    runId: string;
    createdAt: string;
    verdict: 'pass' | 'fail' | 'partial' | 'unknown';
    signedOff: boolean;
    hasReport: boolean;
    sha: string | null;
    score: number | null;
    mechanical: { passed: number; total: number } | null;
  }>;
  /** criterionId → `p`/`f`/`u` pattern over the last runs, oldest → newest. */
  criteriaHistory: Record<string, string>;
}

/**
 * ADD-ONLY: one row of the overview's "Recent runs" table — a verification run
 * indexed on THIS machine, newest first, flattened across every spec.
 *
 * `score` is NOT invented per run: it is the spec's recorded Validity score at
 * (or immediately before) the run, read from `.validity/history/score.jsonl`'s
 * `perSpec` series, and `null` when the ledger has nothing to say. Likewise
 * `mechanical` is present only when the run row preserved its per-criterion
 * snapshot — a legacy row without one reports nothing rather than a guess.
 */
export interface DashboardRecentRun {
  runId: string;
  specId: string;
  /** First line of the spec's prompt, when the spec still exists. */
  specTitle: string | null;
  createdAt: string;
  /** Commit the run was indexed at, when the row recorded one. */
  sha: string | null;
  verdict: 'pass' | 'fail' | 'partial' | 'unknown';
  counts: { pass: number; fail: number; unverifiable: number };
  signedOff: boolean;
  /** Where the run was produced, when the row recorded it. */
  origin?: 'local' | 'ci';
  /** The spec's recorded score at this run, or null when unrecorded. */
  score: number | null;
  /** Mechanically-decided criteria (hard/property) that passed, over their total. */
  mechanical: { passed: number; total: number } | null;
  /** True ⇔ `/run/<id>/report` can serve something (baked report or run-meta). */
  hasReport: boolean;
}

/**
 * Signal triage bucket:
 *   - `actionable`    — restoring health needs a human/agent (regression,
 *                       unverifiable, coverage-drop, needs-review, genuine
 *                       needs-(re)scoring);
 *   - `informational` — advisory context that never gates (perf-drift);
 *   - `stale`         — the current scorecard/spec content already answers the
 *                       claim (see `staleSignalReason`) — rendered as
 *                       auto-resolved, never as open work.
 */
export type DashboardSignalTriage = 'actionable' | 'informational' | 'stale';

/** Inbox row — an OPEN signal with computed age in ms and its triage bucket. */
export interface DashboardSignal {
  id: string;
  kind: string;
  severity: SignalSeverity;
  status: 'open';
  specId: string;
  criterionId: string | null;
  detail: string;
  at: string;
  openedAt: string | null;
  sha: string | null;
  ageMs: number;
  triage: DashboardSignalTriage;
  /** Why the signal is stale (triage === 'stale'); null otherwise. */
  staleReason: string | null;
  /** Add-only close-path; null on open inbox rows. */
  resolvedBy: SignalResolvedBy | null;
  /** Add-only park target; null on open inbox rows. */
  suppressedUntil: { sha: string; note?: string } | null;
}

/** A recently-resolved ledger row for the collapsed history group. */
export interface DashboardResolvedSignal {
  id: string;
  kind: string;
  severity: SignalSeverity;
  specId: string;
  criterionId: string | null;
  detail: string;
  resolvedAt: string;
  /** Add-only; `suppressed` rows sit in this group, not the open inbox. */
  status: 'resolved' | 'suppressed';
  resolvedBy: SignalResolvedBy | null;
  suppressedUntil: { sha: string; note?: string } | null;
}

/** A spec with no scorecard entry — surfaced in the population breakdown. */
export interface DashboardSpecStub {
  specId: string;
  version: number;
  title: string | null;
  /** Derived maturity level (ADD-ONLY; see DashboardSpec.maturity). */
  maturity: SpecMaturity | null;
}

/** Watcher-status projection: high-water mark + on-signal hook cooldown. */
export interface DashboardWatcher {
  lastObservedSha: string | null;
  lastTickAt: string | null;
  headSha: string | null;
  commitsBehind: number | null;
  hook: {
    lastLaunchAt: string;
    batchSize: number;
    cooldownMs: number;
    coolingDown: boolean;
  } | null;
}

/**
 * One verify run CURRENTLY executing — projected from a `.validity/inflight/`
 * marker. `ageMs` is measured against the snapshot's sanctioned `generatedAt`
 * clock (never `Date.now()` in a renderer), so it ticks with the served page.
 * `abandoned` marks a marker that predates the abandonment window — a crashed
 * or killed verify whose cleanup `finally` never ran; it is KEPT in the array
 * (never silently dropped, so a stuck marker stays diagnosable) but the live
 * "verifying" strip renders only fresh (non-abandoned) rows.
 */
export interface DashboardInProgress {
  runId: string;
  specId: string | null;
  mode: 'isolation' | 'url' | 'native';
  startedAt: string;
  ageMs: number;
  abandoned: boolean;
}

/** One trend point — score and open-signal count merged at a timestamp. */
export interface DashboardTrendPoint {
  at: string;
  sha: string | null;
  score: number | null;
  openSignals: number | null;
}

/**
 * The hero verdict — ONE answer to "is my project OK?", derived from TRACKED
 * (frozen) specs and post-triage actionable signals only. Presentation-side
 * aggregation: it reads verdicts, never writes or gates anything.
 */
export interface DashboardHealth {
  verdict: 'healthy' | 'attention' | 'failing' | 'empty';
  /** Frozen specs on disk (the population the verdict covers). */
  trackedSpecs: number;
  /** Tracked specs that have a scorecard entry (verdicts actually recorded). */
  scoredTracked: number;
  passing: number;
  failing: number;
  partial: number;
  /** Open signals triaged actionable / informational / stale-suppressed. */
  actionable: number;
  informational: number;
  staleSuppressed: number;
  /** Blocking soft passes whose code moved since scoring (score decay). */
  staleSoft: number;
  /**
   * DISPLAY-ONLY, ADD-ONLY: tracked specs whose sign-off is ATTESTED — green
   * resting on ≥1 blocking soft (agent-scored) pass rather than proven purely
   * mechanically. Feeds one neutral hero tile; never gates and never moves the
   * verdict. Older snapshots omit it (the tile renders nothing).
   */
  attestedPassing?: number;
  /**
   * Evidence-freshness receipt folded into the hero (ADD-ONLY). The watcher's
   * high-water mark, current HEAD, and how far the observation trails it — so
   * the hero carries the "observed through <sha> (N behind)" receipt inline,
   * and a would-be-`healthy` verdict demotes to `attention` when it is reading
   * evidence older than HEAD (never-false-green over a stale observation).
   */
  observedThroughSha: string | null;
  headSha: string | null;
  commitsBehind: number | null;
  /**
   * Why the verdict is NOT `healthy` when the tracked numbers alone wouldn't
   * explain it (ADD-ONLY): a stale observation that trails HEAD, or actionable
   * signals on UNTRACKED specs that the red "Needs action" tile + section still
   * count. Null when the verdict speaks for itself.
   */
  verdictReason: string | null;
  /**
   * ADD-ONLY (issue #17): soft criteria are tracked but no scoring.judgeModel
   * is configured — needs-(re)scoring signals can never drain, so staleness
   * accumulation is misleading by construction. Rendered as a persistent
   * warning line in the hero; also demotes a would-be-`healthy` verdict to
   * `attention`. Null/absent when a judge is configured, when nothing soft is
   * tracked, or when judge-presence is UNKNOWN (config not loaded — never
   * warn on a guess). Older snapshots omit it.
   */
  judgeGap?: { softCriteria: number } | null;
  /**
   * ADD-ONLY: ENVIRONMENT attribution — distinguishes "the verification
   * environment is broken" from "criteria genuinely failed/regressed", so a
   * broken sandbox/device isn't misread as a code regression.
   *
   * `confirmed` would require a spec-level render/prepare failure
   * (`SpecResult.error` from `verify --all`) to reach the scorecard — it
   * doesn't (see `SpecObservation`/`ScorecardSpec`, neither carries an
   * error field), so this is ALWAYS `suspected` today: derived from a
   * cluster of tracked specs carrying an `unverifiable` criterion tainted by
   * a DEMOTING env taint (`network` / `wrapper` / `unconfirmed-render`).
   * `dep-scan` is deliberately excluded — CI's `verify --all` already
   * escalates it to a spec-level `.error` (a build-failing message, not a
   * taint), so it never reaches this cluster today.
   *
   * Never gates or re-decides a verdict on its own account: it only demotes
   * a would-be-`healthy` result to `attention` (same posture as `judgeGap`)
   * and points `topAction` at `validity doctor`. Null when no cluster is
   * present. Older snapshots omit it (nothing renders).
   */
  environment?: { confidence: 'suspected'; count: number; reason: string } | null;
  /** The single highest-priority next step, or null when healthy. */
  topAction: {
    kind: 'fix-spec' | 'resolve-signal' | 'score-soft' | 'setup' | 'diagnose-env';
    specId: string | null;
    criterionId: string | null;
    summary: string;
  } | null;
  /**
   * Verify runs CURRENTLY executing (ADD-ONLY; older snapshots omit it, so the
   * hero renders nothing). Carried on the health block — rather than a separate
   * top-level field — so the health hero receives it through the dashboard
   * server's existing `health: snapshot.health` pass-through with no new page
   * hook, mirroring how the observation-freshness receipt is already folded in
   * here. Never feeds the verdict (nothing is proven while a verify is in
   * flight); it is display-only liveness.
   */
  inProgress: DashboardInProgress[];
}

export interface DashboardSnapshot {
  version: 1;
  generatedAt: string;
  /**
   * ADD-ONLY: the project's own name — `package.json`'s `name`, else the
   * project directory's basename. Null when neither resolves. Display-only
   * (the overview's sub-line); it never participates in any decision.
   */
  projectName: string | null;
  health: DashboardHealth;
  score: {
    score: number;
    blockingCriteriaCount: number;
    advisoryExcludedCount: number;
    staleSoftCount: number;
  } | null;
  population: {
    tracked: number;
    total: number;
    draftSuperseded: string[];
    /** Non-frozen specs with NO scorecard entry — never scored ("freeze to track"). */
    drafts: DashboardSpecStub[];
    /** Frozen specs with NO scorecard entry — tracked but never verified. */
    unverified: DashboardSpecStub[];
  };
  specs: DashboardSpec[];
  /**
   * ADD-ONLY: the newest indexed runs across every spec, newest first, capped
   * at {@link RECENT_RUNS_LIMIT}. Empty when nothing has been verified here.
   */
  recentRuns: DashboardRecentRun[];
  signals: DashboardSignal[];
  /** Most-recent resolved ledger rows (auto-resolutions + recoveries), newest first. */
  resolvedSignals: DashboardResolvedSignal[];
  watcher: DashboardWatcher;
  trend: { points: DashboardTrendPoint[] } | null;
  /**
   * ADD-ONLY (dashboard publish; see {@link SnapshotPublishedBy}). Absent on a
   * freshly built snapshot — the publish command attaches it when writing.
   */
  publishedBy?: SnapshotPublishedBy;
  /** ADD-ONLY (dashboard publish; see {@link EmbeddedHistory}). */
  embeddedHistory?: EmbeddedHistory;
  /**
   * Maturity tally over EVERY spec on disk (ADD-ONLY) — the hero strip's
   * "3 certified · 4 team · 2 dev · 1 probation". Null when there are no specs.
   */
  maturity: Record<SpecMaturity, number> | null;
}

/**
 * ADD-ONLY (dashboard publish): who published this artifact and when. NO
 * hostname, NO username — privacy; a sha + branch identify the source without
 * identifying a person. `at` equals the snapshot's `generatedAt` (the publish
 * happens at snapshot time), which also makes it the anchor every relative age
 * in a STATIC render is measured from.
 */
export interface SnapshotPublishedBy {
  sha: string;
  branch?: string;
  at: string;
  origin: RunOrigin;
}

/**
 * ADD-ONLY (dashboard publish): the local history ledgers embedded verbatim so
 * the published artifact carries trends even when `historyCommitted` is off.
 * Capped at the same windows the trend builders read (score 200, signals 500,
 * per-spec rows 200).
 */
export interface EmbeddedHistory {
  score: ScoreHistoryEntry[];
  signals: SignalHistoryRow[];
  specs: Record<string, HistoryRunRow[]>;
}

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

/** How many resolved rows the snapshot carries for the collapsed history group. */
const RESOLVED_SNAPSHOT_LIMIT = 20;

/**
 * A verify normally clears its marker in a `finally` within seconds-to-minutes.
 * A marker older than this window is treated as abandoned (the process crashed
 * or was killed before cleanup): still surfaced (with `abandoned: true`) so it's
 * diagnosable, but excluded from the live "verifying" strip. 15 min comfortably
 * clears even a slow native/Vite render plus report write.
 */
const INFLIGHT_ABANDON_MS = 15 * 60 * 1000;

/**
 * Project each in-flight marker into a dashboard row, aging `startedAt` against
 * the snapshot's sanctioned clock. Deterministic order (oldest-started first,
 * runId tie-break) so SSE fragment swaps stay stable.
 */
function mapInProgress(markers: InflightMarker[], generatedAtMs: number): DashboardInProgress[] {
  return markers
    .map((m) => {
      const startedMs = Date.parse(m.startedAt);
      const ageMs = Number.isNaN(startedMs) ? 0 : Math.max(0, generatedAtMs - startedMs);
      return {
        runId: m.runId,
        specId: m.specId ?? null,
        mode: m.mode,
        startedAt: m.startedAt,
        ageMs,
        abandoned: ageMs > INFLIGHT_ABANDON_MS,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
}

function isScorecard(v: unknown): v is Scorecard {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { version?: unknown }).version === 1 &&
    typeof (v as { specs?: unknown }).specs === 'object' &&
    (v as { specs?: unknown }).specs !== null
  );
}

function safeScorecard(root: string): Scorecard | null {
  const loaded = loadScorecard(root);
  return isScorecard(loaded) ? loaded : null;
}

/** First line of a spec prompt, whitespace-collapsed, capped at 120 chars. */
function specTitle(spec: Spec | undefined): string | null {
  const prompt = spec?.source?.prompt;
  if (typeof prompt !== 'string') return null;
  const firstLine = prompt.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (firstLine.length === 0) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

function mapCriterion(
  id: string,
  c: ScorecardCriterion,
  spec: Spec | undefined,
): DashboardCriterion {
  const specCrit = spec?.criteria.find((sc) => sc.id === id);
  return {
    id,
    tier: String(c.tier ?? ''),
    status: c.status,
    stale: c.stale === true,
    severity: c.severity ?? 'blocking',
    score: c.score ?? null,
    detail: c.detail ?? null,
    text: specCrit?.text ?? null,
    evidenceTaints: c.evidenceTaints,
  };
}

function specStatusOf(spec: Spec | undefined): DashboardSpecStatus {
  if (!spec) return 'orphaned';
  if (spec.status === 'frozen') return 'frozen';
  // A non-frozen spec with a scorecard entry was scored under an earlier
  // freeze; a `supersedes` pointer proves the version bump, but the practical
  // meaning is the same either way — the score no longer tracks it.
  return spec.supersedes ? 'drifted' : 'draft';
}

/**
 * Maturity when no live assessor is injected. Probation and dev derive from the spec alone; a
 * frozen spec's team-vs-certified split needs the evidence assembly the
 * canonical wiring owns, so we fall back to the scorecard cache and, absent
 * that, floor at 'team' — certification is a positive claim that requires a
 * fresh derivation, never a default (the display analog of the false-green
 * rule).
 */
function fallbackMaturity(
  spec: Spec,
  cached: ScorecardSpec['maturity'] | undefined,
): MaturityAssessment {
  // The scorecard cache declares blockers structurally (string kind) to avoid
  // an import cycle; it is only ever written from real MaturityBlocker values
  // (applyMaturityToScorecard), so narrowing back is sound.
  const cachedBlockers = (cached?.blockers ?? []) as MaturityAssessment['blockers'];
  if (spec.probation) {
    return {
      level: 'probation',
      blockers: cached?.level === 'probation' ? cachedBlockers : [],
    };
  }
  if (spec.status !== 'frozen') {
    return { level: 'dev', blockers: cached?.level === 'dev' ? cachedBlockers : [] };
  }
  if (cached && (cached.level === 'team' || cached.level === 'certified')) {
    return { level: cached.level, blockers: cachedBlockers };
  }
  return { level: 'team', blockers: [] };
}

/** Resolve one spec's maturity: live assessor first, cache/floor fallback else. */
function maturityOf(
  spec: Spec | undefined,
  entry: ScorecardSpec | undefined,
  assess: ((spec: Spec, entry: ScorecardSpec | undefined) => MaturityAssessment) | undefined,
): MaturityAssessment | null {
  if (!spec) return null;
  if (assess) {
    try {
      return assess(spec, entry);
    } catch {
      return fallbackMaturity(spec, entry?.maturity);
    }
  }
  return fallbackMaturity(spec, entry?.maturity);
}

/** How many runs the overview's "Recent runs" table carries. */
export const RECENT_RUNS_LIMIT = 12;

/**
 * How deep to read each spec's `runs.jsonl`. A verify appends a row AND a
 * scored twin per run, so the raw depth is read at 2× the intended run depth
 * and deduped by runId keeping the LAST (scored) row — the compensated-limit
 * pattern the /reports index already uses.
 */
const RUN_HISTORY_DEPTH = 80;

/** One spec's deduped run timeline, oldest → newest. */
function specRunTimeline(root: string, specId: string): SpecRunSummary[] {
  const byId = new Map<string, SpecRunSummary>();
  for (const r of readSpecRunHistory(root, specId, RUN_HISTORY_DEPTH)) byId.set(r.runId, r);
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId),
  );
}

/**
 * Newest indexed run, plus whether ANY recent run's report.html survives on
 * this machine. Watch ticks index runs without writing reports, so probing
 * only the newest run would hide the report link after every tick; the
 * dashboard's /spec/:id/report route already serves the newest surviving
 * report (serveSpecReport scans the same window), so `hasReport` mirrors
 * that scan rather than the single newest run.
 */
function latestRunOf(root: string, runs: SpecRunSummary[]): DashboardSpec['latestRun'] {
  const last = runs.at(-1);
  if (!last) return null;
  return {
    runId: last.runId,
    createdAt: last.createdAt,
    hasReport: runs
      .slice(-20)
      .some((r) => existsSync(resolve(runDir(root, r.runId), 'report.html'))),
  };
}

/** Same charset guard the dashboard server applies to hand-edited run ids. */
const SAFE_RUN_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** True ⇔ a baked report OR a bakeable run-meta survives for this run. */
function runReportOpenable(root: string, runId: string): boolean {
  const dir = runDir(root, runId);
  return existsSync(resolve(dir, 'report.html')) || existsSync(resolve(dir, 'run-meta.json'));
}

/** UTC `YYYY-MM-DD`, or the raw string when unparseable. Locale-free. */
function isoDay(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString().slice(0, 10);
}

/**
 * Assemble a spec's {@link DashboardSpecDetail} from data this module already
 * read for the snapshot projection (the disk spec, the deduped timeline) plus
 * one shared score-ledger lookup. Mirrors what the live server's `/spec/<id>`
 * route computes per request — embedded here so the static publish path needs
 * no disk and the two surfaces can never disagree.
 */
function buildSpecDetail(
  root: string,
  specId: string,
  specVersion: number,
  diskSpec: Spec | undefined,
  timeline: SpecRunSummary[],
  scoreAt: ReturnType<typeof buildSpecScoreLookup>,
): DashboardSpecDetail {
  const meta: Array<{ k: string; v: string }> = [
    { k: 'version', v: `v${specVersion}${diskSpec ? ` · ${diskSpec.status}` : ''}` },
  ];
  if (diskSpec?.source?.createdBy) meta.push({ k: 'author', v: diskSpec.source.createdBy });
  if (diskSpec?.runtime) meta.push({ k: 'runtime', v: diskSpec.runtime });
  if (diskSpec?.updatedAt) meta.push({ k: 'frozen', v: isoDay(diskSpec.updatedAt) });
  else if (diskSpec?.createdAt) meta.push({ k: 'created', v: isoDay(diskSpec.createdAt) });
  if (diskSpec?.git?.sha) {
    meta.push({
      k: 'frozen at',
      v: `${diskSpec.git.sha.slice(0, 7)}${diskSpec.git.dirty ? ' · dirty' : ''}`,
    });
  }
  const targets = diskSpec?.targets?.components ?? [];
  if (targets.length > 0) meta.push({ k: 'targets', v: targets.join(', ') });

  const runs = [...timeline]
    .reverse()
    .filter((r) => SAFE_RUN_ID.test(r.runId))
    .map((r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      verdict: r.verdict,
      signedOff: r.signedOff === true,
      hasReport: runReportOpenable(root, r.runId),
      sha: r.sha ?? null,
      score: scoreAt(specId, r.createdAt, r.sha ?? null),
      mechanical: runMechanicalTally(r),
    }));

  const criteriaHistory: Record<string, string> = {};
  for (const run of timeline.slice(-10)) {
    for (const c of run.criteria ?? []) {
      const mark = c.status === 'pass' ? 'p' : c.status === 'fail' ? 'f' : 'u';
      criteriaHistory[c.id] = (criteriaHistory[c.id] ?? '') + mark;
    }
  }

  return { meta, runs, criteriaHistory };
}

/** Verdict tally over a spec's indexed runs; null when nothing is indexed. */
function runTallyOf(runs: SpecRunSummary[]): DashboardSpec['runTally'] {
  if (runs.length === 0) return null;
  const tally = { pass: 0, fail: 0, partial: 0, unknown: 0, total: runs.length };
  for (const r of runs) tally[r.verdict] += 1;
  return tally;
}

/**
 * Mechanically-decided criteria (hard/property) that PASSED, over their total,
 * from the run's preserved per-criterion snapshot. Null when the row predates
 * that snapshot — an unknown fraction is reported as unknown, never as 0/0.
 */
export function runMechanicalTally(run: SpecRunSummary): DashboardRecentRun['mechanical'] {
  if (!run.criteria) return null;
  const mech = run.criteria.filter((c) => c.tier === 'hard' || c.tier === 'property');
  if (mech.length === 0) return null;
  return { passed: mech.filter((c) => c.status === 'pass').length, total: mech.length };
}

/**
 * A per-spec score lookup over `.validity/history/score.jsonl`'s `perSpec`
 * series. A run's "Validity" number is READ from this ledger — an exact-sha
 * row first, else the newest recorded score at or before the run — and is
 * `null` when the ledger never scored that spec. Nothing is interpolated: a
 * number the ledger never wrote is never shown.
 */
export function buildSpecScoreLookup(
  root: string,
): (specId: string, at: string, sha: string | null) => number | null {
  const rows = readScoreHistory(root, 400)
    .map((e) => ({ atMs: Date.parse(e.at), sha: e.sha ?? null, perSpec: e.perSpec ?? {} }))
    .filter((e) => !Number.isNaN(e.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  return (specId, at, sha) => {
    if (rows.length === 0) return null;
    if (sha) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const v = rows[i]!.sha === sha ? rows[i]!.perSpec[specId] : undefined;
        if (typeof v === 'number') return v;
      }
    }
    const atMs = Date.parse(at);
    if (Number.isNaN(atMs)) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.atMs > atMs) continue;
      const v = rows[i]!.perSpec[specId];
      if (typeof v === 'number') return v;
    }
    return null;
  };
}

/** Same viewability rule the `/run/<id>/report` route applies: baked OR bakeable. */
function runReportViewable(root: string, runId: string): boolean {
  const dir = runDir(root, runId);
  return existsSync(resolve(dir, 'report.html')) || existsSync(resolve(dir, 'run-meta.json'));
}

/** `package.json`'s name, else the project directory's basename, else null. */
function readProjectName(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim() !== '') return pkg.name.trim();
  } catch {
    // no package.json / unreadable / malformed — fall through to the basename
  }
  const base = basename(resolve(root));
  return base === '' || base === '.' || base === '/' ? null : base;
}

function mapSpec(
  specId: string,
  spec: ScorecardSpec,
  root: string,
  diskSpec: Spec | undefined,
  runs: SpecRunSummary[],
  assess?: (spec: Spec, entry: ScorecardSpec | undefined) => MaturityAssessment,
): DashboardSpec {
  const criteriaMap = spec.criteria ?? {};
  const criteriaList = Object.entries(criteriaMap)
    .map(([id, c]) => mapCriterion(id, c, diskSpec))
    .sort((a, b) => a.id.localeCompare(b.id));
  const specStatus = specStatusOf(diskSpec);
  // Recompute verdict AND sign-off from the criteria — never trust the stamped
  // display cache. A corrupt or hand-edited scorecard that stamps
  // `verdict: 'pass'` / `signedOff: true` over a failing criterion must not
  // render green; the recompute makes false-green impossible here, the same
  // posture as validityScore below and the reducer's own re-derivation
  // (scorecard.ts computeSignedOff/rollupScorecardVerdict).
  const signedOff = computeSignedOff(Object.values(criteriaMap));
  // Display-only (add-only): an attested sign-off rests on ≥1 BLOCKING soft
  // criterion — a pass an agent scored rather than a mechanical check proved.
  // Read off the already-projected criteria (severity defaults to blocking).
  const attestedSignOff =
    signedOff && criteriaList.some((c) => c.severity !== 'advisory' && c.tier === 'soft');
  // Model-judged (add-only): the blocking soft passes the attested green rests on
  // were ALL scored by the independent model judge — a stronger provenance than a
  // self-attested pass. Read off the RAW criteria (which carry the `judge` marker).
  const blockingSoftPasses = Object.values(criteriaMap).filter(
    (c) => c.severity !== 'advisory' && c.tier === 'soft' && c.status === 'pass',
  );
  const signOffModelJudged =
    attestedSignOff &&
    blockingSoftPasses.length > 0 &&
    blockingSoftPasses.every((c) => c.judge === 'model');
  return {
    specId,
    specVersion: spec.specVersion,
    verdict: rollupScorecardVerdict(criteriaMap),
    signedOff,
    attestedSignOff,
    signOffModelJudged,
    coveragePercent: spec.coveragePercent ?? null,
    validityScore: computeSpecScore(
      Object.values(criteriaMap).map((c) => ({
        tier: c.tier,
        status: c.status,
        severity: c.severity,
        softThreshold: c.softThreshold,
        score: c.score,
        stale: c.stale,
        evidenceTaints: c.evidenceTaints,
      })),
    ).score,
    updatedAt: spec.updatedAt ?? '',
    criteria: criteriaList,
    tracked: specStatus === 'frozen',
    specStatus,
    title: specTitle(diskSpec),
    latestRun: latestRunOf(root, runs),
    maturity: maturityOf(diskSpec, spec, assess),
    runTally: runTallyOf(runs),
    // Structural, not prose: `undefined` (the reducer's "reset") reads as a
    // zero streak, so the certification stepper can never show a rung earned.
    cleanStreak: { count: spec.cleanStreak?.count ?? 0, need: CERTIFICATION_STABLE_RUNS },
  };
}

/**
 * Triage bucket for a NON-stale open signal. Kind-driven with a severity
 * fallback for future kinds, so an unknown high-severity signal can never be
 * silently filed as informational.
 */
const ACTIONABLE_KINDS: ReadonlySet<SignalKind> = new Set([
  'regression',
  'unverifiable',
  'coverage-drop',
  'needs-review',
  'needs-scoring',
  'needs-rescoring',
  // One config line away from actionable staleness signals draining again.
  'judge-gap',
  // A recorded on-device journey that no longer reaches its landmark is work:
  // either the app moved (fix it) or the recording did (re-record via verify).
  'replay-divergence',
]);
const INFORMATIONAL_KINDS: ReadonlySet<SignalKind> = new Set([
  'perf-drift',
  'spec-changed',
  'recovered',
  'maturity-drop',
  // A proposal, not required work: certification is opt-in, so a pending
  // hardening candidate must never read as "your project needs attention".
  'hardening-candidate',
]);

function liveTriageOf(signal: Signal): DashboardSignalTriage {
  if (ACTIONABLE_KINDS.has(signal.kind)) return 'actionable';
  if (INFORMATIONAL_KINDS.has(signal.kind)) return 'informational';
  return signal.severity === 'high' || signal.severity === 'medium'
    ? 'actionable'
    : 'informational';
}

function mapSignals(
  signals: Signal[],
  generatedAtMs: number,
  ctx: SignalStateContext,
): DashboardSignal[] {
  const open = signals.filter((s) => s.status === 'open');
  return open
    .map((s) => {
      const openedAtRaw = s.openedAt ?? s.at;
      const openedMs = Date.parse(openedAtRaw);
      const ageMs = Number.isNaN(openedMs) ? 0 : Math.max(0, generatedAtMs - openedMs);
      const staleReason = staleSignalReason(s, ctx);
      return {
        id: s.id,
        kind: s.kind,
        severity: s.severity,
        status: 'open' as const,
        specId: s.specId,
        criterionId: s.criterionId ?? null,
        detail: s.detail ?? '',
        at: s.at,
        openedAt: s.openedAt ?? null,
        sha: s.sha ?? null,
        ageMs,
        triage: staleReason !== null ? ('stale' as const) : liveTriageOf(s),
        staleReason,
        resolvedBy: s.resolvedBy ?? null,
        suppressedUntil: s.suppressedUntil ?? null,
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.ageMs - a.ageMs ||
        a.id.localeCompare(b.id),
    );
}

function mapResolvedSignals(signals: Signal[]): DashboardResolvedSignal[] {
  return signals
    .filter((s) => s.status === 'resolved' || s.status === 'suppressed')
    .sort((a, b) => (b.resolvedAt ?? b.at).localeCompare(a.resolvedAt ?? a.at))
    .slice(0, RESOLVED_SNAPSHOT_LIMIT)
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      severity: s.severity,
      specId: s.specId,
      criterionId: s.criterionId ?? null,
      detail: s.detail ?? '',
      resolvedAt: s.resolvedAt ?? s.at,
      status: s.status === 'suppressed' ? 'suppressed' : 'resolved',
      resolvedBy: s.resolvedBy ?? null,
      suppressedUntil: s.suppressedUntil ?? null,
    }));
}

/**
 * Build the merged trend: a score series (F1's score.jsonl) and an open-signal
 * running-count series (F2's signals.jsonl), folded into one ascending-by-`at`
 * array. Missing sides render as `null` so the renderer can interpolate.
 * Returns `null` when BOTH sources are empty.
 */
function buildTrend(root: string): { points: DashboardTrendPoint[] } | null {
  const scoreRows = readScoreHistory(root, 200);
  const signalRows = readSignalHistory(root, 500);

  // open-signal running count: sort ascending by `at`, fold a Set of ids (open
  // adds, resolved deletes), emitting {at, openSignals} after each row.
  const signalSeries = new Map<string, number>();
  const openIds = new Set<string>();
  for (const row of [...signalRows].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) {
    if (row.status === 'open') openIds.add(row.id);
    else if (row.status === 'resolved' || row.status === 'suppressed') openIds.delete(row.id);
    signalSeries.set(row.at, openIds.size);
  }

  // Same-at rows merge into one point: a Map keyed by `at` with the score sha/
  // score on the score side and the openSignals count on the signal side.
  const merged = new Map<
    string,
    { at: string; sha: string | null; score: number | null; openSignals: number | null }
  >();
  for (const row of scoreRows) {
    const existing = merged.get(row.at);
    merged.set(row.at, {
      at: row.at,
      sha: row.sha ?? null,
      score: row.score,
      openSignals: existing?.openSignals ?? null,
    });
  }
  for (const [at, count] of signalSeries) {
    const existing = merged.get(at);
    merged.set(at, {
      at,
      sha: existing?.sha ?? null,
      score: existing?.score ?? null,
      openSignals: count,
    });
  }

  if (merged.size === 0) return null;
  const points = [...merged.values()].sort((a, b) => a.at.localeCompare(b.at));

  // Forward-fill AFTER the merge: both series are STEP FUNCTIONS — the score
  // ledger appends only when the score changes, and the open-signal series is
  // a running count defined at every instant — so a null between observations
  // means "unchanged since the last point", not "unmeasured". Carrying the
  // last value forward is truthful and keeps the sparklines connected instead
  // of fragmenting at every merge seam. Leading nulls (before a series' first
  // observation) stay null — nothing is invented.
  let lastScore: number | null = null;
  let lastOpen: number | null = null;
  for (const p of points) {
    if (p.score === null) p.score = lastScore;
    else lastScore = p.score;
    if (p.openSignals === null) p.openSignals = lastOpen;
    else lastOpen = p.openSignals;
  }
  return { points };
}

function buildPopulation(
  allSpecs: Spec[],
  scorecard: Scorecard | null,
  assess?: (spec: Spec, entry: ScorecardSpec | undefined) => MaturityAssessment,
): DashboardSnapshot['population'] {
  // Mirrors watch.ts specPopulation semantics (do not import it): tracked =
  // frozen spec count; total = all; draftSuperseded = non-frozen spec ids with
  // a scorecard entry.
  const tracked = allSpecs.filter((s) => s.status === 'frozen').length;
  const draftSuperseded = allSpecs
    .filter((s) => s.status !== 'frozen' && Boolean(scorecard?.specs[s.id]))
    .map((s) => s.id);
  const stub = (s: Spec): DashboardSpecStub => ({
    specId: s.id,
    version: s.version,
    title: specTitle(s),
    maturity: maturityOf(s, scorecard?.specs[s.id], assess)?.level ?? null,
  });
  const drafts = allSpecs.filter((s) => s.status !== 'frozen' && !scorecard?.specs[s.id]).map(stub);
  const unverified = allSpecs
    .filter((s) => s.status === 'frozen' && !scorecard?.specs[s.id])
    .map(stub);
  return { tracked, total: allSpecs.length, draftSuperseded, drafts, unverified };
}

/**
 * Fold tracked-spec verdicts + triaged signals + observation freshness into the
 * ONE hero verdict. Reads verdicts only — never re-decides them (presentation
 * aggregation, not a gate). The tracked population sets the base verdict, and
 * untracked specs' own verdicts never move it. Two never-false-green demotions
 * then apply on top of a would-be-`healthy` result: ANY actionable signal
 * (including on untracked specs — the red tile and Needs-action section count
 * them, so the hero must not read green above them) and a stale observation
 * (trailing HEAD) each demote to `attention` with a stated `verdictReason`.
 */
export function computeDashboardHealth(args: {
  specs: DashboardSpec[];
  signals: DashboardSignal[];
  population: { tracked: number };
  staleSoftCount: number;
  /** Watcher freshness — folds the observation's high-water mark into the hero. */
  watcher: { lastObservedSha: string | null; headSha: string | null; commitsBehind: number | null };
  /** In-flight verify rows, already projected + aged. Defaults to none. */
  inProgress?: DashboardInProgress[];
  /** Judge gap (issue #17) — see DashboardHealth.judgeGap. */
  judgeGap?: { softCriteria: number } | null;
}): DashboardHealth {
  const trackedSpecs = args.specs.filter((s) => s.tracked);
  const trackedIds = new Set(trackedSpecs.map((s) => s.specId));
  const passing = trackedSpecs.filter((s) => s.verdict === 'pass').length;
  const failing = trackedSpecs.filter((s) => s.verdict === 'fail').length;
  const partial = trackedSpecs.filter((s) => s.verdict === 'partial').length;
  // Display-only: how many tracked passes rest on agent-scored soft evidence.
  const attestedPassing = trackedSpecs.filter((s) => s.attestedSignOff === true).length;

  const actionableSignals = args.signals.filter((s) => s.triage === 'actionable');
  const informational = args.signals.filter((s) => s.triage === 'informational').length;
  const staleSuppressed = args.signals.filter((s) => s.triage === 'stale').length;

  // Environment attribution (SUSPECTED — see DashboardHealth.environment doc):
  // a tracked spec carrying ≥1 `unverifiable` criterion tainted by a DEMOTING
  // env taint (network/wrapper/unconfirmed-render) is likely blocked by a
  // broken sandbox/device, not a genuine regression. `dep-scan` is excluded —
  // CI already escalates that one to a spec-level `.error` (build-failing),
  // never a bare taint.
  const ENV_SUSPECT_TAINTS: ReadonlySet<EvidenceTaint> = new Set([
    'network',
    'wrapper',
    'unconfirmed-render',
  ]);
  const envSuspectSpecs = trackedSpecs.filter((s) =>
    s.criteria.some(
      (c) =>
        c.status === 'unverifiable' &&
        (c.evidenceTaints ?? []).some((t) => ENV_SUSPECT_TAINTS.has(t)),
    ),
  );
  const environment: DashboardHealth['environment'] =
    envSuspectSpecs.length > 0
      ? {
          confidence: 'suspected',
          count: envSuspectSpecs.length,
          reason:
            `environment (suspected): ${envSuspectSpecs.length} spec${envSuspectSpecs.length === 1 ? '' : 's'} blocked ` +
            `(render/setup failure) — unverifiable criteria carry a network/wrapper/unconfirmed-render taint`,
        }
      : null;

  // Verdict from the TRACKED population only.
  const trackedActionable = actionableSignals.filter((s) => trackedIds.has(s.specId));
  let verdict: DashboardHealth['verdict'];
  if (trackedSpecs.length === 0) {
    verdict = 'empty';
  } else if (failing > 0 || trackedActionable.some((s) => s.severity === 'high')) {
    verdict = 'failing';
  } else if (partial > 0 || trackedActionable.length > 0 || args.staleSoftCount > 0) {
    verdict = 'attention';
  } else {
    verdict = 'healthy';
  }

  // Never-false-green demotions. A tracked population that reads clean can
  // still (a) sit above actionable signals on UNTRACKED specs — which the red
  // "Needs action" tile and section DO count, so a green hero would silently
  // contradict them — or (b) be looking at evidence older than HEAD. Either
  // one demotes the hero off green WITH a stated reason, so the verdict never
  // disagrees with the numbers beneath it and never claims freshness it lacks.
  const { commitsBehind } = args.watcher;
  let verdictReason: string | null = null;
  if (verdict === 'healthy') {
    if (commitsBehind != null && commitsBehind > 0) {
      verdict = 'attention';
      verdictReason =
        `last observed ${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind HEAD — ` +
        `re-run the watcher to confirm against the latest code`;
    } else if (actionableSignals.length > 0) {
      const n = actionableSignals.length;
      verdict = 'attention';
      verdictReason = `${n} actionable signal${n === 1 ? '' : 's'} on spec${
        n === 1 ? '' : 's'
      } outside the tracked set`;
    } else if (args.judgeGap) {
      // Issue #17: soft criteria that can never re-score are a standing error
      // state — a green hero over an un-drainable staleness queue would be a
      // false calm. Same never-false-green rule as the freshness demotion.
      verdict = 'attention';
      verdictReason = judgeGapWarning(args.judgeGap.softCriteria);
    } else if (environment) {
      // A tracked spec population that otherwise reads clean can still be
      // resting on unverifiable criteria the environment (not the code)
      // broke — never let that read as a clean green.
      verdict = 'attention';
      verdictReason = environment.reason;
    }
  }

  // The ONE thing to fix, in priority order: failing spec → highest-severity
  // actionable signal → suspected environment blockage → unscored soft work →
  // (healthy/empty ⇒ none/setup).
  let topAction: DashboardHealth['topAction'] = null;
  const firstFailing = trackedSpecs.find((s) => s.verdict === 'fail');
  if (firstFailing) {
    const failCount = firstFailing.criteria.filter((c) => c.status === 'fail').length;
    topAction = {
      kind: 'fix-spec',
      specId: firstFailing.specId,
      criterionId: firstFailing.criteria.find((c) => c.status === 'fail')?.id ?? null,
      summary: `${firstFailing.specId} is failing (${failCount} criteri${failCount === 1 ? 'on' : 'a'})`,
    };
  } else if (trackedActionable.length > 0) {
    const top = trackedActionable[0]!; // pre-sorted severity-then-age
    topAction = {
      kind:
        top.kind === 'needs-scoring' || top.kind === 'needs-rescoring'
          ? 'score-soft'
          : 'resolve-signal',
      specId: top.specId,
      criterionId: top.criterionId,
      summary: `${top.kind} on ${top.specId}${top.criterionId ? `/${top.criterionId}` : ''}`,
    };
  } else if (environment) {
    // No specific failing spec or higher-priority signal — but a suspected
    // environment cluster exists. Point at diagnosis, not a specific spec
    // (the whole point is that this isn't a code problem to fix).
    topAction = {
      kind: 'diagnose-env',
      specId: null,
      criterionId: null,
      summary: `${environment.count} spec${environment.count === 1 ? '' : 's'} may be environment-blocked (suspected) — run \`validity doctor\``,
    };
  } else if (verdict === 'empty') {
    topAction = {
      kind: 'setup',
      specId: null,
      criterionId: null,
      summary:
        args.population.tracked > 0
          ? 'tracked specs have no recorded verdicts yet — run `validity verify --all`'
          : 'no tracked specs yet — run `validity onboard` or freeze a spec',
    };
  } else if (verdict === 'attention' && args.staleSoftCount > 0) {
    topAction = {
      kind: 'score-soft',
      specId: null,
      criterionId: null,
      summary: `${args.staleSoftCount} soft score${args.staleSoftCount === 1 ? '' : 's'} went stale — re-score to restore full credit`,
    };
  }

  return {
    verdict,
    trackedSpecs: args.population.tracked,
    scoredTracked: trackedSpecs.length,
    passing,
    failing,
    partial,
    actionable: actionableSignals.length,
    informational,
    staleSuppressed,
    staleSoft: args.staleSoftCount,
    attestedPassing,
    observedThroughSha: args.watcher.lastObservedSha,
    headSha: args.watcher.headSha,
    commitsBehind: args.watcher.commitsBehind,
    verdictReason,
    judgeGap: args.judgeGap ?? null,
    environment,
    topAction,
    inProgress: args.inProgress ?? [],
  };
}

/**
 * Flatten every spec's run timeline into the newest {@link RECENT_RUNS_LIMIT}
 * runs, newest first (runId breaks timestamp ties so the order is total and
 * the page stays byte-stable for a given on-disk state). Report-existence and
 * score lookups run ONLY over the capped window — a long history costs one
 * ledger read, not a filesystem probe per run.
 */
function buildRecentRuns(
  root: string,
  specs: DashboardSpec[],
  timelines: Map<string, SpecRunSummary[]>,
): DashboardRecentRun[] {
  const flat: Array<{ spec: DashboardSpec; run: SpecRunSummary }> = [];
  for (const spec of specs) {
    for (const run of timelines.get(spec.specId) ?? []) flat.push({ spec, run });
  }
  flat.sort(
    (a, b) =>
      b.run.createdAt.localeCompare(a.run.createdAt) || b.run.runId.localeCompare(a.run.runId),
  );
  const window = flat.slice(0, RECENT_RUNS_LIMIT);
  if (window.length === 0) return [];
  const scoreAt = buildSpecScoreLookup(root);
  return window.map(({ spec, run }) => ({
    runId: run.runId,
    specId: spec.specId,
    specTitle: spec.title,
    createdAt: run.createdAt,
    sha: run.sha ?? null,
    verdict: run.verdict,
    counts: run.counts,
    signedOff: run.signedOff === true,
    ...(run.origin ? { origin: run.origin } : {}),
    score: scoreAt(spec.specId, run.createdAt, run.sha ?? null),
    mechanical: runMechanicalTally(run),
    hasReport: runReportViewable(root, run.runId),
  }));
}

function buildWatcher(root: string, generatedAt: string): DashboardWatcher {
  const state = loadWatchState(root);
  const lastObservedSha = state?.lastObservedSha ?? null;
  const lastTickAt = state?.lastTickAt ?? null;
  const headSha = gitHeadSha(root) ?? null;

  // Only count when both ends resolve; mark===head ⇒ 0 (no commits behind).
  let commitsBehind: number | null = null;
  if (lastObservedSha && headSha) {
    commitsBehind = lastObservedSha === headSha ? 0 : gitCommitsBehind(root, lastObservedSha);
  }

  let hook: DashboardWatcher['hook'] = null;
  if (state?.hook) {
    const h = state.hook;
    let coolingDown = false;
    const lastLaunchMs = Date.parse(h.lastLaunchAt);
    if (!Number.isNaN(lastLaunchMs)) {
      const nowMs = Date.parse(generatedAt);
      const base = Number.isNaN(nowMs) ? Date.now() : nowMs;
      coolingDown = base - lastLaunchMs < h.cooldownMs;
    }
    hook = {
      lastLaunchAt: h.lastLaunchAt,
      batchSize: h.batchSize,
      cooldownMs: h.cooldownMs,
      coolingDown,
    };
  }

  return { lastObservedSha, lastTickAt, headSha, commitsBehind, hook };
}

/**
 * Assemble a {@link DashboardSnapshot} from the on-disk `.validity/` state.
 * Pure-ish (reads files + spawns `git`, writes nothing) and never throws: a
 * missing or corrupt file contributes its empty/null shape.
 *
 * @param projectRoot Absolute path to the project root containing `.validity/`.
 * @param opts.assessMaturity Live maturity derivation, injected by the CLI
 *   from `@validity.ai/verify-web`'s `assessSpecMaturity` (verify-spec
 *   cannot depend on verify-web). Receives the spec's already-loaded scorecard
 *   entry so the wiring never re-reads the scorecard per spec. Absent, the
 *   snapshot falls back to the scorecard cache + the conservative team floor.
 */
export function buildDashboardSnapshot(
  projectRoot: string,
  opts?: {
    /**
     * Clock injection for tests / deterministic rebuilds. Default is the real
     * wall clock — production callers never pass this.
     */
    now?: string;
    /**
     * Embed per-spec static-render detail (`specs[].detail`). Off by default:
     * only the publish path needs it.
     */
    includeDetail?: boolean;
    assessMaturity?: (spec: Spec, entry: ScorecardSpec | undefined) => MaturityAssessment;
    /**
     * Whether `scoring.judgeModel` is configured (issue #17). Core cannot load
     * the TS config, so the CLI threads the probe in: `false` + tracked soft
     * criteria ⇒ the hero shows the judge-gap warning. `undefined` = unknown
     * (config not loaded yet) ⇒ no warning — never on a guess.
     */
    judgeConfigured?: boolean;
  },
): DashboardSnapshot {
  const generatedAt = opts?.now ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  const assess = opts?.assessMaturity;

  const scorecard = safeScorecard(projectRoot);
  const score = scorecard ? computeValidityScore(scorecard) : null;
  const allSpecs = listSpecs(projectRoot);
  const specById = new Map(allSpecs.map((s) => [s.id, s]));

  // Each spec's run timeline is read ONCE and reused for `latestRun`, the
  // runs-per-spec tally, and the cross-spec "Recent runs" feed.
  const timelines = new Map<string, SpecRunSummary[]>();
  const specs: DashboardSpec[] = scorecard
    ? Object.entries(scorecard.specs)
        .map(([specId, spec]) => {
          const runs = specRunTimeline(projectRoot, specId);
          timelines.set(specId, runs);
          return mapSpec(specId, spec, projectRoot, specById.get(specId), runs, assess);
        })
        .sort((a, b) => a.specId.localeCompare(b.specId))
    : [];
  const recentRuns = buildRecentRuns(projectRoot, specs, timelines);

  // Per-spec static-render detail (ADD-ONLY, opt-in): embedded so `validity
  // dashboard publish` can render every spec page from the snapshot alone.
  // OFF by default — the live server rebuilds per request/SSE tick and must
  // not pay ~2 existsSync per timeline row × 80 rows × N specs for data it
  // reads from disk anyway.
  if (opts?.includeDetail && specs.length > 0) {
    const detailScoreAt = buildSpecScoreLookup(projectRoot);
    for (const spec of specs) {
      spec.detail = buildSpecDetail(
        projectRoot,
        spec.specId,
        spec.specVersion,
        specById.get(spec.specId),
        timelines.get(spec.specId) ?? [],
        detailScoreAt,
      );
    }
  }

  const triageCtx: SignalStateContext = {
    scorecard,
    specs: allSpecs.map((s) => ({
      id: s.id,
      version: s.version,
      criteria: s.criteria.map((c) => ({ id: c.id, tier: c.tier })),
    })),
  };
  const storedSignals = loadSignals(projectRoot);
  const signals = mapSignals(storedSignals, generatedAtMs, triageCtx);
  const resolvedSignals = mapResolvedSignals(storedSignals);

  // Hardening suggestions inline (maturity Phase C): when an OPEN
  // hardening-candidate exists for a criterion that appears as an
  // evidence blocker (`criterion-unproven` / `soft-score-stale`), the blocker
  // carries the proposal sentence so the drawer's checklist shows the
  // machine-suggested step, not just the missing-evidence complaint.
  for (const spec of specs) {
    if (!spec.maturity) continue;
    for (const blocker of spec.maturity.blockers) {
      if (
        (blocker.kind !== 'criterion-unproven' && blocker.kind !== 'soft-score-stale') ||
        !blocker.criterionId
      )
        continue;
      const candidate = storedSignals.find(
        (s) =>
          s.kind === 'hardening-candidate' &&
          s.status === 'open' &&
          s.specId === spec.specId &&
          s.criterionId === blocker.criterionId,
      );
      if (candidate) blocker.detail = `${blocker.detail} — ${candidate.detail}`;
    }
  }
  const population = buildPopulation(allSpecs, scorecard, assess);
  const watcher = buildWatcher(projectRoot, generatedAt);
  const trend = buildTrend(projectRoot);
  // In-flight verify markers — aged against the SAME sanctioned clock as signal
  // ages, so a served page's "started Ns ago" ticks without a renderer clock.
  const inProgress = mapInProgress(readInflightMarkers(projectRoot), generatedAtMs);
  // Maturity tally over EVERY spec on disk — the hero strip aggregate.
  const maturity =
    allSpecs.length === 0
      ? null
      : tallyMaturity(
          allSpecs.map((s) => maturityOf(s, scorecard?.specs[s.id], assess)?.level ?? 'dev'),
        );
  // Judge gap (issue #17): only when judge-presence is KNOWN false — an
  // unknown probe must never paint a warning the config would refute.
  const softTracked = countTrackedSoftCriteria(allSpecs);
  const judgeGap =
    opts?.judgeConfigured === false && softTracked > 0 ? { softCriteria: softTracked } : null;

  const health = computeDashboardHealth({
    specs,
    signals,
    population,
    staleSoftCount: score?.staleSoftCount ?? 0,
    watcher: {
      lastObservedSha: watcher.lastObservedSha,
      headSha: watcher.headSha,
      commitsBehind: watcher.commitsBehind,
    },
    inProgress,
    judgeGap,
  });

  return {
    version: DASHBOARD_SNAPSHOT_VERSION,
    generatedAt,
    projectName: readProjectName(projectRoot),
    health,
    score: score
      ? {
          score: score.score,
          blockingCriteriaCount: score.blockingCriteriaCount,
          advisoryExcludedCount: score.advisoryExcludedCount,
          staleSoftCount: score.staleSoftCount,
        }
      : null,
    population,
    specs,
    recentRuns,
    signals,
    resolvedSignals,
    watcher,
    trend,
    maturity,
  };
}
