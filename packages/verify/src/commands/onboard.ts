/**
 * `validity onboard <sub>` — the human/CLI surface over the bulk-onboarding
 * batch review + freeze flow (Phase C).
 *
 * Bulk-created specs carry a `probation` marker (see core/specs.ts). The host
 * agent loops `validity__onboard_enumerate` → `spec_create`/`spec_freeze`
 * minting dozens of draft specs across one or more batches; this command is
 * the SINGLE human approval action over a batch — `validity onboard review`
 * lists the probation-carrying draft/reviewed specs grouped by batch,
 * reviews their coverage delta, and (with `--approve`) calls the privileged
 * out-of-band `approveSpecs` write then freezes every approved id in one go.
 *
 * Subcommands:
 *   review [--batch <id>] [--approve] [--json]
 *
 * Probation outlives freeze: clearing the marker needs a confirmed clean pass
 * (`validity verify --all`), so the frozen specs produced by `--approve` STILL
 * carry `probation` — the watch-tick severity downgrade stays in force until a
 * human-run attended sweep lifts it.
 *
 * Error handling mirrors `spec.ts`: clear stderr line + a non-zero exit code,
 * never a silent no-op. The `specApproval` gate is read from config the SAME
 * way `validity spec freeze` reads it (spec.ts:199) so the two surfaces stay
 * consistent.
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  approveSpecs,
  buildCatalog,
  computeOnboardReport,
  countCriteriaByTier,
  freezeSpec,
  listSpecs,
  loadOnboardState,
  SpecValidationError,
  type OnboardCandidate,
  type OnboardReport,
  type Spec,
  type SpecProbation,
} from '@validity.ai/verify-spec';

export interface OnboardOptions {
  cwd?: string;
  batch?: string;
  approve?: boolean;
  json?: boolean;
}

const SUBCOMMANDS = ['review'] as const;
type SubCommand = (typeof SUBCOMMANDS)[number];

const APPROVAL_ACTOR = 'validity-onboard-review';

export async function runOnboard(
  sub: string | undefined,
  opts: OnboardOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  if (!sub || !SUBCOMMANDS.includes(sub as SubCommand)) {
    process.stderr.write(
      pc.red(
        `error: \`validity onboard\` needs a subcommand: ${SUBCOMMANDS.join(' | ')}.\n` +
          `  e.g. \`validity onboard review\`, \`validity onboard review --approve\`.\n`,
      ),
    );
    process.exit(2);
    return;
  }

  switch (sub as SubCommand) {
    case 'review':
      return runOnboardReview(projectRoot, opts);
  }
}

/* ------------------------------------------------------------------ *
 * onboard review                                                       *
 * ------------------------------------------------------------------ */

/** Pending = probation-carrying draft or reviewed spec (the bulk batch). */
function isPending(spec: Spec): boolean {
  return Boolean(spec.probation) && (spec.status === 'draft' || spec.status === 'reviewed');
}

/** Resolve the batch group label for a pending spec ('(no batch)' when none). */
function batchLabel(spec: Spec): string {
  return spec.probation?.batchId ?? '(no batch)';
}

function firstTarget(spec: Spec): string {
  return spec.targets?.components?.[0] ?? spec.targets?.views?.[0] ?? '—';
}

/** Load the specApproval gate exactly as `validity spec freeze` does. */
async function readApproval(projectRoot: string): Promise<'always' | 'never' | 'auto'> {
  try {
    const { config } = await loadConfig(projectRoot);
    return config.specApproval ?? 'auto';
  } catch (err) {
    // A missing/invalid config shouldn't block the batch freeze — default to
    // `auto`, surfacing the reason the way spec.ts does.
    process.stderr.write(
      pc.yellow(
        `warning: could not load config (${(err as Error).message}); using specApproval=auto.\n`,
      ),
    );
    return 'auto';
  }
}

/**
 * Best-effort coverage header; never fatal — review still works without it.
 * Mirrors `validity__onboard_enumerate`: components+screens only, the real
 * catalog over the user's tree, fed through {@link computeOnboardReport}.
 */
