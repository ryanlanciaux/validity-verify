/**
 * `runJudge` — the automated, provider-configurable LLM judge (core engine).
 *
 * Soft criteria are ~71% of a spec's acceptance surface, and by default the SAME
 * agent that built a change scores its own soft criteria. This engine closes
 * that gap: it sends the BLIND judge-pack (rubric text + screenshots — no
 * source, diff, or prompt history) to a user-configured model and folds the
 * model's scores into the scorecard through the EXACT gate `record_soft_scores`
 * uses (citation floor, taint clamp, soft-only). The judge is therefore an
 * INDEPENDENT scorer, and CI (`verify --all --judge`) and the continuous watcher
 * can both run it.
 *
 * PROGRAMMATIC CONTRACT (stable — the CLI, `verify --all`, and the continuous
 * watch loop all call this):
 *
 *   runJudge({ projectRoot, config, specId?, runId?, all?, signal?, ... })
 *
 * A single options object. `config` is a pre-loaded {@link ValidityConfig}
 * (this engine lives in `@validity.ai/verify-spec`, which must not depend on the config
 * loader). `signal` is the driving needs-scoring/needs-rescoring Signal when a
 * watcher calls in — its `specId` is used when no explicit `specId`/`runId` is
 * given. Extra fields are tolerated.
 *
 * FAILURE SEMANTICS (never false green):
 *   - A soft `pass` must cite a real, non-empty screenshot (shared core gate).
 *   - ANY judge failure — no API key, a provider error, a reply that fails the
 *     schema twice, a drifted rubric, a spec with no prior deterministic tick,
 *     or a gate rejection — is an explicit `skipped` outcome WITH a reason,
 *     never a pass and never a silent drop.
 *   - For a SINGLE-target call (runId/specId) the default is to THROW a
 *     {@link JudgeError} on that skip, so a watcher treats it as "could not
 *     drain" and falls back to agent dispatch (pass `onFailure: 'return'` for
 *     the structured outcome instead). `--all` always returns per-spec outcomes.
 *   - The API key is read from the environment at call time and passed only to
 *     the user's chosen provider — no Validity endpoint is ever involved.
 *
 * Native parity: the pack is built from run-meta screenshots, so a native
 * (Expo) run — post-interaction evidence plus a labeled pre-interaction
 * companion — is judged through this identical path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectGitInfo } from './git.js';
import { persistSignalTransitions } from './signal-lifecycle.js';
import {
  callJudgeModel,
  JudgeClientError,
  judgeApiKeyEnv,
  readJudgeApiKey,
  validateJudgeReply,
  type JudgeScreenshot,
} from './judge-client.js';
import { buildSoftScoreGateContext, gateSoftScores, type SoftScoreInput } from './judge-gate.js';
import { readContainedPng } from './contained-file.js';
import { emitJudgePack, JudgePackError, type JudgePackRubric } from './judge-pack.js';
import { readRunMeta, readSpecRunHistory, runMetaPathFor } from './run.js';
import { writeFileAtomic } from './util.js';
import {
  appendScoreHistory,
  applySoftScores,
  computeValidityScore,
  loadScorecard,
  loadSignals,
  mergeSignals,
  saveScorecard,
  saveSignals,
  VALIDITY_SCORE_VERSION,
  type Signal,
} from './scorecard.js';
import { listSpecs, readSpec } from './specs.js';
import type { JudgeModelConfig, ValidityConfig } from './types.js';

export interface RunJudgeOptions {
  /** Project root (absolute). */
  projectRoot: string;
  /** Pre-loaded config (this engine never loads config itself — no cycle). */
  config: ValidityConfig;
  /** Judge this specific run. */
  runId?: string;
  /** Judge the LATEST run of this spec. */
  specId?: string;
  /** Judge every frozen spec whose soft criteria need (re)scoring. */
  all?: boolean;
  /**
   * The needs-scoring/needs-rescoring Signal driving a watcher call. Its
   * `specId` is used when no explicit `specId`/`runId` was given. Otherwise
   * unused — accepted so the watch loop can pass its context object verbatim.
   */
  signal?: Signal;
  /** Injectable API key (else read from the provider's env var at call time). */
  apiKey?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => string;
  /** Per-request timeout in ms (passed to the provider client). */
  timeoutMs?: number;
  /**
   * Single-target failure mode. `throw` (default) raises {@link JudgeError} when
   * a runId/specId target does not end judged (the watch-loop contract); `return`
   * yields the structured skipped outcome. Ignored for `all`.
   */
  onFailure?: 'throw' | 'return';
}

