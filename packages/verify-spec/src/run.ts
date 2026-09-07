import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  A11yViolation,
  ComponentRender,
  ConsoleErrorEntry,
  JudgeMode,
  NetworkErrorEntry,
  PageErrorEntry,
  PerformanceMetrics,
  RunEnvironment,
  ValidityConfig,
  ViewportSpec,
} from './types.js';
import { resolveViewport } from './types.js';
import {
  applyEvidenceTaints,
  criterionUsesCommandChecks,
  evidenceTaintsOf,
  withEvidenceTaint,
  type CriterionVerdict,
  type CriterionTier,
  type DataState,
  type SpecCriterion,
} from './spec-schema.js';
import type { Spec } from './spec-schema.js';
import {
  executeCommandCriteria,
  overlayCommandVerdicts,
  type CommandCheckRunner,
} from './command-check.js';
import { computeSignedOff, rollupCriterionVerdicts, type SignOffCriterion } from './scorecard.js';
import { buildDataStateHints, type DataStateHint } from './data-state-scan.js';
import {
  readTsconfigPaths,
  resolveImportSpecifier,
  type TsconfigPathsMap,
} from './component-usage.js';
import { scanImportSpecifiers } from './import-graph.js';
import { discoverComponentFiles, selectComponentsToRender } from './components.js';
import { collectDiff, type DiffFile } from './diff.js';
import { collectGitInfo, type GitInfo } from './git.js';
import { extractPropsType } from './props.js';
import type { EnsureResult } from './ensure-configured.js';
import { appendHistoryRow } from './history.js';
import { stampScreenshotHashes } from './render-identity.js';
import { detectRunOrigin, type RunOrigin } from './run-origin.js';
import { inflightDir } from './inflight.js';
import { ensureRunDirectories, runDir, runsDir, validityDir } from './runs.js';
import { resolveReportConfig } from './schema.js';
import { newRunId, slugify, writeFileAtomic } from './util.js';

export interface RenderRequestSpec {
  componentAbsolutePath: string;
  componentId: string;
  props?: Record<string, unknown>;
  /** Scenario id this render runs under. `undefined` = base (no scenario). */
  scenarioId?: string;
  /** Fixture id this render runs under. `undefined` = no fixture (default props). */
  fixtureId?: string;
  /**
   * Composed play function for this render. May be undefined. Always async-callable.
   * If the scenario AND the fixture both have a play, the composed callback runs
   * the scenario's first, then the fixture's.
   */
  play?: (args: { page: unknown }) => Promise<void> | void;
  /**
   * Stacked-fixture mode: render every named fixture as a sibling under the
   * wrapper, one screenshot total. Use only when none of the fixtures have
   * a play function (siblings on the same page would interfere). When set,
   * `fixtureId` and `props` are unused — entry.tsx looks up each name in
   * the injected `__VALIDITY_FIXTURES__` map and applies that fixture's
   * props to its own copy of the component.
   */
  stackedFixtureIds?: string[];
  /**
   * Viewport to render at. Undefined → sandbox default (1280×800). When set,
   * `name` becomes a segment in the variant slug so multi-viewport renders
   * land in distinct screenshot files (and distinct baselines).
   */
  viewport?: ViewportSpec;
  /**
   * Color scheme (theme) to render under. Undefined → the wrapper's own
   * default theme (today's single-render behavior; no slug suffix). When set,
   * the scheme becomes a variant-slug segment so light/dark land in distinct
   * screenshots + baselines, and the sandbox/native runtime forces the theme
   * (Playwright `colorScheme` + documentElement class on web; RN `Appearance`
   * on native) and passes it to the wrapper as a `colorScheme` prop.
   */
  colorScheme?: ColorScheme;
  /**
   * Data state to FORCE for this render (A2). The sandbox's MSW layer overrides
   * every non-internal request: `loading` hangs them, `empty` serves
   * permissive-tagged empty bodies, `error` serves tagged 500s. Undefined =
   * the natural (populated) pipeline. Set only on the additive dataState
   * clones minted by `prepareVerification` — never crossed with
   * scenario/fixture/viewport/theme/play.
   */
  dataState?: DataState;
  /**
   * Spec hard/property criteria to execute DETERMINISTICALLY against this
   * render (after the play step, before the screenshot). Set only on the
   * canonical base render of a spec's target component (or, for a
   * dataState-conditioned criterion, on the matching dataState clone); the
   * sandbox runs each criterion's `checks` via the check-executor and returns
   * per-criterion `criterionVerdicts` on the resulting ComponentRender. Soft
   * criteria carry no checks and are never attached here.
   */
  criteriaChecks?: SpecCriterion[];
  /**
   * Loop cost control — whether any soft criterion needs this render's
   * screenshot for host scoring. `false` ONLY when the spec has zero soft
   * criteria, which lets the sandbox skip the screenshot on a definitively-red
   * render (errored, or every mechanical check failed). Defaults to `true`
   * (never skip) when unset or when there's no spec — screenshots are evidence.
   */
  softCriteriaNeedRender?: boolean;
}

/**
 * What a render session hands back: the per-element renders, plus the ONE
 * environment record describing the session they were captured in.
 *
 * The two halves are deliberately separate. A `ComponentRender` answers "what
 * did THIS element do?"; {@link RunEnvironment} answers "what was true of the
 * whole session?" — the toolchain, the dev server, the app-manifest merge, and
 * whether the dependency pre-scan survived. Before this split the session-level
 * facts had nowhere to live and were copied onto every element, which is why
 * consumers had to `find()` a single string across an array to recover it.
 */
export interface RenderResult {
  renders: ComponentRender[];
  environment: RunEnvironment;
}

export type RenderFn = (args: {
  projectRoot: string;
  config: ValidityConfig;
  screenshotsDir: string;
  components: RenderRequestSpec[];
}) => Promise<RenderResult>;

export interface PrepareVerificationArgs {
  projectRoot: string;
  config: ValidityConfig;
  prompt: string;
  changedFiles?: string[];
  /** Optional scenario names from .validity/config.ts. Empty/undefined = render base only. */
  scenarios?: string[];
  render: RenderFn;
  maxComponents?: number;
  /** Output of `ensureValidityConfigured`. Threaded into run-meta for the report. */
  setupResult?: EnsureResult;
  /**
   * Plan id from `validity__plan`. Threaded into run-meta so `submit_report`
   * can reload the upfront acceptance criteria without making the agent
   * re-pass them.
   */
  planId?: string;
  /** Spec provenance (when verifying against a frozen spec). */
  specId?: string;
  specVersion?: number;
  specHash?: string;
  /** Mechanical hard/property verdicts to persist + index against the spec. */
  criterionVerdicts?: CriterionVerdict[];
  /**
   * The frozen spec to verify against. When set, its hard/property criteria
   * run deterministically in the sandbox (attached to the base render) and its
   * id/version/hash + the resulting verdicts are persisted to run-meta and the
   * per-spec regression index. Soft criteria are LLM-scored as before.
   */
  spec?: Spec;
  /**
   * Verdicts from the previous run of the same spec, used to compute
   * per-criterion regression deltas ("AC-3 regressed: pass→fail"). The caller
   * loads these from the previous run's `run-meta.json` (typically via
   * `readSpecRunHistory` + `readRunMeta`). Absent on first run → all
   * (hard/property) criteria flagged `new`. DISPLAY-ONLY — never gates.
   */
  previousVerdicts?: CriterionVerdict[];
  /** MCP session fingerprint that ran this verify (A3). Threaded by tracks. */
  sessionFingerprint?: string;
  /**
   * Shared `expect.command` runner (A5). `verify --all`/watch pass one runner
   * per invocation so a command referenced by many specs executes once; absent
   * → a fresh runner (still once per run within this verify).
   */
  commandRunner?: CommandCheckRunner;
  /**
   * Pre-generated run id. The MCP verify dispatcher generates the id up front
   * (to write the in-flight marker BEFORE the render begins) and injects it here
   * so the marker names the same run this prepares. Absent → a fresh id, as
   * before.
   */
  runId?: string;
}

export interface PrepareVerificationResult {
  runId: string;
  components: ComponentRender[];
  componentSources: Record<string, string>;
  /** The (component × scenario) pairs that were actually rendered. */
  pairCount: number;
  /** Path of the run-meta.json that was written, so submit_report can read it back. */
  runMetaPath: string;
  /**
   * Data states that were requested but couldn't be forced for a render (A2
   * populates; consumed by the MCP server / CLI). Absent when nothing dropped.
   */
  droppedDataStates?: Array<{ componentId: string; dataState: DataState }>;
  /**
   * Fixture/scenario precedence notes (add-only). Present when scenarios were
   * requested for a component that has config fixtures — fixtures win, and
   * the agent needs to see that the scenarios were ignored.
   */
  warnings?: string[];
  /**
   * INFORMATIONAL coverage nudges (E2.1): a rendered target shows a
   * loading/empty/error branch that no criterion in the spec is conditioned on.
   * Never a taint, never a verdict input — see `data-state-scan.ts`. Absent
   * when there is no spec in scope or nothing uncovered was found.
   */
  dataStateHints?: DataStateHint[];
}

/** Warning when config fixtures silently ignore requested scenarios. */
export function fixtureScenarioPrecedenceWarning(componentId: string, scenarios: string[]): string {
  return (
    `${componentId}: scenarios [${scenarios.join(', ')}] ignored — component has fixtures in ` +
    `.validity/config.ts (fixtures take precedence). Remove the fixtures or drop the scenarios.`
  );
}

/**
 * One captured URL-mode page render. Mirrors `ComponentRender`'s shape but
 * keyed by URL+slug rather than component file path. Persisted to run-meta
 * so `submit_report` can render the same HTML report it does for isolation
 * mode.
 */
export interface PageRender {
  /** Slug used as the screenshot filename and as the report's per-page id. */
  id: string;
  /**
   * Path-only slug — the same value across all scenarios for the same URL,
   * used by the report renderer to group renders together. e.g. "/dashboard"
   * and "/users" become "dashboard" and "users".
   */
  pathId: string;
  /** Absolute URL captured (e.g., http://localhost:3000/dashboard). */
  url: string;
  scenarioId?: string;
  screenshotPath: string;
  /** Capture/play error if the render failed to produce a usable screenshot. */
  errorMessage?: string;
  /** Browser-side requests not matched by any handler (URL-mode equivalent of unmatchedUrls). */
  unmatchedUrls?: string[];
  /** `console.error` calls captured during this render. */
  consoleErrors?: ConsoleErrorEntry[];
  /** Uncaught exceptions captured during this render. */
  pageErrors?: PageErrorEntry[];
  /** Failed network responses (4xx/5xx) captured during this render. */
  networkErrors?: NetworkErrorEntry[];
  /** A11y violations captured during this render. */
  a11yViolations?: A11yViolation[];
}

/**
 * Snapshot persisted to disk after each verify run. `submit_report` reads
 * this back to render the HTML — keeps the two MCP tools stateless across
 * the wire (no session id, no in-memory store).
 *
 * Two shapes share the same file:
 *   - mode: 'isolation' → `components` + `componentSources` are populated
 *   - mode: 'url'       → `pages` is populated (no source code captured)
 * `mode` defaults to 'isolation' on read for backward compat with run-metas
 * written before URL-mode reports were wired up.
 */