async function coverageHeader(projectRoot: string): Promise<OnboardReport | null> {
  try {
    let config: Record<string, unknown> = {};
    try {
      config = (await loadConfig(projectRoot)).config as unknown as Record<string, unknown>;
    } catch (err) {
      // A config load failure degrades gracefully — buildCatalog walks the
      // discovered components with no explicit entries, exactly as if
      // .validity/config.ts were absent. Do not abort the coverage feed here
      // (only a buildCatalog failure is fatal to the header).
      process.stderr.write(
        pc.yellow(
          `warning: could not load .validity/config.ts for the coverage feed (${(err as Error).message}); proceeding with discovered components only.\n`,
        ),
      );
    }
    const catalog = buildCatalog(projectRoot, config);
    const candidates: OnboardCandidate[] = catalog.entries
      .filter((e) => e.kind === 'component' || e.kind === 'screen')
      .map((e) => ({ path: e.path, name: e.name, kind: e.kind }));
    return computeOnboardReport({
      candidates,
      specs: listSpecs(projectRoot),
      state: loadOnboardState(projectRoot),
    });
  } catch (err) {
    process.stderr.write(
      pc.yellow(
        `warning: could not build the onboard coverage report — ${(err as Error).message}.\n` +
          `  The review listing below still works; the before→after header was skipped.\n`,
      ),
    );
    return null;
  }
}

