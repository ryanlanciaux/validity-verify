/**
 * Scorecard MCP tools — the agent soft-scoring loop.
 *
 * Validity has no LLM inside it; the HOST agent scores the soft (~71%) criteria
 * from screenshots. These two tools are the loop's plumbing:
 *
 *   validity__score_soft_criteria — surfaces which soft criteria are OPEN
 *     (never scored, or scored but stale because the code moved) for a frozen
 *     spec, plus the rubric (the frozen criterion text) and the screenshots from
 *     the spec's most recent verify run. The agent scores against EXACTLY this
 *     text.
 *   validity__record_soft_scores — folds the agent's scores into the persistent
 *     scorecard via `applySoftScores` (a targeted soft merge that never touches
 *     the mechanical hard/property verdicts), persists scorecard + signals, and
 *     returns the spec's new rollup + any signals (regressions/recoveries).
 *
 * Gate integrity: a score targeting a hard/property criterion is rejected
 * (mechanical verdicts are authoritative); an unknown id is rejected; a soft
 * criterion the agent doesn't score is left untouched (its prior status stands —
 * an omission never reads as pass).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  applySoftScores,
  appendScoreHistory,
  buildSoftScoreGateContext,
  collectGitInfo,
  computeValidityScore,
  gateSoftScores,
  judgePackDir,
  loadScorecard,
  loadSignals,
  mergeSignals,
  persistSignalTransitions,
  readRunMeta,
  readSpec,
  readSpecRunHistory,
  resolveJudgeMode,
  runMetaPathFor,
  RUBRIC_VERSION,
  runsDir,
  saveScorecard,
  saveSignals,
  screenshotsFromRunMeta,
  VALIDITY_SCORE_VERSION,
  type JudgeMode,
} from '@validity.ai/verify-spec';
import { SESSION_FINGERPRINT } from './session-fingerprint.js';

/** Cap an inlined screenshot so a pathological PNG can't blow up the response. */
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function text(body: string): ServerResult {
  return { content: [{ type: 'text', text: body }] };
}

function errorText(body: string): ServerResult {
  return { isError: true, content: [{ type: 'text', text: body }] };
}

function resolveProjectRoot(input?: string): string {
  return input ? resolve(input) : process.cwd();
}

/**
 * Read a PNG off disk as base64 for an MCP image content block — but only when
 * the path is INSIDE the project's `.validity/runs/` tree and within the size
 * cap. run-meta paths are Validity-authored, but defense-in-depth: never let a
 * crafted run-meta turn this into an arbitrary file read or an unbounded payload.
 */
function pngBase64(projectRoot: string, path: string): string | undefined {
  const resolved = resolve(projectRoot, path);
  const runsRoot = runsDir(projectRoot);
  if (resolved !== runsRoot && !resolved.startsWith(runsRoot + sep)) return undefined;
  try {
    if (statSync(resolved).size > MAX_SCREENSHOT_BYTES) return undefined;
    return readFileSync(resolved).toString('base64');
  } catch {
    return undefined;
  }
}

/**
 * Best-effort judge-mode read (A6). The knob only drives guidance/badging —
 * the tools must keep working in projects where config momentarily fails to
 * load, so a broken config resolves to the default, never an error.
 */
async function judgeModeFor(projectRoot: string): Promise<JudgeMode> {
  try {
    return resolveJudgeMode((await loadConfig(projectRoot)).config);
  } catch {
    return resolveJudgeMode(undefined);
  }
}

/**
 * Best-effort read of the opt-in `historyCommitted` knob (§9.4). All
 * `.validity/history/` writes are gated on it; a broken config reads as OFF
 * (never silently start committing history).
 */
async function historyCommittedFor(projectRoot: string): Promise<boolean> {
  try {
    return (await loadConfig(projectRoot)).config.historyCommitted === true;
  } catch {
    return false;
  }
}

/**
 * Blind-judging guidance prepended to the scoring rubric for a fresh-context
 * judge (explicit `context: 'fresh'` or config `scoring.judge: 'fresh-context'`).
 */
const FRESH_CONTEXT_GUIDANCE = [
  'FRESH-CONTEXT JUDGING MODE.',
  'You are the judge, not the builder. Score BLIND:',
  '  • Base every verdict ONLY on the screenshots below + the rubric text.',
  '  • Do NOT read the component source, the diff, or any build conversation.',
  '  • If a screenshot cannot show a criterion, score it `unverifiable` — never guess.',
  'When recording via validity__record_soft_scores, set `scoredBy` to YOUR model/agent',
  "identity (it must differ from the builder's).",
].join('\n');