export interface RunMeta {
  runId: string;
  createdAt: string;
  /**
   * Render mode that produced this run. Defaults to 'isolation' if absent.
   * `'native'` (C1) is stamped by `writeNativeRunMeta`; readers that don't know
   * it treat unknown/absent as 'isolation'.
   */
  mode?: 'isolation' | 'url' | 'native';
  /**
   * WHICH device produced a `mode: 'native'` run. Evidence is only as good as
   * its provenance: "it rendered on a simulator" is unfalsifiable without the
   * udid/serial, OS, and companion build behind it — two runs that disagree
   * are unattributable, and a stale companion looks identical to a fresh one.
   * Absent on web runs and on native run-metas written before this landed.
   */
  nativeDevice?: {
    platform: 'ios' | 'android';
    /** Simulator udid / emulator serial the capture was pinned to. */
    deviceId?: string;
    /** Human-readable device name, e.g. "iPhone 17 Pro Max". */
    deviceName?: string;
    /** Runtime/OS version when the device reported one. */
    osVersion?: string;
    /** Companion build hash — distinguishes a stale companion from a fresh one. */
    buildHash?: string;
  };
  prompt: string;
  scenarios: string[];
  /** Isolation mode — present when `mode === 'isolation'`. */
  components?: ComponentRender[];
  /** Isolation mode — source code for each rendered component. */
  componentSources?: Record<string, string>;
  /** URL mode — present when `mode === 'url'`. */
  pages?: PageRender[];
  diff: { files: DiffFile[] };
  report: { enabled: boolean; brand: 'validity' | 'none' };
  /**
   * Auto-config orchestrator output. Optional for backward compat with
   * run-metas written before Phase 3 landed; the report renderer treats
   * absence as "no setup-health panel."
   */
  setup?: EnsureResult;
  /**
   * Git HEAD metadata for the project at verify time. Optional — omitted in
   * non-git projects (or when the `git` binary isn't installed). The report
   * renders it in a subtle header strip; baselines key off `sha` so a clean
   * baseline-promotion lands "at sha X".
   */
  git?: GitInfo;
  /**
   * Plan id this run was verified against, if one was created via
   * `validity__plan` before the work happened. Lets `submit_report` reload
   * the upfront criteria for the audit-trail / criterion table without
   * making the agent re-pass them.
   *
   * With the spec layer, a spec id (`spec-…`) flows through this SAME field —
   * `planId` is the historical name; `specId`/`specVersion`/`specHash` below
   * carry the richer provenance when the run verified against a frozen spec.
   */
  planId?: string;
  /** Spec this run verified against (mirrors planId when the id is a spec id). */
  specId?: string;
  /** Frozen spec version verified against — pins the regression timeline. */
  specVersion?: number;
  /** Frozen spec content hash — binds the run's evidence to exact content. */
  specHash?: string;
  /**
   * Per-criterion verdicts. HARD/PROPERTY entries are MECHANICAL (executed
   * deterministically in the sandbox); SOFT entries start `unverifiable` and
   * are overwritten by the agent's `submit_report` scoring. Kept separate from
   * the soft scores so the report can render "proven" distinctly from "scored".
   */
  criterionVerdicts?: CriterionVerdict[];
  /**
   * Roll-up of `criterionVerdicts` in the VERIFY vocabulary
   * (pass | fail | partial | unverifiable) via `rollupCriterionVerdicts`.
   * Stamped at write time so a reader (and the loop) doesn't have to re-fold the
   * per-criterion list. Absent when no spec was verified against.
   */
  verdict?: 'pass' | 'fail' | 'partial' | 'unverifiable';
  /**
   * The loop's stop signal: true ⇔ every BLOCKING criterion passes (via
   * `computeSignedOff`, joining `criterionVerdicts` with the spec's
   * severity/softThreshold when in scope). Soft criteria are `unverifiable`
   * placeholders at verify time, so a spec with un-scored soft criteria is NOT
   * signed off until `submit_report` records the host's scores. Absent when no
   * spec was verified against.
   */
  signedOff?: boolean;
  /**
   * Per-criterion regression deltas vs. the previous run of the SAME spec
   * (HARD/PROPERTY tiers only — soft criteria are LLM-scored placeholders at
   * verify time and would read as a spurious `regressed` against the previous,
   * already-scored run). Computed when the caller threads the previous run's
   * verdicts in; absent on first run, on non-spec verifies, and when the
   * previous run-meta couldn't be loaded. DISPLAY-ONLY: never feeds the
   * pass/fail gate, the coverage ratio, or any `CriterionVerdict.status` — it
   * only lets the verify response say "AC-3 regressed: pass→fail" instead of
   * being amnesiac across iterations.
   */
  regressionDeltas?: RegressionDelta[];
  /**
   * The scoring-contract version this run was scored under. Stamped by
   * submit_report from the `SCORING_CONTRACT_VERSION` constant in
   * `@validity.ai/verify-spec` so a reader can see "this run was scored under contract
   * vN". Absent on run-metas written before this field existed.
   */
  scoringContractVersion?: string;
  /** MCP session fingerprint that ran this verify (A3). Threaded by tracks. */
  sessionFingerprint?: string;
  /** Coverage floor stamped from config at verify time (C1). */
  coverageFloorPercent?: number;
  /**
   * Display-only provenance flag (B1): was this run verified against a plan or
   * spec? Old run-metas lack it — read via `isRunPlanned`, never directly.
   */
  planned?: boolean;
  /**
   * Scoring provenance stamped by submit_report / record_soft_scores / the
   * automated judge (A6). ADD-ONLY: `judgeModel` was appended for the automated
   * LLM judge (`validity judge`) — the `provider/model` string that scored this
   * run's soft criteria, present only when `judge === 'model'`.
   */
  scoring?: {
    judge: JudgeMode;
    scoredBy?: string;
    selfScored?: boolean;
    judgeModel?: string;
    /**
     * Soft-scoring rubric version this run's scores were produced under (E2.2).
     * ADD-ONLY. Declared by the submitter, else stamped from `RUBRIC_VERSION`
     * with `rubricVersionAssumed: true`.
     */
    rubricVersion?: string;
    /** True when `rubricVersion` was assumed by the server, not attested. */
    rubricVersionAssumed?: boolean;
  };
  /**
   * Data states the render budget dropped (A2 best-effort clones). Persisted so
   * submit_report's "Not validated" section can list them (C2) — the verify
   * response already surfaced them live, but the report renders later, from
   * run-meta alone. Absent when nothing was dropped (and on old run-metas).
   */
  droppedDataStates?: Array<{ componentId: string; dataState: DataState }>;
  /**
   * Where this run was produced — `'local'` (developer machine) or `'ci'` (a CI
   * runner), classified by `detectRunOrigin` at write time. DISPLAY-ONLY
   * provenance (never a gate input). Absent on run-metas written before this
   * field existed — readers treat absence as "unknown origin" and show nothing.
   */
  origin?: RunOrigin;
  /**
   * The render session's environment record (toolchain, dev-server provenance,
   * app-manifest merge, dep pre-scan). ADD-ONLY and DISPLAY-ONLY, except that
   * `depScanFailure` is the (unchanged) source of the demoting `dep-scan`
   * evidence taint.
   *
   * Absent on run-metas written before the environment channel landed, and on
   * `mode: 'url'` / `mode: 'native'` runs — neither goes through the web
   * sandbox, so neither has one of these to report.
   */
  environment?: RunEnvironment;
  /**
   * Lifecycle marker (B5). Written as `'in-progress'` at run START, then
   * overwritten by the run's real run-meta (which omits the field) when the
   * run finishes. ADD-ONLY, and ABSENCE MEANS COMPLETE — every run-meta ever
   * written before this field existed is a finished run.
   *
   * The problem it solves: a verify child killed mid-render (OOM, Ctrl-C, a
   * CI timeout) used to leave a run directory with screenshots and NO
   * run-meta at all. Readers skip malformed/missing rows, so the run was
   * simply invisible — indistinguishable from a run that never started.
   * Nothing said "this crashed". A start marker makes the crash a FACT on
   * disk; `readIncompleteRuns` then surfaces it, and — this is the important
   * half — it is never counted as a pass or a fail, because a crashed run
   * decided nothing.
   */
  status?: 'in-progress';
}

/**
 * One criterion's status change vs. the previous run of the same spec.
 * `delta` is the rolled-up direction:
 *   - `regressed`   — status got strictly worse (e.g. pass → fail, pass →
 *                     unverifiable, unverifiable → fail).
 *   - `improved`    — status got strictly better (fail → pass, etc.).
 *   - `unchanged`   — same status as before.
 *   - `new`         — the criterion didn't exist in the previous run (spec
 *                     was edited between runs).
 *
 * The lattice is `fail ⊐ unverifiable ⊐ pass` (fail is the worst, pass the
 * best). A move DOWN the lattice is a regression; a move UP is an improvement.
 */
export interface RegressionDelta {
  criterionId: string;
  previousStatus?: 'pass' | 'fail' | 'unverifiable';
  currentStatus: 'pass' | 'fail' | 'unverifiable';
  delta: 'regressed' | 'improved' | 'unchanged' | 'new';
}

/**
 * Order of the verdict lattice: fail (worst) > unverifiable > pass (best).
 * Used by `computeRegressionDeltas` to decide whether a status change is a
 * regression (worse) or an improvement (better).
 */
const VERDICT_RANK: Record<'pass' | 'fail' | 'unverifiable', number> = {
  fail: 2,
  unverifiable: 1,
  pass: 0,
};

/**
 * Compute per-criterion regression deltas vs. the previous run. Pure —
 * unit-tested without a render. Returns one entry per CURRENT criterion;
 * criteria that existed in the previous run but were removed from the spec
 * are NOT included (they're no longer part of the contract).
 *
 * Callers MUST pass only mechanically-decided verdicts (HARD/PROPERTY tiers):
 * soft criteria are `unverifiable` placeholders at verify time and only get a
 * real status from submit_report, so diffing them against the previous
 * (already-scored) run would emit a spurious `regressed` every run.
 *
 * This is a DISPLAY-ONLY signal: it never participates in the pass/fail gate
 * and never overrides a `CriterionVerdict.status`.
 */
export function computeRegressionDeltas(
  currentVerdicts: CriterionVerdict[],
  previousVerdicts?: CriterionVerdict[],
): RegressionDelta[] {
  if (!previousVerdicts || previousVerdicts.length === 0) {
    return currentVerdicts.map((v) => ({
      criterionId: v.id,
      currentStatus: v.status,
      delta: 'new' as const,
    }));
  }
  const prevById = new Map(previousVerdicts.map((v) => [v.id, v]));
  return currentVerdicts.map((cur) => {
    const prev = prevById.get(cur.id);
    if (!prev) {
      return { criterionId: cur.id, currentStatus: cur.status, delta: 'new' as const };
    }
    if (prev.status === cur.status) {
      return {
        criterionId: cur.id,
        previousStatus: prev.status,
        currentStatus: cur.status,
        delta: 'unchanged' as const,
      };
    }
    const prevRank = VERDICT_RANK[prev.status];
    const curRank = VERDICT_RANK[cur.status];
    return {
      criterionId: cur.id,
      previousStatus: prev.status,
      currentStatus: cur.status,
      delta: curRank > prevRank ? ('regressed' as const) : ('improved' as const),
    };
  });
}

/**
 * Project the persisted `criterionVerdicts` onto the canonical sign-off input,
 * joining each verdict with its spec criterion (for `severity`/`softThreshold`)
 * when the spec is in scope. At verify time soft criteria are `unverifiable`
 * placeholders with no numeric score, so a soft criterion only signs off after
 * `submit_report` records the host's pass — exactly the behavior we want for the
 * loop gate. When the spec isn't available (URL/native writers carry only
 * id/version/hash), severity/threshold default to "blocking" — the conservative
 * choice that can never read as a false green.
 */
function toSignOffCriteria(
  verdicts: CriterionVerdict[] | undefined,
  spec?: Spec,
): SignOffCriterion[] {
  if (!verdicts || verdicts.length === 0) return [];
  const byId = new Map<string, SpecCriterion>();
  for (const c of spec?.criteria ?? []) byId.set(c.id, c);
  return verdicts.map((v) => {
    const crit = byId.get(v.id);
    return {
      tier: v.tier,
      status: v.status,
      severity: crit?.severity,
      softThreshold: crit?.softThreshold,
      // Normalized taints (legacy networkTainted → 'network') so the sign-off
      // guard can refuse a demoting-tainted "pass" (belt-and-braces; A3).
      evidenceTaints: evidenceTaintsOf(v),
    };
  });
}

export function runMetaPathFor(projectRoot: string, runId: string): string {
  return resolve(runDir(projectRoot, runId), 'run-meta.json');
}