async function runOnboardReview(projectRoot: string, opts: OnboardOptions): Promise<void> {
  const specs = listSpecs(projectRoot, (id, err) =>
    process.stderr.write(pc.yellow(`warning: skipping malformed spec ${id}: ${err.message}\n`)),
  );

  let pending = specs.filter(isPending);
  if (opts.batch) {
    // `--batch <id>` narrows to specs minted under that batch id. Specs with
    // probation but NO batchId are NOT matched by a --batch filter (they live
    // under '(no batch)' in the unfiltered listing).
    pending = pending.filter((s) => s.probation?.batchId === opts.batch);
  }

  if (pending.length === 0) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { pending: [], coverage: null, approved: null, batch: opts.batch ?? null },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(
        pc.dim('nothing pending — no probation-carrying draft/reviewed specs.\n'),
      );
    }
    return;
  }

  // Group by batchId (undefined → '(no batch)'), preserving spec-id sort order.
  const groups = new Map<string, Spec[]>();
  for (const spec of pending) {
    const key = batchLabel(spec);
    const bucket = groups.get(key);
    if (bucket) bucket.push(spec);
    else groups.set(key, [spec]);
  }

  const report = await coverageHeader(projectRoot);

  // The SINGLE human approval action over the batch — performed BEFORE any
  // render so `--json --approve` reports the actual approve/freeze outcome
  // rather than echoing un-executed intent. Probation outlives freeze (cleared
  // only on a confirmed clean `verify --all` pass), so the frozen specs STILL
  // carry `probation` after this completes — asserted in onboard.test.ts.
  let approveResult: {
    approved: string[];
    frozen: number;
    approveSkipped: Array<{ id: string; reason: string }>;
    freezeSkipped: Array<{ id: string; reason: string }>;
  } | null = null;
  if (opts.approve) {
    const approval = await readApproval(projectRoot);
    const pendingIds = pending.map((s) => s.id);
    const { approved, skipped: approveSkipped } = approveSpecs({
      projectRoot,
      specIds: pendingIds,
      by: APPROVAL_ACTOR,
    });
    let frozen = 0;
    const freezeSkipped: Array<{ id: string; reason: string }> = [];
    for (const id of approved) {
      try {
        freezeSpec({ projectRoot, specId: id, approval });
        frozen += 1;
      } catch (err) {
        if (err instanceof SpecValidationError) {
          freezeSkipped.push({ id, reason: err.message });
        } else {
          throw err;
        }
      }
    }
    approveResult = { approved, frozen, approveSkipped, freezeSkipped };
  }

  if (opts.json) {
    process.stdout.write(renderJson(groups, report, opts, approveResult) + '\n');
    return;
  }

  // Coverage header (before → after).
  if (report) {
    process.stdout.write(renderCoverageHeader(report));
  }

  // Per-batch review tables.
  for (const [batch, bucket] of groups) {
    process.stdout.write(pc.bold(`\nBatch: ${batch}\n`));
    process.stdout.write(renderTable(bucket));
  }

  if (!opts.approve || !approveResult) {
    process.stdout.write(
      pc.dim(
        `\n${pending.length} pending spec${pending.length === 1 ? '' : 's'}. ` +
          `Review, then \`validity onboard review --approve\` to approve + freeze the batch in one action.\n`,
      ),
    );
    return;
  }

  process.stdout.write(
    pc.bold(
      `\nApproved ${approveResult.approved.length}, frozen ${approveResult.frozen}` +
        (approveResult.freezeSkipped.length > 0
          ? `, ${approveResult.freezeSkipped.length} freeze-skipped`
          : '') +
        (approveResult.approveSkipped.length > 0
          ? `, ${approveResult.approveSkipped.length} approve-skipped`
          : '') +
        `.\n`,
    ),
  );
  for (const s of approveResult.approveSkipped) {
    process.stdout.write(`  ${pc.yellow('skipped')} ${s.id} — ${s.reason}\n`);
  }
  for (const s of approveResult.freezeSkipped) {
    process.stdout.write(`  ${pc.yellow('freeze-skipped')} ${s.id} — ${s.reason}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Renderers.                                                           *
 * ------------------------------------------------------------------ */

/** Left-justify a plain string into `width` columns (1-space minimum gap). */
function pad(s: string, width: number): string {
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

function renderTable(specs: Spec[]): string {
  // id · target · tier counts (h/p/soft) · normative · status
  const header =
    pc.bold(
      `${pad('SPEC', 14)}${pad('TARGET', 24)}${pad('H', 4)}${pad('P', 4)}${pad('SOFT', 6)}${pad(
        'NORM',
        6,
      )}STATUS`,
    ) + '\n';
  let out = header;
  for (const spec of specs) {
    const counts = countCriteriaByTier(spec);
    const normative = counts.hard + counts.property;
    out +=
      `${pad(spec.id, 14)}${pad(firstTarget(spec), 24)}${pad(String(counts.hard), 4)}${pad(
        String(counts.property),
        4,
      )}${pad(String(counts.soft), 6)}${pad(String(normative), 6)}` +
      spec.status +
      '\n';
  }
  return out;
}

function renderCoverageHeader(report: OnboardReport): string {
  const before =
    report.before === null
      ? pc.dim('— (no baseline)')
      : `${report.before.covered}/${report.before.total} (${report.before.pct}%)`;
  const after = `${report.after.covered}/${report.after.total} (${report.after.pct}%)`;
  return (
    pc.bold('Coverage: ') +
    `${before} → ${after}` +
    pc.dim(
      ` · ${report.remainingUncovered} remaining uncovered · ${report.created.length} created · ${report.skipped.length} skipped\n`,
    )
  );
}

/** Stable machine-readable report for `--json`. */
function renderJson(
  groups: Map<string, Spec[]>,
  report: OnboardReport | null,
  opts: OnboardOptions,
  approveResult: {
    approved: string[];
    frozen: number;
    approveSkipped: Array<{ id: string; reason: string }>;
    freezeSkipped: Array<{ id: string; reason: string }>;
  } | null,
): string {
  const pending = [...groups.values()].flat();
  const entries = [...groups.entries()].map(([batch, bucket]) => ({
    batch,
    specs: bucket.map((spec) => {
      const counts = countCriteriaByTier(spec);
      return {
        id: spec.id,
        status: spec.status,
        target: firstTarget(spec),
        batchId: spec.probation?.batchId ?? null,
        probation: serializeProbation(spec.probation),
        counts: { ...counts, normative: counts.hard + counts.property },
      };
    }),
  }));
  return JSON.stringify(
    {
      pending: pending.map((s) => s.id),
      batch: opts.batch ?? null,
      batches: entries,
      coverage: report
        ? {
            before: report.before,
            after: report.after,
            remainingUncovered: report.remainingUncovered,
            created: report.created.length,
            skipped: report.skipped.length,
          }
        : null,
      approved: approveResult
        ? {
            by: APPROVAL_ACTOR,
            approved: approveResult.approved,
            frozen: approveResult.frozen,
            approveSkipped: approveResult.approveSkipped,
            freezeSkipped: approveResult.freezeSkipped,
          }
        : null,
    },
    null,
    2,
  );
}

function serializeProbation(
  p: SpecProbation | undefined,
): { since: string; batchId?: string } | null {
  if (!p) return null;
  return { since: p.since, ...(p.batchId ? { batchId: p.batchId } : {}) };
}