export interface ScoreSoftCriteriaArgs {
  specId?: string;
  /**
   * Pass 'fresh' when the caller is a fresh-context judge (a subagent spawned
   * only to score). Adds blind-judging guidance to the response.
   */
  context?: 'fresh';
  projectRoot?: string;
}

/**
 * Surface the OPEN soft criteria for a spec (unscored or stale) + the rubric +
 * the latest run's screenshots, so the host agent can score them. Read-only.
 */
export async function handleScoreSoftCriteria(args: ScoreSoftCriteriaArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity score error: specId is required.');
  const projectRoot = resolveProjectRoot(args.projectRoot);

  const spec = readSpec(projectRoot, args.specId);
  if (!spec) {
    return errorText(
      `Validity score error: spec "${args.specId}" not found in .validity/specs/. ` +
        `Create + freeze it first (validity__spec_create / spec_freeze).`,
    );
  }

  const softCriteria = spec.criteria.filter((c) => c.tier === 'soft');
  if (softCriteria.length === 0) {
    return text(
      `Spec "${spec.id}" has no soft criteria — nothing for the agent to score. ` +
        `Its hard/property criteria are decided mechanically by verify/watch.`,
    );
  }

  // Which soft criteria are OPEN? Consult the scorecard: unscored, or stale
  // (code moved since the score). With no scorecard yet, every soft is open.
  const scorecard = loadScorecard(projectRoot);
  const sc = scorecard?.specs[spec.id]?.criteria ?? {};
  const open = softCriteria.filter((c) => {
    const standing = sc[c.id];
    return !standing || standing.status === 'unscored' || standing.stale;
  });

  // Latest verify run for this spec → screenshots to score from. History is
  // newest-last; with limit 1 the single entry is the most recent run.
  const history = readSpecRunHistory(projectRoot, spec.id, 1);
  const latest = history.at(-1);
  const meta = latest ? readRunMeta(projectRoot, latest.runId) : null;

  // Judge-mode affordances (A6): blind-judging guidance for a fresh-context
  // judge, and a nudge toward one when the config asks for that posture but
  // the caller didn't claim it. Guidance only — never a gate.
  const judgeMode = await judgeModeFor(projectRoot);
  const freshJudging = args.context === 'fresh' || judgeMode === 'fresh-context';
  const freshNudge = judgeMode === 'fresh-context' && args.context !== 'fresh';
  const existingPackDir =
    latest && existsSync(judgePackDir(projectRoot, latest.runId))
      ? judgePackDir(projectRoot, latest.runId)
      : undefined;

  const content: Content[] = [];
  const rubric = open.length > 0 ? open : softCriteria;
  content.push({
    type: 'text',
    text: [
      ...(freshJudging ? [FRESH_CONTEXT_GUIDANCE, ''] : []),
      `Score the ${rubric.length} soft criteri${rubric.length === 1 ? 'on' : 'a'} for spec "${spec.id}"@v${spec.version}.`,
      open.length === 0
        ? 'All soft criteria already have a current score — re-scoring is optional (shown for context).'
        : `${open.length} need (re)scoring (unscored or stale after a code change).`,
      '',
      'Rubric — score against EXACTLY this text, quoting screenshot evidence in your reasoning:',
      ...rubric.map((c) => `  • ${c.id}: ${c.text}`),
      '',
      meta
        ? `Screenshots below are from run ${latest!.runId}${meta.git?.sha ? ` @ ${meta.git.sha.slice(0, 7)}` : ''} (${meta.createdAt}). Each is labeled with its render id.`
        : 'No verify run found for this spec yet — call validity__verify first so there are screenshots to score, then retry.',
      'When done, call validity__record_soft_scores with one entry per soft criterion you scored. ' +
        'A soft `pass` MUST carry `screenshotIds: [<render id>]` citing the screenshot(s) you scored it from (see the ids below).',
      ...(freshNudge
        ? [
            '',
            "Config sets scoring.judge = 'fresh-context': prefer spawning a clean subagent " +
              "(pass context:'fresh'), or run `validity judge-pack " +
              `${latest?.runId ?? '<runId>'}` +
              '` and hand off the bundle.' +
              (existingPackDir ? ` A pack already exists at ${existingPackDir}.` : ''),
          ]
        : []),
    ].join('\n'),
  });

  if (meta) {
    for (const shot of screenshotsFromRunMeta(meta)) {
      const citable = !shot.error && !shot.skipped;
      content.push({
        type: 'text',
        text:
          `Screenshot [render id: ${shot.id}] ${shot.label}` +
          (shot.error ? ` — render error: ${shot.error} (NOT citable)` : '') +
          (shot.skipped ? ' — screenshot skipped (NOT citable)' : '') +
          (citable ? ` — cite as screenshotIds: ["${shot.id}"]` : ''),
      });
      if (!shot.error) {
        const data = pngBase64(projectRoot, shot.path);
        if (data) content.push({ type: 'image', data, mimeType: 'image/png' });
      }
    }
  }

  return { content };
}

