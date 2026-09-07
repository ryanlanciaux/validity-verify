/**
 * `validity verify --all [--changed] [--specs id,id] [--report junit|table]`
 *
 * The CI / regression wedge: re-run the MECHANICAL (hard + property) checks of
 * frozen specs without a host LLM in the loop, and fail the build if any of
 * them regress. This is the non-interactive cousin of the `validity__verify`
 * MCP tool — that one drives an agent through the soft (LLM-scored) criteria;
 * THIS one only asserts what can be proven deterministically in the sandbox.
 *
 * SOFT criteria cannot be scored here (no model), so they are reported as
 * `skipped` ("needs agent verify") — NEVER as pass. A green `verify --all` means
 * "every proof still holds", not "the feature is fully accepted".
 *
 * Cost controls: the change-mapping path (`--changed`) is implemented so CI only
 * re-verifies specs whose target components moved. Screenshot short-circuiting is
 * now available as an opt-in on the render path (the sandbox skips the screenshot
 * when a render errored or every mechanical verdict failed and no soft criterion
 * needs the pixels — never on green). Tier-aware scheduling remains a documented
 * follow-up — see the note printed when `--all` runs the full set.
 *
 * The PURE pieces (`selectSpecsForRun`, `aggregateVerdicts`, `formatTable`,
 * `toJUnit`) are exported and unit-tested without ever booting the sandbox,
 * because the Vite sandbox boot fails on node 23 locally.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  acquireVerifyLock,
  clearSpecProbation,
  CommandCheckRunner,
  computeValidityScore,
  detectRunOrigin,
  gitTracksPath,
  gitWorkingTreeChanges,
  judgeApiKeyEnv,
  listSpecs,
  loadScorecard,
  loadSignals,
  mergeSignals,
  readJudgeApiKey,
  readRunMeta,
  runJudge,
  saveScorecard,
  saveSignals,
  mapChangedFilesToSpecs,
  observationConfirmsProbationClear,
  applyMaturityToScorecard,
  reconcileScorecard,
  resolveReportConfig,
  resolveTemporalBinding,
  specPathFor,
  VALIDITY_SCORE_VERSION,
  VerifyLockHeldError,
  type CriterionTier,
  type CriterionVerdict,
  type JudgeSpecOutcome,
  type RunMeta,
  type RunOrigin,
  type Scorecard,
  type Signal,
  type Spec,
  type SpecObservation,
  type MaturityAssessment,
  type TemporalClassification,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  assessSpecMaturity,
  formatBaselineLifecycleAdvisory,
  renderHtmlReport,
  sweepBaselineLifecycle,
} from '@validity.ai/verify-web';
import {
  bootAndroidEmulator,
  checkNativeReadiness,
  companionBuildIdentity,
  defaultCompanionApkRoots,
  closeEstablishedNativeSessions,
  defaultRunner,
  diagnoseNativeEnvironment,
  findNewestApk,
  installCompanion,
  listBootedDevices,
  teardownEmulator,
  type BootedDevice,
  type BootedEmulator,
  type CommandRunner,
  type DiscoveredApk,
  type EnvironmentDiagnosis,
} from '@validity.ai/verify-native';
import { verifyOneSpec } from '../verify-engine.js';
import { verifyOneSpecNative } from '../native-verify-engine.js';
import {
  buildCheckBaseComparison,
  buildCheckMetadata,
  buildVerifyAllReportInput,
  combineSpecHashes,
  deriveRepo,
  headSha,
  mergeBaseSha,
  resolveBaseValidityScore,
  writeRunReportHtml,
  type CheckBaseComparison,
  type VerifyAllRun,
} from '../report-render.js';

export interface VerifyAllOptions {
  cwd?: string;
  all?: boolean;
  changed?: boolean;
  /** Explicit spec ids (comma-separated on the CLI, array here). */
  specs?: string[];
  /**
   * stdout / `--out` format. `junit` (aliases `ci` / `xml`) is the portable
   * CI interchange XML — not Java, just a text format every CI reads;
   * `markdown` is a GitHub-summary table; `table` (default) is the human
   * console view.
   */
  report?: 'table' | 'junit' | 'markdown' | 'ci' | 'xml';
  /** Write the `--report` output to this file instead of stdout. */
  out?: string;
  /**
   * Side-output: also write a Markdown summary table to this file in the SAME
   * run (no second render). Point it at `$GITHUB_STEP_SUMMARY` in CI.
   */
  summary?: string;
  /**
   * Render a self-contained `report.html` (screenshots + Proven section + soft
   * advisory) to this path. This is the project's artifact — it stays in local
   * storage (CI uploads it as a GitHub artifact). Written even on a failing run.
   */
  reportHtml?: string;
  /**
   * Write check metadata JSON (`CheckMetadata`) to this path for the GitHub
   * Action to post a status check without re-parsing human output. Contains
   * only verdict/coverage/counts + repo/sha/specHash — never report bytes.
   */
  checkOutput?: string;
  /**
   * Boot an Android emulator and run any selected `runtime: native` frozen specs
   * on-device (the CI native path). When ABSENT and native specs are selected,
   * we first try AUTO-DISCOVERY (an already-running device via adb + the newest
   * companion APK on disk — see the native block in runVerifyAll); only if that
   * finds nothing does the run hard-fail with an actionable error. A native spec
   * that nothing verified must never leave the build green.
   */
  native?: { avdName: string; apkPath: string; port?: number; bootTimeoutSec?: number };
  /**
   * Emulator console port from a lone `--native-port` (no `--native-avd`/apk).
   * Only consulted on the auto-discovery path — it overrides the port parsed
   * from an `emulator-<port>` serial. Ignored when `native` is set (the port
   * lives inside it there).
   */
  nativePort?: number;
  /**
   * Injectable adb runner for native auto-discovery (`listBootedDevices`).
   * Defaults to the real adb runner; the discovery tests pass a fake so they
   * can present a running device without a booted emulator. Never changes
   * behavior when absent.
   */
  nativeDeviceRunner?: CommandRunner;
  /**
   * Score soft criteria with the automated LLM judge after the mechanical
   * checks (requires `scoring.judgeModel` in config + the provider's API key in
   * the env). Without it — or on ANY judge failure — soft criteria stay
   * `skipped` with a reason (never a pass): "never false green". The judge never
   * changes the exit gate, which remains hard/property-only.
   */
  judge?: boolean;
}

/** PR context for the check metadata, read from the CI environment. */
export function readPrContext(): {
  branch: string | null;
  prNumber: number | null;
  baseRef: string | null;
} {
  const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null;
  const ref = process.env.GITHUB_REF ?? '';
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  // GITHUB_BASE_REF is only set on pull_request events — the PR's target
  // branch, which the base-comparison section (B3) resolves a merge-base from.
  return {
    branch,
    prNumber: m ? Number(m[1]) : null,
    baseRef: process.env.GITHUB_BASE_REF || null,
  };
}

/** Normalize report aliases: ci/xml → junit. */
function normalizeReportKind(r: VerifyAllOptions['report']): 'table' | 'junit' | 'markdown' {
  if (r === 'ci' || r === 'xml' || r === 'junit') return 'junit';
  if (r === 'markdown') return 'markdown';
  return 'table';
}

/* ------------------------------------------------------------------ *
 * Result shapes.                                                      *
 * ------------------------------------------------------------------ */

/** Per-criterion outcome in a CLI verify run. `skipped` = soft, no LLM here. */
export interface CriterionResult {
  id: string;
  tier: CriterionTier;
  status: 'pass' | 'fail' | 'unverifiable' | 'skipped';
  detail?: string;
}

/** Per-spec roll-up of a CLI verify run. */
export interface SpecResult {
  specId: string;
  version: number;
  /** Render/prepare failure that prevented any criterion from running. */
  error?: string;
  /**
   * Temporal-binding classification (B2) — did this spec's freeze precede the
   * verified work? Display-only provenance: never feeds the exit gate.
   * B3's `CheckSpecSummary.temporal` maps straight from this field.
   */
  temporal?: TemporalClassification;
  /**
   * ATTRIBUTION for `error` — the named cause and the exact fix command
   * (handoff-2026-07-28: five distinct causes, one indistinguishable "no
   * mechanical verdict produced"). ADDITIVE and gate-inert: `error` alone still
   * trips `hasHardFailure`, so a run with no diagnosis behaves exactly as it
   * did before. Populated on the native path today; absent on web and whenever
   * every probe answered "cannot tell".
   */
  diagnosis?: EnvironmentDiagnosis;
  criteria: CriterionResult[];
}

/* ------------------------------------------------------------------ *
 * Pure helper: spec selection.                                        *
 * ------------------------------------------------------------------ */

export interface SelectSpecsArgs {
  /** Every spec on disk (already loaded). */
  specs: Spec[];
  mode: 'all' | 'changed' | 'explicit';
  /** Required for `explicit`. */
  explicitIds?: string[];
  /** Required for `changed`. */
  changedFiles?: string[];
  /** Optional component-name → file-path resolver for change mapping. */
  resolveTarget?: (name: string) => string[];
}

export interface SelectSpecsResult {
  selected: Spec[];
  /** Ids requested/considered but not run, with a reason (never silent). */
  skipped: { id: string; reason: string }[];
}

function isFrozen(spec: Spec): boolean {
  return spec.status === 'frozen';
}

/**
 * Resolve which specs a `verify --all` invocation runs. Pure: takes already
 * loaded specs + the requested mode, returns the selection plus an audited
 * `skipped` list (so nothing is dropped without a printed reason).
 */
