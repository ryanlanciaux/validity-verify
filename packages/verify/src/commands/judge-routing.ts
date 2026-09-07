/**
 * Judge short-circuit routing for the continuous watch loop.
 *
 * WHY: draining a `needs-scoring` / `needs-rescoring` signal is a cheap,
 * mechanical "look at the screenshots and score" job. When the repo configures
 * a MODEL JUDGE, watch can do that inline (invoke the judge directly) instead of
 * spinning up a full headless agent via the on-signal hook. Every OTHER kind
 * (regression, etc.) still dispatches the configured agent command exactly as
 * before. When NO judge is configured, ALL kinds dispatch the agent — today's
 * behavior, unchanged.
 *
 * This is watch-INTERNAL routing that happens BEFORE hook dispatch. It is NOT a
 * new actuation sink: the one-hook/one-command law (on-signal-hook.ts header)
 * is preserved — we simply drain some signals ourselves and hand the rest to
 * the same single hook.
 *
 * DEFENSIVE BY DESIGN: the model-judge feature (config `scoring.judgeModel`, a
 * `validity judge` CLI, and a programmatic `runJudge` entry) is landing on a
 * PARALLEL branch (feat/independent-judge). None of its symbols exist here, so
 * we detect availability at RUNTIME and never import them statically:
 *   - config presence: a loose, optional read of `scoring.judgeModel` (a shape
 *     this branch does NOT define — the judge branch owns the schema/types);
 *   - entry presence: a dynamic `import()` that looks for an exported
 *     `runJudge` (the programmatic twin of the `validity judge` CLI).
 * If EITHER is missing, `active` is false and everything dispatches the agent.
 * (NOTE: until the judge branch adds `judgeModel` to `scoringConfigSchema`, the
 *  config loader strips the field, so `active` is false here regardless — the
 *  correct, safe degradation. Detection starts firing once the branches merge.)
 */