export interface RecordSoftScoresArgs {
  specId?: string;
  scores?: Array<{
    id: string;
    status: 'pass' | 'fail' | 'unverifiable';
    reasoning?: string;
    suggestion?: string;
    /**
     * Optional normalized score [0,1]. Only meaningful when the frozen spec set a
     * `softThreshold` for this criterion: the stop rule then also requires
     * `score >= softThreshold`, so a `pass` with a below-threshold score does not
     * sign off. Omitted ⇒ status alone decides.
     */
    score?: number;
    /**
     * Ids of the screenshot(s) this verdict was scored from — the Component/page
     * ids of real renders in the spec's latest verify run. REQUIRED for a soft
     * `pass` (it is the evidence that flips sign-off): a pass without a valid
     * citation is rejected, mirroring submit_report's floor, so this tool can't
     * be used as a back door to land an unbacked pass on the trust surface.
     */
    screenshotIds?: string[];
  }>;
  sha?: string;
  /**
   * Identifier of the model/agent doing the scoring. Persisted onto each scored
   * soft criterion for provenance. When it equals `VALIDITY_BUILDER_MODEL`, the
   * response flags `selfScored` (a WARNING — same model built and judged — not a
   * block).
   */
  scoredBy?: string;
  /**
   * Soft-scoring rubric version these scores were produced under (E2.2), e.g.
   * `'1'`. Omit and the server stamps its own current `RUBRIC_VERSION` with
   * `rubricVersionAssumed: true` — every judgment records how it was scored,
   * and an audit can still tell a declared version from an inferred one.
   */
  rubricVersion?: string;
  projectRoot?: string;
}

/**
 * Fold the agent's soft scores into the scorecard. Persists scorecard + signals.
 * Mechanical verdicts are untouched; non-soft / unknown ids are rejected and
 * reported back (not silently dropped).
 */