export function selectSpecsForRun(args: SelectSpecsArgs): SelectSpecsResult {
  const skipped: { id: string; reason: string }[] = [];

  if (args.mode === 'explicit') {
    const wanted = new Set(args.explicitIds ?? []);
    const byId = new Map(args.specs.map((s) => [s.id, s]));
    const selected: Spec[] = [];
    for (const id of wanted) {
      const spec = byId.get(id);
      if (!spec) {
        skipped.push({ id, reason: 'not found under .validity/specs/' });
        continue;
      }
      selected.push(spec);
    }
    return { selected, skipped };
  }

  // Both `all` and `changed` only consider FROZEN specs — an unfrozen spec has
  // no bound content-hash to regress against.
  const frozen = args.specs.filter(isFrozen);
  for (const s of args.specs) {
    if (!isFrozen(s)) skipped.push({ id: s.id, reason: `status=${s.status} (not frozen)` });
  }

  if (args.mode === 'all') {
    return { selected: frozen, skipped };
  }

  // changed
  const { matched, unmapped } = mapChangedFilesToSpecs({
    specs: frozen,
    changedFiles: args.changedFiles ?? [],
    resolveTarget: args.resolveTarget,
  });
  for (const s of unmapped) {
    skipped.push({ id: s.id, reason: 'no targets — cannot map to changed files' });
  }
  // Frozen specs WITH targets that simply didn't match the diff are also skipped.
  const matchedIds = new Set(matched.map((s) => s.id));
  for (const s of frozen) {
    if (!matchedIds.has(s.id) && (s.targets?.components?.length ?? 0) > 0) {
      skipped.push({ id: s.id, reason: 'targets unchanged' });
    }
  }
  return { selected: matched, skipped };
}

/* ------------------------------------------------------------------ *
 * Pure helper: verdict aggregation.                                   *
 * ------------------------------------------------------------------ */

/**
 * Combine a spec's full criteria list with the MECHANICAL verdicts produced by
 * the sandbox (hard/property only). Soft criteria become `skipped` — they need
 * an agent + model to score and must never appear as pass here. A hard/property
 * criterion with no mechanical verdict is `unverifiable` (the check couldn't be
 * executed), not silently passed.
 */
export function aggregateVerdicts(spec: Spec, mechanical: CriterionVerdict[]): CriterionResult[] {
  const byId = new Map(mechanical.map((v) => [v.id, v]));
  return spec.criteria.map((c): CriterionResult => {
    if (c.tier === 'soft') {
      return {
        id: c.id,
        tier: 'soft',
        status: 'skipped',
        detail: 'soft criterion — needs agent verify (no LLM in the CLI)',
      };
    }
    const verdict = byId.get(c.id);
    if (!verdict) {
      return {
        id: c.id,
        tier: c.tier,
        status: 'unverifiable',
        detail: 'no mechanical verdict produced for this criterion',
      };
    }
    return { id: c.id, tier: c.tier, status: verdict.status, detail: verdict.detail };
  });
}

/** True when any HARD/PROPERTY criterion across all specs failed. */
export function hasHardFailure(results: SpecResult[]): boolean {
  return results.some(
    (r) => Boolean(r.error) || r.criteria.some((c) => c.tier !== 'soft' && c.status === 'fail'),
  );
}

/**
 * ATTRIBUTION summary (never softens the gate): specs whose render/prepare
 * failed BEFORE any criterion could run (`SpecResult.error`). A run with
 * env-blocked specs still trips `hasHardFailure` (the `.error` check above)
 * and can still breach the coverage floor — this is display-only context so
 * the team can tell "the environment broke" apart from "the code regressed",
 * never a reason to exit 0. `errors` is deduped so N specs sharing one root
 * cause (e.g. the same broken sandbox) read as one line, not a wall of
 * repeats. Returns undefined when nothing errored — the CheckMetadata field
 * and the CLI's ENVIRONMENT BLOCKED block are both presence-gated on this.
 */
export function computeEnvBlocked(results: SpecResult[]): EnvBlockedSummary | undefined {
  const errored = results.filter((r) => r.error);
  if (errored.length === 0) return undefined;
  const errors = Array.from(new Set(errored.map((r) => r.error!)));
  // Per-error attribution, keyed by the SAME deduped error string the `errors`
  // array carries so a consumer can join the two without re-deriving anything.
  // Keep-first on collision: identical error text implies identical cause.
  const causes: NonNullable<EnvBlockedSummary['causes']> = [];
  const seen = new Set<string>();
  for (const r of errored) {
    if (!r.diagnosis || seen.has(r.error!)) continue;
    seen.add(r.error!);
    causes.push({
      error: r.error!,
      cause: r.diagnosis.cause,
      ...(r.diagnosis.fixCommand ? { fixCommand: r.diagnosis.fixCommand } : {}),
    });
  }
  // OMITTED, not empty, when nothing was diagnosed — an older CLI's metadata
  // and a modern undiagnosed run stay byte-identical, and post-check.cjs's
  // absence guard covers both with one code path.
  return { count: errored.length, errors, ...(causes.length > 0 ? { causes } : {}) };
}

/** Shape of {@link computeEnvBlocked}; mirrored by `CheckMetadata.envBlocked`. */
export interface EnvBlockedSummary {
  count: number;
  errors: string[];
  /** Per-error attribution. Absent ⇒ nothing was diagnosed (or an older CLI). */
  causes?: Array<{ error: string; cause: string; fixCommand?: string }>;
}

/**
 * The one-line attribution appended to an ERROR row in the table / markdown /
 * JUnit outputs. ONE renderer for all three so they can never drift into
 * saying different things about the same failure.
 *
 * Only the FIRST line of `fixCommand` is shown: the full reset recipe is four
 * commands, and a table row is not where a developer runs it — the CLI's
 * ENVIRONMENT BLOCKED block and the report banner carry the whole thing.
 * Returns '' with no diagnosis, so undiagnosed output is unchanged.
 */
export function formatDiagnosisSuffix(diagnosis: EnvironmentDiagnosis | undefined): string {
  if (!diagnosis) return '';
  const fix = diagnosis.fixCommand?.split('\n')[0]?.trim();
  return `  cause: ${diagnosis.cause}${fix ? ` — fix: ${fix}` : ''}`;
}

/**
 * Exit code for a verify that did not complete its plan. Distinct from 1
 * (regression / gate failure) and 2 (usage error, the convention across
 * commands) so CI can tell "the code is red" apart from "the run is dead".
 */
export const EXIT_UNFINISHED = 3;

export function unfinishedRunMessage(executed: number, planned: number): string {
  return (
    `UNFINISHED: verify executed ${executed} of ${planned} planned run${planned === 1 ? '' : 's'} ` +
    `and is exiting without a verdict — treat this run as dead, not green (exit ${EXIT_UNFINISHED}).\n`
  );
}

/**
 * Plan-completion sentinel. A verify that dies mid-plan can reach exit 0
 * WITHOUT ever returning from `runVerifyAll`: when the sandbox strands its
 * pending capture (e.g. a dep-scan abort kills the dev server and the
 * fatalError race never settles), the event loop simply drains and Node exits
 * 0 from inside an `await` — no throw, no gate, false green. Arm an `exit`
 * listener while the plan is in flight; if the process exits 0 before
 * `disarm()`, stamp a loud UNFINISHED marker and force EXIT_UNFINISHED.
 * Deliberate non-zero exits (the gate's exit 1, usage exit 2) pass through
 * untouched — they already tell the truth.
 */
export function armPlanSentinel(
  planned: number,
  executedCount: () => number,
): { disarm: () => void; onExit: (code: number) => void } {
  const onExit = (code: number): void => {
    if (code !== 0) return;
    process.stderr.write(pc.red(unfinishedRunMessage(executedCount(), planned)));
    process.exitCode = EXIT_UNFINISHED;
  };
  process.on('exit', onExit);
  return { onExit, disarm: () => void process.off('exit', onExit) };
}

/**
 * Project CLI SpecResults into scorecard observations (F1). `skipped` soft →
 * `unscored` — semantically identical ("soft, no LLM in the CLI"; see the
 * `CriterionResult` doc above), just named differently across layers.
 * `severity`/`softThreshold` join from the FROZEN spec by id, so advisory
 * exclusion and thresholds come from the content-hashed contract, never from
 * run-time input. Pure — used for the read-only scorecard fold that feeds
 * `CheckMetadata.validityScore` (informational; never the gate).
 */
export function toSpecObservations(
  runs: Array<{ spec: Spec; results: SpecResult }>,
): SpecObservation[] {
  return runs.map(({ spec, results }) => {
    const bySpecId = new Map(spec.criteria.map((c) => [c.id, c]));
    return {
      specId: spec.id,
      specVersion: spec.version,
      specHash: spec.hash,
      // Thread the bulk-onboarding probation marker (Phase C) so the reducer
      // downgrades a pass→fail to needs-review (low) on an unconfirmed bulk
      // spec. verify --all also clears it via `observationConfirmsProbationClear`
      // at the fold site below.
      probation: Boolean(spec.probation) || undefined,
      criteria: results.criteria.map((c) => {
        const frozen = bySpecId.get(c.id);
        return {
          id: c.id,
          tier: c.tier,
          status: c.status === 'skipped' ? ('unscored' as const) : c.status,
          detail: c.detail,
          severity: frozen?.severity,
          softThreshold: frozen?.softThreshold,
        };
      }),
    };
  });
}

/**
 * Compute hard+property coverage for formatting. Soft criteria and specs that
 * failed to render are excluded. Returns { percent, verifiable, total } or null
 * when there are no hard/property criteria to measure.
 *
 * COUPLING: this is the SpecResult-shaped sibling of core's canonical
 * `computeCoverageFromVerdicts` (which works on CriterionVerdict[] and returns
 * `{ ratio, hardPropertyTotal, verifiableCount }`). Both apply the identical
 * rule — exclude soft, count (pass + fail) / total over hard/property — and the
 * CLI keeps its own copy only because it folds in the extra CLI-only states
 * (`skipped` soft + per-spec render `error`). If the coverage formula ever
 * changes, update BOTH. `percent = round(ratio * 100)`.
 */
function computeCoverageMetrics(
  results: SpecResult[],
): { percent: number; verifiable: number; total: number } | null {
  let totalHardProperty = 0;
  let verifiable = 0;
  for (const spec of results) {
    if (spec.error) continue;
    for (const c of spec.criteria) {
      if (c.tier === 'soft') continue;
      totalHardProperty += 1;
      if (c.status === 'pass' || c.status === 'fail') verifiable += 1;
    }
  }
  if (totalHardProperty === 0) return null;
  return {
    percent: Math.round((verifiable / totalHardProperty) * 100),
    verifiable,
    total: totalHardProperty,
  };
}

