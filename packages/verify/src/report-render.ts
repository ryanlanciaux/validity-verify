/**
 * Build a self-contained `report.html` from a `verify --all` run (or runs).
 *
 * report.html is a local artifact: the CLI renders it on disk; CI can upload
 * it as a GitHub Actions artifact. It is not sent anywhere else.
 *
 * This module owns the impure `RunMeta → ReportInput` mapping (reading the
 * captured screenshots off disk) and the multi-spec MERGE into one report. The
 * mapping mirrors the MCP server's `submit_report` builder, minus the agent's
 * soft scoring (the CLI has no model): soft criteria are rendered as ADVISORY,
 * never as a pass. The Proven (deterministic) section carries the mechanical
 * hard/property verdicts verbatim.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateTemporalClassifications,
  attestRecording,
  attestReport,
  attestRun,
  computeCoverageFromVerdicts,
  computeRegressionDeltas,
  evidenceTaintsOf,
  readAttestation,
  stampOf,
  type AttestationStamp,
  loadScorecard,
  loadSignals,
  readHistoryRows,
  readScoreHistory,
  runDir,
  VALIDITY_SCORE_VERSION,
  readSpecRunHistory,
  type CriterionVerdict,
  type EvidenceTaint,
  type JudgeMode,
  type RegressionDelta,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';
import {
  assessSpecMaturity,
  buildEvidenceMap,
  readRunEvidence,
  renderHtmlReport,
  type ReportComponent,
  type ReportCriterion,
  type ReportEvidence,
  type ReportGitInfo,
  type ReportInput,
} from '@validity.ai/verify-web';
import type { SpecResult } from './commands/verify-all.js';

/** Read a screenshot and inline it as a data URL; undefined on read failure. */
function screenshotAsDataUrl(path: string): string | undefined {
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * Map a run-meta to the renderer's `ReportComponent[]`, reading screenshots off
 * disk. Handles both isolation mode (`components`) and url mode (`pages`),
 * mirroring the MCP server's submit_report mapping so the CLI report looks
 * identical minus the agent commentary.
 */
export function reportComponentsFromMeta(meta: RunMeta): ReportComponent[] {
  const mode = meta.mode ?? 'isolation';
  const byComponent = new Map<string, ReportComponent>();

  if (mode === 'url') {
    for (const p of meta.pages ?? []) {
      let entry = byComponent.get(p.pathId);
      if (!entry) {
        entry = { id: p.pathId, filePath: p.url, renders: [] };
        byComponent.set(p.pathId, entry);
      }
      entry.renders.push({
        scenarioId: p.scenarioId,
        screenshotDataUrl: p.errorMessage ? undefined : screenshotAsDataUrl(p.screenshotPath),
        renderError: p.errorMessage,
        unmatchedUrls: p.unmatchedUrls,
        consoleErrors: p.consoleErrors,
        pageErrors: p.pageErrors,
        networkErrors: p.networkErrors,
        a11yViolations: p.a11yViolations,
      });
    }
    return Array.from(byComponent.values());
  }

  for (const c of meta.components ?? []) {
    let entry = byComponent.get(c.id);
    if (!entry) {
      entry = {
        id: c.id,
        filePath: c.filePath,
        source: meta.componentSources?.[c.id],
        renders: [],
      };
      byComponent.set(c.id, entry);
    }
    entry.renders.push({
      scenarioId: c.scenarioId,
      fixtureId: c.fixtureId,
      stackedFixtureIds: c.stackedFixtureIds,
      screenshotDataUrl: c.renderError ? undefined : screenshotAsDataUrl(c.screenshotPath),
      renderError: c.renderError,
      unmatchedUrls: c.unmatchedUrls,
      unmatchedRequests: c.unmatchedRequests,
      looksEmpty: c.looksEmpty,
      identicalTo: c.identicalTo,
      consoleErrors: c.consoleErrors,
      pageErrors: c.pageErrors,
      networkErrors: c.networkErrors,
      a11yViolations: c.a11yViolations,
      performance: c.performance,
      viewport: c.viewport,
      baseline: c.baseline
        ? {
            sha: c.baseline.sha,
            takenAt: c.baseline.takenAt,
            mismatchedPixels: c.baseline.mismatchedPixels,
            diffDataUrl: c.baseline.diffPath ? screenshotAsDataUrl(c.baseline.diffPath) : undefined,
          }
        : undefined,
    });
  }
  return Array.from(byComponent.values());
}

/**
 * Soft criteria rendered as ADVISORY rows — the CLI has no model, so it cannot
 * score them. They appear clearly separated from the Proven section and are
 * NEVER counted as a pass. `unverifiable` is the honest CLI status for a soft
 * criterion (needs an agent verify).
 */
export function softAdvisoryCriteria(spec: Spec): ReportCriterion[] {
  return spec.criteria
    .filter((c) => c.tier === 'soft')
    .map((c) => ({
      id: c.id,
      description: c.text,
      status: 'unverifiable' as const,
      reasoning: 'Soft criterion — needs an agent verify (no model in CI). Advisory only.',
    }));
}

/**
 * Soft rows for a run's report, judged-aware (issue #18c). A soft criterion the
 * run-meta records as SCORED (a judge or agent stamped `scoredBy`) renders with
 * that verdict's status, its reasoning, and the cited screenshots — previously
 * the judge's per-criterion reasoning lived only in the signal queue. Unscored
 * soft criteria keep the advisory "needs an agent verify" row, so a plain
 * verify/watch report is byte-identical to the old `softAdvisoryCriteria` path.
 */
export function softCriteriaRows(spec: Spec, meta: RunMeta | null): ReportCriterion[] {
  const scored = new Map(
    (meta?.criterionVerdicts ?? [])
      .filter((v) => v.tier === 'soft' && v.scoredBy)
      .map((v) => [v.id, v]),
  );
  const advisory = new Map(softAdvisoryCriteria(spec).map((c) => [c.id, c]));
  return spec.criteria
    .filter((c) => c.tier === 'soft')
    .map((c) => {
      const v = scored.get(c.id);
      if (v && (v.status === 'pass' || v.status === 'fail' || v.status === 'unverifiable')) {
        return {
          id: c.id,
          description: c.text,
          tier: 'soft' as const,
          status: v.status,
          reasoning:
            v.detail ?? `scored ${v.status} by ${v.scoredBy?.model ?? 'the configured judge'}`,
          screenshotIds: v.screenshotCitations,
        };
      }
      return advisory.get(c.id)!;
    });
}

/**
 * Headline verdict for a `verify --all` run. A hard/property FAIL (or a spec
 * render error) is `fail`; any unverifiable hard/property OR any soft (always
 * unscored in CI) makes it `partial`; otherwise `pass`. Mirrors the gate: a
 * green report ≡ `verify --all` exit 0 with full coverage.
 */
export function combinedVerdict(results: SpecResult[]): 'pass' | 'fail' | 'partial' {
  let sawSoft = false;
  let sawUnverifiable = false;
  for (const spec of results) {
    if (spec.error) return 'fail';
    for (const c of spec.criteria) {
      if (c.tier !== 'soft' && c.status === 'fail') return 'fail';
      if (c.status === 'skipped') sawSoft = true; // soft criteria report as skipped in CLI
      if (c.tier !== 'soft' && c.status === 'unverifiable') sawUnverifiable = true;
    }
  }
  return sawSoft || sawUnverifiable ? 'partial' : 'pass';
}

export interface VerifyAllRun {
  spec: Spec;
  meta: RunMeta | null;
  results: SpecResult;
}

/**
 * Run-level scoring provenance for a merged report (plan 1.4).
 *
 * The CLI report used to light the provenance pill ONLY when a `judge: 'model'`
 * run was in the set, so a `verify --all` over agent-scored runs rendered no
 * provenance at all — it hid exactly the self-scored taint the MCP report leads
 * with. This aggregates it honestly, in the same direction every other merge in
 * this file degrades: the WEAKEST claim wins.
 *
 *   - any `selfScored: true` run ⇒ the merged report reads self-scored, even if
 *     another spec was judged independently (one launderable half taints the
 *     rollup — it must never average out to "model-judged");
 *   - otherwise a model judge wins over a fresh-context agent (stronger claim,
 *     but only when nothing self-scored);
 *   - runs with no `scoring` stamp contribute nothing, so a plain CI sweep with
 *     no scored soft criteria renders byte-identically to before.
 *
 * `scoredBy` / `judgeModel` come from the FIRST run matching the winning shape —
 * runs arrive in a deterministic order, so the merged report is deterministic.
 */
export function scoringFromRuns(runs: VerifyAllRun[]): RunMeta['scoring'] | undefined {
  const stamps = runs.map((r) => r.meta?.scoring).filter((s): s is NonNullable<typeof s> => !!s);
  if (stamps.length === 0) return undefined;
  const selfScored = stamps.find((s) => s.selfScored === true);
  if (selfScored) return selfScored;
  const modelJudged = stamps.find((s) => s.judge === 'model');
  if (modelJudged) return modelJudged;
  return stamps[0];
}

/**
 * The render environment for a merged report.
 *
 * Degrades in the same direction every other merge in this file does — the
 * WEAKEST claim wins — because a merged report has one environment record and
 * must not present the healthiest run's as the whole sweep's:
 *
 *   - a run whose dependency pre-scan ABORTED wins outright (its taint is on
 *     every verdict in that run, and hiding the cause behind a cleaner run's
 *     record would leave the reader hunting);
 *   - otherwise a `reused-browse` run wins, because on that path the pre-scan
 *     state was never observable at all — "could not tell" outranks "clean";
 *   - otherwise the first run that recorded one.
 *
 * Runs arrive in a deterministic order, so the merged report is deterministic.
 * Undefined when no run recorded an environment (native/URL sweeps, and any
 * run-meta written before the environment channel landed).
 */
export function environmentFromRuns(runs: VerifyAllRun[]): ReportInput['environment'] {
  const envs = runs
    .map((r) => r.meta?.environment)
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
  if (envs.length === 0) return undefined;
  return envs.find((e) => e.depScanFailure) ?? envs.find((e) => e.devServer !== 'cold') ?? envs[0];
}

/**
 * Per-criterion evidence for a merged report, under the same `<specId>/<id>`
 * namespacing `buildVerifyAllReportInput` applies to multi-spec verdicts
 * (keep-first on collision — criterion ids are spec-scoped and unique per run).
 * This is what carries the per-criterion evidence chips ("scored by: X",
 * "self-scored", taints) into the CLI report.
 */
export function evidenceFromRuns(runs: VerifyAllRun[]): Record<string, ReportEvidence> {
  const multi = runs.length > 1;
  const evidence: Record<string, ReportEvidence> = {};
  for (const run of runs) {
    if (!run.meta) continue;
    for (const [id, ev] of Object.entries(buildEvidenceMap({ meta: run.meta, spec: run.spec }))) {
      const key = multi ? `${run.spec.id}/${id}` : id;
      if (!(key in evidence)) evidence[key] = ev;
    }
  }
  return evidence;
}

/**
 * Mechanical verdicts for a run with NO run-meta — i.e. a spec whose render or
 * device setup failed before any check could execute. Soft criteria are
 * excluded (they flow through `softCriteriaRows` as advisory rows, and they are
 * never part of mechanical coverage). The spec's `error` is folded into each
 * detail so the ledger says WHY the criterion is undecided instead of the bare
 * "no mechanical verdict produced".
 */
function criterionVerdictsFromResults(results: SpecResult, spec: Spec): CriterionVerdict[] {
  const tiers = new Map(spec.criteria.map((c) => [c.id, c.tier]));
  // The error alone says WHAT went wrong; the diagnosis says what to DO. Fold
  // both into the row so the ledger is self-sufficient — a reader scanning the
  // "Not validated" section gets the command without hunting for the banner.
  // Only the first line of a multi-line recipe: the banner carries the rest.
  const d = results.diagnosis;
  const fix = d?.fixCommand?.split('\n')[0]?.trim();
  const attribution = d ? ` [cause: ${d.cause}${fix ? ` — fix: ${fix}` : ''}]` : '';
  const prefix = results.error ? `${results.error}${attribution}` : '';
  return results.criteria
    .filter((c) => (tiers.get(c.id) ?? c.tier) !== 'soft')
    .map((c) => ({
      id: c.id,
      tier: c.tier,
      // `skipped` has no CriterionVerdict equivalent; undecided is undecided.
      status: c.status === 'pass' || c.status === 'fail' ? c.status : ('unverifiable' as const),
      detail: prefix ? `${prefix}${c.detail ? ` — ${c.detail}` : ''}` : c.detail,
    }));
}

/**
 * The report's environment-blocked banner input, from the FIRST run that
 * errored. First, not a merged list: the banner exists to name one thing to
 * fix, and in practice a broken environment fails every spec with the same root
 * cause (which is exactly why `computeEnvBlocked` dedups). When more than one
 * spec errored, the count is stated so nothing is hidden.
 *
 * Returns undefined when nothing errored — the banner is presence-gated, so a
 * healthy run renders byte-identically to before.
 */
export function specErrorFromRuns(runs: VerifyAllRun[]): ReportInput['specError'] {
  const errored = runs.filter((r) => r.results.error);
  const first = errored[0];
  if (!first) return undefined;
  const more =
    errored.length > 1
      ? `\n\n(+${errored.length - 1} more spec${errored.length === 2 ? '' : 's'} blocked in this run.)`
      : '';
  const d = first.results.diagnosis;
  return {
    message: `${first.spec.id}: ${first.results.error}${more}`,
    ...(d ? { cause: d.cause } : {}),
    ...(d?.fixCommand ? { fixCommand: d.fixCommand } : {}),
  };
}

/**
 * Merge one or more verify runs into a single `ReportInput`. Components and
 * mechanical verdicts are concatenated; across multiple specs the verdict ids
 * are namespaced (`<specId>/<id>`) so the Proven section never shows a
 * colliding `AC-1` from two specs. Soft criteria become advisory rows. Coverage
 * is computed across the union of hard/property verdicts.
 */
export function buildVerifyAllReportInput(args: {
  runs: VerifyAllRun[];
  git?: ReportGitInfo;
  brand?: 'validity' | 'none';
  createdAt: string;
  viewCommand: string;
}): ReportInput {
  const multi = args.runs.length > 1;
  const components: ReportComponent[] = [];
  const criterionVerdicts: CriterionVerdict[] = [];
  const criteria: ReportCriterion[] = [];

  for (const run of args.runs) {
    if (run.meta) components.push(...reportComponentsFromMeta(run.meta));
    // A spec that ERRORED has no run-meta, so reading verdicts from meta alone
    // dropped its criteria out of the report entirely: they vanished from the
    // coverage denominator (which then read 100% while nothing had been
    // decided), from the "Not validated" ledger that promises gaps are never
    // hidden, and from the page — even though the markdown/JSON summaries
    // reported the error correctly. Fall back to the aggregated SpecResult so
    // the HTML tells the same story as every other output.
    const verdicts =
      run.meta?.criterionVerdicts ?? criterionVerdictsFromResults(run.results, run.spec);
    for (const v of verdicts) {
      criterionVerdicts.push(multi ? { ...v, id: `${run.spec.id}/${v.id}` } : v);
    }
    for (const c of softCriteriaRows(run.spec, run.meta)) {
      criteria.push(multi ? { ...c, id: c.id ? `${run.spec.id}/${c.id}` : c.id } : c);
    }
  }

  const verdict = combinedVerdict(args.runs.map((r) => r.results));
  const prompt = multi
    ? `Verifying ${args.runs.length} frozen specs: ${args.runs.map((r) => r.spec.id).join(', ')}`
    : (args.runs[0]?.spec.source.prompt ?? '');

  // Header temporal-binding chip (B2): mid-work wins over unknown-only;
  // mixed known+unknown reports the known classification (partial).
  // Per-spec detail stays on SpecResult.temporal; this is the at-a-glance roll.
  const temporalEntries = args.runs
    .filter((r) => r.results.temporal !== undefined)
    .map((r) => ({ specId: r.spec.id, classification: r.results.temporal! }));
  const temporalAgg =
    temporalEntries.length > 0 ? aggregateTemporalClassifications(temporalEntries) : undefined;
  const temporalBinding = temporalAgg?.classification;

  // Provenance (plan 1.4). Assembled HERE, in the one builder every CLI report
  // goes through, so `verify --all`, watch, judge, and the dashboard's
  // bake-on-demand can never disagree about who scored a soft criterion: the
  // run-level pill (self-scored / fresh-context / model-judged) and the
  // per-criterion evidence chips ship together or not at all.
  const scoring = scoringFromRuns(args.runs);
  const evidence = evidenceFromRuns(args.runs);
  const environment = environmentFromRuns(args.runs);

  return {
    runId: multi
      ? `verify-all (${args.runs.length} specs)`
      : (args.runs[0]?.results.specId ?? 'verify-all'),
    createdAt: args.createdAt,
    mode: 'isolation',
    prompt,
    scenarios: [],
    verdict,
    // Presence-gated: absent unless a spec failed before any criterion ran.
    // Never softens `verdict` above — an env-blocked run still reads `fail`;
    // this only says WHY, so the reader doesn't mistake it for a code verdict.
    specError: specErrorFromRuns(args.runs),
    temporalBinding,
    ...(temporalAgg?.partial
      ? {
          temporalPartial: true as const,
          ...(temporalAgg.unknownSpecs && temporalAgg.unknownSpecs.length > 0
            ? { temporalUnknownSpecs: temporalAgg.unknownSpecs }
            : {}),
        }
      : {}),
    components,
    criteria: criteria.length > 0 ? criteria : undefined,
    criterionVerdicts: criterionVerdicts.length > 0 ? criterionVerdicts : undefined,
    ...(scoring ? { scoring } : {}),
    // The render session's environment — presence-gated, so a sweep with no
    // recorded environment renders byte-identically to before.
    ...(environment ? { environment } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    coverage: computeCoverageFromVerdicts(criterionVerdicts) ?? undefined,
    brand: args.brand ?? 'validity',
    viewCommand: args.viewCommand,
    git: args.git,
  };
}

/**
 * The "Part of spec …" system-context panel for a CLI-baked report — the
 * renderer leads with it, so every spec-bound report opens on what spec this
 * run belongs to (identity, maturity, open signals, run timeline). Mirrors the
 * MCP server's `buildReportSpecContext` (`submit_report`'s builder); the CLI
 * loads the scorecard itself. Best-effort + display-only: any assembly failure
 * drops the panel, never the report.
 */
export function buildRunSpecContext(
  projectRoot: string,
  meta: RunMeta,
  spec: Spec | null,
): ReportInput['specContext'] {
  if (!meta.specId || !spec) return undefined;
  try {
    const entry = loadScorecard(projectRoot)?.specs[meta.specId] ?? null;
    const maturity = assessSpecMaturity(projectRoot, spec, undefined, entry);
    const openSignals = loadSignals(projectRoot).filter(
      (s) => s.specId === meta.specId && !s.resolvedAt,
    );
    // runs.jsonl is append-faithful: a runId appears twice once scored (the
    // verify append + the submit twin), so read a compensated tail and keep
    // the LAST row per runId (the scored one).
    const byRun = new Map<string, ReturnType<typeof readSpecRunHistory>[number]>();
    for (const r of readSpecRunHistory(projectRoot, meta.specId, 16)) byRun.set(r.runId, r);
    return {
      specId: meta.specId,
      version: spec.version,
      status: spec.status,
      maturity: {
        level: maturity.level,
        blockers: maturity.blockers.map((b) => b.detail),
      },
      ...(entry?.cleanStreak ? { cleanStreak: entry.cleanStreak.count } : {}),
      openSignals: openSignals.map((s) => ({
        kind: s.kind,
        severity: s.severity,
        ...(s.criterionId ? { criterionId: s.criterionId } : {}),
      })),
      history: Array.from(byRun.values())
        .slice(-8)
        .map((r) => ({
          runId: r.runId,
          createdAt: r.createdAt,
          verdict: r.verdict,
          ...(r.signedOff !== undefined ? { signedOff: r.signedOff } : {}),
        })),
    };
  } catch {
    return undefined;
  }
}

export interface RunReportArgs {
  projectRoot: string;
  spec: Spec;
  meta: RunMeta;
  /**
   * The CLI-aggregated result when the caller has one (`verify --all`).
   * Watch / judge / dashboard callers omit it — a result is then synthesized
   * from the run-meta's own criterionVerdicts (judged soft verdicts keep
   * their scored status; unscored soft reads `skipped`, the honest CLI value).
   */
  results?: SpecResult;
  coverageFloorPercent?: number;
}

/**
 * Render ONE run's report to an HTML string WITHOUT touching the run dir —
 * the dashboard serves this transiently when the run sits outside the
 * `retention.reports` window (persisting there would just be re-pruned next
 * tick, and a click must not refill the disk). Same assembly as
 * `writeRunReportHtml`, minus the write.
 */
export function buildRunReportHtml(
  args: RunReportArgs & { attestation?: AttestationStamp },
): string {
  const { projectRoot, spec, meta } = args;
  const results: SpecResult = args.results ?? {
    specId: spec.id,
    version: spec.version,
    criteria: (meta.criterionVerdicts ?? []).map((v) => ({
      id: v.id,
      tier: v.tier,
      status: v.tier === 'soft' && !v.scoredBy ? ('skipped' as const) : v.status,
      detail: v.detail,
    })),
  };
  const g = meta.git;
  const input = buildVerifyAllReportInput({
    runs: [{ spec, meta, results }],
    git: g ? { sha: g.sha, branch: g.branch, dirty: g.dirty } : undefined,
    brand: meta.report?.brand ?? 'validity',
    createdAt: meta.createdAt ?? new Date().toISOString(),
    viewCommand: `npx http-server ${runDir(projectRoot, meta.runId)}`,
  });
  input.coverageFloorPercent = args.coverageFloorPercent;
  const specContext = buildRunSpecContext(projectRoot, meta, spec);
  if (specContext) input.specContext = specContext;
  // Run-dir SIDECARS: a divergence report and/or device-evidence bundles that
  // sit beside run-meta. Read at RENDER time, not verify time, and that is the
  // point — `validity replay` writes its divergence AFTER the run was signed
  // and its report baked, so the drift only reaches the page on the next
  // (re-)render (the dashboard's bake-on-demand, or a subsequent `verify
  // --all`). Presence-gated: no sidecars ⇒ no fields ⇒ identical bytes.
  const runEvidence = readRunEvidence(runDir(projectRoot, meta.runId));
  if (runEvidence.replayDivergence) input.replayDivergence = runEvidence.replayDivergence;
  if (runEvidence.deviceEvidence) input.deviceEvidence = runEvidence.deviceEvidence;
  // (evidence map + scoring provenance are assembled by buildVerifyAllReportInput
  // above — single-run in, single-run out, so the map is identical to the one
  // this function used to build inline.)
  // Sign-off note (display-only). Without a judge a signed-off run rests
  // entirely on mechanical proof (attested === false); WITH one it can rest on
  // model-judged soft passes — attested (dashed, unproven-by-machine).
  if (meta.signedOff === true) {
    const restsOnJudgedSoft =
      meta.scoring?.judge === 'model' &&
      results.criteria.some((c) => c.tier === 'soft' && c.status === 'pass');
    input.signOff = { signedOff: true, attested: restsOnJudgedSoft };
  }
  // Attestation receipt (footer). Supplied by `writeRunReportHtml`, which signs
  // first; the transient dashboard render passes whatever attestation.json
  // already holds, and shows nothing when the run predates attestation.
  const stamp = args.attestation ?? stampOfExisting(projectRoot, meta.runId);
  if (stamp) input.attestation = stamp;
  return renderHtmlReport(input);
}

/** The stamp already on disk for a run, without signing anything new. */
function stampOfExisting(projectRoot: string, runId: string): AttestationStamp | undefined {
  const record = readAttestation(runDir(projectRoot, runId));
  return record ? stampOf(record) : undefined;
}

/**
 * Bake the per-run `report.html` for ONE run into its run dir — the exact file
 * the dashboard's `/run/<runId>/report` route serves. Issue #18: `verify --all`
 * was the only writer, so watch ticks and judge runs (which produce the same
 * run-meta + screenshots) left the NEWEST runs unopenable. This is the one
 * shared writer for all three callers, plus the dashboard's bake-on-demand
 * fallback. Throws on render/write failure — callers decide severity.
 * Returns the written path.
 */
export function writeRunReportHtml(args: RunReportArgs): string {
  const dest = resolve(runDir(args.projectRoot, args.meta.runId), 'report.html');
  // Same two-step chain as the MCP writer: sign run-meta + screenshots, render
  // with the digest in the footer, then sign the report bytes. Best-effort —
  // this function's contract is "throws on render/write failure", and a missing
  // key or an unwritable run dir is neither.
  const record = attestRun(args.projectRoot, args.meta.runId);
  // The `.ad` replay recording, when the native capture left one in this run
  // dir. Signed BEFORE the report render rather than after, purely so the
  // ordering reads as the chain does (payload → recording → report); the
  // recording is not in the payload and the report does not print it, so the
  // three are independent. A run with no recording — every web run, and any
  // native run that opted out or did not establish the session — is a no-op.
  if (record) attestRecording(args.projectRoot, args.meta.runId);
  writeFileSync(
    dest,
    buildRunReportHtml({ ...args, attestation: record ? stampOf(record) : undefined }),
  );
  if (record) attestReport(args.projectRoot, args.meta.runId, dest);
  return dest;
}

/* ------------------------------------------------------------------ *
 * Git / key derivation for the check metadata.                        *
 * ------------------------------------------------------------------ */

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** "owner/name" from the origin remote, or undefined when not a GitHub repo. */
export function deriveRepo(projectRoot: string): string | undefined {
  const url = git(['remote', 'get-url', 'origin'], projectRoot);
  return url ? parseRepoFromRemote(url) : undefined;
}

/** Pure: parse `owner/name` out of an ssh or https GitHub remote URL. */
export function parseRepoFromRemote(remote: string): string | undefined {
  const cleaned = remote.trim().replace(/\.git$/, '');
  // git@github.com:owner/name  |  ssh://git@github.com/owner/name
  const ssh = /(?:^git@|@)[^:/]+[:/]([^/]+\/[^/]+)$/.exec(cleaned);
  if (ssh) return ssh[1];
  // https://github.com/owner/name
  try {
    const u = new URL(cleaned);
    const parts = u.pathname.replace(/^\//, '').split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** Current HEAD sha (full), or undefined outside a git repo. */
export function headSha(projectRoot: string): string | undefined {
  return git(['rev-parse', 'HEAD'], projectRoot);
}

/**
 * Combined spec hash binding the report to exact frozen content. One spec → its
 * own hash; multiple → a stable sha256 over the sorted member hashes. Specs
 * without a hash (not frozen) contribute their id so the value still changes if
 * the set changes.
 */
export function combineSpecHashes(specs: Spec[]): string {
  const parts = specs.map((s) => s.hash ?? `unfrozen:${s.id}`).sort();
  if (parts.length === 1) return parts[0]!;
  return `sha256-${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

/* ------------------------------------------------------------------ *
 * Check-metadata JSON (consumed by the GitHub Action).                *
 * ------------------------------------------------------------------ */

/** One criterion row for the PR-comment table (B3). Presentation-ready, gate-inert. */
export interface CheckCriterionRow {
  id: string;
  /** Criterion text from the frozen spec (untruncated here; the renderer clips). */
  text: string;
  tier: 'hard' | 'property' | 'soft';
  /** CLI vocabulary: `skipped` = soft/advisory (no model in CI). */
  status: 'pass' | 'fail' | 'unverifiable' | 'skipped';
  detail?: string;
  /** Evidence taints (A3). Mapped via core's `evidenceTaintsOf` from the verdict. */
  taints?: EvidenceTaint[];
  /** Judge provenance for soft rows (A6). Absent from the CLI path today. */
  judge?: JudgeMode;
}

/** Per-spec block for the PR-comment (B3). */
export interface CheckSpecSummary {
  specId: string;
  version: number;
  /** Render/prepare failure that prevented any criterion from running. */
  error?: string;
  /** Temporal-binding classification (B2), mapped from `SpecResult.temporal`. */
  temporal?: 'frozen-before-work' | 'frozen-mid-work' | 'unknown';
  criteria: CheckCriterionRow[];
}

/** Regression comparison vs the PR base branch (merge-base sha) (B3). */
export interface CheckBaseComparison {
  /** Full merge-base sha the comparison keys on. */
  sha: string;
  /** Per-spec deltas. Empty ⇒ merge-base resolved but no runs.jsonl entry matched. */
  specs: Array<{
    specId: string;
    /** Spec version at the matched base entry (caveat when ≠ current version). */
    baseSpecVersion?: number;
    baseRunId: string;
    baseCreatedAt: string;
    /** HARD/PROPERTY only — soft rows are unscored placeholders in CI. */
    deltas: RegressionDelta[];
  }>;
}

export interface CheckMetadata {
  /** Absent = v1 (pre-fat-comment). 2 = carries `specs` (+optional sections). */
  schemaVersion?: 2;
  verdict: 'pass' | 'fail' | 'partial';
  /** Gate result: true ⇒ the build should be green (exit 0). */
  pass: boolean;
  coveragePercent: number | null;
  counts: { pass: number; fail: number; unverifiable: number; skipped: number };
  repo: string | null;
  sha: string | null;
  specHash: string;
  branch: string | null;
  prNumber: number | null;
  // ── v2 additions (all optional; populated by Tracks 3–4) ──
  specs?: CheckSpecSummary[];
  /** Base-branch comparison; absent = not a PR / no merge-base (B3). */
  base?: CheckBaseComparison;
  /** B1: run had no frozen pre-work spec. */
  unplanned?: boolean;
  /** B1: config enforcement mode active for this run. */
  enforcement?: 'advisory' | 'strict';
  /**
   * F1/B3 merged shape: `current` (+ `scoreVersion`) written by verify-all;
   * `base` is populated (also by verify-all, via `resolveBaseValidityScore`)
   * only when the committed score history has a row at the merge-base sha.
   */
  validityScore?: { current: number | null; base?: number; scoreVersion: number };
  /**
   * W6 #23: frozen-spec accounting so the PR comment's denominator is honest.
   * `verified` is how many frozen specs THIS run scored; `total` is how many
   * exist on disk; `untracked` is how many of those have a git-untracked
   * `spec.yaml` — invisible to a fresh CI checkout, so their criteria never
   * enter the committed contract CI verified. `untracked > 0` is the footgun
   * (a spec improves the local score but was never committed). Absent ⇒ not a
   * git repo (nothing to say about tracking).
   */
  specCensus?: { verified: number; total: number; untracked: number };
  /**
   * ATTRIBUTION signal (never softens the gate — a hard fail / coverage-floor
   * breach caused by env-blocked specs still fails the build): specs whose
   * render/prepare failed before any criterion could run (`SpecResult.error`).
   * `errors` is deduped (distinct message strings), so a shared root cause
   * across many specs reads as one line, not a wall of repeats. Absent/empty
   * ⇒ nothing was environment-blocked this run. Populated by verify-all's
   * `computeEnvBlocked`; consumed by post-check.cjs's "Environment blocked"
   * callout + check-run title. Older CLI builds omit this field entirely —
   * every consumer must guard for its absence.
   *
   * `causes` (additive, and independently optional) joins each deduped error
   * string to its named cause + fix command, so the PR comment can say WHICH
   * of the five look-alike environment failures happened instead of repeating
   * the message that could not tell them apart. Absent ⇒ nothing was
   * diagnosed; every consumer must render without it.
   */
  envBlocked?: {
    count: number;
    errors: string[];
    causes?: Array<{ error: string; cause: string; fixCommand?: string }>;
  };
}

/** Tally per-criterion statuses across all specs for the check summary. */
export function tallyCounts(results: SpecResult[]): CheckMetadata['counts'] {
  const counts = { pass: 0, fail: 0, unverifiable: 0, skipped: 0 };
  for (const spec of results) {
    for (const c of spec.criteria) counts[c.status] += 1;
  }
  return counts;
}

/**
 * Map each verify run to its per-spec PR-comment block (B3). Pure presentation
 * assembly over already-decided statuses — never re-derives a verdict. Rows come
 * from the aggregated `results.criteria` (so a hard criterion that produced no
 * mechanical verdict shows as `unverifiable`, never silently passes); `text`
 * joins from the frozen spec by id; taints join from the persisted verdicts via
 * core's `evidenceTaintsOf` (legacy `networkTainted` normalizes to `'network'`).
 * `judge` stays absent — the CLI path has no model, so nothing here was judged.
 */
export function buildCheckSpecSummaries(runs: VerifyAllRun[]): CheckSpecSummary[] {
  return runs.map((run) => {
    const textById = new Map(run.spec.criteria.map((c) => [c.id, c.text]));
    const verdictById = new Map((run.meta?.criterionVerdicts ?? []).map((v) => [v.id, v]));
    return {
      specId: run.results.specId,
      version: run.results.version,
      error: run.results.error,
      temporal: run.results.temporal,
      criteria: run.results.criteria.map((c): CheckCriterionRow => {
        const verdict = verdictById.get(c.id);
        const taints = verdict ? evidenceTaintsOf(verdict) : [];
        return {
          id: c.id,
          text: textById.get(c.id) ?? '',
          tier: c.tier,
          status: c.status,
          detail: c.detail,
          ...(taints.length > 0 ? { taints } : {}),
        };
      }),
    };
  });
}

/**
 * `git merge-base <base> HEAD` for the PR base ref — tries `origin/<baseRef>`
 * first (the CI checkout's remote-tracking ref), then the bare ref. Undefined
 * when unresolvable (shallow clone, unknown ref, not a git repo): the base
 * comparison is then omitted entirely, never an error.
 */
export function mergeBaseSha(projectRoot: string, baseRef: string): string | undefined {
  return (
    git(['merge-base', `origin/${baseRef}`, 'HEAD'], projectRoot) ??
    git(['merge-base', baseRef, 'HEAD'], projectRoot)
  );
}

/**
 * Regression deltas vs the run recorded at the merge-base sha (B3). Reads each
 * spec's local `runs.jsonl` timeline first, then falls back to F2's COMMITTED
 * `.validity/history/<specId>.jsonl` twin, and diffs the current hard/property
 * statuses against the LAST entry indexed at `baseSha` that carries a criteria
 * snapshot. The fallback is what makes the section live in CI: the local
 * timeline is gitignored per-machine noise (empty in a fresh checkout), while
 * the committed feed (`historyCommitted: true`) travels with the repo and
 * carries the same sha + criteria snapshot. DISPLAY-ONLY — deltas never touch
 * the verdict, the gate, or the check conclusion; a spec with no matching base
 * entry is simply omitted (⇒ possibly `specs: []`, which the renderer turns
 * into the opt-in hint line).
 */
export function buildCheckBaseComparison(args: {
  projectRoot: string;
  baseSha: string;
  runs: VerifyAllRun[];
}): CheckBaseComparison {
  const specs: CheckBaseComparison['specs'] = [];
  const matchesBase = (e: { sha?: string; criteria?: unknown[] }): boolean =>
    e.sha === args.baseSha && (e.criteria?.length ?? 0) > 0;
  for (const run of args.runs) {
    try {
      // 500 (not the default 10): base entries can be far back; JSONL lines are
      // tiny and readSpecRunHistory slices before parsing, so this stays cheap.
      const history = readSpecRunHistory(args.projectRoot, run.spec.id, 500);
      const entry =
        history.filter(matchesBase).at(-1) ??
        readHistoryRows(args.projectRoot, run.spec.id, 500).filter(matchesBase).at(-1);
      if (!entry) continue;
      // Current side = the aggregated results (a criterion that STOPPED
      // producing a mechanical verdict reads `unverifiable` here, so
      // pass → unverifiable surfaces as regressed). Soft rows are unscored
      // placeholders in CI — excluded from BOTH sides.
      const current = run.results.criteria
        .filter(
          (c): c is typeof c & { status: 'pass' | 'fail' | 'unverifiable' } =>
            c.tier !== 'soft' && c.status !== 'skipped',
        )
        .map((c) => ({ id: c.id, tier: c.tier, status: c.status }));
      const base = (entry.criteria ?? [])
        .filter((c) => c.tier !== 'soft')
        .map((c) => ({ id: c.id, tier: c.tier, status: c.status }));
      specs.push({
        specId: run.spec.id,
        baseSpecVersion: entry.specVersion,
        baseRunId: entry.runId,
        baseCreatedAt: entry.createdAt,
        deltas: computeRegressionDeltas(current, base),
      });
    } catch {
      // Per-spec skip: a poisoned timeline can at worst cost the delta prose —
      // never the verdict, the gate, or the rest of the check metadata.
    }
  }
  return { sha: args.baseSha, specs };
}

/**
 * Base-branch Validity Score for the PR-comment delta (`base N · ▲/▼`, B3/F1).
 * Reads F1's COMMITTED score history (`.validity/history/score.jsonl`) and
 * returns the LAST score recorded at the merge-base sha — the same
 * `historyCommitted: true` feed the base comparison reads, so a fresh CI
 * checkout can resolve it. Undefined when no row matches (renderer
 * presence-gates: the delta line is simply omitted). DISPLAY-ONLY — never
 * feeds `pass`/`verdict`.
 */
export function resolveBaseValidityScore(projectRoot: string, baseSha: string): number | undefined {
  try {
    const entry = readScoreHistory(projectRoot, 500)
      .filter(
        (e) =>
          e.sha === baseSha &&
          typeof e.score === 'number' &&
          // Same-formula rows only: a v1 (unweighted) base compared against a
          // v2 (maturity-weighted) current would present a formula change as a
          // regression/improvement. A cross-version base simply omits the
          // delta line (presence-gated) — honest over decorative.
          e.scoreVersion === VALIDITY_SCORE_VERSION,
      )
      .at(-1);
    return entry?.score ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assemble the full `--check-output` payload (CheckMetadata v2). Pure — the
 * verify-all orchestrator only gathers the inputs (git shas, PR env, config,
 * the optional base comparison, the optional base score) and writes the JSON.
 * The nine v1 fields keep their exact names and semantics (old actions read
 * them unchanged); every v2 field is additive. `validityScore` (F1) is
 * INFORMATIONAL — it never feeds `pass`/`verdict`; its `base` slot comes from
 * `resolveBaseValidityScore` when the committed score history resolves at the
 * merge-base.
 */
export function buildCheckMetadata(args: {
  results: SpecResult[];
  runs: VerifyAllRun[];
  /** The build gate (exit-0 mirror): no hard failure AND coverage floor met. */
  gatePass: boolean;
  coveragePercent: number | null;
  repo: string | null;
  sha: string | null;
  specHash: string;
  branch: string | null;
  prNumber: number | null;
  enforcement: 'advisory' | 'strict';
  base?: CheckBaseComparison;
  validityScore?: CheckMetadata['validityScore'];
  specCensus?: CheckMetadata['specCensus'];
  envBlocked?: CheckMetadata['envBlocked'];
}): CheckMetadata {
  return {
    schemaVersion: 2,
    // `verdict` is the criteria outcome (fail ⊐ partial ⊐ pass); `pass` is the
    // BUILD gate. They are intentionally distinct — soft criteria make the
    // verdict `partial` but never fail the build. The check STATE the Action
    // derives is 3-way (fail → failure, partial → neutral, pass → success) so
    // a partial is never shown as a clean green success.
    verdict: combinedVerdict(args.results),
    pass: args.gatePass,
    coveragePercent: args.coveragePercent,
    counts: tallyCounts(args.results),
    repo: args.repo,
    sha: args.sha,
    specHash: args.specHash,
    branch: args.branch,
    prNumber: args.prNumber,
    // B1: verify --all iterates the frozen-spec store, so every run is
    // spec-driven by construction; the field exists so future single-run CI
    // paths share the schema. `enforcement` echoes the config posture.
    unplanned: false,
    enforcement: args.enforcement,
    specs: buildCheckSpecSummaries(args.runs),
    ...(args.base ? { base: args.base } : {}),
    ...(args.validityScore ? { validityScore: args.validityScore } : {}),
    ...(args.specCensus ? { specCensus: args.specCensus } : {}),
    ...(args.envBlocked ? { envBlocked: args.envBlocked } : {}),
  };
}