export async function handleRecordSoftScores(args: RecordSoftScoresArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity record error: specId is required.');
  if (!Array.isArray(args.scores) || args.scores.length === 0) {
    return errorText('Validity record error: a non-empty `scores` array is required.');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);

  const scorecard = loadScorecard(projectRoot);
  if (!scorecard || !scorecard.specs[args.specId]) {
    return errorText(
      `Validity record error: no scorecard entry for "${args.specId}". Run a deterministic ` +
        `tick first (\`validity verify --all\` or validity__verify) so the hard/property verdicts ` +
        `are recorded, then record soft scores on top.`,
    );
  }

  // The spec's latest verify run — the evidence the scores are judged against.
  // Read once here and reused for the self-scoring fingerprint check below.
  const latestRun = readSpecRunHistory(projectRoot, args.specId, 1).at(-1);
  const latestMeta = latestRun ? readRunMeta(projectRoot, latestRun.runId) : null;

  const specEntry = scorecard.specs[args.specId]!;
  // Spec-level target components (best-effort) for the cross-component warning.
  // A malformed spec.yaml must never break scoring — degrade to no targets.
  let targetComponents: string[] = [];
  try {
    targetComponents = readSpec(projectRoot, args.specId)?.targets?.components ?? [];
  } catch {
    targetComponents = [];
  }
  // CITATION FLOOR (parity with submit_report AND `validity judge`): a soft
  // `pass` must cite a real, non-empty render from this spec's latest run.
  // The gate is the shared core primitive — the automated judge runs the exact
  // same rules — so neither scoring path is a back door around the other. The
  // context is built from run-meta (never the agent's ids) so a typo/forgery
  // can't satisfy the floor.
  const softCriterionIds = new Set(
    Object.entries(specEntry.criteria)
      .filter(([, c]) => c.tier === 'soft')
      .map(([id]) => id),
  );
  const gateCtx = buildSoftScoreGateContext({
    meta: latestMeta,
    targetComponents,
    softCriterionIds,
  });
  const { accepted: scores, preRejected, citationWarnings } = gateSoftScores(args.scores, gateCtx);
  if (scores.length === 0) {
    const why = preRejected.map((r) => `${r.id}: ${r.reason}`).join('; ');
    return errorText(
      'Validity record error: no scorable entries — every score was rejected ' +
        `(missing reasoning or an uncited soft pass). ${why}`,
    );
  }

  // Stamp the commit the scores were CAPTURED against SERVER-SIDE (W3 #9). The
  // reducer's staleness check needs a sha on the stored soft score to compare a
  // later tick against; SKILL.md's canonical record call omits it, so relying on
  // the agent arg alone left every soft score structurally never-stale.
  //
  // The score is a judgment of the CITED RUN's evidence, so it must carry that
  // run's CAPTURE sha (`latestMeta.git.sha`), NOT the current HEAD — otherwise a
  // score recorded after further edits reads as fresh and the staleness
  // machinery (scorecard.ts) never fires on the intervening commits. When the
  // latest run was captured at HEAD (the normal watch-loop case) the two are
  // equal, so behavior is unchanged. Precedence: an explicit `args.sha` override
  // (replays / non-cwd) wins; else the cited run's capture sha; else HEAD as a
  // last resort (run had no recorded sha / non-git project — that case relies on
  // relevance-scoped staleness (#10), not the sha path).
  const sha = args.sha ?? latestMeta?.git?.sha ?? collectGitInfo(projectRoot)?.sha;

  let result;
  try {
    result = applySoftScores({
      prev: scorecard,
      specId: args.specId,
      scores,
      now: new Date().toISOString(),
      sha,
    });
  } catch (err) {
    return errorText(`Validity record error: ${(err as Error).message}`);
  }

  // Provenance: stamp the judge identity onto each freshly-applied soft
  // criterion BEFORE persisting. The session fingerprint is ALWAYS recorded
  // (A3); the model id only when the host self-reports one. Metadata only — it
  // does not feed the stop rule, so applySoftScores' verdict/signedOff stay
  // correct without a recompute.
  // Rubric provenance (E2.2): the submitter's declared version, else this
  // build's — flagged as ASSUMED so a reader can tell a claim from a default.
  const rubricVersion = args.rubricVersion ?? RUBRIC_VERSION;
  const rubricVersionAssumed = args.rubricVersion === undefined;
  {
    const specEntry = result.scorecard.specs[args.specId]!;
    for (const id of result.applied) {
      const crit = specEntry.criteria[id];
      if (!crit) continue;
      crit.scoredBySession = SESSION_FINGERPRINT;
      if (args.scoredBy) crit.scoredBy = args.scoredBy;
      crit.rubricVersion = rubricVersion;
      crit.rubricVersionAssumed = rubricVersionAssumed;
    }
  }

  saveScorecard(projectRoot, result.scorecard);
  const existingSignals = loadSignals(projectRoot);
  const merged = mergeSignals(existingSignals, result.signals);
  saveSignals(projectRoot, merged);

  persistSignalTransitions(projectRoot, existingSignals, merged, new Date().toISOString(), sha);
  const historyCommitted = await historyCommittedFor(projectRoot);

  // Validity Score (F1) — ADVISORY: recomputed from the just-saved scorecard,
  // surfaced in the response, and appended to the trend feed only when the
  // repo opted into committed history (§9.4). It never touches verdict/signedOff.
  const validityScore = computeValidityScore(result.scorecard);
  if (historyCommitted) {
    appendScoreHistory(projectRoot, {
      at: new Date().toISOString(),
      sha,
      source: 'soft-scores',
      scoreVersion: VALIDITY_SCORE_VERSION,
      score: validityScore?.score ?? null,
      perSpec: Object.fromEntries(
        Object.entries(result.scorecard.specs).map(([id, s]) => [id, s.validityScore ?? null]),
      ),
    });
  }

  // Self-scoring is a weak signal — surfaced as a WARNING, never a block. Two
  // triggers (A3): the spec's latest verify run carries THIS session's
  // fingerprint (same session built+verified+judged — no env var needed), or
  // the host opted into the legacy VALIDITY_BUILDER_MODEL contract and the
  // self-reported model matches.
  const builder = process.env.VALIDITY_BUILDER_MODEL;
  const builderMatch = Boolean(args.scoredBy && builder && args.scoredBy === builder);
  const sessionMatch = Boolean(
    latestMeta?.sessionFingerprint && latestMeta.sessionFingerprint === SESSION_FINGERPRINT,
  );
  const selfScored = builderMatch || sessionMatch;

  // Judge-mode badging (A6). Deny-by-default: a fresh-context/human posture
  // only badges clean when a distinct judge identity was affirmatively
  // recorded — an UNPROVEN claim badges as self-scored (plus a warning), so
  // configuring the knob can never launder a self-graded soft tier.
  const judgeMode = await judgeModeFor(projectRoot);
  const unprovenJudge = judgeMode !== 'self' && !args.scoredBy;
  const selfScoredForBadging = selfScored || unprovenJudge;

  // Stamp the run-level scoring provenance onto the spec's latest run-meta so
  // the report badge + downstream tooling can read it (foundation §4.1 shape).
  // Best-effort: a stamp failure must never roll back the recorded scores.
  if (latestMeta) {
    try {
      latestMeta.scoring = {
        judge: judgeMode,
        scoredBy: args.scoredBy,
        selfScored: selfScoredForBadging,
        rubricVersion,
        rubricVersionAssumed,
      };
      writeFileSync(
        runMetaPathFor(projectRoot, latestMeta.runId),
        JSON.stringify(latestMeta, null, 2),
      );
    } catch {
      // non-fatal — the scorecard still carries per-criterion provenance.
    }
  }

  const spec = result.scorecard.specs[args.specId]!;
  const lines = [
    `Recorded ${result.applied.length} soft score${result.applied.length === 1 ? '' : 's'} for "${args.specId}".`,
    `Spec rollup: ${spec.verdict.toUpperCase()}${spec.coveragePercent == null ? '' : ` · coverage ${spec.coveragePercent}%`}.`,
    `Validity score: ${validityScore?.score ?? '—'} (informational).`,
  ];
  if (selfScored) {
    lines.unshift(
      builderMatch
        ? `WARNING: scoredBy "${args.scoredBy}" matches VALIDITY_BUILDER_MODEL — the model that built ` +
            `this also judged it. Self-scoring is a weak signal; prefer a DISTINCT judge model. (Not blocked.)`
        : `WARNING: this session also ran the spec's latest verify — the builder is judging its own ` +
            `work. Self-scoring is a weak signal; prefer a fresh-context judge. (Not blocked.)`,
    );
    if (judgeMode === 'fresh-context') {
      lines.unshift(
        `WARNING: scoring.judge is 'fresh-context' but this scoring came from the builder — it does ` +
          `NOT satisfy the configured posture. Re-score from a clean context ` +
          `(validity judge-pack ${latestRun?.runId ?? '<runId>'}). (Not blocked.)`,
      );
    }
  } else if (unprovenJudge) {
    lines.unshift(
      `WARNING: scoring.judge is '${judgeMode}' but no scoredBy was provided — the judge identity ` +
        `is unrecorded, so ${judgeMode} judging cannot be confirmed. Treating as self-scored for ` +
        `badging. (Not blocked.)`,
    );
  }
  const allRejected = [...preRejected, ...result.rejected];
  if (allRejected.length > 0) {
    lines.push('', 'Rejected (not applied):');
    for (const r of allRejected) lines.push(`  ✗ ${r.id}: ${r.reason}`);
  }
  if (citationWarnings.length > 0) {
    lines.push('', `Citation notes (${citationWarnings.length}, advisory — not blocked):`);
    for (const w of citationWarnings) lines.push(`  ⚠ ${w}`);
  }
  const newOpen = result.signals.filter((s) => s.status === 'open');
  if (newOpen.length > 0) {
    lines.push('', `Signals raised (${newOpen.length}):`);
    for (const s of newOpen) lines.push(`  ● ${s.kind} ${s.criterionId ?? s.specId} — ${s.detail}`);
  }
  // Additive loop signal: expose the rollup, the single `signedOff` stop bit,
  // and the scoring provenance (incl. the `selfScored` warning). The `content`
  // text array is unchanged for interactive use.
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      specId: args.specId,
      verdict: spec.verdict,
      signedOff: spec.signedOff ?? false,
      applied: result.applied,
      // Machine-readable twin of the "Rejected (not applied)" text block —
      // pre-validation rejects (missing reasoning / uncited pass) AND core
      // rejects (unknown id, mechanical tier, invalid status). Without this a
      // loop driver sees `applied: []` with no way to learn why.
      rejected: allRejected,
      // Cross-component citation notes (advisory) — omitted when clean so normal
      // payloads stay byte-identical.
      ...(citationWarnings.length > 0 ? { citationWarnings } : {}),
      scoredBy: args.scoredBy,
      selfScored: selfScoredForBadging,
      judgeMode,
      // How these scores were produced (E2.2). Add-only, never a gate.
      rubricVersion,
      rubricVersionAssumed,
      // Repo-level Validity Score (F1) — informational sibling key (§9.1);
      // never a verdict, never read by any gate.
      validityScore: validityScore?.score ?? null,
    },
  };
}