/**
 * Check if all specs meet the coverage floor configured in ValidityConfig.
 * Hard/property criteria only; soft are excluded (always skipped in CLI).
 * Returns { pass: true } if no floor configured, or if coverage >= floor.
 * Returns { pass: false, reason } if coverage < floor.
 * Coverage = (pass + fail) / (pass + fail + unverifiable) for hard+property only.
 */
export function checkCoverageFloor(
  results: SpecResult[],
  config: ValidityConfig,
): { pass: boolean; reason?: string } {
  const floor = config.coverageFloorPercent;
  if (floor === undefined) {
    return { pass: true };
  }

  const coverage = computeCoverageMetrics(results);
  // No hard/property criteria → coverage is unmeasurable → vacuously true.
  if (coverage === null) {
    return { pass: true };
  }

  if (coverage.percent < floor) {
    let reason = `Coverage ${coverage.percent}% < floor ${floor}% (${coverage.verifiable}/${coverage.total} hard/property criteria verifiable)`;
    // Attribution context: specs that never rendered are EXCLUDED from the
    // coverage calc above (computeCoverageMetrics skips `spec.error`), so an
    // env-blocked spec never directly inflates the unverifiable count here —
    // but the same broken environment can also be why OTHER specs came back
    // with hard/property criteria that produced no mechanical verdict. Compare
    // how many hard/property criteria sat inside env-blocked specs against the
    // shortfall (additional verified criteria needed to clear the floor): when
    // it covers the shortfall, name it as a plausible full explanation; when
    // it's merely present, note it without claiming it explains the breach.
    const envBlocked = computeEnvBlocked(results);
    if (envBlocked) {
      const envCriteriaCount = results
        .filter((r) => r.error)
        .reduce((sum, r) => sum + r.criteria.filter((c) => c.tier !== 'soft').length, 0);
      const shortfall = Math.max(
        0,
        Math.ceil((floor / 100) * coverage.total) - coverage.verifiable,
      );
      if (envCriteriaCount > 0 && envCriteriaCount >= shortfall) {
        reason +=
          ` — ${envBlocked.count} environment-blocked spec${envBlocked.count === 1 ? '' : 's'} ` +
          `(${envCriteriaCount} criteri${envCriteriaCount === 1 ? 'on' : 'a'} never ran) may fully explain this shortfall`;
      } else if (envCriteriaCount > 0) {
        reason +=
          ` — note: ${envBlocked.count} environment-blocked spec${envBlocked.count === 1 ? '' : 's'} ` +
          `also produced no verdicts (${envCriteriaCount} criteri${envCriteriaCount === 1 ? 'on' : 'a'}), ` +
          `though not enough alone to explain this shortfall`;
      }
    }
    return { pass: false, reason };
  }
  return { pass: true };
}

/* ------------------------------------------------------------------ *
 * Pure helper: table formatting.                                      *
 * ------------------------------------------------------------------ */

function statusGlyph(status: CriterionResult['status']): string {
  switch (status) {
    case 'pass':
      return pc.green('PASS');
    case 'fail':
      return pc.red('FAIL');
    case 'unverifiable':
      return pc.yellow('UNVERIFIABLE');
    case 'skipped':
      return pc.dim('SKIPPED');
  }
}