export function readRunMeta(projectRoot: string, runId: string): RunMeta | null {
  try {
    const raw = readFileSync(runMetaPathFor(projectRoot, runId), 'utf-8');
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

/**
 * Write the START marker run-meta for a run (B5) — `status: 'in-progress'`
 * plus the identity the run already knows. Called at the ONE choke point where
 * the in-flight marker is written, so all three modes are covered, and
 * overwritten wholesale by the mode's real run-meta when the run finishes.
 *
 * Best-effort and NEVER throws: this is a crash-visibility aid, not a gate.
 *
 * Written atomically (temp + rename) like every other run-meta write, so a
 * crash DURING this very write leaves no half-marker behind; readers tolerate
 * an unparseable run-meta anyway (they skip it), so the failure mode is at
 * worst today's invisible run, never a wrong verdict.
 */
export function writeStartRunMeta(args: {
  projectRoot: string;
  runId: string;
  mode: 'isolation' | 'url' | 'native';
  prompt?: string;
  specId?: string;
  planId?: string;
}): void {
  try {
    ensureRunDirectories(args.projectRoot, args.runId);
    const marker: RunMeta = {
      runId: args.runId,
      createdAt: new Date().toISOString(),
      mode: args.mode,
      prompt: args.prompt ?? '',
      scenarios: [],
      diff: { files: [] },
      report: resolveReportConfig(undefined),
      git: collectGitInfo(args.projectRoot),
      origin: detectRunOrigin(),
      ...(args.specId ? { specId: args.specId } : {}),
      ...(args.planId ? { planId: args.planId } : {}),
      status: 'in-progress',
    };
    writeFileAtomic(runMetaPathFor(args.projectRoot, args.runId), JSON.stringify(marker, null, 2));
  } catch {
    // best-effort — a verify must never fail because its start marker didn't write
  }
}

/**
 * How many run directories `readIncompleteRuns` inspects, newest-first. Run ids
 * are `run_<epoch-ms>_<hex>`, so a lexicographic sort is chronological — the
 * newest N dirs are the only place a recent crash can be. Bounded because this
 * runs on the verify hot path (via `readSpecRunHistory`) in projects that may
 * hold thousands of run dirs.
 */
export const INCOMPLETE_RUN_SCAN_LIMIT = 30;

/**
 * Runs whose run-meta is still marked `in-progress` while their in-flight
 * marker is gone — i.e. the process died between "verify started" and "verify
 * finished". A run that is genuinely still executing keeps its in-flight
 * marker, so it is NOT reported here (the dashboard's live "◍ verifying" row
 * already covers that state).
 *
 * The returned rows are `SpecRunSummary`-shaped with `status: 'incomplete'`,
 * `verdict: 'unknown'` and zeroed counts: an incomplete run proved nothing, so
 * it must be visible without ever being tallied as a pass or a fail.
 */
export function readIncompleteRuns(
  projectRoot: string,
  opts: { specId?: string; scanLimit?: number } = {},
): SpecRunSummary[] {
  const dir = runsDir(projectRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => n.startsWith('run_'));
  } catch {
    return [];
  }
  const rows: SpecRunSummary[] = [];
  for (const runId of entries.sort().slice(-(opts.scanLimit ?? INCOMPLETE_RUN_SCAN_LIMIT))) {
    const meta = readRunMeta(projectRoot, runId);
    if (!meta || meta.status !== 'in-progress') continue;
    if (opts.specId !== undefined && meta.specId !== opts.specId) continue;
    // Still running ⇒ not incomplete. The marker is removed on every exit path.
    if (existsSync(resolve(inflightDir(projectRoot), `${runId}.json`))) continue;
    rows.push({
      runId: meta.runId,
      createdAt: meta.createdAt,
      ...(meta.specVersion !== undefined ? { specVersion: meta.specVersion } : {}),
      ...(meta.specHash !== undefined ? { specHash: meta.specHash } : {}),
      ...(meta.git?.sha ? { sha: meta.git.sha } : {}),
      verdict: 'unknown',
      counts: { pass: 0, fail: 0, unverifiable: 0 },
      status: 'incomplete',
      ...(meta.origin ? { origin: meta.origin } : {}),
    });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Back-compat reader for the display-only `planned` flag (B1). Old run-metas
 * predate the field — derive it from the ids they DO carry (a legacy plan id
 * counts as planned: criteria were captured before the work, even if not
 * frozen). Readers must use this, never `meta.planned` directly.
 */
export function isRunPlanned(meta: Pick<RunMeta, 'planned' | 'planId' | 'specId'>): boolean {
  return meta.planned ?? Boolean(meta.planId ?? meta.specId);
}

/**
 * Canonical key for a render's slot in the per-run performance timeline (D1).
 * Keys are OPAQUE strings — group by the `id` prefix (before the first `__`)
 * when the component is needed. A forced non-`populated` `dataState` gets its
 * own `__data-<state>` segment so its timings stay out of the base render's
 * median (A2 coordination); native renders get an `@native` suffix (derived by
 * the caller from `meta.mode === 'native'`).
 */
export function perfKeyFor(
  c: Pick<ComponentRender, 'id' | 'scenarioId' | 'fixtureId' | 'viewport' | 'dataState'>,
  platform?: 'web' | 'native',
): string {
  let key = `${c.id}__${c.scenarioId ?? 'base'}__${c.fixtureId ?? 'base'}__${
    c.viewport?.name ?? 'default'
  }`;
  if (c.dataState && c.dataState !== 'populated') key += `__data-${c.dataState}`;
  if (platform === 'native') key += '@native';
  return key;
}

/** A theme the verify run can render a target under. */
export type ColorScheme = 'light' | 'dark';

/**
 * Resolve the color-scheme (theme) render axis for a verify run. The DEFAULT is
 * smart: a target is captured in BOTH light and dark automatically whenever the
 * spec has a theme-related criterion (so "looks right in light and dark" is
 * verifiable with zero config), and as a SINGLE default-theme render otherwise
 * (no doubling on theme-agnostic verifies).
 *
 *   - `config.colorSchemes` SET (non-empty) -> use it (deduped, clamped to
 *     light/dark in order). Forces those themes on EVERY target regardless of
 *     criteria — e.g. ['light','dark'] to always check both.
 *   - `config.colorSchemes: []` (explicit empty) -> force OFF: always a single
 *     default-theme render, even for theme criteria.
 *   - UNDEFINED (default) -> auto: both themes when `spec` has a theme-related
 *     criterion, else a single render.
 *
 * Pure — unit-tested directly.
 */
export function resolveColorSchemes(config: ValidityConfig, spec?: Spec): ColorScheme[] {
  const configured = config.colorSchemes;
  if (configured !== undefined) {
    // Explicit config (including []) is honored exactly; [] disables the axis.
    const out: ColorScheme[] = [];
    for (const s of configured) {
      if ((s === 'light' || s === 'dark') && !out.includes(s)) out.push(s);
    }
    return out;
  }
  // Auto: only pay the 2x render cost when there's a theme criterion to verify.
  if (spec && specMentionsTheme(spec)) return ['light', 'dark'];
  return [];
}

/** Does any criterion talk about themes/color schemes (so both must render)? */
function specMentionsTheme(spec: Spec): boolean {
  return spec.criteria.some((c) => {
    const t = c.text.toLowerCase();
    return (
      (t.includes('light') && t.includes('dark')) ||
      t.includes('color scheme') ||
      t.includes('colour scheme') ||
      t.includes('dark mode') ||
      t.includes('light mode')
    );
  });
}

/**
 * Resolve the MANDATORY non-populated data states a verify run must render,
 * mirroring `resolveColorSchemes`' set/[]/auto contract:
 *
 *   - `config.dataStates` SET (non-empty) -> use it (deduped, `populated`
 *     filtered — the base render already covers it). Forces those states on
 *     every rendered component regardless of criteria.
 *   - `config.dataStates: []` (explicit empty) -> axis OFF: no forced renders,
 *     even for dataState-conditioned criteria.
 *   - UNDEFINED (default) -> auto: the union of the spec's
 *     `conditions.dataStates` and every criterion's `dataState`.
 *
 * The best-effort "populated + empty for data-dependent components" default
 * policy is NOT part of this list — see `componentLooksDataDependent` and the
 * expansion in `prepareVerification` (those clones are droppable; these are
 * mandatory and count against the render cap). Pure — unit-tested directly.
 */
export function resolveDataStates(config: ValidityConfig, spec?: Spec): DataState[] {
  const configured = config.dataStates;
  if (configured !== undefined) {
    const out: DataState[] = [];
    for (const s of configured) {
      if (s !== 'populated' && !out.includes(s)) out.push(s);
    }
    return out;
  }
  const out = new Set<DataState>();
  for (const s of spec?.conditions?.dataStates ?? []) {
    if (s !== 'populated') out.add(s);
  }
  for (const c of spec?.criteria ?? []) {
    if (c.dataState && c.dataState !== 'populated') out.add(c.dataState);
  }
  return [...out];
}

/**
 * Heuristic: does this component source fetch remote data? Drives the
 * best-effort "populated + empty" default policy for the dataState axis.
 * Conservative source regex — misses hook-indirection (a fetch buried in an
 * imported hook) on purpose: a miss only skips the free extra `empty` render,
 * while criteria/config-driven states are unaffected. Pure — unit-tested.
 */
export function componentLooksDataDependent(source: string): boolean {
  return /\bfetch\s*\(|\bXMLHttpRequest\b|\baxios\b|\buse(?:Query|SWR|InfiniteQuery|SuspenseQuery|Queries|LazyQuery)\b|\bcreateTRPC|\buseConvex|\bgetDocs?\s*\(|\bsupabase\./.test(
    source,
  );
}

/**
 * Hard cap on total renders per verify call. Bounds Playwright runtime.
 * Bumped from 6 → 12 once fixtures landed, then 12 → 24 once multi-viewport
 * landed — 3 viewports × 3 components × ~2 scenarios is a realistic, legit
 * ask, but we still need a ceiling so a config bug can't blow up into 50
 * renders. Each render still costs a context spin-up + screenshot, so 24
 * remains a budget the typical agent loop won't notice. The color-scheme axis
 * (light/dark) multiplies into this count just like viewports do.
 */
export const MAX_RENDER_PAIRS = 24;

/**
 * Hard cap on native verify targets per call. Native is NOT web: web fans
 * MAX_RENDER_PAIRS renders out across parallel Playwright contexts, but native
 * drives ONE pinned simulator/emulator SERIALLY — every target is a navigate +
 * two-rAF ack + screenshot round-trip on the same device, so the same budget
 * would make the agent wait minutes (and likely time the tool call out). A
 * quarter of MAX_RENDER_PAIRS keeps a native verify under a realistic warm-loop
 * budget while still covering the common "a few changed screens × a scenario"
 * ask. Enforced by TRUNCATION (with a loud note in the response), never a
 * silent drop — see `selectNativeVerifyTargets`.
 */
export const MAX_NATIVE_RENDER_TARGETS = Math.max(1, Math.floor(MAX_RENDER_PAIRS / 4));

export class TooManyRenderPairsError extends Error {
  constructor(
    readonly requestedPairs: number,
    readonly limit: number,
  ) {
    super(
      `validity__verify would render ${requestedPairs} (component × scenario × fixture × viewport) ` +
        `pairs, which exceeds the ${limit}-render cap. Narrow the request: pass fewer scenarios, ` +
        `pass a smaller \`changedFiles\` list, trim fixtures in .validity/config.ts, shorten the ` +
        `scenario's \`viewports\` list, or trim \`dataStates\`.`,
    );
    this.name = 'TooManyRenderPairsError';
  }
}

export class UnknownScenarioError extends Error {
  constructor(
    readonly scenario: string,
    readonly available: string[],
  ) {
    super(
      `Scenario "${scenario}" is not defined in .validity/config.ts. ` +
        (available.length > 0
          ? `Available: ${available.map((s) => `"${s}"`).join(', ')}.`
          : 'No scenarios are defined.'),
    );
    this.name = 'UnknownScenarioError';
  }
}

/**
 * Stable, filesystem-safe id for a component, derived from its project-relative
 * path. Exported so the native verify path (which renders outside the Playwright
 * RenderFn) can mint the SAME ids the isolation path does — keeping run-meta and
 * the report's per-component grouping identical across web and native.
 */
export function componentIdFor(absolutePath: string, projectRoot: string): string {
  const rel = absolutePath.startsWith(projectRoot)
    ? absolutePath.slice(projectRoot.length + 1)
    : absolutePath;
  return slugify(rel.replace(/\.(tsx|jsx)$/, '')) || 'component';
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Basename of a path with the React extension stripped — the unit that a
 * spec's `targets.components` (component NAMES like `ContactForm`) match
 * against. Mirrors the matching used in `mapChangedFilesToSpecs` (specs.ts).
 */
function baseNameNoExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.(tsx|jsx|ts|js)$/, '');
}

/**
 * Order the spec's target components FIRST — in the spec's DECLARED order — and
 * pull in any target that wasn't among the changed files (so a spec's hard
 * checks always have their target component rendered). Targets are matched by
 * basename against `componentPaths` first; unresolved targets are looked up via
 * a project component scan.
 *
 * Two invariants the naive version broke:
 *   - DECLARED ORDER WINS. `componentPaths`/the project scan are SORTED
 *     (`discoverComponentFiles` ends with `found.sort()`), so filtering targets
 *     out of that list yields alphabetical order, not the spec's. A spec
 *     targeting `['UserPage', 'Avatar']` would render/bind `Avatar` first.
 *   - NO TARGET IS EVER DROPPED. The cap applies to the NON-target remainder
 *     only; a spec with more targets than `max` keeps all of them rather than
 *     silently losing the ones past the slice.
 */
function orderTargetsFirst(args: {
  componentPaths: string[];
  targetNames: string[];
  projectRoot: string;
  max: number;
}): string[] {
  const { componentPaths, targetNames, projectRoot, max } = args;
  if (targetNames.length === 0) return componentPaths;

  // Targets may be component NAMES ("ContactForm") OR project-relative PATHS
  // ("src/components/ContactForm.tsx") — `validity__plan` stores a path,
  // `spec_create` often stores a name. Normalize BOTH sides to basename-no-ext
  // so either form resolves to the same render.
  const targetKey = (t: string) => baseNameNoExt(t).toLowerCase();
  const targetSet = new Set(targetNames.map(targetKey));
  const have = new Set(componentPaths.map((p) => baseNameNoExt(p).toLowerCase()));

  // Try to resolve targets that aren't in the changed set via a project scan.
  const missing = targetNames.filter((t) => !have.has(targetKey(t)));
  const merged = [...componentPaths];
  if (missing.length > 0) {
    const want = new Set(missing.map(targetKey));
    for (const rel of discoverComponentFiles(projectRoot)) {
      if (want.has(baseNameNoExt(rel).toLowerCase())) {
        const abs = resolve(projectRoot, rel);
        if (!merged.includes(abs)) merged.push(abs);
      }
    }
  }

  const isTarget = (p: string): boolean => targetSet.has(baseNameNoExt(p).toLowerCase());

  // Rank each target path by its position in the spec's declared target list so
  // the render set follows the AUTHOR's order, not the sorted scan order. First
  // declaration wins on duplicates; a path with no rank (impossible under
  // `isTarget`, but cheap to be safe) sorts last. `.sort` is stable, so equal
  // ranks keep their `merged` order.
  const targetRank = new Map<string, number>();
  targetNames.forEach((t, i) => {
    const k = targetKey(t);
    if (!targetRank.has(k)) targetRank.set(k, i);
  });
  const rankOf = (p: string): number =>
    targetRank.get(baseNameNoExt(p).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;

  const targets = merged.filter(isTarget).sort((a, b) => rankOf(a) - rankOf(b));
  const rest = merged.filter((p) => !isTarget(p));
  // Every declared target survives: `rest` absorbs the cap. A spec with more
  // targets than `max` renders them all (and may legitimately trip
  // MAX_RENDER_PAIRS downstream — a loud failure beats a silent drop).
  return [...targets, ...rest].slice(0, Math.max(max, targets.length));
}

/**
 * Render the components relevant to the prompt under each requested scenario
 * and return their screenshots + source. Pure deterministic work: no LLM
 * calls. The caller (typically the MCP server) hands the rendered output
 * to the host LLM for scoring.
 *
 * Scenario semantics:
 *   - `scenarios: undefined` or `[]` → render the base configuration only
 *     (one render per component).
 *   - `scenarios: ["foo", "bar"]`    → render each component under each
 *     scenario; total pairs = components × scenarios.
 *
 * Throws `UnknownScenarioError` if a name isn't in `config.scenarios`, and
 * `TooManyRenderPairsError` if the resulting pair count exceeds
 * `MAX_RENDER_PAIRS`. Both surface clean MCP errors to the host.
 */
/**
 * Short human label for the render a check executed on — used when a criterion
 * ran on several variants (multi-attach: a fixtures-only target has no base
 * render, so its hard checks bind to EVERY fixture variant) so the merged
 * verdict can name which variants failed / couldn't execute. Prefers the
 * specific axis id; falls back to the render's slug (`componentId__variantSlug`).
 *
 * Exported for the native verify path (mcp-server), which multi-attaches the
 * same way and must label its variants identically — one wording for both
 * runtimes.
 */
export function variantLabel(r: ComponentRender): string {
  if (r.fixtureId) return `fixture "${r.fixtureId}"`;
  if (r.stackedFixtureIds && r.stackedFixtureIds.length > 0)
    return `fixtures [${r.stackedFixtureIds.join('+')}]`;
  if (r.scenarioId) return `scenario "${r.scenarioId}"`;
  if (r.dataState) return `${r.dataState} state`;
  return r.id;
}

/**
 * Fold the per-render verdicts a single criterion produced under multi-attach
 * into ONE verdict, conservatively — "never silently passed against the wrong
 * DOM":
 *   - any FAIL wins (carrying a failing render's per-check breakdown, prefixed
 *     with a tally naming the failing variants);
 *   - else any `unverifiable` execution beats pass (naming which variants
 *     couldn't execute);
 *   - else all-pass → pass with a `passed on N/N variants` note.
 * A single execution (the common non-fixture case) is returned VERBATIM, so the
 * base-render path is byte-identical to before multi-attach.
 *
 * Exported so native's roll-up (mcp-server `collectVerdictsFromComponents`)
 * folds multi-attached verdicts with THIS function rather than a second
 * implementation — the two runtimes must never disagree about whether a fail
 * on one variant sinks the criterion.
 */
export function mergeExecutedVerdicts(
  runs: Array<{ verdict: CriterionVerdict; label: string }>,
): CriterionVerdict {
  if (runs.length === 1) return runs[0]!.verdict;
  const total = runs.length;
  const plural = total === 1 ? '' : 's';
  const fails = runs.filter((r) => r.verdict.status === 'fail');
  const unverifiables = runs.filter((r) => r.verdict.status === 'unverifiable');
  const withNote = (carrier: CriterionVerdict, lead: string): CriterionVerdict => ({
    ...carrier,
    detail: carrier.detail ? `${lead} — ${carrier.detail}` : lead,
  });
  if (fails.length > 0) {
    return withNote(
      fails[0]!.verdict,
      `failed on ${fails.length}/${total} variant${plural} (${fails.map((r) => r.label).join(', ')})`,
    );
  }
  if (unverifiables.length > 0) {
    return withNote(
      unverifiables[0]!.verdict,
      `unverifiable on ${unverifiables.length}/${total} variant${plural} (${unverifiables
        .map((r) => r.label)
        .join(', ')})`,
    );
  }
  return withNote(runs[0]!.verdict, `passed on ${total}/${total} variant${plural}`);
}

/**
 * Roll the per-render mechanical verdicts up to one verdict per spec criterion.
 * Hard/property criteria take their verdict from whichever render(s) executed
 * their checks: a single base render binds once (verbatim), while a fixtures-only
 * target's checks bind to every variant and are merged conservatively by
 * `mergeExecutedVerdicts` (fail-wins). Soft criteria — and any hard criterion
 * whose checks didn't run (e.g. its target component wasn't rendered) — are
 * emitted as `unverifiable` placeholders so run-meta lists the whole contract;
 * the agent's `submit_report` overwrites the soft entries with its scoring.
 */
function collectCriterionVerdicts(spec: Spec, components: ComponentRender[]): CriterionVerdict[] {
  // criterion id → every render that executed it (in render order). Under
  // multi-attach a criterion can execute on several renders; merge below.
  const executions = new Map<string, Array<{ verdict: CriterionVerdict; label: string }>>();
  for (const c of components) {
    for (const v of c.criterionVerdicts ?? []) {
      const list = executions.get(v.id) ?? [];
      list.push({ verdict: v, label: variantLabel(c) });
      executions.set(v.id, list);
    }
  }
  // A render that THREW executes no checks — but "target component not among
  // the rendered set" sends the reader hunting for a targeting/selection bug
  // when the actual cause is a redbox they can read. Name the throw instead;
  // only fall back to the not-rendered wording when nothing errored.
  const errored = components.find((c) => c.renderError);
  const renderThrewNote = errored
    ? `checks did not execute (the ${errored.id} render threw: ${firstLine(errored.renderError!)})`
    : undefined;
  return spec.criteria.map((crit) => {
    const runs = executions.get(crit.id);
    if (runs && runs.length > 0) return mergeExecutedVerdicts(runs);
    // A dataState-conditioned criterion only ever binds to the matching forced
    // render — when that render doesn't exist (axis forced off, clone dropped
    // or impossible) the criterion is unverifiable, never silently passed
    // against the wrong (populated) state.
    const wantState = crit.dataState && crit.dataState !== 'populated' ? crit.dataState : undefined;
    return {
      id: crit.id,
      tier: crit.tier,
      status: 'unverifiable',
      detail:
        crit.tier === 'soft'
          ? 'soft criterion — scored by the host model from the screenshot'
          : wantState
            ? `checks did not execute (no '${wantState}' data-state render for the target — axis off or render budget)`
            : (renderThrewNote ??
              'checks did not execute (target component not among the rendered set)'),
    };
  });
}

/**
 * First meaningful line of a render error. Render errors carry a friendly
 * multi-paragraph preamble plus a stack; the verdict detail wants the one line
 * that names the throw (`navigation.setOptions is not a function`).
 */
function firstLine(renderError: string): string {
  const lines = renderError
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Prefer a line that reads like a thrown error over the boilerplate lead-in.
  const thrown = lines.find((l) => /(Error|TypeError|ReferenceError|is not a)/.test(l));
  return (thrown ?? lines[0] ?? 'render error').slice(0, 200);
}

/**
 * Append a taint reason to a verdict's detail using the executors'
 * `— tainted: <reasons>` convention (the human-readable carrier; the
 * `evidenceTaints` enum list is the machine-readable one).
 */
function appendTaintNote(detail: string | undefined, note: string): string {
  return detail ? `${detail} — tainted: ${note}` : `tainted: ${note}`;
}

/**
 * Direct (one-hop) imports of a component that resolve to a project file, so
 * the branch scan sees a `useUsers()` hook's `isLoading` even when the
 * component itself only destructures it. Bounded — a barrel import shouldn't
 * turn an informational hint into a tree walk.
 */
const MAX_SCANNED_IMPORTS = 20;

/** `readTsconfigPaths` without letting a malformed tsconfig break a hint. */
function tsconfigPathsSafe(projectRoot: string): TsconfigPathsMap | null {
  try {
    return readTsconfigPaths(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Gather the sources the data-state branch scan should read for one component:
 * its own source first, then its directly-imported project files. Best-effort —
 * an unreadable or unresolvable import is simply skipped (a missed hint costs
 * nothing; the demoting signal is the taint, not this).
 */
function sourcesForBranchScan(
  projectRoot: string,
  componentAbsolutePath: string,
  ownSource: string,
  paths: TsconfigPathsMap | null,
): string[] {
  const out = [ownSource];
  let scanned = 0;
  for (const specifier of scanImportSpecifiers(ownSource)) {
    if (scanned >= MAX_SCANNED_IMPORTS) break;
    let resolved: string | null = null;
    try {
      resolved = resolveImportSpecifier(specifier, componentAbsolutePath, paths);
    } catch {
      resolved = null;
    }
    if (!resolved || !resolved.startsWith(projectRoot)) continue;
    scanned += 1;
    const source = readSafe(resolved);
    if (source) out.push(source);
  }
  return out;
}

/**
 * The reason line stamped on a criterion demoted by the `data-state` taint.
 * Exported so the MCP surfaces (and the native hold) say the same sentence.
 */
export function dataStateTaintReason(state: DataState): string {
  return `${state} branch not rendered`;
}

/**
 * DATA-STATE COVERAGE TAINT (E2.1) — never a false green on a branch-dependent
 * criterion.
 *
 * A criterion conditioned on a non-`populated` `dataState` is a claim ABOUT the
 * loading/empty/error branch. If that branch never rendered — the clone was
 * dropped by the render budget, the axis was configured off, the forced render
 * threw, or the target simply produced no clone — then whatever the checks did
 * (or didn't) observe is not evidence about the branch, and the criterion must
 * read `unverifiable`.
 *
 * `data-state` is DEMOTING, so this can only ever move a verdict down the
 * lattice (`pass` → `unverifiable`; a `fail` stays `fail` — a failure observed
 * on the wrong premise is still not a pass). Mutates in place; the verdicts are
 * about to be persisted. Pure logic — unit-tested without a render.
 */
export function applyDataStateCoverageTaints(args: {
  criteria: Array<Pick<SpecCriterion, 'id' | 'dataState'>>;
  verdicts: CriterionVerdict[];
  /** The renders this run actually produced. */
  renders: Array<Pick<ComponentRender, 'dataState' | 'renderError'>>;
}): void {
  const wanted = new Map<string, DataState>();
  for (const c of args.criteria) {
    if (c.dataState && c.dataState !== 'populated') wanted.set(c.id, c.dataState);
  }
  if (wanted.size === 0) return;
  // A render that ERRORED produced no DOM to assert against, so it does not
  // count as coverage of its state — same posture as the render-threw note in
  // `collectCriterionVerdicts`.
  //
  // SCOPE, deliberately: `rendered` is state-global across the whole run, not
  // per component. A criterion carries a `dataState` but no component binding —
  // criteria are not component-scoped today — so there is no key on which to
  // ask "did THIS criterion's component render its error clone?". The
  // consequence: if component A produced an `error` clone and component B did
  // not, an `error` criterion is treated as covered and this taint stays quiet.
  // That is the honest reading of the data available, but it is a real gap, and
  // it is the reason to prefer per-component criteria if criteria ever gain a
  // component binding — at which point this set should become keyed by it.
  const rendered = new Set<DataState>();
  for (const r of args.renders) {
    if (r.dataState && !r.renderError) rendered.add(r.dataState);
  }
  for (const v of args.verdicts) {
    const state = wanted.get(v.id);
    if (!state || rendered.has(state)) continue;
    // Idempotent: a re-fold must not stack a second copy of the note.
    if (v.evidenceTaints?.includes('data-state')) continue;
    v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'data-state');
    v.detail = appendTaintNote(v.detail, `data-state: ${dataStateTaintReason(state)}`);
    v.status = applyEvidenceTaints(v.status, evidenceTaintsOf(v));
  }
}

export async function prepareVerification(
  args: PrepareVerificationArgs,
): Promise<PrepareVerificationResult> {
  const { projectRoot, config, render } = args;

  const requestedScenarios = args.scenarios ?? [];
  const availableScenarios = Object.keys(config.scenarios ?? {});
  for (const name of requestedScenarios) {
    if (!availableScenarios.includes(name)) {
      throw new UnknownScenarioError(name, availableScenarios);
    }
  }

  const maxComponents = args.maxComponents ?? 3;
  let componentPaths = selectComponentsToRender({
    prompt: args.prompt,
    changedFiles: args.changedFiles,
    projectRoot,
    max: maxComponents,
  });

  // When the spec names target components, render them FIRST (and pull in any
  // that weren't changed) so its hard/property checks run against the right
  // DOM — not whatever component happened to change first.
  componentPaths = orderTargetsFirst({
    componentPaths,
    targetNames: args.spec?.targets?.components ?? [],
    projectRoot,
    max: maxComponents,
  });

  const runId = args.runId ?? newRunId();
  const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
  const runMetaPath = runMetaPathFor(projectRoot, runId);

  // Run-level `expect.command` criteria (A5): executed ONCE per verify run on
  // the host at projectRoot — never inside a render. Empty list (no spec / no
  // command criteria) executes nothing.
  const runCommandCriteria = (): Promise<CriterionVerdict[]> =>
    args.spec
      ? executeCommandCriteria({
          criteria: args.spec.criteria.filter(criterionUsesCommandChecks),
          commands: config.commands,
          projectRoot,
          timeoutMs: config.commandTimeoutMs,
          runner: args.commandRunner,
        })
      : Promise.resolve([]);

  // Shared run-meta write for the main path AND the component-less early
  // return below — one construction site so the persisted verdict/signedOff
  // can never disagree between the two.
  // Declared BEFORE writeRunMeta (which closes over it): the early
  // component-less return below calls writeRunMeta before the data-state
  // axis populates this, and a TDZ read would throw.
  const droppedDataStates: Array<{ componentId: string; dataState: DataState }> = [];
  const writeRunMeta = (
    components: ComponentRender[],
    sources: Record<string, string>,
    criterionVerdicts: CriterionVerdict[],
    /**
     * The render session's environment record. Absent on the component-less
     * early return below — no session ran, so there is nothing to describe, and
     * writing a fabricated "web / cold" record would claim a sandbox boot that
     * never happened.
     */
    environment?: RunEnvironment,
  ): void => {
    // Per-criterion regression deltas vs. the previous run of the same spec.
    // Computed here (not in submit_report) so the verify response can surface
    // "AC-3 regressed" immediately — the agent doesn't have to wait for scoring.
    // HARD/PROPERTY tiers ONLY: soft criteria are `unverifiable` placeholders at
    // verify time and would read as a spurious `regressed` against the previous
    // (already-scored) run. DISPLAY-ONLY — never feeds the gate.
    const mechVerdicts = criterionVerdicts.filter(
      (v) => v.tier === 'hard' || v.tier === 'property',
    );
    const regressionDeltas: RegressionDelta[] | undefined =
      args.spec && args.previousVerdicts !== undefined
        ? computeRegressionDeltas(mechVerdicts, args.previousVerdicts)
        : undefined;

    // The verdicts that land on run-meta (spec-derived this run, else whatever the
    // caller passed). Both the persisted list and the rolled-up verdict/signedOff
    // are computed from this same value so they can never disagree.
    const finalVerdicts = criterionVerdicts.length > 0 ? criterionVerdicts : args.criterionVerdicts;

    const reportCfg = resolveReportConfig(config.report);
    const meta: RunMeta = {
      runId,
      createdAt: new Date().toISOString(),
      mode: 'isolation',
      prompt: args.prompt,
      scenarios: requestedScenarios,
      components,
      componentSources: sources,
      // Diff is collected per run so submit_report can render code changes
      // alongside the screenshots without re-shelling git later.
      diff: reportCfg.enabled
        ? collectDiff({ projectRoot, changedFiles: args.changedFiles })
        : { files: [] },
      report: reportCfg,
      setup: args.setupResult,
      // The render session's environment (toolchain, dev server, app-manifest
      // merge, dep pre-scan) — ONE record for the session, not one copy per
      // render. Omitted entirely when no session ran.
      ...(environment ? { environment } : {}),
      git: collectGitInfo(projectRoot),
      // Local-vs-CI provenance (display-only) — classified from env at write time.
      origin: detectRunOrigin(),
      planId: args.planId,
      specId: args.specId ?? args.spec?.id,
      specVersion: args.specVersion ?? args.spec?.version,
      specHash: args.specHash ?? args.spec?.hash,
      // Display-only provenance (B1): planned ⇔ a plan or spec was in scope.
      planned: Boolean(args.planId ?? args.specId ?? args.spec?.id),
      // Which MCP session ran this verify (A3) — submit_report compares it
      // against its own fingerprint to flag same-session (self) scoring.
      sessionFingerprint: args.sessionFingerprint,
      // Coverage floor at verify time (C1) — the submit-time report shows the
      // same number the gate ran against even if config changes in between.
      coverageFloorPercent: config.coverageFloorPercent,
      ...(droppedDataStates.length > 0 ? { droppedDataStates: [...droppedDataStates] } : {}),
      criterionVerdicts: finalVerdicts,
      // Loop gate: roll up the verify-time verdict and compute the sign-off stop
      // signal (joining with the spec's severity/threshold when in scope). Only
      // set when there are verdicts — a non-spec verify carries neither.
      verdict:
        finalVerdicts && finalVerdicts.length > 0
          ? rollupCriterionVerdicts(finalVerdicts)
          : undefined,
      signedOff:
        finalVerdicts && finalVerdicts.length > 0
          ? computeSignedOff(toSignOffCriteria(finalVerdicts, args.spec))
          : undefined,
      regressionDeltas,
    };
    try {
      // Record each evidence screenshot's sha256 so byte-identity (soft-score
      // carry-forward / renderUnchanged) survives the run's PNGs being pruned.
      stampScreenshotHashes(meta.components);
      writeFileAtomic(runMetaPath, JSON.stringify(meta, null, 2));
      if (meta.specId) {
        indexRunForSpec(projectRoot, meta, { historyCommitted: config.historyCommitted });
      }
    } catch {
      // Non-fatal: the verify response still works; submit_report will fail
      // gracefully with a clear error when it can't read the file.
    }
  };

  if (componentPaths.length === 0) {
    // A component-less run (no changed files matched) still executes the
    // spec's run-level command checks — a typecheck-only spec is a legitimate
    // CI wedge — and persists the merged verdicts. Render-dependent criteria
    // stay "checks did not execute" placeholders: unverifiable, never pass.
    if (args.spec?.criteria.some(criterionUsesCommandChecks)) {
      const commandVerdicts = await runCommandCriteria();
      writeRunMeta(
        [],
        {},
        overlayCommandVerdicts(collectCriterionVerdicts(args.spec, []), commandVerdicts),
      );
    }
    return {
      runId,
      components: [],
      componentSources: {},
      pairCount: 0,
      runMetaPath,
    };
  }

  // Either render once per component (base only) or fan out across scenarios.
  // Per-component override: if the component has fixtures defined in the
  // config, render once per fixture (and IGNORE the requested scenarios for
  // that component). Fixtures are component-scoped state; scenarios are
  // global (auth/network) state. Mixing both per render multiplies the
  // (component × scenario × fixture) cube and rarely produces a meaningful
  // distinction — keep the math simple and predictable.
  const scenarioIds: Array<string | undefined> =
    requestedScenarios.length === 0 ? [undefined] : requestedScenarios;

  const cachedComponents = config.components ?? {};
  let renderRequests: RenderRequestSpec[] = [];
  const sources: Record<string, string> = {};
  const warnings: string[] = [];

  for (const abs of componentPaths) {
    const rel = abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
    const id = componentIdFor(abs, projectRoot);
    const entry = cachedComponents[rel] ?? cachedComponents[abs];
    const fixtures = entry?.fixtures;
    const fixtureNames = fixtures ? Object.keys(fixtures) : [];

    sources[id] = readSafe(abs);

    // Helper: viewports for a given scenario (or [undefined] for "single
    // default-viewport render"). Undefined viewport entry means "let the
    // sandbox use its built-in 1280×800 default and don't add a viewport
    // suffix to the slug" — preserves existing screenshot filenames when
    // nobody has opted into multi-viewport.
    const viewportsForScenario = (
      scenarioId: string | undefined,
    ): Array<ViewportSpec | undefined> => {
      if (!scenarioId) return [undefined];
      const list = config.scenarios?.[scenarioId]?.viewports;
      if (!list || list.length === 0) return [undefined];
      return list.map((v) => resolveViewport(v));
    };

    if (fixtureNames.length > 0) {
      if (requestedScenarios.length > 0) {
        warnings.push(fixtureScenarioPrecedenceWarning(id, requestedScenarios));
      }
      // Decide stacked vs per-fixture. We can stack when:
      //   - There are 2+ fixtures (1 fixture stacked = same as 1 fixture rendered alone)
      //   - None of the fixtures has a `play` function — play actions on
      //     siblings would interfere (clicking a button in one fixture
      //     might trigger handlers in another's identical-looking copy).
      const anyPlay = fixtureNames.some((n) => typeof fixtures![n]?.play === 'function');
      const canStack = fixtureNames.length >= 2 && !anyPlay;

      // Fixture-driven components don't fan out across scenarios (see the
      // existing decision above), so viewports here come from the FIRST
      // requested scenario only. In practice, fixtures + viewports + scenarios
      // is rare enough that we keep this simple: if you want a fixture
      // rendered at multiple viewports, define them in one scenario's
      // `viewports` list and pass that scenario.
      const scenarioForViewports = requestedScenarios[0];
      const viewports = viewportsForScenario(scenarioForViewports);

      if (canStack) {
        for (const viewport of viewports) {
          renderRequests.push({
            componentAbsolutePath: abs,
            componentId: id,
            stackedFixtureIds: fixtureNames,
            viewport,
          });
        }
      } else {
        // Per-fixture path: one render per named fixture (current behavior).
        // Triggers when a fixture has a play function or there's only one.
        for (const fxName of fixtureNames) {
          const fx = fixtures![fxName]!;
          for (const viewport of viewports) {
            renderRequests.push({
              componentAbsolutePath: abs,
              componentId: id,
              props: fx.props ?? {},
              fixtureId: fxName,
              play: fx.play,
              viewport,
            });
          }
        }
      }
      continue;
    }

    // No fixtures → fall through to scenario fanout (or single base render).
    let props = entry?.props;
    if (!props) {
      try {
        const extracted = extractPropsType(abs);
        // Agent-driven mode: no synthesized mock props. If the component
        // requires props, the user supplies them via .validity/config.ts;
        // otherwise we render with `{}` and the component falls back to its
        // own defaults (or fails loudly, which is the right signal).
        props = extracted.props.length === 0 ? {} : {};
      } catch {
        props = {};
      }
    }

    for (const scenarioId of scenarioIds) {
      const scenarioPlay = scenarioId
        ? (config.scenarios?.[scenarioId]?.play as RenderRequestSpec['play'] | undefined)
        : undefined;
      for (const viewport of viewportsForScenario(scenarioId)) {
        renderRequests.push({
          componentAbsolutePath: abs,
          componentId: id,
          props,
          scenarioId,
          play: scenarioPlay,
          viewport,
        });
      }
    }
  }

  // Color-scheme (theme) axis: multiply every request across the resolved
  // schemes (light/dark) so a "looks right in both themes" criterion has both
  // screenshots to score. Default-off (empty schemes → unchanged single render,
  // no colorScheme applied). Each themed clone gets its own variant slug +
  // baseline. Done BEFORE the criteriaChecks attachment below, so the
  // deterministic checks bind to exactly one (the first, light) base render and
  // run once — not once per theme.
  const colorSchemes = resolveColorSchemes(config, args.spec);
  if (colorSchemes.length > 0) {
    renderRequests = renderRequests.flatMap((r) =>
      colorSchemes.map((scheme) => ({ ...r, colorScheme: scheme })),
    );
  }

  // Data-state axis (A2): ADDITIVE clones, one per (component × required
  // state), minted from the component's canonical base render — never
  // multiplied across scenarios/fixtures/viewports/themes (degraded-state
  // coverage doesn't need the full matrix and the cap must stay predictable).
  // A clone carries NO play: play under a hung/forced network is undefined
  // behavior we refuse to enter.
  const requiredStates = resolveDataStates(config, args.spec);
  const axisOff = config.dataStates !== undefined && config.dataStates.length === 0;
  const hasStateClone = (abs: string, state: DataState): boolean =>
    renderRequests.some((r) => r.componentAbsolutePath === abs && r.dataState === state);
  const cloneFor = (abs: string, state: DataState): RenderRequestSpec | undefined => {
    const sameComponent = (r: RenderRequestSpec): boolean =>
      r.componentAbsolutePath === abs && !r.dataState;
    const base =
      renderRequests.find(
        (r) =>
          sameComponent(r) && !r.scenarioId && !r.fixtureId && !r.viewport && !r.stackedFixtureIds,
      ) ??
      // Fixtures-only / scenario-only component: clone from its first request
      // (props kept, every other axis stripped) so the state is still covered.
      renderRequests.find(sameComponent);
    if (!base) return undefined;
    return {
      componentAbsolutePath: base.componentAbsolutePath,
      componentId: base.componentId,
      props: base.props,
      dataState: state,
    };
  };
  // Mandatory clones (criterion/conditions/config-driven) — count toward the
  // render cap below and can throw TooManyRenderPairsError (loud; the agent
  // narrows the request).
  for (const abs of componentPaths) {
    for (const state of requiredStates) {
      if (hasStateClone(abs, state)) continue;
      const clone = cloneFor(abs, state);
      if (clone) renderRequests.push(clone);
    }
  }
  // Default policy: populated + `empty` minimum for components whose source
  // looks data-dependent. BEST-EFFORT — added only under the cap, dropped
  // loudly (droppedDataStates) otherwise. Dropping can only reduce coverage,
  // never flip a verdict: policy clones carry no checks.
  if (!axisOff && !requiredStates.includes('empty')) {
    for (const abs of componentPaths) {
      if (!componentLooksDataDependent(sources[componentIdFor(abs, projectRoot)] ?? '')) continue;
      if (hasStateClone(abs, 'empty')) continue;
      const clone = cloneFor(abs, 'empty');
      if (!clone) continue;
      if (renderRequests.length < MAX_RENDER_PAIRS) {
        renderRequests.push(clone);
      } else {
        droppedDataStates.push({ componentId: clone.componentId, dataState: 'empty' });
      }
    }
  }

  const pairCount = renderRequests.length;
  if (pairCount > MAX_RENDER_PAIRS) {
    throw new TooManyRenderPairsError(pairCount, MAX_RENDER_PAIRS);
  }

  // Spec hard/property checks: attach the criteria that carry a `checks` block
  // to the render(s) whose DOM the sandbox should assert against, per the
  // criterion's dataState bucket. When the spec names targets, bind to the
  // target — NOT blindly renderRequests[0], which may be an unrelated changed
  // component. Soft criteria are LLM-scored and never attached.
  //
  // BINDING SHAPE — single canonical render preferred, all-variants fallback:
  //   - 'populated' bucket: the canonical base render (no scenario / fixture /
  //     viewport / dataState) of the target is the single bind, UNCHANGED for
  //     every component that produces one.
  //   - A fixtures-only (or scenario/viewport-only) target produces NO base
  //     render — every request carries a fixtureId/stackedFixtureIds. Rather
  //     than leave the checks unattached (which surfaced the exact a11y/console
  //     gates as `unverifiable — target not among the rendered set`, making
  //     hard gating impossible precisely where fixtures drive the component),
  //     fall back to attaching to EVERY no-dataState variant of the target.
  //     collectCriterionVerdicts then merges the per-variant verdicts
  //     conservatively (fail-wins), so a check still gates and never silently
  //     passes against a DOM that wasn't rendered.
  //   - Non-'populated' buckets bind to the matching forced dataState clone(s);
  //     a clone always exists (cloneFor mints one even for fixtures-only
  //     components) when the axis is on, so this keeps the state-scoped binding.
  //   - No-targets fallback stays analogous: the single base render if one
  //     exists, else all no-dataState variants of the component renderRequests[0]
  //     belongs to (the old renderRequests[0] fallback, widened to that
  //     component's variants so a fixtures-only lone target still gates).
  //
  // Command criteria are excluded from render attachment — they execute once
  // per RUN (below, after the render), not per render; the executor stub would
  // only mint `unverifiable` if one leaked into the sandbox.
  const checkCriteria =
    args.spec?.criteria.filter(
      (c) => c.checks && c.checks.length > 0 && !criterionUsesCommandChecks(c),
    ) ?? [];
  if (checkCriteria.length > 0) {
    const isBaseRender = (r: RenderRequestSpec): boolean =>
      !r.scenarioId && !r.fixtureId && !r.viewport && !r.stackedFixtureIds && !r.dataState;
    const targetNames = args.spec?.targets?.components ?? [];
    // Targets may be names or paths — normalize to basename-no-ext (see
    // orderTargetsFirst) so the binding matches the rendered component either way.
    const targetSet = new Set(targetNames.map((t) => baseNameNoExt(t).toLowerCase()));
    const matchesTarget = (r: RenderRequestSpec): boolean =>
      targetSet.size === 0 || targetSet.has(baseNameNoExt(r.componentAbsolutePath).toLowerCase());

    // Partition by the criterion's dataState condition: checks bind ONLY to the
    // matching-state render(s), so a populated-content criterion can never pass
    // against an empty render (and vice versa). A partition whose render is
    // missing stays unattached — collectCriterionVerdicts surfaces those
    // criteria `unverifiable`, never pass.
    const byState = new Map<DataState, SpecCriterion[]>();
    for (const c of checkCriteria) {
      const state = c.dataState ?? 'populated';
      const list = byState.get(state) ?? [];
      list.push(c);
      byState.set(state, list);
    }
    for (const [state, criteria] of byState) {
      let bound: RenderRequestSpec[];
      if (state === 'populated') {
        // Walk the spec's targets in DECLARED order and bind to the first one
        // that actually has a base render. The old `find(isBaseRender &&
        // matchesTarget)` bound to the first base render matching ANY target —
        // and `renderRequests` follows render order, which is sorted — so a
        // multi-target spec pointed its page-wide assertions at whichever
        // target sorted first (typically a leaf atom rendered with `{}` props),
        // leaving the real subject unverified. Spec order is author intent.
        // Identical to the old behavior for single-target specs.
        let base: RenderRequestSpec | undefined;
        if (targetSet.size > 0) {
          for (const name of targetNames) {
            const key = baseNameNoExt(name).toLowerCase();
            base = renderRequests.find(
              (r) =>
                isBaseRender(r) && baseNameNoExt(r.componentAbsolutePath).toLowerCase() === key,
            );
            if (base) break;
          }
        } else {
          base = renderRequests.find(isBaseRender);
        }
        if (base) {
          bound = [base]; // canonical single-bind — unchanged
        } else if (targetSet.size > 0) {
          // Fixtures-only target: no base render → all its no-dataState variants.
          bound = renderRequests.filter((r) => !r.dataState && matchesTarget(r));
        } else {
          // No targets AND no base render anywhere: widen the old
          // renderRequests[0] fallback to all no-dataState variants of the
          // component that first request belongs to.
          const anchor = renderRequests[0];
          bound = anchor
            ? renderRequests.filter(
                (r) => !r.dataState && r.componentAbsolutePath === anchor.componentAbsolutePath,
              )
            : [];
        }
      } else {
        // Forced dataState clone(s) for this state — usually one per target;
        // attach to every match so a multi-target spec gates each target's clone.
        bound = renderRequests.filter((r) => r.dataState === state && matchesTarget(r));
      }
      for (const render of bound) {
        // Buckets are disjoint per render (a render has one dataState or none),
        // but accumulate defensively so no earlier attachment is clobbered.
        render.criteriaChecks = [...(render.criteriaChecks ?? []), ...criteria];
      }
    }
  }

  // Unlock the screenshot short-circuit ONLY when the spec exists and has zero
  // soft criteria: with no soft tier, no render's pixels are needed for host
  // scoring, so a definitively-red render (errored / all mechanical failed) can
  // skip the costly full-page screenshot. With soft criteria — or no spec at
  // all (plain browse/catalog) — every screenshot is evidence, so we leave the
  // flag at its safe default (render kept). See capture.ts short-circuit.
  const hasSoftCriteria = args.spec ? args.spec.criteria.some((c) => c.tier === 'soft') : true;
  for (const r of renderRequests) r.softCriteriaNeedRender = hasSoftCriteria;

  // The renderer hands back two things: the per-element renders, and ONE
  // environment record for the session they were captured in (see RenderResult).
  const { renders: components, environment } = await render({
    projectRoot,
    config,
    screenshotsDir,
    components: renderRequests,
  });

  // Run-level command checks (A5): executed AFTER the render completes,
  // sequentially — never concurrent with Playwright, so tsc/vitest CPU load
  // can't inflate `expect.performance` timings mid-render.
  const commandVerdicts = await runCommandCriteria();

  // Roll up mechanical verdicts (hard/property) from the renders, then append
  // soft criteria as `unverifiable` placeholders so run-meta lists the whole
  // contract — submit_report overwrites the soft entries with the agent's
  // scoring. Kept separate so the report can show "proven" vs "scored".
  // Command criteria fall out of the roll-up as "checks did not execute"
  // placeholders, which the overlay replaces (never upgrading a collision).
  const criterionVerdicts: CriterionVerdict[] = args.spec
    ? overlayCommandVerdicts(collectCriterionVerdicts(args.spec, components), commandVerdicts)
    : [];

  // DATA-STATE COVERAGE (E2.1): a criterion conditioned on a non-populated
  // state whose render never happened reads `unverifiable` + `data-state`,
  // never pass. Applied BEFORE the other taints so the note ordering on a
  // multiply-tainted verdict is stable (coverage, then wrapper/dep-scan).
  if (args.spec) {
    applyDataStateCoverageTaints({
      criteria: args.spec.criteria,
      verdicts: criterionVerdicts,
      renders: components,
    });
  }

  // WRAPPER TAINT (A3/A1): a degraded wrapper clone (passthrough fallback, or
  // one the fidelity analyzer found missing providers) means the pixels may
  // look right for the wrong reason — taint the SOFT criteria (the tier scored
  // from those pixels). Hard/property checks assert concrete DOM facts that
  // hold or don't regardless of provider fidelity, so they stay untainted. The
  // taint is sticky: submit_report's clamp keeps a scored "pass" at
  // `unverifiable`.
  if (args.setupResult?.wrapperFidelity?.status === 'degraded') {
    const fidelity = args.setupResult.wrapperFidelity;
    // Name the exact fix when the analyzer found it — the remedy is the SETUP
    // (add the provider to .validity/wrapper.user.tsx), not the component.
    const why =
      fidelity.missingProviders.length > 0
        ? `missing ${fidelity.missingProviders.join(', ')}`
        : (fidelity.detail ?? 'degraded clone');
    for (const v of criterionVerdicts) {
      if (v.tier !== 'soft') continue;
      v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'wrapper');
      v.detail = appendTaintNote(v.detail, `wrapper: ${why}`);
    }
  }

  // DEP-SCAN ABORT: the sandbox reported that its dependency pre-scan died
  // (a stray unresolvable import). Deps were then discovered lazily, and ANY
  // capture in the session may have raced a re-optimize reload that swapped
  // the React instance under a mounting tree — there is no way to attribute
  // which renders were corrupted, so EVERY verdict's evidence is unconfirmed:
  // taint all tiers (demoting — a pass clamps to `unverifiable`; `fail` stays
  // `fail`). The note names the offending import so the accumulation of
  // unverifiable verdicts points at the one-file fix instead of reading as a
  // product regression.
  // ONE session-level fact, read from ONE place. (It used to be recovered by
  // `find()`-ing across the renders, because the renderer copied it onto each
  // of them; the legacy per-render field survives only for run-metas written
  // before the environment channel — see ComponentRender.depScanFailure.)
  const depScanFailure = environment?.depScanFailure;
  if (depScanFailure) {
    for (const v of criterionVerdicts) {
      v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'dep-scan');
      v.detail = appendTaintNote(v.detail, `dep-scan: ${depScanFailure}`);
    }
  }

  // SYNTHETIC-DATA PROVENANCE (A3, never demoting): record when a verdict's
  // evidence render consumed data the permissive proxy fabricated (unmatched
  // fetches). Hard/property verdicts are stamped when THEIR executing render
  // was synthetic-fed (same object references as the render's verdicts); soft
  // criteria are scored from any of the run's screenshots, so any
  // synthetic-fed render taints them. Provenance-only — `applyEvidenceTaints`
  // never demotes on it.
  if (args.spec) {
    const syntheticFed = components.filter((c) => (c.unmatchedUrls?.length ?? 0) > 0);
    if (syntheticFed.length > 0) {
      const executedOnSynthetic = new Set<string>();
      for (const c of syntheticFed) {
        for (const v of c.criterionVerdicts ?? []) executedOnSynthetic.add(v.id);
      }
      for (const v of criterionVerdicts) {
        if (v.tier === 'soft' || executedOnSynthetic.has(v.id)) {
          v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'synthetic-data');
        }
      }
    }
  }

  writeRunMeta(components, sources, criterionVerdicts, environment);

  // COVERAGE HINTS (E2.1, informational): branches the spec never conditions a
  // criterion on. Spec-scoped on purpose — a spec-less browse verify has no
  // contract to be short of, so every hint there would be noise.
  // One tsconfig read for the whole scan, not one per component.
  const scanPaths = args.spec ? tsconfigPathsSafe(projectRoot) : null;
  const dataStateHints = args.spec
    ? buildDataStateHints({
        components: componentPaths.map((abs) => {
          const id = componentIdFor(abs, projectRoot);
          return {
            component: id,
            sources: sourcesForBranchScan(projectRoot, abs, sources[id] ?? '', scanPaths),
          };
        }),
        coveredStates: [
          ...args.spec.criteria.flatMap((c) => (c.dataState ? [c.dataState] : [])),
          ...(args.spec.conditions?.dataStates ?? []),
        ],
      })
    : [];

  return {
    runId,
    components,
    componentSources: sources,
    pairCount,
    runMetaPath,
    ...(droppedDataStates.length > 0 ? { droppedDataStates } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(dataStateHints.length > 0 ? { dataStateHints } : {}),
  };
}

/**
 * URL-mode counterpart to prepareVerification's run-meta write. The MCP
 * server's URL handler captures pages via Playwright (no synthetic Vite
 * sandbox) and then calls this to persist the same shape `submit_report`
 * already knows how to read. Diff is collected the same way as isolation
 * mode so the report can show code changes alongside the page screenshots.
 */
export interface WriteUrlRunMetaArgs {
  projectRoot: string;
  runId: string;
  prompt: string;
  scenarios: string[];
  pages: PageRender[];
  /** Forwarded to `collectDiff`. Same semantics as in prepareVerification. */
  changedFiles?: string[];
  /** Resolved report config (from .validity/config.ts). */
  reportConfig: { enabled: boolean; brand: 'validity' | 'none' };
  /** Plan id from `validity__plan`. Threaded into run-meta for submit_report. */
  planId?: string;
  /** Spec provenance (when verifying against a frozen spec). */
  specId?: string;
  specVersion?: number;
  specHash?: string;
  criterionVerdicts?: CriterionVerdict[];
  /**
   * Verdicts from the previous run of the same spec, for regression-delta
   * computation. Absent on first run / non-spec verifies.
   */
  previousVerdicts?: CriterionVerdict[];
  /** MCP session fingerprint that ran this verify (A3). Threaded by tracks. */
  sessionFingerprint?: string;
  /** Coverage floor stamped from config at verify time (C1). Threaded by tracks. */
  coverageFloorPercent?: number;
  /** Whether `.validity/history/` writes are enabled (F2). Threaded by tracks. */
  historyCommitted?: boolean;
}

export function writeUrlRunMeta(args: WriteUrlRunMetaArgs): string {
  // HARD/PROPERTY tiers only — see prepareVerification. DISPLAY-ONLY signal.
  const regressionDeltas =
    args.specId && args.previousVerdicts !== undefined && args.criterionVerdicts
      ? computeRegressionDeltas(
          args.criterionVerdicts.filter((v) => v.tier === 'hard' || v.tier === 'property'),
          args.previousVerdicts,
        )
      : undefined;
  const meta: RunMeta = {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    mode: 'url',
    prompt: args.prompt,
    scenarios: args.scenarios,
    pages: args.pages,
    diff: args.reportConfig.enabled
      ? collectDiff({ projectRoot: args.projectRoot, changedFiles: args.changedFiles })
      : { files: [] },
    report: args.reportConfig,
    git: collectGitInfo(args.projectRoot),
    // Local-vs-CI provenance (display-only) — classified from env at write time.
    origin: detectRunOrigin(),
    planId: args.planId,
    specId: args.specId,
    specVersion: args.specVersion,
    specHash: args.specHash,
    // Display-only provenance (B1): planned ⇔ a plan or spec id was in scope.
    planned: Boolean(args.planId ?? args.specId),
    // Which MCP session ran this verify (A3) — see prepareVerification.
    sessionFingerprint: args.sessionFingerprint,
    // Coverage floor at verify time (C1) — see prepareVerification.
    coverageFloorPercent: args.coverageFloorPercent,
    criterionVerdicts: args.criterionVerdicts,
    // No full Spec object in scope here (these writers carry only id/version/hash),
    // so sign-off treats every criterion as blocking — conservative, never a
    // false green. Only set when there are verdicts to roll up.
    verdict:
      args.criterionVerdicts && args.criterionVerdicts.length > 0
        ? rollupCriterionVerdicts(args.criterionVerdicts)
        : undefined,
    signedOff:
      args.criterionVerdicts && args.criterionVerdicts.length > 0
        ? computeSignedOff(toSignOffCriteria(args.criterionVerdicts))
        : undefined,
    regressionDeltas,
  };
  const runMetaPath = runMetaPathFor(args.projectRoot, args.runId);
  try {
    writeFileAtomic(runMetaPath, JSON.stringify(meta, null, 2));
    if (meta.specId) {
      indexRunForSpec(args.projectRoot, meta, { historyCommitted: args.historyCommitted });
    }
  } catch {
    // Same as isolation mode: non-fatal. submit_report will surface a
    // readable error if the file can't be loaded.
  }
  return runMetaPath;
}

/**
 * Native-mode counterpart to prepareVerification's run-meta write. The native
 * verify path (server.ts) drives the simulator itself — outside the Playwright
 * RenderFn — so it builds `ComponentRender[]` by hand (one per native capture,
 * with the structured render status mapped onto `renderError` and the
 * agent-device a11y tree on `a11ySnapshot`) and calls this to persist the SAME
 * `mode: 'isolation'` shape `submit_report` already reads. That keeps
 * submit_report UNMODIFIED across web and native: the report renderer only
 * knows about isolation `components` + `componentSources`, and native screenshots
 * embed as data-URLs exactly like web ones. Diff/git/plan are collected the same
 * way as the other two writers.
 */
export interface WriteNativeRunMetaArgs {
  projectRoot: string;
  runId: string;
  prompt: string;
  scenarios: string[];
  /** Pre-rendered native captures (screenshotPath/renderError/a11ySnapshot set). */
  components: ComponentRender[];
  /** Source code for each rendered component id (behavioral-criterion evidence). */
  componentSources: Record<string, string>;
  /** Forwarded to `collectDiff`. Same semantics as in prepareVerification. */
  changedFiles?: string[];
  /** Device provenance for this capture — see {@link RunMeta.nativeDevice}. */
  nativeDevice?: RunMeta['nativeDevice'];
  /** Resolved report config (from .validity/config.ts). */
  reportConfig: { enabled: boolean; brand: 'validity' | 'none' };
  /** Plan id from `validity__plan`. Threaded into run-meta for submit_report. */
  planId?: string;
  /** Spec provenance (when verifying against a frozen spec). */
  specId?: string;
  specVersion?: number;
  specHash?: string;
  criterionVerdicts?: CriterionVerdict[];
  /**
   * Verdicts from the previous run of the same spec, for regression-delta
   * computation. Absent on first run / non-spec verifies.
   */
  previousVerdicts?: CriterionVerdict[];
  /** MCP session fingerprint that ran this verify (A3). Threaded by tracks. */
  sessionFingerprint?: string;
  /** Coverage floor stamped from config at verify time (C1). Threaded by tracks. */
  coverageFloorPercent?: number;
  /** Whether `.validity/history/` writes are enabled (F2). Threaded by tracks. */
  historyCommitted?: boolean;
}

export function writeNativeRunMeta(args: WriteNativeRunMetaArgs): string {
  // HARD/PROPERTY tiers only — see prepareVerification. DISPLAY-ONLY signal.
  const regressionDeltas =
    args.specId && args.previousVerdicts !== undefined && args.criterionVerdicts
      ? computeRegressionDeltas(
          args.criterionVerdicts.filter((v) => v.tier === 'hard' || v.tier === 'property'),
          args.previousVerdicts,
        )
      : undefined;
  const meta: RunMeta = {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    // Native carries the same `components` + `componentSources` payload the
    // isolation shape does (see the doc comment above), but labels the mode
    // `'native'` (C1) so readers can distinguish the source. The only branching
    // reader today is server.ts's `'url'`-vs-else check, which treats 'native'
    // like 'isolation'. Old native run-metas keep the isolation label — accepted.
    mode: 'native',
    ...(args.nativeDevice ? { nativeDevice: args.nativeDevice } : {}),
    prompt: args.prompt,
    scenarios: args.scenarios,
    components: args.components,
    componentSources: args.componentSources,
    diff: args.reportConfig.enabled
      ? collectDiff({ projectRoot: args.projectRoot, changedFiles: args.changedFiles })
      : { files: [] },
    report: args.reportConfig,
    git: collectGitInfo(args.projectRoot),
    // Local-vs-CI provenance (display-only) — classified from env at write time.
    origin: detectRunOrigin(),
    planId: args.planId,
    specId: args.specId,
    specVersion: args.specVersion,
    specHash: args.specHash,
    // Display-only provenance (B1): planned ⇔ a plan or spec id was in scope.
    planned: Boolean(args.planId ?? args.specId),
    // Which MCP session ran this verify (A3) — see prepareVerification.
    sessionFingerprint: args.sessionFingerprint,
    // Coverage floor at verify time (C1) — see prepareVerification.
    coverageFloorPercent: args.coverageFloorPercent,
    criterionVerdicts: args.criterionVerdicts,
    // No full Spec object in scope here (these writers carry only id/version/hash),
    // so sign-off treats every criterion as blocking — conservative, never a
    // false green. Only set when there are verdicts to roll up.
    verdict:
      args.criterionVerdicts && args.criterionVerdicts.length > 0
        ? rollupCriterionVerdicts(args.criterionVerdicts)
        : undefined,
    signedOff:
      args.criterionVerdicts && args.criterionVerdicts.length > 0
        ? computeSignedOff(toSignOffCriteria(args.criterionVerdicts))
        : undefined,
    regressionDeltas,
  };
  const runMetaPath = runMetaPathFor(args.projectRoot, args.runId);
  try {
    // Parity with prepareVerification's writer: record evidence-screenshot
    // hashes so byte-identity survives run-dir pruning.
    stampScreenshotHashes(meta.components);
    writeFileAtomic(runMetaPath, JSON.stringify(meta, null, 2));
    if (meta.specId) {
      indexRunForSpec(args.projectRoot, meta, { historyCommitted: args.historyCommitted });
    }
  } catch {
    // Same as the other writers: non-fatal. submit_report surfaces a readable
    // error if the file can't be loaded.
  }
  return runMetaPath;
}

/* ------------------------------------------------------------------ *
 * Per-spec run index — the regression timeline.                       *
 *                                                                     *
 * Each spec verified against accrues a one-line-per-run summary at    *
 * `.validity/specs/<specId>/runs.jsonl`. `spec_get` reads the last N  *
 * to show "did this spec pass last time?" without rescanning every    *
 * run-meta. Append-only JSONL keeps writes cheap and the file diff-    *
 * friendly. Lives here (not specs.ts) because it's derived from a      *
 * finished RunMeta.                                                    *
 * ------------------------------------------------------------------ */

/** One entry in a spec's regression timeline. */
export interface SpecRunSummary {
  runId: string;
  createdAt: string;
  specVersion?: number;
  specHash?: string;
  /** Git sha this run was indexed at (B3). Stamped from `meta.git?.sha`. */
  sha?: string;
  /** Roll-up across criterionVerdicts: pass only if every criterion passed. */
  verdict: 'pass' | 'fail' | 'partial' | 'unknown';
  counts: { pass: number; fail: number; unverifiable: number };
  /** The loop stop signal at this run (computeSignedOff over this run's criteria). */
  signedOff?: boolean;
  /**
   * Per-render performance timeline, keyed by `perfKeyFor` (D1). ADVISORY ONLY —
   * never feeds the verdict, signedOff, or counts. Populated by `collectRunPerf`;
   * absent on rows written before the field existed, on URL-mode runs (pages
   * carry no perf), and when no render produced metrics.
   */
  perf?: Record<string, PerformanceMetrics>;
  /**
   * Per-criterion snapshot at this run — the "scorecard snapshot" the timeline preserves.
   * For a soft criterion this is its scored status once submit_report folded the agent's
   * score in (it's `unverifiable` on a pre-scoring verify append). Derived purely from
   * meta.criterionVerdicts; severity/numeric score live elsewhere and are intentionally omitted.
   */
  criteria?: Array<{ id: string; tier: CriterionTier; status: 'pass' | 'fail' | 'unverifiable' }>;
  /**
   * Run provenance mirrored from `meta.origin` (`'local'` | `'ci'`), copied only
   * when the run-meta carried it — legacy metas leave this absent, so the field
   * never lies about an unknown origin. DISPLAY-ONLY (drives the /reports badge).
   */
  origin?: RunOrigin;
  /**
   * Lifecycle status (B5). ADD-ONLY: the only value ever written is
   * `'incomplete'`, and only by `readIncompleteRuns` for a run whose process
   * died mid-verify. Absent on every persisted `runs.jsonl` row — the timeline
   * only ever recorded runs that finished — so no existing consumer changes
   * behavior. An `incomplete` row carries `verdict: 'unknown'` and zeroed
   * counts: surfaced, never tallied as a pass or a fail.
   */
  status?: 'incomplete';
}

/**
 * Deterministic cap on perf keys per timeline row so a pathological render
 * fan-out can't bloat runs.jsonl (keys are sorted before capping).
 */
export const MAX_PERF_KEYS_PER_RUN = 40;

/**
 * Collect a run's per-render performance metrics into the timeline shape
 * (D1): keyed by `perfKeyFor`, values rounded to 0.1ms. ADVISORY only —
 * nothing here feeds verdict/signedOff/counts. Errored renders are skipped
 * (a crashed render's timings are junk), and only finite non-negative
 * numbers survive, so a crafted/legacy run-meta can't inject strings or
 * `NaN` into the timeline. Returns `undefined` when nothing was collected
 * so perf-less rows stay byte-identical to the pre-feature shape.
 */
export function collectRunPerf(meta: RunMeta): Record<string, PerformanceMetrics> | undefined {
  const platform = meta.mode === 'native' ? 'native' : 'web';
  const out: Record<string, PerformanceMetrics> = {};
  for (const c of meta.components ?? []) {
    if (!c.performance || c.renderError) continue;
    const rounded: PerformanceMetrics = {};
    for (const [k, v] of Object.entries(c.performance)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        (rounded as Record<string, number>)[k] = Math.round(v * 10) / 10;
      }
    }
    if (Object.keys(rounded).length === 0) continue;
    // Duplicate key (identical render slot): last render wins.
    out[perfKeyFor(c, platform)] = rounded;
  }
  const keys = Object.keys(out).sort();
  if (keys.length === 0) return undefined;
  if (keys.length <= MAX_PERF_KEYS_PER_RUN) return out;
  const capped: Record<string, PerformanceMetrics> = {};
  for (const k of keys.slice(0, MAX_PERF_KEYS_PER_RUN)) capped[k] = out[k]!;
  return capped;
}

function rollupVerdict(verdicts: CriterionVerdict[] | undefined): SpecRunSummary {
  const counts = { pass: 0, fail: 0, unverifiable: 0 };
  for (const v of verdicts ?? []) counts[v.status] += 1;
  let verdict: SpecRunSummary['verdict'] = 'unknown';
  if (verdicts && verdicts.length > 0) {
    if (counts.fail > 0) verdict = 'fail';
    else if (counts.unverifiable > 0) verdict = 'partial';
    else verdict = 'pass';
  }
  return { runId: '', createdAt: '', verdict, counts };
}

/**
 * Compute hard+property coverage ratio from counts.
 * Soft criteria (already excluded from counts when computed by rollupVerdict)
 * are not counted. Returns [0, 1] or null if no hard+property criteria.
 * NOT persisted — computed fresh each time to avoid staleness.
 */
export function computeHardPropertyCoverage(counts: {
  pass: number;
  fail: number;
  unverifiable: number;
}): number | null {
  const total = counts.pass + counts.fail + counts.unverifiable;
  if (total === 0) return null;
  return (counts.pass + counts.fail) / total;
}

/**
 * Canonical hard/property coverage metrics, computed straight from criterion
 * verdicts. This is the single source of truth shared across the report
 * renderer (ReportInput.coverage), the MCP submit-report path, and any CLI
 * surface — so the formula ("verifiable = pass + fail; soft excluded") can
 * never drift between layers.
 *
 * A verdict is COUNTED toward `hardPropertyTotal` only when its tier is `hard`
 * or `property` (soft criteria are LLM-scored, not mechanically decided, so
 * they don't belong in mechanical coverage). It is VERIFIABLE when the
 * mechanical check actually decided it — i.e. status `pass` or `fail`; an
 * `unverifiable` verdict counts toward the total but not toward the verifiable
 * numerator.
 *
 * Returns `null` when there are no hard/property verdicts (coverage is
 * unmeasurable — the caller should omit the coverage footnote entirely rather
 * than render "0/0"). Pure — unit-testable without a render.
 */
export function computeCoverageFromVerdicts(
  verdicts: readonly CriterionVerdict[] | undefined,
): { ratio: number; hardPropertyTotal: number; verifiableCount: number } | null {
  let hardPropertyTotal = 0;
  let verifiableCount = 0;
  for (const v of verdicts ?? []) {
    if (v.tier !== 'hard' && v.tier !== 'property') continue;
    hardPropertyTotal += 1;
    if (v.status === 'pass' || v.status === 'fail') verifiableCount += 1;
  }
  if (hardPropertyTotal === 0) return null;
  return { ratio: verifiableCount / hardPropertyTotal, hardPropertyTotal, verifiableCount };
}

/**
 * Append a run summary to its spec's regression timeline. When
 * `opts.historyCommitted === true` (the config knob, threaded by callers) the
 * SAME summary is also appended as a committed-history row under
 * `.validity/history/<specId>.jsonl` (F2) — verdict/counts/criteria copied
 * verbatim, so the committed timeline can never disagree with the local one.
 */
export function indexRunForSpec(
  projectRoot: string,
  meta: RunMeta,
  opts?: { historyCommitted?: boolean },
): void {
  if (!meta.specId) return;
  const path = resolve(validityDir(projectRoot), 'specs', meta.specId, 'runs.jsonl');
  const roll = rollupVerdict(meta.criterionVerdicts);
  const summary: SpecRunSummary = {
    runId: meta.runId,
    createdAt: meta.createdAt,
    specVersion: meta.specVersion,
    specHash: meta.specHash,
    sha: meta.git?.sha,
    verdict: roll.verdict,
    counts: roll.counts,
    // Loop stop signal + per-criterion snapshot for "what was the verdict N
    // iterations ago" reads. Both derive purely from meta — `signedOff` is the
    // post-scoring value once submit_report re-appends (un-scored soft criteria
    // read `unverifiable` here), and `criteria` is the contract's tier+status
    // projection (no severity/numeric score — those live on the run-meta).
    signedOff: meta.signedOff,
    // Advisory perf timeline (D1). `JSON.stringify` drops `undefined`, so a
    // perf-less run writes a row byte-identical to the pre-feature shape.
    perf: collectRunPerf(meta),
    criteria: (meta.criterionVerdicts ?? []).map((v) => ({
      id: v.id,
      tier: v.tier,
      status: v.status,
    })),
    // Copied ONLY when the run-meta carried it — `JSON.stringify` drops the
    // key on an absent origin, so legacy metas write a byte-identical row.
    origin: meta.origin,
  };
  try {
    // Spec dir already exists when a spec was frozen; create defensively.
    const dir = resolve(validityDir(projectRoot), 'specs', meta.specId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(summary) + '\n');
    // Opt-in committed twin (F2): the SAME summary object, so the row can
    // never disagree with runs.jsonl. `score` is deliberately absent — it is
    // not cheaply available at index time (§9.4); trends recomputes it.
    if (opts?.historyCommitted === true) {
      appendHistoryRow(projectRoot, {
        v: 1,
        specId: meta.specId,
        runId: summary.runId,
        createdAt: summary.createdAt,
        specVersion: summary.specVersion,
        specHash: summary.specHash,
        verdict: summary.verdict,
        signedOff: summary.signedOff,
        counts: summary.counts,
        criteria: summary.criteria,
        sha: summary.sha,
        perf: summary.perf,
        origin: summary.origin,
      });
    }
  } catch {
    // Non-fatal — the index is a convenience, not a source of truth.
  }
}

/** Read the last `limit` run summaries for a spec, newest last. */
export function readSpecRunHistory(
  projectRoot: string,
  specId: string,
  limit = 10,
): SpecRunSummary[] {
  const path = resolve(validityDir(projectRoot), 'specs', specId, 'runs.jsonl');
  // No timeline file is the COMMON crash shape, not an empty case: the very
  // first verify for a spec dies before `indexRunForSpec` ever creates the
  // file, so returning `[]` here would hide exactly the run worth surfacing.
  if (!existsSync(path)) return withIncompleteRuns(projectRoot, specId, [], limit);
  try {
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Only the last `limit` records are ever returned — slice the raw lines
    // BEFORE parsing so a long-loop's ever-growing timeline costs O(limit)
    // JSON.parse work per read, not O(whole file). (The file read itself is a
    // few KB–MB and cheap; the per-line parse was the wasteful part.) Malformed
    // lines are still tolerated and dropped.
    //
    // NOTE (W5 #20): rows are APPEND-ordered and a runId can appear twice (the
    // verify append + the submit_report scored twin), so a caller that dedupes
    // by runId sees only ~`limit/2` UNIQUE runs. Such callers must pass a
    // compensated limit (see `buildTrendsSpec`, which reads `limit * 2`). This
    // reader deliberately stays append-faithful — the per-append rows are the
    // "N iterations ago" timeline.
    const parsed = lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as SpecRunSummary;
        } catch {
          return null;
        }
      })
      .filter((v): v is SpecRunSummary => v !== null);
    return withIncompleteRuns(projectRoot, specId, parsed, limit);
  } catch {
    return withIncompleteRuns(projectRoot, specId, [], limit);
  }
}

/**
 * Append this spec's CRASHED runs (B5) to a parsed timeline, newest-last, and
 * re-apply the caller's limit.
 *
 * A run killed mid-verify never reaches `indexRunForSpec`, so it has no
 * runs.jsonl row at all — reading the file alone makes a crash indistinguishable
 * from a run that never happened. These rows come from the start markers on
 * disk instead. They are `verdict: 'unknown'` with zeroed counts, so every
 * existing pass/fail tally is unaffected; they only ADD visibility.
 */
function withIncompleteRuns(
  projectRoot: string,
  specId: string,
  rows: SpecRunSummary[],
  limit: number,
): SpecRunSummary[] {
  const incomplete = readIncompleteRuns(projectRoot, { specId });
  if (incomplete.length === 0) return rows;
  const known = new Set(rows.map((r) => r.runId));
  const merged = [...rows, ...incomplete.filter((r) => !known.has(r.runId))];
  return merged.slice(-limit);
}