import {
  readRunMeta,
  readSpec,
  readSpecRunHistory,
  resolveReportConfig,
  type Signal,
  type SignalKind,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { writeRunReportHtml } from '../report-render.js';

/** The signal kinds a model judge can drain inline (cheap, no agent dispatch). */
export const JUDGE_DRAINED_KINDS: readonly SignalKind[] = ['needs-scoring', 'needs-rescoring'];

/** Input handed to the (future) judge entry for one scoring signal. */
export interface JudgeDrainInput {
  projectRoot: string;
  /** The loaded ValidityConfig (loosely typed — the judge branch owns its shape). */
  config: unknown;
  /** The needs-scoring / needs-rescoring signal being drained. */
  signal: Signal;
  specId: string;
}

/**
 * The programmatic judge entry, resolved at runtime. Signature is intentionally
 * permissive: the judge branch owns the real one, and we only ever call it
 * inside a try/catch, falling back to agent dispatch on any throw. Adjust the
 * adapter in {@link resolveJudgeRunner} when the branches merge.
 */
export type JudgeRunner = (input: JudgeDrainInput) => unknown | Promise<unknown>;

/**
 * Loose, optional config probe — true when the repo asks for a model judge.
 * Reads `scoring.judgeModel` structurally without importing (or defining) the
 * judge branch's config type. Accepts either a non-empty string model id or an
 * object form (`{ provider, model, … }`) the judge branch may adopt.
 */
export function judgeConfigured(config: unknown): boolean {
  const scoring = (config as { scoring?: unknown } | null | undefined)?.scoring;
  if (scoring == null || typeof scoring !== 'object') return false;
  const jm = (scoring as { judgeModel?: unknown }).judgeModel;
  if (typeof jm === 'string') return jm.trim().length > 0;
  return jm != null && typeof jm === 'object';
}

/**
 * Resolve the judge entry WITHOUT a static import of its symbols. Dynamically
 * imports `@validity.ai/verify-spec` (already loaded by watch — effectively free) and
 * returns an adapter around an exported `runJudge` when present, else null.
 * The importer is injectable so tests can simulate the judge branch being
 * present without it actually existing on this branch.
 */
export async function resolveJudgeRunner(
  importer: () => Promise<Record<string, unknown>> = () =>
    import('@validity.ai/verify-spec') as Promise<Record<string, unknown>>,
): Promise<JudgeRunner | null> {
  try {
    const mod = await importer();
    const fn = mod.runJudge;
    if (typeof fn === 'function') {
      return (input: JudgeDrainInput) => (fn as (i: JudgeDrainInput) => unknown)(input);
    }
  } catch {
    // Entry not present (this branch) — judge is unavailable; degrade to agent.
  }
  return null;
}

export interface JudgeDispatch {
  /** True only when a judge is BOTH configured AND a runner resolved. */
  active: boolean;
  run: JudgeRunner | null;
}

/**
 * Combine the config probe with runner resolution. `active` requires BOTH — a
 * half-present state (model configured but no entry, or vice versa) degrades to
 * agent dispatch so scoring signals are never silently dropped.
 */
export async function resolveJudgeDispatch(
  config: unknown,
  deps: { resolveRunner?: () => Promise<JudgeRunner | null> } = {},
): Promise<JudgeDispatch> {
  if (!judgeConfigured(config)) return { active: false, run: null };
  const run = await (deps.resolveRunner ?? resolveJudgeRunner)();
  return { active: run != null, run };
}

export interface RoutedSignals {
  /** Scoring signals a configured judge will drain inline. */
  toJudge: Signal[];
  /** Everything else — dispatched via the on-signal hook (agent command). */
  toAgent: Signal[];
}

/**
 * Split this tick's newly-opened signals into judge-drained vs agent-dispatched.
 * Pure. With no judge active, EVERYTHING goes to the agent (today's behavior);
 * with a judge active, only {@link JUDGE_DRAINED_KINDS} peel off to the judge.
 */
export function routeOpenedSignals(opened: Signal[], judgeActive: boolean): RoutedSignals {
  if (!judgeActive) return { toJudge: [], toAgent: opened };
  const judgeKinds = new Set<SignalKind>(JUDGE_DRAINED_KINDS);
  const toJudge: Signal[] = [];
  const toAgent: Signal[] = [];
  for (const s of opened) (judgeKinds.has(s.kind) ? toJudge : toAgent).push(s);
  return { toJudge, toAgent };
}

/**
 * Drain scoring signals through the resolved judge runner. Returns the signals
 * it could NOT drain (a runner throw) so the caller can fall back to agent
 * dispatch for them — a scoring signal must never be silently dropped.
 */
export async function drainViaJudge(
  run: JudgeRunner,
  signals: Signal[],
  ctx: { projectRoot: string; config: unknown; log: (line: string) => void },
): Promise<Signal[]> {
  const undrained: Signal[] = [];
  for (const s of signals) {
    try {
      const result = await run({
        projectRoot: ctx.projectRoot,
        config: ctx.config,
        signal: s,
        specId: s.specId,
      });
      ctx.log(`drained ${s.id} (${s.kind}) via model judge`);
      bakeJudgedRunReport(ctx, s.specId, result);
    } catch (err) {
      ctx.log(
        `judge failed to drain ${s.id}: ${(err as Error).message} — dispatching the agent instead`,
      );
      undrained.push(s);
    }
  }
  return undrained;
}

/**
 * Bake the judged run's report.html after an inline drain (issue #18) — the
 * `validity judge` CLI does the same; without this, watch's inline judging
 * would keep minting report-less judged runs. The judged runId is probed
 * structurally from the runner's result (the adapter's return type is loose by
 * design), falling back to the spec's latest run. Best-effort: the report is a
 * convenience artifact and must never break the drain loop.
 */
function bakeJudgedRunReport(
  ctx: { projectRoot: string; config: unknown },
  specId: string,
  result: unknown,
): void {
  try {
    const config = ctx.config as ValidityConfig | undefined;
    if (config && !resolveReportConfig(config.report).enabled) return;
    const outcomes =
      (result as { outcomes?: Array<{ specId?: string; runId?: string; status?: string }> } | null)
        ?.outcomes ?? [];
    const runId =
      outcomes.find((o) => o.status === 'judged' && o.specId === specId && o.runId)?.runId ??
      readSpecRunHistory(ctx.projectRoot, specId, 1)[0]?.runId;
    if (!runId) return;
    const spec = readSpec(ctx.projectRoot, specId);
    const meta = readRunMeta(ctx.projectRoot, runId);
    if (!spec || !meta || meta.scoring?.judge !== 'model' || meta.report?.enabled === false) return;
    writeRunReportHtml({
      projectRoot: ctx.projectRoot,
      spec,
      meta,
      coverageFloorPercent: config?.coverageFloorPercent,
    });
  } catch {
    // never let the report bake break the drain loop
  }
}