/** Render the run as a human-readable console table. */
export function formatTable(results: SpecResult[]): string {
  const lines: string[] = [];
  let pass = 0;
  let fail = 0;
  let unverifiable = 0;
  let skipped = 0;

  for (const spec of results) {
    lines.push(pc.bold(`${spec.specId}@v${spec.version}`));
    if (spec.error) {
      lines.push(`  ${pc.red('ERROR')}  ${spec.error}`);
      // Attribution rides its own dim line: the error is what happened, the
      // cause is why. Absent diagnosis ⇒ no line at all (unchanged output).
      const suffix = formatDiagnosisSuffix(spec.diagnosis);
      if (suffix) lines.push(`  ${pc.dim(suffix.trimStart())}`);
    }
    for (const c of spec.criteria) {
      if (c.status === 'pass') pass += 1;
      else if (c.status === 'fail') fail += 1;
      else if (c.status === 'unverifiable') unverifiable += 1;
      else skipped += 1;
      const detail = c.detail ? `  ${pc.dim(c.detail)}` : '';
      lines.push(`  ${statusGlyph(c.status)}  ${c.id} ${pc.dim(`[${c.tier}]`)}${detail}`);
    }
    lines.push('');
  }

  lines.push(
    `${pc.bold('Summary:')} ${pc.green(`${pass} pass`)}, ${pc.red(`${fail} fail`)}, ` +
      `${pc.yellow(`${unverifiable} unverifiable`)}, ${pc.dim(`${skipped} skipped (soft)`)}`,
  );
  const coverage = computeCoverageMetrics(results);
  if (coverage) {
    lines.push(pc.dim(`Coverage: ${coverage.verifiable}/${coverage.total} (${coverage.percent}%)`));
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the run as a GitHub-flavored Markdown table, suitable for writing to
 * `$GITHUB_STEP_SUMMARY` so the result is readable in the PR/Checks UI without
 * anyone needing to open the JUnit artifact or know what JUnit is. Pure +
 * color-free (no picocolors) so it round-trips as plain markdown.
 */
export function formatMarkdown(results: SpecResult[]): string {
  const badge = (s: CriterionResult['status']): string =>
    s === 'pass'
      ? '✅ pass'
      : s === 'fail'
        ? '❌ fail'
        : s === 'unverifiable'
          ? '⚠️ unverifiable'
          : '⏭️ skipped';
  const counts = { pass: 0, fail: 0, unverifiable: 0, skipped: 0 };
  const lines: string[] = ['## Validity `verify --all`', ''];
  for (const spec of results) {
    lines.push(`### \`${spec.specId}@v${spec.version}\``);
    if (spec.error) {
      // Newlines would break out of the blockquote — the error already contains
      // an indented cause/fix block on the native path, so flatten it.
      lines.push(`> ⛔ ${spec.error.replace(/\n+/g, ' ')}`);
      const suffix = formatDiagnosisSuffix(spec.diagnosis);
      if (suffix) lines.push(`> ${suffix.trimStart()}`);
      lines.push('');
    }
    lines.push('| Criterion | Tier | Result | Detail |', '| --- | --- | --- | --- |');
    for (const c of spec.criteria) {
      counts[c.status] += 1;
      const detail = (c.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${c.id} | ${c.tier} | ${badge(c.status)} | ${detail} |`);
    }
    lines.push('');
  }
  const coverage = computeCoverageMetrics(results);
  const coverageText = coverage
    ? ` · Coverage: ${coverage.verifiable}/${coverage.total} (${coverage.percent}%)`
    : '';
  lines.push(
    `**${counts.pass} pass · ${counts.fail} fail · ${counts.unverifiable} unverifiable · ` +
      `${counts.skipped} skipped (soft — need an agent verify; not scored here).${coverageText}**`,
  );
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Pure helper: JUnit XML.                                             *
 * ------------------------------------------------------------------ */

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Emit a JUnit report: one `<testsuite>` per spec, one `<testcase>` per
 * criterion. Hard/property failures become `<failure>`; soft (and
 * unverifiable) criteria become `<skipped>` so CI surfaces "not proven here"
 * without reding the build.
 */
export function toJUnit(results: SpecResult[]): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  let totalTests = 0;
  let totalFailures = 0;
  let totalSkipped = 0;
  const suites: string[] = [];

  for (const spec of results) {
    const name = `${spec.specId}@v${spec.version}`;
    let failures = 0;
    let skips = 0;
    const cases: string[] = [];

    if (spec.error) {
      // A spec that couldn't render at all = one failing synthetic testcase.
      failures += 1;
      cases.push(
        `    <testcase classname="${xmlEscape(name)}" name="render">\n` +
          `      <failure message="${xmlEscape(spec.error + formatDiagnosisSuffix(spec.diagnosis))}"></failure>\n` +
          `    </testcase>`,
      );
    }

    for (const c of spec.criteria) {
      // Soft criteria NEVER gate the machine interchange, even when the
      // automated judge scored them pass/fail — the CI exit gate is
      // hard/property-only. A judged soft verdict is visible in the human table
      // + report; here it stays a `<skipped>` carrying the judged detail, so a
      // model's opinion can neither red nor green the build.
      const isSkip = c.tier === 'soft' || c.status === 'skipped' || c.status === 'unverifiable';
      const isFail = c.tier !== 'soft' && c.status === 'fail';
      if (isFail) failures += 1;
      if (isSkip) skips += 1;
      const detail = c.detail ? xmlEscape(c.detail) : '';
      let inner = '';
      if (isFail) {
        inner = `\n      <failure message="${detail}"></failure>\n    `;
      } else if (isSkip) {
        inner = `\n      <skipped message="${detail}"></skipped>\n    `;
      }
      cases.push(
        `    <testcase classname="${xmlEscape(name)}" name="${xmlEscape(
          `${c.id} [${c.tier}]`,
        )}">${inner}</testcase>`,
      );
    }

    totalTests += spec.criteria.length + (spec.error ? 1 : 0);
    totalFailures += failures;
    totalSkipped += skips;
    suites.push(
      `  <testsuite name="${xmlEscape(name)}" tests="${
        spec.criteria.length + (spec.error ? 1 : 0)
      }" failures="${failures}" skipped="${skips}">\n${cases.join('\n')}\n  </testsuite>`,
    );
  }

  lines.push(
    `<testsuites name="validity verify --all" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}">`,
  );
  lines.push(...suites);
  lines.push(`</testsuites>`);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Working-tree change detection (impure — git shell out).             *
 * ------------------------------------------------------------------ */

/**
 * Tracked modifications (`git diff --name-only HEAD`) plus untracked files.
 *
 * The implementation moved to `@validity.ai/verify-spec` (`gitWorkingTreeChanges`) when
 * the verify fold needed the same "what is uncommitted?" read for its
 * relevance mapping; this stays as the CLI's existing name (watch imports it).
 */
export function workingTreeChanges(projectRoot: string): string[] {
  return gitWorkingTreeChanges(projectRoot);
}

/* ------------------------------------------------------------------ *
 * Native auto-discovery (impure — adb + fs).                          *
 * ------------------------------------------------------------------ */

/**
 * The resolved native run after flag/discovery resolution:
 *   - `boot`: explicit `--native-avd`/`--native-apk` — boot a fresh emulator,
 *     then tear it down when done (we created it).
 *   - `discovered`: neither flag given — attach to the user's ALREADY-running
 *     device and install a freshly-built APK. We never booted it, so we never
 *     tear it down.
 */
export type ResolvedNativeRun =
  | { mode: 'boot'; avdName: string; apkPath: string; port?: number; bootTimeoutSec?: number }
  | {
      mode: 'discovered';
      platform: 'ios' | 'android';
      deviceId: string;
      /** Run-meta provenance — see RunMeta.nativeDevice. */
      deviceName?: string;
      osVersion?: string;
      /**
       * Android only — the companion APK to `adb install -r`. iOS has no
       * install step here: the companion is a simulator build the user already
       * installed, and its presence is gated by `checkNativeReadiness` instead.
       */
      apkPath?: string;
      port: number;
    };

/** Success/failure of native auto-discovery — failure carries what WAS found for the error. */
export type NativeDiscovery =
  | {
      ok: true;
      deviceId: string;
      deviceName: string;
      /** OS/runtime version when the platform reports one (iOS only today). */
      osVersion?: string;
      port: number;
      /** Android only — undefined on iOS, where nothing is installed from disk. */
      apk: DiscoveredApk | undefined;
      /** Other running devices we did NOT pick (logged so the choice is auditable). */
      alternatives: BootedDevice[];
    }
  | { ok: false; devices: BootedDevice[]; apk: DiscoveredApk | undefined };

/**
 * Which runtime a `runtime: native` spec verifies on. Single-sourced with the
 * MCP server's native path (`config.native.target`, iOS by default) so the CI
 * sweep and the interactive tool target the SAME device family — they used to
 * disagree, and the sweep's hardcoded `android` made every native spec on an
 * iOS-only machine unverifiable no matter what was booted.
 */
export function resolveNativePlatform(config: ValidityConfig): 'ios' | 'android' {
  return config.native?.target === 'android' ? 'android' : 'ios';
}

/**
 * Auto-discover a native verify target when the user passed NEITHER
 * `--native-avd` nor `--native-apk`: an already-RUNNING device (adb on Android,
 * `simctl` on iOS) plus — on Android only — the newest companion APK on disk.
 * This attaches to the user's live device: it never boots a simulator/emulator
 * and never tears one down. With more than one device running we pick the first
 * and report the rest. Returns a resolved plan on success, or the raw findings
 * so the caller can print an actionable "what was / wasn't found" error.
 *
 * iOS deliberately has no APK requirement. The companion is a simulator build
 * that `validity browse --native` installs onto the device; there is no
 * artifact on disk to rank by recency, so the "is it actually there?" question
 * is answered by `checkNativeReadiness` at run time instead.
 */
export async function discoverNativeRun(
  projectRoot: string,
  platform: 'ios' | 'android',
  portOverride: number | undefined,
  run: CommandRunner,
): Promise<NativeDiscovery> {
  const devices = await listBootedDevices(platform, run);
  if (platform === 'ios') {
    const chosen = devices[0];
    if (!chosen) return { ok: false, devices, apk: undefined };
    return {
      ok: true,
      deviceId: chosen.id,
      deviceName: chosen.name,
      ...(chosen.osVersion ? { osVersion: chosen.osVersion } : {}),
      // Simulators are addressed by udid; there is no console port to parse.
      port: 0,
      apk: undefined,
      alternatives: devices.slice(1),
    };
  }
  const apk = findNewestApk(projectRoot);
  if (devices.length === 0 || !apk) {
    return { ok: false, devices, apk };
  }
  const chosen = devices[0]!;
  // Console port: an explicit --native-port wins; else parse it from an
  // `emulator-<port>` serial; else default 5554 (a physical-device serial has
  // no port — the device is addressed by its serial regardless).
  const portMatch = /^emulator-(\d+)$/.exec(chosen.id);
  const port = portOverride ?? (portMatch ? Number(portMatch[1]) : 5554);
  return {
    ok: true,
    deviceId: chosen.id,
    deviceName: chosen.name,
    // Same provenance the iOS branch above forwards. Omitting it here meant
    // Android run-meta carried platform/deviceId/deviceName but never an OS
    // version — even once listBootedDevices started probing for one — so
    // Android screenshots stayed unattributable to the OS that drew them
    // while iOS ones were not. Verified against a live emulator (Android 15).
    ...(chosen.osVersion ? { osVersion: chosen.osVersion } : {}),
    port,
    apk,
    alternatives: devices.slice(1),
  };
}

/** Human-readable "built Nm ago" from an APK mtime (for the discovery notice). */
function formatApkAge(mtimeMs: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/* ------------------------------------------------------------------ *
 * Automated judge (--judge): fold soft scores into the results.       *
 * ------------------------------------------------------------------ */

/** Annotate every soft criterion with WHY it wasn't judged (it stays skipped). */
function annotateSoftUnjudged(runs: VerifyAllRun[], reason: string): void {
  for (const run of runs) {
    for (const c of run.results.criteria) {
      if (c.tier === 'soft') c.detail = `soft criterion — ${reason}`;
    }
  }
}

/** Fold one run's judge outcome into its SpecResult soft criteria. */
function foldJudgeOutcome(result: SpecResult, outcome: JudgeSpecOutcome, modelLabel: string): void {
  const byId = new Map((outcome.scores ?? []).map((s) => [s.id, s]));
  for (const c of result.criteria) {
    if (c.tier !== 'soft') continue;
    const scored = outcome.status === 'judged' ? byId.get(c.id) : undefined;
    if (scored) {
      c.status = scored.status;
      c.detail = `model-judged (${modelLabel})${scored.score != null ? ` · score ${scored.score}` : ''}`;
    } else {
      // Judge unavailable for this run, or this criterion was rejected/omitted —
      // it stays `skipped` (never a pass) with the reason attached.
      const why =
        outcome.status === 'skipped'
          ? (outcome.reason ?? 'judge unavailable')
          : 'not scored by the judge';
      c.status = 'skipped';
      c.detail = `soft criterion — judge did not score it (${why})`;
    }
  }
}

/**
 * Persist the standing state a `verify --all` sweep just recomputed — but only
 * when this machine OWNS that state (B4).
 *
 * `local`: the sweep IS the tick. Nothing else is going to write the scorecard
 * on a developer's machine that runs `validity verify --all` and never starts
 * `watch`, so refusing to save left the dashboard reading verdicts from
 * whenever `watch` was last open — the numbers were real, just old.
 *
 * `ci`: read-only, unchanged. A CI checkout is a disposable clone of one
 * commit; writing standings there would either be thrown away with the runner
 * or, worse, committed back and clobber the trunk's history with a single
 * branch's view. CI's job is the exit code and the artifact.
 *
 * Best-effort: a read-only or full disk must not fail a sweep that already
 * produced its verdicts. Returns whether it wrote, so the caller can decide
 * what to tell the user.
 */
export function persistStandingsForOrigin(args: {
  projectRoot: string;
  origin: RunOrigin;
  scorecard: Scorecard;
  signals: Signal[];
}): boolean {
  const { projectRoot, origin, scorecard, signals } = args;
  if (origin !== 'local') return false;
  try {
    saveScorecard(projectRoot, scorecard);
    // Signals ride along. The scorecard says what the state IS; the signal
    // queue says what to do about it, and saving one without the other is how
    // you get a red row nobody is asked to fix.
    saveSignals(projectRoot, mergeSignals(loadSignals(projectRoot), signals));
    return true;
  } catch (err) {
    process.stderr.write(
      pc.yellow(`warning: could not persist standings: ${(err as Error).message}\n`),
    );
    return false;
  }
}

/**
 * Score soft criteria with the automated judge and fold the results into the
 * in-memory SpecResults. Seeds+saves the scorecard from the mechanical
 * observations first (so runJudge folds soft onto the recorded hard/property
 * verdicts, matching record_soft_scores' precondition). A missing config/key
 * annotates every soft criterion with the reason rather than judging — never a
 * pass. Never touches the exit gate (hard/property-only).
 */
async function runJudgeForVerifyAll(args: {
  projectRoot: string;
  config: ValidityConfig;
  runs: VerifyAllRun[];
  sha: string | null;
}): Promise<void> {
  const { projectRoot, config, runs, sha } = args;
  const judgeModel = config.scoring?.judgeModel;
  if (!judgeModel) {
    annotateSoftUnjudged(runs, 'judge not run: no scoring.judgeModel configured');
    process.stderr.write(
      pc.yellow(
        '--judge: no scoring.judgeModel configured in .validity/config.ts — soft criteria left unscored.\n',
      ),
    );
    return;
  }
  const apiKey = readJudgeApiKey(judgeModel);
  if (!apiKey) {
    const env = judgeApiKeyEnv(judgeModel);
    annotateSoftUnjudged(runs, `judge not run: ${env} is not set`);
    process.stderr.write(
      pc.yellow(`--judge: ${env} is not set — soft criteria left unscored (never a pass).\n`),
    );
    return;
  }

  // Seed+save the scorecard from this run's mechanical verdicts so the judge can
  // fold soft scores onto recorded hard/property verdicts.
  //
  // The SIGNALS this reconcile produced are persisted too (B4). They used to be
  // dropped on the floor: the judge branch saved the scorecard but never called
  // `saveSignals`, so a regression this sweep detected updated the score while
  // the signal queue — what the dashboard and `validity signals` read — never
  // heard about it.
  const observations = toSpecObservations(runs.map((r) => ({ spec: r.spec, results: r.results })));
  const now = new Date().toISOString();
  const { scorecard, signals } = reconcileScorecard({
    prev: loadScorecard(projectRoot),
    observations,
    now,
    sha: sha ?? undefined,
  });
  saveScorecard(projectRoot, scorecard);
  try {
    saveSignals(projectRoot, mergeSignals(loadSignals(projectRoot), signals));
  } catch {
    // best-effort — a signal-queue write failure must not abort the judge run
  }

  const modelLabel = `${judgeModel.provider}/${judgeModel.model}`;
  let judged = 0;
  let skipped = 0;
  let pass = 0;
  let fail = 0;
  let unver = 0;
  for (const run of runs) {
    if (!run.meta) continue;
    let outcome: JudgeSpecOutcome | undefined;
    try {
      const { outcomes } = await runJudge({
        projectRoot,
        runId: run.meta.runId,
        config,
        apiKey,
        onFailure: 'return',
      });
      outcome = outcomes[0];
    } catch (err) {
      outcome = {
        specId: run.spec.id,
        runId: run.meta.runId,
        status: 'skipped',
        reason: (err as Error).message,
      };
    }
    if (!outcome) continue;
    foldJudgeOutcome(run.results, outcome, modelLabel);
    if (outcome.status === 'judged') {
      // runJudge rewrote the run-meta on disk (scoring provenance, refreshed
      // signedOff, judged soft criterionVerdicts). Refresh our in-memory copy so
      // the report/check-metadata built below reflect the judged result rather
      // than the stale pre-judge meta.
      const refreshed = readRunMeta(projectRoot, run.meta.runId);
      if (refreshed) run.meta = refreshed;
      judged += 1;
      pass += outcome.scores?.filter((s) => s.status === 'pass').length ?? 0;
      fail += outcome.scores?.filter((s) => s.status === 'fail').length ?? 0;
      unver += outcome.scores?.filter((s) => s.status === 'unverifiable').length ?? 0;
    } else if (outcome.status === 'skipped') {
      skipped += 1;
      process.stderr.write(pc.yellow(`--judge: ${run.spec.id} skipped — ${outcome.reason}\n`));
    }
  }
  if (judged > 0 || skipped > 0) {
    process.stderr.write(
      pc.dim(
        `--judge (${modelLabel}): scored ${judged} spec${judged === 1 ? '' : 's'} ` +
          `(${pass} pass, ${fail} fail, ${unver} unverifiable)` +
          (skipped > 0 ? `; ${skipped} skipped` : '') +
          '. Soft scores are advisory — the exit gate stays hard/property-only.\n',
      ),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Orchestrator (impure — boots the sandbox).                          *
 * ------------------------------------------------------------------ */

export async function runVerifyAll(opts: VerifyAllOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const reportKind = normalizeReportKind(opts.report);

  let config;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(1);
    return;
  }

  const allSpecs = listSpecs(projectRoot, (id, err) =>
    process.stderr.write(pc.yellow(`warning: skipping malformed spec ${id}: ${err.message}\n`)),
  );

  // A PRESENT `specs` array (even when empty) is an explicit selection — only
  // an ABSENT one falls through to --changed / the full sweep. Keying off
  // presence (not `.length`) keeps a present-but-empty list from silently
  // expanding to the full frozen sweep.
  const mode: SelectSpecsArgs['mode'] =
    opts.specs != null ? 'explicit' : opts.changed ? 'changed' : 'all';

  const changedFiles = mode === 'changed' ? workingTreeChanges(projectRoot) : undefined;
  const selection = selectSpecsForRun({
    specs: allSpecs,
    mode,
    explicitIds: opts.specs,
    changedFiles,
    // resolveTarget intentionally omitted — mapChangedFilesToSpecs falls back to
    // basename matching (component name ↔ changed file's basename). A scanning
    // resolver is a documented follow-up.
  });
  const skipped = selection.skipped;
  // A requested `--specs` id that resolved to nothing is a FALSE-GREEN risk: CI
  // pinned to a since-renamed/deleted spec would otherwise verify nothing and
  // exit 0. Track unmatched explicit ids so the gate fails on them (empty or
  // partial selection) rather than silently green-lighting the build.
  const explicitNotFound =
    mode === 'explicit' ? skipped.filter((s) => /not found/i.test(s.reason)) : [];
  // Split web vs. native: web specs render through the Vite sandbox; native
  // specs need a booted emulator + the companion + the WS bridge. With
  // `opts.native` the CI native path boots an emulator and verifies them
  // on-device below; WITHOUT it, native specs HARD-FAIL (see next block) rather
  // than being silently dropped.
  const nativeSelected = selection.selected.filter((s) => s.runtime === 'native');
  const webSelected = selection.selected.filter((s) => s.runtime !== 'native');
  // Which device family native specs verify on — iOS unless config opts into
  // Android, matching the MCP native path's default.
  const nativePlatform = resolveNativePlatform(config);

  // GATE INTEGRITY: native specs selected without an emulator config are NOT
  // dropped — they're recorded as build-failing errors after the web loop (see
  // the `nativeSelected.length > 0 && !opts.native` block below) so the gate
  // still fails. We deliberately do NOT early-exit here: doing so aborted the
  // run before the WEB specs were verified + reported, so a mixed web+native
  // repo saw no web results and its web regressions were masked behind the
  // native message. A native-only selection can't slip through the exit-0
  // empty-selection return either — that only fires when BOTH runtimes are
  // empty, and a native spec keeps nativeSelected non-empty.

  if (skipped.length > 0) {
    for (const s of skipped) {
      process.stderr.write(pc.dim(`skip ${s.id}: ${s.reason}\n`));
    }
  }

  // Nothing to verify in either runtime → not a regression, exit 0.
  if (webSelected.length === 0 && nativeSelected.length === 0) {
    process.stderr.write(
      pc.yellow(
        mode === 'changed'
          ? 'No frozen specs map to the current working-tree changes — nothing to verify.\n'
          : mode === 'explicit'
            ? 'None of the requested spec ids were found.\n'
            : 'No frozen specs to verify. Freeze a spec first (`validity spec freeze <id>`).\n',
      ),
    );
    // EXPLICIT mode with nothing selected is a FAILURE, not a no-op: the caller
    // named specs (a CI gate) and none resolved — exiting 0 would verify nothing
    // yet pass. `changed`/`all` with an empty selection stay exit 0 (an unrelated
    // change legitimately maps to nothing).
    if (mode === 'explicit') {
      process.exit(1);
    }
    // Empty selection is not a regression — exit 0 so CI on an unrelated change
    // doesn't fail. The skip reasons above explain why nothing ran.
    return;
  }

  const totalSelected = webSelected.length + nativeSelected.length;

  let verifyLock: ReturnType<typeof acquireVerifyLock>;
  try {
    verifyLock = acquireVerifyLock(projectRoot, { owner: 'verify-all' });
  } catch (err) {
    if (err instanceof VerifyLockHeldError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
      return;
    }
    throw err;
  }

  try {
    await runVerifyAllHeld(opts, {
      projectRoot,
      config,
      reportKind,
      allSpecs,
      mode,
      explicitNotFound,
      nativeSelected,
      webSelected,
      nativePlatform,
      totalSelected,
    });
  } finally {
    verifyLock.release();
  }
}

async function runVerifyAllHeld(
  opts: VerifyAllOptions,
  ctx: {
    projectRoot: string;
    config: ValidityConfig;
    reportKind: ReturnType<typeof normalizeReportKind>;
    allSpecs: Spec[];
    mode: SelectSpecsArgs['mode'];
    explicitNotFound: ReturnType<typeof selectSpecsForRun>['skipped'];
    nativeSelected: Spec[];
    webSelected: Spec[];
    nativePlatform: ReturnType<typeof resolveNativePlatform>;
    totalSelected: number;
  },
): Promise<void> {
  const {
    projectRoot,
    config,
    reportKind,
    allSpecs,
    mode,
    explicitNotFound,
    nativeSelected,
    webSelected,
    nativePlatform,
    totalSelected,
  } = ctx;

  if (mode === 'all') {
    process.stderr.write(
      pc.dim(
        `Verifying ${totalSelected} frozen spec${totalSelected === 1 ? '' : 's'}. ` +
          'Note: screenshot short-circuit is now available (opt-in, applied on the ' +
          'render path — skips the screenshot only when a render errored or every ' +
          'mechanical verdict failed, never on green). Tier-aware scheduling is still ' +
          'a documented follow-up — every selected spec runs in full.\n',
      ),
    );
  }

  const results: SpecResult[] = [];
  // Per-spec run details kept for the report.html build (screenshots + meta).
  const runs: VerifyAllRun[] = [];
  // Armed for the whole execution phase: if the process exits 0 before every
  // planned spec produced a result, the sentinel converts that silent death
  // into a loud UNFINISHED + EXIT_UNFINISHED. Disarmed right before the gate.
  const planSentinel = armPlanSentinel(totalSelected, () => results.length);
  // Per-spec temporal-binding classification (B2): display-only provenance —
  // it rides SpecResult/CheckSpecSummary and the report header pill, never the
  // exit gate. A run without a persisted meta has no verify sha ⇒ `unknown`.
  const classifyTemporal = (spec: Spec, meta: RunMeta | null): TemporalClassification =>
    resolveTemporalBinding({
      projectRoot,
      freeze: spec.git,
      meta: meta ?? { git: undefined, diff: { files: [] } },
    }).classification;
  // ONE `expect.command` runner per CLI invocation, shared across web AND
  // native specs: ten specs referencing `typecheck` run `tsc` once.
  const commandRunner = new CommandCheckRunner();
  for (const spec of webSelected) {
    const v = await verifyOneSpec(projectRoot, config, spec, { commandRunner });
    // Dep pre-scan abort is an INFRA failure, not a verdict: the `dep-scan`
    // evidence taints already demote this run's passes to unverifiable, but
    // unverifiable alone never trips the gate — record it as the spec's error
    // so CI goes red and the message names the stray import to fix.
    // The session-level environment record is the source of truth. The
    // per-render `find()` is the LEGACY fallback and stays only because
    // run-metas are durable evidence: a run written before the environment
    // channel carries the failure on its renders alone, and dropping the read
    // would make those runs report clean — a false green.
    const depScanFailure =
      v.meta?.environment?.depScanFailure ??
      v.meta?.components?.find((c) => c.depScanFailure)?.depScanFailure;
    const specResult: SpecResult = {
      specId: spec.id,
      version: spec.version,
      error:
        v.error ?? (depScanFailure ? `dependency pre-scan aborted: ${depScanFailure}` : undefined),
      temporal: classifyTemporal(spec, v.meta),
      criteria: aggregateVerdicts(spec, v.mechanical),
    };
    results.push(specResult);
    runs.push({ spec, meta: v.meta, results: specResult });
  }

  // Native specs: resolve HOW to run them, then run each on-device through the
  // SAME aggregateVerdicts/exit gate as web. Two ways in:
  //   - explicit --native-avd/--native-apk → boot a fresh emulator (we own it,
  //     so we tear it down in `finally`);
  //   - NEITHER flag → auto-discover the user's already-running device + newest
  //     companion APK, attach to it, and NEVER tear it down (it isn't ours).
  // A native spec that nothing can verify is NEVER dropped: an unresolvable
  // selection, a boot/install throw, or a non-confirmed render each records the
  // spec as a build-failing `error` (which trips the exit gate below). This all
  // runs AFTER the web loop, so a mixed web+native repo still verifies + reports
  // its web specs instead of an early exit masking them.
  let nativePlan: ResolvedNativeRun | undefined;
  if (nativeSelected.length > 0) {
    if (opts.native) {
      nativePlan = { mode: 'boot', ...opts.native };
    } else {
      const discovery = await discoverNativeRun(
        projectRoot,
        nativePlatform,
        opts.nativePort,
        opts.nativeDeviceRunner ?? defaultRunner,
      );
      if (discovery.ok) {
        const deviceLabel = nativePlatform === 'ios' ? 'iOS Simulator' : 'Android device';
        const noticeLines = [
          `Auto-detected a running ${deviceLabel} — verifying ${nativeSelected.length} native ` +
            `spec${nativeSelected.length === 1 ? '' : 's'} against it (nothing booted, nothing torn down):`,
          `  device: ${discovery.deviceId}` +
            (discovery.deviceName && discovery.deviceName !== discovery.deviceId
              ? ` (${discovery.deviceName})`
              : ''),
        ];
        if (discovery.apk) {
          noticeLines.push(
            `  APK:    ${relative(projectRoot, discovery.apk.path)} ` +
              `(built ${formatApkAge(discovery.apk.mtimeMs)})`,
          );
        }
        if (discovery.alternatives.length > 0) {
          noticeLines.push(
            `  note:   ${discovery.alternatives.length} other running ` +
              `device${discovery.alternatives.length === 1 ? '' : 's'} ` +
              `(${discovery.alternatives.map((d) => d.id).join(', ')}) — chose ${discovery.deviceId}.`,
          );
        }
        if (nativePlatform === 'android') {
          noticeLines.push(
            '  Pass --native-avd=<name> --native-apk=<path> to override (boots a fresh emulator instead).',
          );
        }
        process.stderr.write(pc.dim(noticeLines.join('\n') + '\n'));
        nativePlan = {
          mode: 'discovered',
          platform: nativePlatform,
          deviceId: discovery.deviceId,
          deviceName: discovery.deviceName,
          osVersion: discovery.osVersion,
          apkPath: discovery.apk?.path,
          port: discovery.port,
        };
      } else {
        // Nothing to attach to and no fresh APK: say exactly what was / wasn't
        // found, keep the explicit-flags escape hatch, and record each native
        // spec as a build-failing error so the gate stays red.
        const isIos = nativePlatform === 'ios';
        const found: string[] = [];
        if (discovery.devices.length === 0) {
          found.push(
            isIos
              ? 'no booted iOS Simulator (`xcrun simctl list devices booted` showed none)'
              : 'no running Android device (adb devices showed none)',
          );
        } else {
          found.push(
            `${discovery.devices.length} running ` +
              `device${discovery.devices.length === 1 ? '' : 's'} ` +
              `(${discovery.devices.map((d) => d.id).join(', ')})`,
          );
        }
        // The APK line is Android-only vocabulary — on iOS there is no artifact
        // on disk to look for, so reporting "no companion APK" would send the
        // reader chasing a file that is never supposed to exist.
        if (!isIos) {
          found.push(
            discovery.apk
              ? `APK ${relative(projectRoot, discovery.apk.path)}`
              : `no companion APK under ${relative(projectRoot, defaultCompanionApkRoots(projectRoot)[0]!)}`,
          );
        }
        process.stderr.write(
          pc.red(
            `${nativeSelected.length} native spec${nativeSelected.length === 1 ? '' : 's'} selected ` +
              `(${nativeSelected.map((s) => s.id).join(', ')}) but auto-discovery could not find a ` +
              `${isIos ? 'booted simulator' : 'running device + companion APK'} to verify them on.\n`,
          ) +
            pc.dim(
              `  auto-discovery found: ${found.join('; ')}.\n` +
                (isIos
                  ? '  Fix: boot an iOS Simulator (`xcrun simctl boot <udid>` or open Simulator.app)\n' +
                    '  AND install the companion (`validity browse --native`), then re-run.\n' +
                    '  Verifying on Android instead? Set `native: { target: "android" }` in\n' +
                    '  .validity/config.ts, or pass --native-avd=<name> --native-apk=<path>.\n'
                  : '  Fix: boot an Android emulator (or plug in a device) AND build the companion\n' +
                    '  (`validity browse --native`), then re-run — or pass --native-avd=<name>\n' +
                    '  --native-apk=<path> to boot a fresh emulator and install a specific APK.\n') +
                '  They are NOT skipped: a native spec that nothing verifies must fail the build.\n',
            ),
        );
        const message = isIos
          ? 'native spec not verified: no booted iOS Simulator auto-discovered'
          : 'native spec not verified: no running device + companion APK auto-discovered, ' +
            'and no --native-avd/--native-apk given';
        // CONFIRMED, and constructed rather than probed: auto-discovery IS the
        // observation — it enumerated devices and found none to attach to.
        // Running the environment probes here would be theatre (there is no
        // session to have decayed) and could report a misleading second cause.
        const noDeviceDiagnosis: EnvironmentDiagnosis = {
          cause: 'device-not-ready',
          symptom: `Auto-discovery found: ${found.join('; ')}.`,
          detail:
            'No device could be attached to, so nothing was rendered and no criterion was scored ' +
            'for any native spec in this run. These specs are NOT skipped — a native spec that ' +
            'nothing verifies fails the build — but the failure is environmental, not a code ' +
            'regression.',
          fixCommand: isIos
            ? 'xcrun simctl boot <udid>   # or open Simulator.app\nvalidity browse --native'
            : 'emulator -avd <name>   # or plug in a device; then `adb devices`\nvalidity browse --native',
          confidence: 'confirmed',
        };
        for (const spec of nativeSelected) {
          const specResult: SpecResult = {
            specId: spec.id,
            version: spec.version,
            error: message,
            diagnosis: noDeviceDiagnosis,
            temporal: classifyTemporal(spec, null),
            criteria: aggregateVerdicts(spec, []),
          };
          results.push(specResult);
          runs.push({ spec, meta: null, results: specResult });
        }
      }
    }
  }

  if (nativePlan) {
    // `booted` is set ONLY on the explicit boot path — the finally tears down
    // exactly what we booted and leaves an auto-discovered device untouched.
    let booted: BootedEmulator | undefined;
    try {
      let deviceId: string;
      let port: number;
      // The boot path is Android-only (it shells out to `emulator -avd`), so a
      // booted plan is always Android regardless of the configured target.
      const runPlatform: 'ios' | 'android' =
        nativePlan.mode === 'boot' ? 'android' : nativePlan.platform;
      if (nativePlan.mode === 'boot') {
        booted = await bootAndroidEmulator({
          avdName: nativePlan.avdName,
          port: nativePlan.port,
          bootTimeoutSec: nativePlan.bootTimeoutSec,
          onLog: (line) => process.stderr.write(pc.dim(`[emulator] ${line}\n`)),
        });
        deviceId = booted.deviceId;
        port = booted.port;
      } else {
        deviceId = nativePlan.deviceId;
        port = nativePlan.port;
      }
      // Confirm the companion is actually ON this device BEFORE rendering, and
      // install it only when it is NOT — one gate, both platforms.
      //
      // The unconditional `adb install -r` this replaces was the single cause of
      // "every Android verify starts on the dev-launcher home". Reinstalling a
      // package force-stops it (`Force stopping … installPackageLI` → `pkg
      // removed` in logcat), so every run killed a perfectly good companion; the
      // deep link then cold-started MainActivity, expo-dev-launcher redirected to
      // its own server-picker activity because no bundle was loaded, and every
      // rung of the open ladder timed out against that screen. On the `boot`
      // path the install is still unconditional and still right — that emulator
      // is fresh and has nothing installed — but on the `discovered` path
      // (attach to the developer's running emulator) the companion is normally
      // already there and current, and reinstalling it only destroys state.
      if (nativePlan.mode === 'boot') {
        // We booted this emulator seconds ago — nothing is installed on it, so
        // probing first would only be a slower way to reach the same install.
        await installCompanion({ apkPath: nativePlan.apkPath, deviceId });
      } else {
        const identity = companionBuildIdentity({ projectRoot, config, platform: runPlatform });
        const readiness = await checkNativeReadiness({
          projectRoot,
          platform: runPlatform,
          scheme: identity.scheme,
          bundleId: identity.bundleId,
          device: deviceId,
          buildHash: identity.buildHash,
          buildMarkerPath: identity.buildMarkerPath,
          buildInputs: identity.buildInputs,
        });
        // The companion-app step alone decides whether to install.
        // `readiness.ready` is deliberately NOT the gate: it also covers
        // agent-device's version, the adb reverse forward and Metro, none of
        // which installing an APK would fix, and treating those as a hard
        // failure here would convert today's honest degrade into a new class of
        // red build.
        const companionCurrent =
          readiness.steps.find((s) => s.id === 'companion-app')?.status === 'ok';
        if (!companionCurrent) {
          if (nativePlan.apkPath) {
            await installCompanion({ apkPath: nativePlan.apkPath, deviceId });
          } else {
            // No artifact on disk to install from (always the case on iOS): the
            // only honest move is to name the missing prerequisite and its fix,
            // rather than render against a device that cannot answer and
            // surface an opaque `render not confirmed`.
            throw new Error(
              `companion not ready on ${deviceId}: ` +
                `${readiness.nextAction?.label ?? 'unmet prerequisite'}` +
                (readiness.nextAction?.action ? ` — ${readiness.nextAction.action}` : ''),
            );
          }
        }
      }
      for (const spec of nativeSelected) {
        const v = await verifyOneSpecNative(
          projectRoot,
          config,
          spec,
          {
            deviceId,
            port,
            platform: runPlatform,
            ...(nativePlan.mode === 'discovered' && nativePlan.deviceName
              ? { deviceName: nativePlan.deviceName }
              : {}),
            ...(nativePlan.mode === 'discovered' && nativePlan.osVersion
              ? { osVersion: nativePlan.osVersion }
              : {}),
          },
          { commandRunner },
        );
        const specResult: SpecResult = {
          specId: spec.id,
          version: spec.version,
          error: v.error,
          // Carried straight through from the native engine's failure paths
          // (Metro down / render unconfirmed / thrown capture).
          ...(v.diagnosis ? { diagnosis: v.diagnosis } : {}),
          temporal: classifyTemporal(spec, v.meta),
          criteria: aggregateVerdicts(spec, v.mechanical),
        };
        results.push(specResult);
        runs.push({ spec, meta: v.meta, results: specResult });
      }
    } catch (err) {
      // Boot or install failed before (or during) per-spec verify: every native
      // spec that didn't already get a result is a build-failing render error.
      const message = `native verify infrastructure failed: ${(err as Error).message}`;
      // Best-effort attribution for the whole batch. The thrown text goes in as
      // `openErrorText` so the agent-device signatures (phantom claim, a session
      // bound to the other platform, the exit-127 stale-open) are recognized
      // rather than reduced to an infrastructure shrug. Never throws — a probe
      // failure here must not replace a legible error with a stack trace.
      const infraDiagnosis = await diagnoseNativeEnvironment({
        projectRoot,
        platform: nativePlatform,
        openErrorText: (err as Error).message,
      }).catch(() => undefined);
      const done = new Set(results.map((r) => r.specId));
      for (const spec of nativeSelected) {
        if (done.has(spec.id)) continue;
        const specResult: SpecResult = {
          specId: spec.id,
          version: spec.version,
          error: message,
          ...(infraDiagnosis ? { diagnosis: infraDiagnosis } : {}),
          temporal: classifyTemporal(spec, null),
          criteria: aggregateVerdicts(spec, []),
        };
        results.push(specResult);
        runs.push({ spec, meta: null, results: specResult });
      }
    } finally {
      // ORDER IS THE POINT. The session has to go back to the daemon while the
      // DEVICE still exists: closing releases the device claim, and killing the
      // emulator first leaves the daemon holding a claim against a device that
      // is gone — the claim file that the next run's readiness pass reports as
      // a phantom. Best-effort and non-throwing, so teardown can never change
      // the verdict this sweep already reached.
      await closeEstablishedNativeSessions();
      // Only tear down an emulator WE booted. In discovered mode we attached to
      // the user's already-running device — killing it would be hostile.
      if (booted) await teardownEmulator(booted);
    }
  }

  // --judge: after the mechanical sweep, score soft criteria with the automated
  // LLM judge. Runs BEFORE any output is rendered so the table / report /
  // check-metadata reflect the judged scores. On ANY judge failure the soft
  // criteria stay `skipped` with a reason — never a pass, never a silent drop —
  // and the exit gate below stays hard/property-only regardless.
  if (opts.judge) {
    const sha0 = headSha(projectRoot) ?? runs.find((r) => r.meta?.git)?.meta?.git?.sha ?? null;
    await runJudgeForVerifyAll({ projectRoot, config, runs, sha: sha0 });
  }

  const rendered =
    reportKind === 'junit'
      ? toJUnit(results)
      : reportKind === 'markdown'
        ? formatMarkdown(results)
        : formatTable(results);
  if (opts.out) {
    const dest = resolve(projectRoot, opts.out);
    writeFileSync(dest, rendered);
    process.stdout.write(pc.dim(`Wrote ${reportKind} report to ${opts.out}.\n`));
  } else {
    process.stdout.write(rendered);
  }

  // Baseline lifecycle sweep (W5 #18). Compare the baselines on disk against the
  // keys this cycle actually rendered, so a renamed component / re-slugged
  // variant surfaces as a `validity accept` migration offer instead of silently
  // self-establishing a new baseline (regression baked in with a zero diff).
  // ONLY on a FULL, error-free `all` run: a `changed`/explicit subset — or a run
  // where a spec failed to render — doesn't render the whole key set, so every
  // un-rendered key would masquerade as an orphan. Advisory: never gates.
  if (mode === 'all' && results.length > 0 && results.every((r) => !r.error)) {
    const renderKeys = runs.flatMap((r) =>
      (r.meta?.components ?? [])
        .filter((c) => !c.renderError && c.screenshotPath)
        .map((c) => basename(c.screenshotPath, '.png')),
    );
    const advisory = formatBaselineLifecycleAdvisory(
      sweepBaselineLifecycle(projectRoot, renderKeys),
    );
    if (advisory) process.stderr.write(pc.yellow(`\nBaseline drift:\n${advisory}\n`));
  }

  // Side-output: a Markdown summary written from the SAME run (for
  // $GITHUB_STEP_SUMMARY). Appended so it composes with other CI summary
  // sections rather than clobbering them.
  if (opts.summary) {
    try {
      appendFileSync(resolve(projectRoot, opts.summary), formatMarkdown(results));
    } catch (err) {
      process.stderr.write(
        pc.yellow(`warning: could not write summary: ${(err as Error).message}\n`),
      );
    }
  }

  // Every planned spec is expected to have produced a result by now — the
  // per-spec engine never throws (errors land on SpecResult.error), so a
  // shortfall means the loop above was cut short. A thrown abort exits 1 via
  // main()'s catch; an event-loop drain fires the sentinel from inside the
  // await. This explicit check is the belt-and-braces third leg: never grade
  // a partial plan.
  planSentinel.disarm();
  if (results.length < totalSelected) {
    process.stderr.write(pc.red(unfinishedRunMessage(results.length, totalSelected)));
    process.exit(EXIT_UNFINISHED);
  }

  const coverageCheck = checkCoverageFloor(results, config);
  const hardFail = hasHardFailure(results);
  const envBlocked = computeEnvBlocked(results);

  // ATTRIBUTION, never softening: a spec whose render/prepare failed before
  // any criterion ran already trips `hasHardFailure` above (and can breach
  // the coverage floor) — this block never changes that. It exists so a team
  // reading CI output can tell "the verification environment broke" apart
  // from "the code genuinely regressed" without digging through per-spec
  // errors.
  if (envBlocked) {
    const firstError = envBlocked.errors[0] ?? '';
    const moreErrors =
      envBlocked.errors.length > 1
        ? ` (+${envBlocked.errors.length - 1} more distinct error(s))`
        : '';
    process.stderr.write(
      pc.red(
        `\nENVIRONMENT BLOCKED — ${envBlocked.count} spec${envBlocked.count === 1 ? '' : 's'} ` +
          `produced no verdicts: ${firstError}${moreErrors}\n` +
          `This gate failure is environmental, not a code regression.\n`,
      ),
    );
    // The FULL fix recipe, not the one-line table suffix: this is the block a
    // developer reads when the sweep comes back empty, so the whole multi-line
    // reset command belongs here. One entry per distinct cause — N specs
    // sharing a root cause read as one instruction, not a wall.
    const shownCauses = new Set<string>();
    for (const c of envBlocked.causes ?? []) {
      if (shownCauses.has(c.cause)) continue;
      shownCauses.add(c.cause);
      process.stderr.write(pc.dim(`  cause: ${c.cause}\n`));
      if (c.fixCommand) {
        process.stderr.write(
          pc.dim(
            `  fix:\n${c.fixCommand
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n')}\n`,
          ),
        );
      }
    }
  }

  // --- Private report.html + check metadata (written BEFORE any non-zero exit:
  // a failing run is exactly the one whose report matters most). Neither leaves
  // the machine — the report stays in the project; the metadata is local.
  const coverage = computeCoverageMetrics(results);
  const specHash = combineSpecHashes([...webSelected, ...nativeSelected]);
  const pr = readPrContext();
  const repo = deriveRepo(projectRoot) ?? null;
  const sha = headSha(projectRoot) ?? runs.find((r) => r.meta?.git)?.meta?.git?.sha ?? null;

  // Per-run report.html by DEFAULT (Feature 1): every run that produced a
  // run-meta gets a self-contained report.html written into its run dir — the
  // exact path the dashboard's `/run/<runId>/report` route serves. A report
  // therefore ALWAYS exists after a sweep, not only when `--report-html` was
  // passed. Written BEFORE any non-zero exit (a failing run's report matters
  // most). Honors `report: false` (globally and per-run). The aggregate
  // `--report-html` below is unchanged, layered on top.
  if (resolveReportConfig(config.report).enabled) {
    let perRunWritten = 0;
    for (const run of runs) {
      if (!run.meta || run.meta.report?.enabled === false) continue;
      try {
        // Shared writer (issue #18): the same bake watch/judge/dashboard use,
        // fed this run's CLI-aggregated results (temporal chip + sign-off
        // provenance identical to the pre-extraction inline block).
        writeRunReportHtml({
          projectRoot,
          spec: run.spec,
          meta: run.meta,
          results: run.results,
          coverageFloorPercent: config.coverageFloorPercent,
        });
        perRunWritten += 1;
      } catch (err) {
        process.stderr.write(
          pc.yellow(
            `warning: could not render report.html for ${run.spec.id}: ${(err as Error).message}\n`,
          ),
        );
      }
    }
    if (perRunWritten > 0) {
      process.stdout.write(
        pc.dim(
          `Wrote ${perRunWritten} per-run report.html under .validity/runs/ ` +
            `(open the dashboard and follow /run/<runId>/report).\n`,
        ),
      );
    }
  }

  if (opts.reportHtml) {
    try {
      const firstGit = runs.find((r) => r.meta?.git)?.meta?.git;
      const input = buildVerifyAllReportInput({
        runs,
        git: firstGit
          ? { sha: firstGit.sha, branch: firstGit.branch, dirty: firstGit.dirty }
          : undefined,
        brand: 'validity',
        createdAt: new Date().toISOString(),
        viewCommand: `open ${opts.reportHtml}`,
      });
      // Coverage floor pass-through (C1): the report's "Not validated" line
      // shows the same floor the CLI gate below runs against.
      input.coverageFloorPercent = config.coverageFloorPercent;
      // Evidence map + scoring provenance now come from buildVerifyAllReportInput
      // itself (plan 1.4) — the merged self-scored/fresh-context pill and the
      // per-criterion chips ship with EVERY CLI report, not just judged ones.
      const dest = resolve(projectRoot, opts.reportHtml);
      writeFileSync(dest, renderHtmlReport(input));
      process.stdout.write(pc.dim(`Wrote report.html to ${opts.reportHtml}.\n`));
    } catch (err) {
      process.stderr.write(
        pc.yellow(`warning: could not render report.html: ${(err as Error).message}\n`),
      );
    }
  }

  // --- Standing state (B4).
  //
  // A sweep's mechanical results are a deterministic tick like any other, and
  // `verify --all` is an ATTENDED surface (a human or CI ran it deliberately),
  // so the fold below is the same one the MCP verify performs. The old comment
  // on this block claimed "a local `verify --all` must not dirty the user's
  // committed scorecard" — that premise is STALE: `ensureValidityGitignore`
  // gitignores scorecard.json, signals.json, watch-state.json and
  // specs/*/runs.jsonl, so a local save dirties nothing that is committed. It
  // does the opposite of harm: without it, a developer whose whole workflow is
  // `validity verify --all` never accumulates standing state at all.
  //
  // CI stays READ-ONLY, by origin: a CI workspace is ephemeral (the write would
  // be discarded), and its scorecard read is precisely the committed baseline
  // the PR-comment score delta is measured against — folding this run into it
  // first would compare the run against itself.
  const runOrigin = detectRunOrigin();
  const foldNow = new Date().toISOString();
  const verifyAllObservations = toSpecObservations(
    runs.map((r) => ({ spec: r.spec, results: r.results })),
  );
  const { scorecard: reconciledScorecard, signals: reconciledSignals } = reconcileScorecard({
    prev: loadScorecard(projectRoot),
    observations: verifyAllObservations,
    now: foldNow,
    sha: sha ?? undefined,
  });
  // Maturity weighting for the DISPLAYED score: derive every spec's level
  // fresh so the v2 pooled score never leans on a stale carried-forward cache.
  // Without this, a freshly bulk-onboarded probation spec that has never seen a
  // watch tick would weigh 0.9 (the uncached team floor) instead of 0 in the
  // very CI run that introduces it. Per-spec best-effort, like the tick's guard.
  const ciAssessments = new Map<string, MaturityAssessment>();
  for (const s of allSpecs) {
    try {
      // Evidence from THIS run's fold — the scorecard on disk predates the
      // verifications this very run performed.
      ciAssessments.set(
        s.id,
        assessSpecMaturity(projectRoot, s, config, reconciledScorecard.specs[s.id] ?? null),
      );
    } catch {
      // failed derivation — the cached/floored weight stands
    }
  }
  const { scorecard: foldedScorecard, signals: maturitySignals } = applyMaturityToScorecard({
    scorecard: reconciledScorecard,
    assessments: ciAssessments,
    now: foldNow,
    sha: sha ?? undefined,
  });
  // Probation clear: a bulk-created spec's first clean human-confirmed pass
  // lifts the marker. `verify --all` is an ATTENDED surface (CI or a human
  // running it locally). Best-effort: a clear failure must not fail the run
  // or dirty the check metadata — wrap and swallow.
  for (const obs of verifyAllObservations) {
    const spec = runs.find((r) => r.spec.id === obs.specId)?.spec;
    if (spec?.probation && observationConfirmsProbationClear(obs)) {
      try {
        clearSpecProbation({ projectRoot, specId: spec.id });
      } catch {
        // best-effort — the check metadata + exit gate are unaffected
      }
    }
  }
  if (
    persistStandingsForOrigin({
      projectRoot,
      origin: runOrigin,
      scorecard: foldedScorecard,
      signals: [...reconciledSignals, ...maturitySignals],
    })
  ) {
    process.stdout.write(pc.dim('Updated .validity/scorecard.json + signals.json (local run).\n'));
  }

  if (opts.checkOutput) {
    // Base-branch comparison (B3): reads each spec's local `runs.jsonl`
    // timeline, falling back to the committed `.validity/history/<specId>.jsonl`
    // feed (`historyCommitted: true`) so a fresh CI checkout with
    // `fetch-depth: 0` still resolves the base row. GITHUB_BASE_REF is only set
    // on PR events; an unresolvable merge-base (shallow clone, no git) omits
    // the section gracefully — never an error.
    let base: CheckBaseComparison | undefined;
    let mergeBase: string | undefined;
    if (pr.baseRef) {
      mergeBase = mergeBaseSha(projectRoot, pr.baseRef);
      if (mergeBase) base = buildCheckBaseComparison({ projectRoot, baseSha: mergeBase, runs });
    }
    // Validity Score for B3's PR-comment delta (F1), read off the fold
    // computed above. INFORMATIONAL — `pass`/`verdict` never read it.
    const foldedScore = computeValidityScore(foldedScorecard);
    // Base-branch score for the PR-comment delta (`base N · ▲/▼`) — resolved
    // from the committed score history at the merge-base sha, absent otherwise
    // (the renderer presence-gates the delta line). INFORMATIONAL, like
    // `current` above.
    const baseScore = mergeBase ? resolveBaseValidityScore(projectRoot, mergeBase) : undefined;
    // Frozen-spec census (W6 #23) — only meaningful in a git repo (`sha`
    // present). `untracked` counts frozen specs whose spec.yaml git doesn't
    // track: they're invisible to a fresh CI checkout, so the PR comment must
    // NOT let the committed denominator read as the whole contract.
    const frozenSpecs = allSpecs.filter((s) => s.status === 'frozen');
    const specCensus = sha
      ? {
          verified: runs.length,
          total: frozenSpecs.length,
          untracked: frozenSpecs.filter(
            (s) => !gitTracksPath(projectRoot, specPathFor(projectRoot, s.id)),
          ).length,
        }
      : undefined;
    const metadata = buildCheckMetadata({
      results,
      runs,
      gatePass: !hardFail && coverageCheck.pass,
      coveragePercent: coverage ? coverage.percent : null,
      repo,
      sha,
      specHash,
      branch: pr.branch,
      prNumber: pr.prNumber,
      enforcement: config.enforcement ?? 'advisory',
      base,
      validityScore: {
        current: foldedScore?.score ?? null,
        ...(baseScore !== undefined ? { base: baseScore } : {}),
        scoreVersion: VALIDITY_SCORE_VERSION,
      },
      specCensus,
      envBlocked,
    });
    try {
      writeFileSync(
        resolve(projectRoot, opts.checkOutput),
        JSON.stringify(metadata, null, 2) + '\n',
      );
      process.stdout.write(pc.dim(`Wrote check metadata to ${opts.checkOutput}.\n`));
    } catch (err) {
      process.stderr.write(
        pc.yellow(`warning: could not write check metadata: ${(err as Error).message}\n`),
      );
    }
  }

  // Advisory maturity floor (maturity Phase D). WARNS only — never a gate:
  // gating on maturity would incentivize deleting specs, and the PR-comment
  // census already covers "how much contract exists". A spec below the floor
  // gets a stderr line once it has sat there past the grace window.
  if (config.minimumMaturity) {
    const RANK: Record<'probation' | 'dev' | 'team' | 'certified', number> = {
      probation: 0,
      dev: 1,
      team: 2,
      certified: 3,
    };
    const GRACE_DAYS = 7;
    const nowMs = Date.now();
    const floor = config.minimumMaturity;
    // One committed-scorecard read for the whole loop (the wiring would
    // otherwise reload it per spec).
    const floorScorecard = loadScorecard(projectRoot);
    for (const s of allSpecs) {
      if (s.status === 'superseded') continue;
      const level = assessSpecMaturity(
        projectRoot,
        s,
        config,
        floorScorecard?.specs[s.id] ?? null,
      ).level;
      if (RANK[level] >= RANK[floor]) continue;
      const sinceMs = Date.parse(s.updatedAt ?? s.createdAt);
      const ageDays = Number.isNaN(sinceMs) ? Infinity : (nowMs - sinceMs) / 86_400_000;
      if (ageDays <= GRACE_DAYS) continue;
      process.stderr.write(
        pc.yellow(
          `maturity floor (advisory): ${s.id} is '${level}' — below minimumMaturity '${floor}' ` +
            `and unchanged for ${Number.isFinite(ageDays) ? Math.floor(ageDays) : '?'} days. ` +
            `\`validity spec show ${s.id}\` lists its path up the ladder. Never fails the gate.\n`,
        ),
      );
    }
  }

  if (hardFail || !coverageCheck.pass || explicitNotFound.length > 0) {
    if (!hardFail && coverageCheck.reason) {
      process.stderr.write(pc.yellow(`coverage floor not met: ${coverageCheck.reason}\n`));
    }
    if (explicitNotFound.length > 0) {
      // A partial explicit run: some requested ids matched and verified, but
      // others didn't exist. Fail the gate — the caller didn't get what it asked
      // for, and a renamed/deleted spec must not slip through as green.
      process.stderr.write(
        pc.red(
          `requested spec id(s) not found: ${explicitNotFound.map((s) => s.id).join(', ')} — ` +
            `failing the gate (nothing verified them).\n`,
        ),
      );
    }
    process.exit(1);
  }
}