/** Per-spec/per-run result of a judge invocation. */
export interface JudgeSpecOutcome {
  specId: string;
  specVersion?: number;
  runId?: string;
  /**
   * `judged` — the model scored and scores were folded (see `applied`).
   * `skipped` — an explicit non-green outcome WITH a `reason` (no key, provider
   *   error, schema-invalid twice, drift, no prior tick, no run).
   * `nothing-to-judge` — the spec has no soft criteria (nothing for a judge).
   */
  status: 'judged' | 'skipped' | 'nothing-to-judge';
  reason?: string;
  /** Provider/model string that judged, e.g. "anthropic/claude-3-5-sonnet-latest". */
  scoredBy?: string;
  /** Criterion ids whose soft score was folded in. */
  applied?: string[];
  /** Scores rejected by the gate/reducer (each with a printable reason). */
  rejected?: Array<{ id: string; reason: string }>;
  /** Advisory cross-component citation notes. */
  citationWarnings?: string[];
  /** Spec rollup after folding. */
  verdict?: 'pass' | 'fail' | 'partial';
  signedOff?: boolean;
  /** Per-criterion judged results — for the verify --all report fold. */
  scores?: Array<{ id: string; status: 'pass' | 'fail' | 'unverifiable'; score?: number }>;
}

export interface RunJudgeResult {
  outcomes: JudgeSpecOutcome[];
}

/**
 * Thrown by {@link runJudge} on a single-target failure (default `onFailure`).
 * Carries the structured {@link JudgeSpecOutcome} so a caller can inspect the
 * reason; a bare throw is enough for the watch loop's "could not drain" branch.
 */
export class JudgeError extends Error {
  readonly outcome: JudgeSpecOutcome;
  constructor(outcome: JudgeSpecOutcome) {
    super(outcome.reason ?? 'judge failed');
    this.name = 'JudgeError';
    this.outcome = outcome;
  }
}

const SYSTEM_PROMPT = [
  'You are an INDEPENDENT UI-acceptance judge. You did NOT build the change under review.',
  'Score each soft criterion ONLY from the attached screenshots, against the EXACT rubric text —',
  'do not reinterpret or improve the criterion. Never infer beyond what a screenshot shows: if a',
  'criterion cannot be shown in a still image (motion, click behavior) or its render errored / is',
  'missing, score it "unverifiable" — never a soft "unsure-pass". Cite the screenshotId(s) each',
  'score rests on. Respond with the JSON object ONLY — no prose, no markdown fences.',
].join('\n');

/** Read a written pack's rubric + SCORING.md + schema off disk. */
function readPack(dir: string): { rubric: JudgePackRubric; scoringMd: string; schema: unknown } {
  const rubric = JSON.parse(readFileSync(resolve(dir, 'rubric.json'), 'utf8')) as JudgePackRubric;
  const scoringMd = readFileSync(resolve(dir, 'SCORING.md'), 'utf8');
  const schema = JSON.parse(readFileSync(resolve(dir, 'scores.schema.json'), 'utf8'));
  return { rubric, scoringMd, schema };
}

