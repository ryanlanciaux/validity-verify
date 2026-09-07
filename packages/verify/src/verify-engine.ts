/**
 * Shared deterministic verify loop.
 *
 * Runs a frozen spec through the Vite sandbox and returns its MECHANICAL
 * (hard/property) verdicts + the run-meta — no model, no aggregation, no
 * reporting. Both `verify --all` (CI gate / report) and `watch` (continuous
 * scorecard) build on this so there's exactly one place that drives
 * `prepareVerification`.
 */
import {
  CommandCheckRunner,
  prepareVerification,
  readCachedEnsureResult,
  readRunMeta,
  type CriterionVerdict,
  type EnsureResult,
  type RunMeta,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import type { EnvironmentDiagnosis } from '@validity.ai/verify-native';
import { renderComponents } from '@validity.ai/verify-web';

export interface SpecVerification {
  spec: Spec;
  /** Run-meta for the render (screenshots, git, etc.), null when the render failed. */
  meta: RunMeta | null;
  /** Mechanical hard/property verdicts. Empty on render failure. */
  mechanical: CriterionVerdict[];
  /** Render/prepare failure that prevented any criterion from running. */
  error?: string;
  /**
   * ATTRIBUTION for `error` (native path today): the named cause + the exact
   * command that fixes it. Additive and inert — `error` alone still drives the
   * gate, so a run with no diagnosis fails exactly as it did before. Absent
   * whenever there is no error, or when every probe came back "cannot tell".
   */
  diagnosis?: EnvironmentDiagnosis;
}

/** Verify one frozen spec mechanically. Never throws — failure lands in `error`. */
export async function verifyOneSpec(
  projectRoot: string,
  config: ValidityConfig,
  spec: Spec,
  opts: { commandRunner?: CommandCheckRunner; setupResult?: EnsureResult } = {},
): Promise<SpecVerification> {
  try {
    // CLI paths must not run the writing orchestrator, but the run-meta must
    // still carry the wrapper taint + setup provenance MCP verifies get —
    // thread the signature-cached EnsureResult into prepareVerification so a
    // degraded wrapper taints soft criteria here too (verify --all / watch).
    const setupResult = opts.setupResult ?? readCachedEnsureResult(projectRoot);
    const result = await prepareVerification({
      projectRoot,
      config,
      prompt: spec.source.prompt,
      render: renderComponents,
      spec,
      commandRunner: opts.commandRunner,
      setupResult,
    });
    // Mechanical verdicts live on each component render; the run-meta carries the
    // rolled-up copy. Prefer run-meta (authoritative); fall back to the renders.
    const meta = readRunMeta(projectRoot, result.runId);
    const mechanical =
      meta?.criterionVerdicts ?? result.components.flatMap((c) => c.criterionVerdicts ?? []);
    return { spec, meta, mechanical };
  } catch (err) {
    return { spec, meta: null, mechanical: [], error: (err as Error).message };
  }
}

/** Verify many specs sequentially (the sandbox boot is not safe to parallelize). */
export async function verifySpecsMechanically(
  projectRoot: string,
  config: ValidityConfig,
  specs: Spec[],
): Promise<SpecVerification[]> {
  // ONE `expect.command` runner per cycle: a command referenced by many specs
  // executes once. Each new cycle (watch tick) gets a fresh runner — the code
  // changed, so a cached exit code would be stale relative to the verdict.
  const commandRunner = new CommandCheckRunner();
  const out: SpecVerification[] = [];
  for (const spec of specs) {
    out.push(await verifyOneSpec(projectRoot, config, spec, { commandRunner }));
  }
  return out;
}