export const SCORECARD_TOOL_DEFINITIONS = [
  {
    name: 'validity__score_soft_criteria',
    description:
      "Surface a frozen spec's OPEN soft (LLM-scored) criteria — the ones never scored or gone " +
      'stale after a code change — with the rubric (frozen criterion text) and the screenshots ' +
      'from the spec’s most recent verify run. You (the host agent) score them from the images, ' +
      'then call validity__record_soft_scores. Read-only; the deterministic hard/property tiers are ' +
      'decided by validity__verify / `validity verify --all`, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'Frozen spec id, e.g. "spec-7f3a".' },
        context: {
          type: 'string',
          enum: ['fresh'],
          description:
            "Pass 'fresh' when the caller is a fresh-context judge (a subagent spawned only " +
            'to score, with no build context). Adds blind-judging guidance to the response.',
        },
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
      },
      required: ['specId'],
    },
  },
  {
    name: 'validity__record_soft_scores',
    description:
      'Record your soft-criterion scores for a spec into Validity’s persistent scorecard ' +
      '(.validity/scorecard.json) + signal queue. Score against the frozen criterion text and quote ' +
      'screenshot evidence in `reasoning`. Only soft criteria are accepted (mechanical hard/property ' +
      'verdicts are authoritative and cannot be overridden); unknown or non-soft ids are rejected and ' +
      'reported back. Requires a prior deterministic tick (validity__verify or `validity verify --all`).',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'Frozen spec id the scores apply to.' },
        scores: {
          type: 'array',
          description: 'One entry per soft criterion you scored.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Criterion id, e.g. "AC-3".' },
              status: { type: 'string', enum: ['pass', 'fail', 'unverifiable'] },
              reasoning: {
                type: 'string',
                description: 'Why — quote evidence from the screenshot.',
              },
              suggestion: { type: 'string', description: 'Optional: what to fix if fail.' },
              score: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                  'Optional normalized score in [0,1]. Only meaningful when the frozen spec set a ' +
                  '`softThreshold` for this criterion — sign-off then also requires score >= softThreshold, ' +
                  'so a `pass` with a below-threshold score does NOT sign off. Omit ⇒ status alone decides.',
              },
              screenshotIds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Ids of the screenshot(s) you scored this verdict from — the Component/page ids ' +
                  'printed above each screenshot by validity__score_soft_criteria. REQUIRED for a ' +
                  '`pass` (an unbacked pass is rejected); the ids must be real renders from the ' +
                  'spec’s latest verify run. Run validity__verify first if there are no screenshots.',
              },
            },
            required: ['id', 'status', 'reasoning'],
          },
        },
        sha: { type: 'string', description: 'Optional commit sha these scores were made against.' },
        scoredBy: {
          type: 'string',
          description:
            'Optional identifier of the model/agent doing the scoring (e.g. "claude-opus-4"). ' +
            'Persisted on each scored soft criterion for provenance. Use a DISTINCT model from the ' +
            'one that built the change; if it equals VALIDITY_BUILDER_MODEL the response flags ' +
            '`selfScored` (a warning, not a block).',
        },
        rubricVersion: {
          type: 'string',
          description:
            'Optional: the soft-scoring rubric version you scored against — the "Rubric version: ' +
            `<n>" marker in the Validity skill (currently "${RUBRIC_VERSION}"). Omit and Validity ` +
            'stamps its own current rubric with `rubricVersionAssumed: true`. Recorded as ' +
            'provenance so scores produced under different rubrics are never silently compared.',
        },
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
      },
      required: ['specId', 'scores'],
    },
  },
] as const;