/** Collect the citable (file-bearing) screenshots from the pack as base64 blocks. */
function packScreenshots(dir: string, rubric: JudgePackRubric): JudgeScreenshot[] {
  const shots: JudgeScreenshot[] = [];
  for (const s of rubric.screenshots) {
    if (!s.file) continue; // errored / missing → not citable, not attached
    try {
      const bytes = readContainedPng(dir, resolve(dir, s.file));
      if (!bytes) continue;
      const base64 = bytes.toString('base64');
      shots.push({ screenshotId: s.screenshotId, label: s.label, base64 });
    } catch {
      // A copy that vanished — skip it; its criteria fall to unverifiable.
    }
  }
  return shots;
}

/** Build the user-facing prompt body from SCORING.md + the screenshot legend + the schema. */
function buildUserText(scoringMd: string, rubric: JudgePackRubric, schema: unknown): string {
  const legend = rubric.screenshots.map((s) => {
    const state = s.file
      ? 'attached below'
      : s.renderError
        ? `render error: ${s.renderError} (NOT citable — score dependent criteria unverifiable)`
        : 'no screenshot (NOT citable — score dependent criteria unverifiable)';
    return `- [screenshotId: ${s.screenshotId}] ${s.label} — ${state}`;
  });
  return [
    scoringMd,
    '',
    '## Screenshots',
    ...legend,
    '',
    'The images below are the "attached" screenshots above, each preceded by its screenshotId.',
    '',
    '## Output',
    'Return ONLY a JSON object (no prose, no markdown fences) matching this schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/** Human `provider/model` provenance string used for the scoredBy stamp. */
function providerModelLabel(cfg: JudgeModelConfig): string {
  return `${cfg.provider}/${cfg.model}`;
}

/**
 * Judge a single run: emit-or-reuse the pack → call the model (one schema
 * retry) → gate + fold the scores → stamp provenance. Returns a structured
 * outcome; every failure path is a `skipped` outcome WITH a reason, never a
 * throw and never a pass. (The single-target throw is decided by the caller,
 * {@link runJudge}.)
 */
async function judgeOneRun(
  projectRoot: string,
  config: ValidityConfig,
  judgeModel: JudgeModelConfig,
  apiKey: string,
  runId: string,
  opts: { fetchImpl?: typeof fetch; now: () => string; timeoutMs?: number },
): Promise<JudgeSpecOutcome> {
  const meta = readRunMeta(projectRoot, runId);
  if (!meta)
    return { specId: '(unknown)', runId, status: 'skipped', reason: `no run-meta for "${runId}"` };
  const specId = meta.specId ?? '(unplanned)';
  const base: Omit<JudgeSpecOutcome, 'status'> = { specId, runId, specVersion: meta.specVersion };

  // Emit-or-reuse the blind pack. A drifted rubric / unplanned run is a hard
  // skip (never judge stale evidence); a spec with no soft criteria is nothing
  // to judge.
  let packDir: string;
  let rubric: JudgePackRubric;
  let scoringMd: string;
  let schema: unknown;
  try {
    const result = emitJudgePack({ projectRoot, runId });
    if (!result) return { ...base, status: 'nothing-to-judge', reason: 'no soft criteria' };
    packDir = result.dir;
    ({ rubric, scoringMd, schema } = readPack(packDir));
  } catch (err) {
    if (err instanceof JudgePackError) return { ...base, status: 'skipped', reason: err.message };
    throw err;
  }

  // Requires a prior deterministic tick — soft scores fold on top of the
  // recorded hard/property verdicts; we never invent them (parity with
  // record_soft_scores).
  const scorecard = loadScorecard(projectRoot);
  const specEntry = scorecard?.specs[specId];
  if (!scorecard || !specEntry) {
    return {
      ...base,
      status: 'skipped',
      reason:
        `no scorecard entry for "${specId}" — run a deterministic tick first ` +
        `(\`validity verify --all\` or validity__verify), then judge.`,
    };
  }

  const shots = packScreenshots(packDir, rubric);
  const userText = buildUserText(scoringMd, rubric, schema);

  // Call the model, validating against scores.schema.json with ONE retry that
  // feeds back the exact validation errors.
  let replyText: string;
  try {
    const first = await callJudgeModel({
      config: judgeModel,
      apiKey,
      system: SYSTEM_PROMPT,
      userText,
      screenshots: shots,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    replyText = first.raw;
  } catch (err) {
    const reason = err instanceof JudgeClientError ? err.reason : (err as Error).message;
    return { ...base, status: 'skipped', reason: `judge model error: ${reason}` };
  }

  let validated = validateJudgeReply(replyText);
  if (!validated.ok) {
    const retryText = [
      userText,
      '',
      'Your previous reply did not match the schema. Fix these problems and return ONLY the corrected JSON:',
      ...validated.errors.map((e) => `- ${e}`),
    ].join('\n');
    try {
      const retry = await callJudgeModel({
        config: judgeModel,
        apiKey,
        system: SYSTEM_PROMPT,
        userText: retryText,
        screenshots: shots,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
      validated = validateJudgeReply(retry.raw);
    } catch (err) {
      const reason = err instanceof JudgeClientError ? err.reason : (err as Error).message;
      return { ...base, status: 'skipped', reason: `judge model error on retry: ${reason}` };
    }
    if (!validated.ok) {
      return {
        ...base,
        status: 'skipped',
        reason: `judge reply failed the schema twice: ${validated.errors.join('; ')}`,
      };
    }
  }

  // Fold through the SHARED gate (identical to record_soft_scores) + the
  // reducer's soft-only / taint / unknown-id gates.
  let targetComponents: string[] = [];
  try {
    targetComponents = readSpec(projectRoot, specId)?.targets?.components ?? [];
  } catch {
    targetComponents = [];
  }
  const softCriterionIds = new Set(
    Object.entries(specEntry.criteria)
      .filter(([, c]) => c.tier === 'soft')
      .map(([id]) => id),
  );
  const gateCtx = buildSoftScoreGateContext({ meta, targetComponents, softCriterionIds });
  const inputs: SoftScoreInput[] = validated.value.scores.map((s) => ({
    id: s.id,
    status: s.status,
    reasoning: s.reasoning,
    score: s.score,
    screenshotIds: s.screenshotIds,
  }));
  const gated = gateSoftScores(inputs, gateCtx);
  const now = opts.now();
  const sha = meta.git?.sha ?? collectGitInfo(projectRoot)?.sha;
  const scoredBy = providerModelLabel(judgeModel);

  if (gated.accepted.length === 0) {
    return {
      ...base,
      status: 'skipped',
      reason:
        'no scorable entries — every judged score was rejected by the citation gate: ' +
        gated.preRejected.map((r) => `${r.id}: ${r.reason}`).join('; '),
      rejected: gated.preRejected,
      citationWarnings: gated.citationWarnings,
      scoredBy,
    };
  }

  const applied = applySoftScores({ prev: scorecard, specId, scores: gated.accepted, now, sha });

  // Stamp the model provenance onto each folded criterion (scoredBy + the
  // judge-mode marker the dashboard reads to distinguish model-judged sign-offs).
  const foldedEntry = applied.scorecard.specs[specId]!;
  for (const id of applied.applied) {
    const crit = foldedEntry.criteria[id];
    if (crit) {
      crit.scoredBy = scoredBy;
      crit.judge = 'model';
    }
  }

  saveScorecard(projectRoot, applied.scorecard);
  const existingSignals = loadSignals(projectRoot);
  const merged = mergeSignals(existingSignals, applied.signals);
  saveSignals(projectRoot, merged);

  persistSignalTransitions(projectRoot, existingSignals, merged, now, sha);
  const historyCommitted = config.historyCommitted === true;
  const validityScore = computeValidityScore(applied.scorecard);
  if (historyCommitted) {
    appendScoreHistory(projectRoot, {
      at: now,
      sha,
      source: 'soft-scores',
      scoreVersion: VALIDITY_SCORE_VERSION,
      score: validityScore?.score ?? null,
      perSpec: Object.fromEntries(
        Object.entries(applied.scorecard.specs).map(([id, s]) => [id, s.validityScore ?? null]),
      ),
    });
  }

  // Refresh the run-meta: stamp scoring provenance (so the report chip +
  // dashboard read "model-judged") AND overwrite the SOFT criterionVerdicts with
  // the judged status — mirroring how submit_report overwrites soft placeholders
  // — so the report's per-criterion soft section reflects the judged result.
  // Best-effort: a stamp failure must never roll back recorded scores.
  try {
    meta.scoring = { judge: 'model', scoredBy, selfScored: false, judgeModel: scoredBy };
    // The sign-off can flip now that blocking soft criteria carry real verdicts
    // (parity with submit_report). Take the reducer's authoritative recompute so
    // the report's sign-off note reflects the judged result.
    if (foldedEntry.signedOff !== undefined) meta.signedOff = foldedEntry.signedOff;
    if (Array.isArray(meta.criterionVerdicts)) {
      const acceptedById = new Map(gated.accepted.map((s) => [s.id, s]));
      const citationsById = new Map(inputs.map((s) => [s.id, s.screenshotIds ?? []]));
      const appliedSet = new Set(applied.applied);
      for (const v of meta.criterionVerdicts) {
        if (v.tier !== 'soft' || !appliedSet.has(v.id)) continue;
        const j = acceptedById.get(v.id);
        if (!j) continue;
        // Reflect the reducer's clamped status (taints can withhold a pass).
        const clamped = foldedEntry.criteria[v.id]?.status;
        v.status = clamped === 'fail' || clamped === 'unverifiable' ? clamped : j.status;
        v.detail = j.detail;
        v.scoredBy = { model: scoredBy, session: 'validity-judge' };
        const cites = citationsById.get(v.id);
        if (cites && cites.length > 0) v.screenshotCitations = cites;
      }
    }
    writeFileAtomic(runMetaPathFor(projectRoot, runId), JSON.stringify(meta, null, 2));
  } catch {
    // non-fatal — the scorecard still carries per-criterion provenance.
  }

  return {
    ...base,
    status: 'judged',
    scoredBy,
    applied: applied.applied,
    rejected: [...gated.preRejected, ...applied.rejected],
    citationWarnings: gated.citationWarnings,
    verdict: foldedEntry.verdict,
    signedOff: foldedEntry.signedOff ?? false,
    scores: gated.accepted
      .filter((s) => applied.applied.includes(s.id))
      .map((s) => ({ id: s.id, status: s.status, score: s.score })),
  };
}

interface ResolvedTargets {
  runs: Array<{ runId: string; specId?: string }>;
  /** Skips that happened during selection (spec with no run, etc.). */
  errorOutcomes: JudgeSpecOutcome[];
}

/** Turn the {runId | specId | all} selector into a concrete list of run ids. */
function resolveTargets(
  projectRoot: string,
  sel: { runId?: string; specId?: string; all?: boolean },
): ResolvedTargets {
  const runs: Array<{ runId: string; specId?: string }> = [];
  const errorOutcomes: JudgeSpecOutcome[] = [];

  if (sel.runId) {
    const meta = readRunMeta(projectRoot, sel.runId);
    runs.push({ runId: sel.runId, specId: meta?.specId });
    return { runs, errorOutcomes };
  }

  if (sel.specId) {
    const latest = readSpecRunHistory(projectRoot, sel.specId, 1).at(-1);
    if (!latest) {
      errorOutcomes.push({
        specId: sel.specId,
        status: 'skipped',
        reason: 'no verify run yet — run validity__verify first, then judge',
      });
    } else {
      runs.push({ runId: latest.runId, specId: sel.specId });
    }
    return { runs, errorOutcomes };
  }

  // --all: every frozen spec whose soft criteria need (re)scoring.
  const scorecard = loadScorecard(projectRoot);
  const specs = listSpecs(projectRoot).filter((s) => s.status === 'frozen');
  for (const spec of specs) {
    const soft = spec.criteria.filter((c) => c.tier === 'soft');
    if (soft.length === 0) continue; // nothing for a judge
    const sc = scorecard?.specs[spec.id]?.criteria ?? {};
    const open = soft.filter((c) => {
      const st = sc[c.id];
      return !st || st.status === 'unscored' || st.stale;
    });
    if (open.length === 0) continue; // all soft current — skip in --all
    const latest = readSpecRunHistory(projectRoot, spec.id, 1).at(-1);
    if (!latest) {
      errorOutcomes.push({
        specId: spec.id,
        status: 'skipped',
        reason: `${open.length} soft criteri${open.length === 1 ? 'on needs' : 'a need'} scoring but there is no verify run yet`,
      });
      continue;
    }
    runs.push({ runId: latest.runId, specId: spec.id });
  }
  return { runs, errorOutcomes };
}

/**
 * Resolve the run ids to judge from the requested selector, then judge each.
 * Returns a structured {@link RunJudgeResult}. On a SINGLE-target selection the
 * default is to THROW {@link JudgeError} when the target does not end judged (so
 * a watcher falls back to agent dispatch); `--all` always returns per-spec
 * outcomes. When the judge is unconfigured (no `scoring.judgeModel`) or its API
 * key is missing, targets resolve to `skipped` with the reason (never a pass).
 */
export async function runJudge(opts: RunJudgeOptions): Promise<RunJudgeResult> {
  const projectRoot = resolve(opts.projectRoot);
  const config = opts.config;
  if (!config) {
    throw new Error('runJudge requires opts.config (a loaded ValidityConfig).');
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const multi = Boolean(opts.all);
  const specId = opts.specId ?? opts.signal?.specId;
  const judgeModel = config.scoring?.judgeModel;

  const targets = resolveTargets(projectRoot, { runId: opts.runId, specId, all: opts.all });

  let outcomes: JudgeSpecOutcome[];
  if (!judgeModel) {
    outcomes = [
      ...targets.errorOutcomes,
      ...targets.runs.map(
        (t): JudgeSpecOutcome => ({
          specId: t.specId ?? '(unknown)',
          runId: t.runId,
          status: 'skipped',
          reason:
            'no scoring.judgeModel configured — add it to .validity/config.ts to enable the automated judge',
        }),
      ),
    ];
  } else {
    const apiKey = opts.apiKey ?? readJudgeApiKey(judgeModel);
    if (!apiKey) {
      const env = judgeApiKeyEnv(judgeModel);
      outcomes = [
        ...targets.errorOutcomes,
        ...targets.runs.map(
          (t): JudgeSpecOutcome => ({
            specId: t.specId ?? '(unknown)',
            runId: t.runId,
            status: 'skipped',
            reason: `API key env ${env} is not set — the judge cannot run (soft criteria stay unscored)`,
          }),
        ),
      ];
    } else {
      outcomes = [...targets.errorOutcomes];
      for (const t of targets.runs) {
        outcomes.push(
          await judgeOneRun(projectRoot, config, judgeModel, apiKey, t.runId, {
            fetchImpl: opts.fetchImpl,
            now,
            timeoutMs: opts.timeoutMs,
          }),
        );
      }
    }
  }

  // Single-target contract: a skip THROWS (watch loop → "could not drain" →
  // agent dispatch) unless the caller opted into structured returns.
  if (!multi && opts.onFailure !== 'return') {
    const failed = outcomes.find((o) => o.status === 'skipped');
    if (failed) throw new JudgeError(failed);
  }
  return { outcomes };
}
