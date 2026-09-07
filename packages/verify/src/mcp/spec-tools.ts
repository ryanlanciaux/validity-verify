/**
 * Spec lifecycle MCP tool handlers — the Phase-2 surface that splits the
 * monolithic `validity__plan` into composable, multi-agent-friendly verbs:
 *
 *   spec_create → spec_review → spec_update → spec_freeze   (author + audit)
 *   spec_list / spec_get                                    (query)
 *
 * These are thin adapters over the @validity.ai/verify-spec spec store: the store owns
 * persistence + schema validation, the config package owns the approval gate,
 * and these handlers own the agent-facing UX (readable text, inline-actionable
 * validation errors, and the deterministic `spec_review` audit). Validity does
 * NO LLM work here — `spec_review` returns deterministic findings the calling
 * agent acts on; it never auto-edits a spec.
 *
 * The MCP transport / dispatch wiring lives in `server.ts`; this module only
 * exports the tool definitions + handlers so the orchestrator can register
 * them without this file touching any shared barrel.
 */
import { resolve } from 'node:path';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildCatalog,
  CHECK_COMPILER_VERSION,
  compileCriterion,
  compilerMigrationReport,
  createSpec,
  detectDataState,
  freezeSpec,
  isClickCheck,
  isExpectCheck,
  isFillCheck,
  listSpecs,
  loadSignals,
  readSpec,
  resolveName,
  readSpecRunHistory,
  serializeSpec,
  SpecValidationError,
  tallyMaturity,
  updateSpec,
  weakenedSincePrevVersion,
  type Check,
  type CriterionTier,
  type DataState,
  type MaturityAssessment,
  type Selector,
  type Spec,
  type SpecConditions,
  type SpecCriterion,
  type SpecStatus,
  type SpecTargets,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { assessSpecMaturity } from '@validity.ai/verify-web';
import { loadConfig } from '@validity.ai/verify-spec';

/* ------------------------------------------------------------------ *
 * Local helpers.                                                      *
 * ------------------------------------------------------------------ */

/**
 * Mirror of `server.ts`'s `resolveProjectRoot` (sans the native-app escape,
 * which is irrelevant to file-only spec work): absolutize the input or fall
 * back to cwd so every spec handler resolves the same `.validity/specs/` dir.
 */
function resolveProjectRoot(input?: string): string {
  return input ? resolve(input) : process.cwd();
}

/** A plain-text `ServerResult` (the common success shape). */
function text(body: string): ServerResult {
  return { content: [{ type: 'text', text: body }] };
}

/** An error `ServerResult` whose message the agent can act on inline. */
function errorText(body: string): ServerResult {
  return { isError: true, content: [{ type: 'text', text: body }] };
}

/**
 * Best-effort target normalization shared by `spec_create` and `plan`: a bare
 * component NAME ("ContactForm") is resolved to its project-relative file
 * path through the catalog (same ladder as `validity__resolve`) so the stored
 * target is what change-mapping and the sandbox expect. Already-pathy values
 * (a slash or a file extension) pass through untouched; no config, no match,
 * or an ambiguous match keeps the raw value — downstream basename matching
 * still applies, so keeping raw is degraded, never broken.
 */
export function resolveComponentTarget(
  projectRoot: string,
  config: ValidityConfig | null,
  raw: string,
): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || /\.[a-z0-9]+$/i.test(trimmed)) {
    return trimmed;
  }
  if (!config) return trimmed;
  try {
    const resolved = resolveName(trimmed, buildCatalog(projectRoot, config));
    return resolved.best?.path ?? trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Load config defensively — a project may not have a `.validity/config.ts`
 * (loadConfig throws then), and the `specApproval` field is not yet typed on
 * ValidityConfig (the orchestrator adds it later). Read it as `any` and fall
 * back to `'auto'`.
 */
async function readSpecApproval(projectRoot: string): Promise<'always' | 'never' | 'auto'> {
  try {
    const { config } = await loadConfig(projectRoot);
    const value = (config as { specApproval?: unknown }).specApproval;
    if (value === 'always' || value === 'never' || value === 'auto') return value;
    return 'auto';
  } catch {
    // No config / unreadable config → default gate.
    return 'auto';
  }
}

/** Render a one-line criterion summary for list/get output. */
function criterionLine(c: SpecCriterion): string {
  const checks = c.checks?.length ? `, ${c.checks.length} check(s)` : '';
  const mocking = c.mocking ? `, mocking:${c.mocking}` : '';
  return `  • ${c.id} [${c.tier}${checks}${mocking}]: ${c.text}`;
}

/** Best-effort config for maturity derivation — absent config still derives. */
async function readConfigOrUndefined(projectRoot: string): Promise<ValidityConfig | undefined> {
  try {
    return (await loadConfig(projectRoot)).config;
  } catch {
    return undefined;
  }
}

/**
 * Render a spec's DERIVED maturity + hardening backlog (the ladder:
 * probation → dev → team → certified). Levels are never authored — see
 * `assessMaturity` in @validity.ai/verify-spec.
 */
function maturityLines(assessment: MaturityAssessment): string[] {
  if (assessment.level === 'certified') {
    return [
      'Maturity: certified — the frozen contract is CURRENTLY PROVEN: every gate criterion passes',
      '  on fresh, untainted evidence at the current frozen content, held across consecutive clean',
      '  verifications at distinct commits.',
    ];
  }
  const n = assessment.blockers.length;
  const lines = [
    `Maturity: ${assessment.level} — ${n} step${n === 1 ? '' : 's'} from certified ` +
      `(certified = every gate criterion currently proven, stably, on untainted evidence):`,
  ];
  for (const [i, b] of assessment.blockers.entries()) {
    lines.push(`  ${i + 1}. [${b.kind}]${b.criterionId ? ` ${b.criterionId}:` : ''} ${b.detail}`);
  }
  return lines;
}

/** Compact, human-readable header for a spec (used by list + get + create). */
function specHeader(spec: Spec): string[] {
  const lines = [`${spec.id} @v${spec.version} — status: ${spec.status}, runtime: ${spec.runtime}`];
  if (spec.targets?.components?.length) {
    lines.push(`  components: ${spec.targets.components.join(', ')}`);
  }
  if (spec.targets?.views?.length) {
    lines.push(`  views: ${spec.targets.views.join(', ')}`);
  }
  if (spec.hash) lines.push(`  hash: ${spec.hash}`);
  if (spec.supersedes) lines.push(`  supersedes: ${spec.supersedes}`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Tool definitions (name + description + JSON inputSchema).           *
 * ------------------------------------------------------------------ */

const criterionItemSchema = {
  type: 'object',
  required: ['id', 'text', 'tier'],
  properties: {
    id: { type: 'string', description: 'Stable id, e.g. "AC-1".' },
    text: { type: 'string', description: 'Human-readable statement of the criterion.' },
    tier: {
      type: 'string',
      enum: ['hard', 'property', 'soft'],
      description:
        'hard = machine-checkable (requires non-empty `checks`); property = invariant fanned ' +
        'across the conditions matrix; soft = LLM-scored from screenshots (no checks).',
    },
    checks: {
      type: 'array',
      description:
        'Structured, compilable actions/assertions. REQUIRED (non-empty) for hard tier. Each ' +
        'check is a single-key object: {navigate:{url}} | {click:<selector>} | ' +
        "{press:'Tab'|{key,times?}} | {hover:<selector>} | {fill:<selector & {value}>} | " +
        '{expect:{element|network|console|screenshot|performance|command}}. ' +
        'Selectors are accessibility-first — prefer role/name over a bare text match so they ' +
        'survive a rebuild. When the target element exposes a stable testID in source, ALSO set ' +
        '`testId` on the selector (in ADDITION to role/name, not instead of it): it exports as a ' +
        'durable Maestro `id:` matcher and survives copy/i18n changes; web sources expose the same ' +
        'handle via `data-testid`. PERFORMANCE: {expect:{performance:{metric,maxMs}}} budgets one timing metric ' +
        '(metric ∈ load|firstContentfulPaint|ready|mount|update; maxMs = upper bound in ms). Add a ' +
        'perf check ONLY when the prompt states a timing requirement (e.g. "renders within 1s", ' +
        '"re-renders instantly when data changes"); pick the single most specific metric and budget ' +
        'it ONCE — do NOT add multiple perf criteria for the same target/metric, and do NOT pair a ' +
        'hard perf budget with a soft "feels fast" criterion (that double-counts). Measured in the ' +
        'web sandbox; native + exports degrade to unverifiable/TODO. ' +
        'COMMAND: {expect:{command:{run:<name>,exitCode?}}} runs a NAMED command from ' +
        ".validity/config.ts `commands` (e.g. run:'typecheck') ONCE per verify run at the repo " +
        'level — no shell strings in specs; a criterion may not mix command checks with page ' +
        'checks. Unconfigured names score unverifiable, never pass. ' +
        "KEYBOARD/FOCUS: {press:'Tab'} or {press:{key:'Shift+Tab',times:3}} sends a keyboard key " +
        'to the page/active element (times bounded 1..25); {hover:<selector>} hovers an element; ' +
        "{expect:{element:{...,state:'focused'}}} asserts the element is the active (focused) " +
        'element. Use these for keyboard reachability, focus management, and hover-state ACs. ' +
        'Web-only — native + Maestro export degrade to unverifiable/TODO.',
      items: { type: 'object' },
    },
    mocking: {
      type: 'string',
      enum: ['required', 'none'],
      description:
        "Whether this criterion's checks assume Validity's mocked network is ACTIVE. Default 'none'.",
    },
  },
} as const;

/**
 * The spec-lifecycle MCP tool definitions, exported so `server.ts` can splice
 * them into `TOOL_DEFINITIONS` and a docs-consistency test can assert the
 * schema strings stay truthful. Typed loosely (`unknown[]`-friendly) to match
 * the existing `TOOL_DEFINITIONS` plain-array convention.
 */
export const SPEC_TOOL_DEFINITIONS = [
  {
    name: 'validity__spec_create',
    description:
      'Compile a user prompt + structured acceptance criteria into a DRAFT spec — the durable, ' +
      'versioned, reviewable upgrade of `validity__plan`. You (the host model) extract the criteria ' +
      'and assign each a tier (hard/property/soft); Validity validates the shape and writes ' +
      '`.validity/specs/<specId>/spec.yaml`. Spec-only mode is just calling this and stopping. ' +
      'Pass the returned specId to `validity__spec_review` (audit), `validity__spec_freeze` (lock), ' +
      'or `validity__verify` (build + score against the same contract).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The original user/agent request. Stored verbatim for audit + coverage review.',
        },
        criteria: {
          type: 'array',
          description: 'Structured acceptance criteria you extracted from the prompt.',
          items: criterionItemSchema,
        },
        runtime: {
          type: 'string',
          enum: ['web', 'native'],
          description: "Which runtime this spec verifies against. Defaults to 'web'.",
        },
        targets: {
          type: 'object',
          description: 'Resolved targets — enables change-mapping for `verify --all --changed`.',
          properties: {
            components: { type: 'array', items: { type: 'string' } },
            views: { type: 'array', items: { type: 'string' } },
          },
        },
        componentPath: {
          type: 'string',
          description:
            'Convenience single-target alias (parity with `validity__plan`): project-relative ' +
            'path — or a bare component name, resolved via the catalog — folded into ' +
            '`targets.components`.',
        },
        conditions: {
          type: 'object',
          description: 'Nemesis matrix to fan property/hard checks across.',
          properties: {
            viewports: { type: 'array', items: { type: 'number' } },
            network: { type: 'array', items: { type: 'string' } },
          },
        },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
        bulk: {
          type: 'boolean',
          description:
            'Marks the spec as bulk-onboarding output — it starts ON PROBATION, meaning its ' +
            'failures surface as low-severity `needs-review` signals (never high-severity ' +
            'regressions) until its first confirmed clean pass.',
        },
        batchId: {
          type: 'string',
          description:
            'Groups one bulk pass so a human can approve+freeze the whole batch in ONE action ' +
            'via `validity onboard review`.',
        },
      },
      required: ['prompt', 'criteria'],
    },
  },
  {
    name: 'validity__spec_review',
    description:
      'Deterministically AUDIT a draft spec against the original request and return structured ' +
      'findings — the multi-agent reviewer enabler. Reports: uncovered prompt clauses, soft criteria ' +
      'that should be PROMOTED to hard (they describe actions), hard criteria with missing or ' +
      'non-durable checks, and missing nemesis (viewport/network) coverage. Returns findings ONLY and ' +
      'never auto-edits — the calling agent applies fixes via `validity__spec_update`.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'The spec to audit.' },
        prompt: {
          type: 'string',
          description:
            "Original request to audit coverage against. Defaults to the spec's stored source.prompt.",
        },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['specId'],
    },
  },
  {
    name: 'validity__spec_update',
    description:
      'Amend a DRAFT spec in place, or version a FROZEN one (frozen content is snapshotted to ' +
      'history/ and a new draft at v+1 is written with a `supersedes` lineage pointer). Records the ' +
      'reviewer in source.reviewedBy when `by` is set. Use this to apply `spec_review` findings: ' +
      'promote soft→hard with checks, add targets/conditions, or set status to "reviewed". ' +
      'Locking ("frozen") and approval ("approved") are NOT set here — use validity__spec_freeze.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'The spec to amend.' },
        patch: {
          type: 'object',
          description: 'Partial mutation applied over the current spec content.',
          properties: {
            criteria: { type: 'array', items: criterionItemSchema },
            targets: {
              type: 'object',
              properties: {
                components: { type: 'array', items: { type: 'string' } },
                views: { type: 'array', items: { type: 'string' } },
              },
            },
            conditions: {
              type: 'object',
              properties: {
                viewports: { type: 'array', items: { type: 'number' } },
                network: { type: 'array', items: { type: 'string' } },
              },
            },
            runtime: { type: 'string', enum: ['web', 'native'] },
            status: {
              type: 'string',
              // `approved`/`frozen` are intentionally absent: freezing + approval
              // run through validity__spec_freeze, not a free-text status write.
              enum: ['draft', 'reviewed', 'superseded'],
            },
          },
        },
        by: { type: 'string', description: 'Reviewer/agent id appended to source.reviewedBy.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['specId', 'patch'],
    },
  },
  {
    name: 'validity__spec_freeze',
    description:
      'Lock a spec and bind its content hash (sha256 of the canonical content), making it immutable — ' +
      'later edits create v+1 with lineage. Honors the `specApproval` config: when "always", the spec ' +
      'must already be status "approved" (set via `spec_update`) or the freeze is rejected. Idempotent ' +
      'for an already-frozen spec.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'The spec to freeze.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['specId'],
    },
  },
  {
    name: 'validity__spec_list',
    description:
      'List specs under `.validity/specs/`, optionally filtered by `status` or by a target ' +
      '`component`. Cheap deterministic read — use it to find a spec id before review/freeze/verify. ' +
      "Each row shows the spec's DERIVED maturity level (probation → dev → team → certified): " +
      'certified means every gate check compiles warning-free to Playwright/Maestro with ' +
      'drift-checked exports under .validity/exports/ — zero judge tokens, runnable by any CI.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'reviewed', 'approved', 'frozen', 'superseded'],
          description: 'Only return specs in this lifecycle status.',
        },
        component: {
          type: 'string',
          description: 'Only return specs whose targets.components include this name.',
        },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
    },
  },
  {
    name: 'validity__spec_get',
    description:
      'Show one spec in full (its YAML) plus a header summary, its DERIVED maturity level, and the ' +
      'hardening backlog — the exact steps between it and "certified" (e.g. promote a soft ' +
      'criterion to hard checks, remove a perf budget from the gate, run `validity spec export`). ' +
      "Also surfaces the last N per-criterion verdicts from the spec's `runs.jsonl` regression " +
      'timeline (populated automatically by every verify against the spec).',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'The spec to show.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['specId'],
    },
  },
] as const;

/* ------------------------------------------------------------------ *
 * Handler arg interfaces.                                             *
 * ------------------------------------------------------------------ */

/** Criterion as supplied over MCP — same shape as the core SpecCriterion. */
export interface SpecCriterionInput {
  id: string;
  text: string;
  tier: CriterionTier;
  checks?: Check[];
  mocking?: 'required' | 'none';
}

export interface SpecCreateArgs {
  prompt: string;
  criteria: SpecCriterionInput[];
  runtime?: 'web' | 'native';
  targets?: SpecTargets;
  /**
   * Convenience alias for a single-component target (parity with `plan`):
   * folded into `targets.components`. A bare name is resolved to its
   * project-relative path via the catalog; without this field the arg agents
   * habitually pass from the `plan` flow was silently dropped by shape.
   */
  componentPath?: string;
  conditions?: SpecConditions;
  projectRoot?: string;
  /**
   * Bulk-onboarding provenance (Phase C). When `true` OR `batchId` is provided,
   * the created draft is stamped `probation: { since, batchId }` via the core
   * store's `createSpec` probation arg — failures surface as low-severity
   * `needs-review` signals until the spec's first confirmed clean pass.
   */
  bulk?: boolean;
  /** Bulk-batch id grouping one onboarding pass (advisory; groups the review). */
  batchId?: string;
}

export interface SpecReviewArgs {
  specId: string;
  /** Original request to audit coverage against. Defaults to source.prompt. */
  prompt?: string;
  projectRoot?: string;
}

export interface SpecUpdateArgs {
  specId: string;
  patch: {
    criteria?: SpecCriterionInput[];
    targets?: SpecTargets;
    conditions?: SpecConditions;
    runtime?: 'web' | 'native';
    status?: SpecStatus;
  };
  by?: string;
  projectRoot?: string;
}

export interface SpecFreezeArgs {
  specId: string;
  projectRoot?: string;
  /**
   * Opt-in migration confirmation (W2 #4). When the spec was compiled under an
   * older contract whose recompile changes the mechanical bar, freeze BLOCKS by
   * default (freezing a stale bar bakes in a known false-RED). Set true to
   * accept the recompile: the criteria are re-compiled + re-stamped in place,
   * then frozen. A stale spec whose recompile is IDENTICAL is re-stamped and
   * frozen without this flag (no bar change to confirm).
   */
  acceptRecompile?: boolean;
}

export interface SpecListArgs {
  status?: SpecStatus;
  /** Filter to specs whose targets.components include this name. */
  component?: string;
  projectRoot?: string;
}

export interface SpecGetArgs {
  specId: string;
  projectRoot?: string;
}

/* ------------------------------------------------------------------ *
 * Handlers.                                                           *
 * ------------------------------------------------------------------ */

/**
 * Compile prompt + criteria into a draft spec. The store validates the shape
 * through `parseSpec`; a `SpecValidationError` is surfaced inline so the agent
 * can fix + retry in the same turn (mirrors handlePlan's PlanValidationError
 * handling) rather than escalating to the user.
 */
export async function handleSpecCreate(args: SpecCreateArgs): Promise<ServerResult> {
  if (!args.prompt || args.prompt.trim().length === 0) {
    return errorText('Validity spec validation error: prompt is required.');
  }
  if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
    return errorText('Validity spec validation error: at least one criterion is required.');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);

  // Config is load-bearing twice below (runtime derivation + bare-name target
  // resolution); a project without one degrades to the historical defaults.
  let config: ValidityConfig | null = null;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch {
    // No config yet (first run) — web default, raw targets.
  }

  // Derive the runtime from config when the agent didn't pass one (parity
  // with `plan`): a native project's spec must not silently default to web.
  const runtime: Spec['runtime'] =
    args.runtime ?? (config?.renderMode === 'native' ? 'native' : 'web');

  // Fold the single-target convenience alias into targets.components,
  // resolving a bare component name to its project-relative path.
  let targets = args.targets;
  if (args.componentPath) {
    const resolved = resolveComponentTarget(projectRoot, config, args.componentPath);
    const components = targets?.components ?? [];
    if (!components.includes(resolved)) {
      targets = { ...targets, components: [...components, resolved] };
    }
  }

  // Bulk-onboarding probation (Phase C). Either `bulk: true` OR an explicit
  // `batchId` stamps the marker; a stray `batchId` without `bulk` still groups
  // the spec under a batch, so it goes on probation the same way.
  const probation = args.bulk || args.batchId ? { batchId: args.batchId } : undefined;

  let created: { specId: string; spec: Spec; path: string };
  try {
    created = createSpec({
      projectRoot,
      prompt: args.prompt,
      criteria: args.criteria as SpecCriterion[],
      runtime,
      targets,
      conditions: args.conditions,
      createdBy: 'agent',
      probation,
    });
  } catch (err) {
    if (err instanceof SpecValidationError) {
      return errorText(`Validity spec validation error: ${err.message}`);
    }
    throw err;
  }

  const { spec, path } = created;
  const lines = [
    `Spec created: ${spec.id} (status: draft, v${spec.version})`,
    `Saved to: ${path}`,
    '',
    ...specHeader(spec),
    '',
    `Criteria (${spec.criteria.length}):`,
    ...spec.criteria.map(criterionLine),
  ];
  if (spec.probation) {
    lines.push(
      '',
      `On probation (bulk batch ${spec.probation.batchId ?? '—'}): failures surface as ` +
        `needs-review (low) until the first confirmed clean pass.`,
    );
  }
  lines.push(
    '',
    'Next steps:',
    `  • Audit coverage: validity__spec_review specId="${spec.id}"`,
    `  • Lock it:        validity__spec_freeze specId="${spec.id}"`,
    `  • Build + score:  validity__verify with specId/planId "${spec.id}"`,
    '',
    'Surface these criteria to the user so they can correct any misinterpretation before you build.',
  );
  return text(lines.join('\n'));
}

/**
 * Deterministic spec audit. Computes coverage / tier / hard-check / nemesis
 * findings and returns them as readable text PLUS a JSON block the calling
 * agent can act on. NEVER edits the spec — fixes are applied via spec_update.
 */
export async function handleSpecReview(args: SpecReviewArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity spec review error: specId is required.');
  const projectRoot = resolveProjectRoot(args.projectRoot);

  const spec = readSpec(projectRoot, args.specId);
  if (!spec) {
    return errorText(
      `Validity spec review error: spec "${args.specId}" not found in .validity/specs/.`,
    );
  }

  const prompt = args.prompt ?? spec.source.prompt;
  const findings = auditSpec(spec, prompt);

  const lines: string[] = [
    `Spec review: ${spec.id} @v${spec.version} (status: ${spec.status})`,
    'Findings only — this tool never edits the spec. Apply fixes with validity__spec_update.',
    '',
  ];

  lines.push('1) Coverage (prompt clauses with no related criterion):');
  if (findings.uncoveredClauses.length === 0) {
    lines.push('   ✓ every prompt clause maps to at least one criterion (keyword heuristic).');
  } else {
    for (const clause of findings.uncoveredClauses) lines.push(`   ✗ uncovered: "${clause}"`);
  }
  lines.push('');

  lines.push('2) Tier audit (soft criteria that describe actions → promote to hard + checks):');
  if (findings.promoteCandidates.length === 0) {
    lines.push('   ✓ no soft criteria look action-shaped.');
  } else {
    for (const p of findings.promoteCandidates) {
      const verbHint = p.verbs.length > 0 ? `verbs: ${p.verbs.join(', ')}` : 'compiler-promotable';
      lines.push(`   ⚠ promote ${p.id} (${verbHint}): ${p.text}`);
      if (p.suggestedChecks) {
        lines.push(
          `       → compiler suggests ${p.suggestedChecks.length} check(s); copy from the JSON below into a spec_update patch.`,
        );
      }
      if (p.dataState) {
        lines.push(
          `       → auto-attach dataState: '${p.dataState}' (checks/scoring then run against the forced '${p.dataState}' render).`,
        );
      }
    }
  }
  for (const n of findings.pixelInvisibleNotes) {
    lines.push(
      `   ✗ ${n.id} hinges on ${n.terms.join(', ')} — screenshots cannot show these, so a soft ` +
        `score can only guess. Rewrite as a hard expect.element check (a concrete testId/role/name ` +
        `compiles deterministically).`,
    );
  }
  lines.push('');

  lines.push('3) Hard-check sanity:');
  if (findings.missingChecks.length === 0 && findings.durabilityNotes.length === 0) {
    lines.push('   ✓ every hard criterion has checks and every selector carries an a11y field.');
  } else {
    for (const id of findings.missingChecks) {
      lines.push(`   ✗ ${id}: hard tier but no checks block (schema should have caught this).`);
    }
    for (const n of findings.durabilityNotes) {
      lines.push(
        `   ⚠ ${n.id}: selector relies only on ${n.basis} — fragile across rebuilds, prefer role/name.`,
      );
    }
  }
  lines.push('');

  lines.push('4) Nemesis coverage:');
  if (findings.nemesisNotes.length === 0) {
    lines.push('   ✓ conditions declare viewports and network.');
  } else {
    for (const n of findings.nemesisNotes) lines.push(`   ⚠ ${n}`);
  }
  lines.push('');

  lines.push('5) Performance hygiene (no duplicate / double-counted perf budgets):');
  if (findings.perfNotes.length === 0) {
    lines.push('   ✓ no duplicate or redundant performance criteria.');
  } else {
    for (const n of findings.perfNotes) lines.push(`   ⚠ ${n}`);
  }
  lines.push('');

  // 6) Compiler migration (W2 #4). verify runs a spec's FROZEN checks and never
  // re-compiles, so a spec authored under an older compiler contract keeps its
  // old mechanical bar. Surface the drift and the exact recompile the agent can
  // apply — never rewrite the frozen contract here.
  const migration = compilerMigrationReport(spec.criteria, spec.source.compiledWith);
  lines.push('6) Compiler migration (mechanical bar vs the current compiler):');
  if (!migration.stale) {
    lines.push(`   ✓ compiled under the current contract (v${CHECK_COMPILER_VERSION}).`);
  } else if (migration.changes.length === 0) {
    lines.push(
      `   ⚠ compiled under v${migration.fromVersion ?? '(unstamped)'} — the current compiler is ` +
        `v${migration.toVersion}, but a recompile yields an IDENTICAL bar. ` +
        `A no-op spec_update (re-supplying the criteria) or the next freeze re-stamps it.`,
    );
  } else {
    lines.push(
      `   ✗ compiled under v${migration.fromVersion ?? '(unstamped)'} — the current compiler is ` +
        `v${migration.toVersion} and would produce a DIFFERENT bar for ${migration.changes.length} ` +
        `criterion(s). Frozen checks never re-compile, so this spec may false-RED (or under-check) ` +
        `on correct code:`,
    );
    for (const c of migration.changes) {
      lines.push(
        `       • ${c.id}: ${c.fromTier}(${c.fromCheckCount} check${c.fromCheckCount === 1 ? '' : 's'})` +
          ` → ${c.toTier}(${c.toCheckCount} check${c.toCheckCount === 1 ? '' : 's'})`,
      );
    }
    lines.push(
      '       → apply the recompiled criteria below via validity__spec_update (bumps a frozen ' +
        'spec to v+1) after confirming the new bar with the user, then re-freeze.',
    );
    lines.push('```json');
    lines.push(JSON.stringify({ criteria: migration.recompiled }, null, 2));
    lines.push('```');
  }
  lines.push('');

  // 7) Criterion weakening (surface, never gate). A versioned (v+1) spec that
  // relaxed a check vs its predecessor — tier hard→soft, blocking→advisory, or
  // softThreshold lowered — can turn a prior fail into a silent pass. Named
  // prominently so a reviewer confirms the downgrade was intended.
  const weakened = weakenedSincePrevVersion(projectRoot, spec);
  lines.push(`7) Criterion weakening (relaxed checks vs v${spec.version - 1}):`);
  if (spec.version <= 1) {
    lines.push('   ✓ first version — nothing to compare against.');
  } else if (!weakened) {
    lines.push(`   ✓ no criterion was weakened since v${spec.version - 1}.`);
  } else {
    lines.push(
      `   ✗ ${weakened.weakenings.length} criterion(s) WEAKENED since v${weakened.fromVersion} — ` +
        `a prior fail can now read as a pass. Confirm each was intended:`,
    );
    for (const w of weakened.weakenings) lines.push(`       • ${w.detail}`);
  }
  lines.push('');

  lines.push('Actionable JSON (feed targeted fixes back through validity__spec_update):');
  lines.push('```json');
  lines.push(JSON.stringify(findings, null, 2));
  lines.push('```');

  return text(lines.join('\n'));
}

/**
 * Amend a draft / version a frozen spec. Surfaces SpecValidationError inline
 * (e.g. unknown spec id, or a patch that produces an invalid spec) so the
 * agent can correct + retry.
 */
export async function handleSpecUpdate(args: SpecUpdateArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity spec update error: specId is required.');
  if (!args.patch || typeof args.patch !== 'object') {
    return errorText('Validity spec update error: a `patch` object is required.');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);

  let result: { spec: Spec; path: string; bumped: boolean };
  try {
    result = updateSpec({
      projectRoot,
      specId: args.specId,
      patch: args.patch as SpecUpdateArgs['patch'] & { criteria?: SpecCriterion[] },
      by: args.by,
    });
  } catch (err) {
    if (err instanceof SpecValidationError) {
      return errorText(`Validity spec update error: ${err.message}`);
    }
    throw err;
  }

  const { spec, path, bumped } = result;
  const lines = [
    bumped
      ? `Frozen spec versioned: ${spec.id} → v${spec.version} (new draft; prior version snapshotted to history/).`
      : `Spec updated in place: ${spec.id} @v${spec.version} (status: ${spec.status}).`,
    `Saved to: ${path}`,
    '',
    ...specHeader(spec),
    '',
    `Criteria (${spec.criteria.length}):`,
    ...spec.criteria.map(criterionLine),
  ];
  if (bumped) {
    lines.push('', 'Re-review and re-freeze the new version before verifying against it.');
  }
  return text(lines.join('\n'));
}

/**
 * Lock + hash a spec, honoring the `specApproval` gate read from config.
 */
export async function handleSpecFreeze(args: SpecFreezeArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity spec freeze error: specId is required.');
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const approval = await readSpecApproval(projectRoot);

  // Compiler-migration gate (W2 #4). Freezing locks the CURRENT checks forever
  // (verify never re-compiles), so a spec compiled under an older contract must
  // not silently bake in a stale bar.
  const preFreeze = readSpec(projectRoot, args.specId);
  if (preFreeze && preFreeze.status !== 'frozen') {
    const migration = compilerMigrationReport(preFreeze.criteria, preFreeze.source.compiledWith);
    if (migration.stale && migration.changes.length > 0 && !args.acceptRecompile) {
      const lines = [
        `Validity spec freeze BLOCKED: ${preFreeze.id} @v${preFreeze.version} was compiled under ` +
          `v${migration.fromVersion ?? '(unstamped)'}, but the current compiler is ` +
          `v${migration.toVersion} and would produce a DIFFERENT mechanical bar for ` +
          `${migration.changes.length} criterion(s). Freezing now bakes in the OLD (possibly ` +
          `false-RED) checks — verify never re-compiles a frozen spec.`,
        '',
        'Changed criteria:',
        ...migration.changes.map(
          (c) => `  • ${c.id}: ${c.fromTier}(${c.fromCheckCount}) → ${c.toTier}(${c.toCheckCount})`,
        ),
        '',
        'Resolve one of:',
        '  • Review the diff (validity__spec_review) and apply the recompiled criteria via ' +
          'validity__spec_update, then freeze; OR',
        '  • Re-run spec_freeze with acceptRecompile:true to recompile + re-stamp in place, then freeze.',
      ];
      return errorText(lines.join('\n'));
    }
    // Safe to migrate transparently: either the recompile is identical (just a
    // stale stamp) or the agent accepted the new bar. Re-supply the criteria so
    // updateSpec re-stamps `compiledWith` (and, when accepted, adopts the new
    // checks) before we lock it.
    if (migration.stale) {
      try {
        updateSpec({
          projectRoot,
          specId: args.specId,
          patch: { criteria: args.acceptRecompile ? migration.recompiled : preFreeze.criteria },
        });
      } catch (err) {
        if (err instanceof SpecValidationError) {
          return errorText(`Validity spec freeze error (migration): ${err.message}`);
        }
        throw err;
      }
    }
  }

  let result: { spec: Spec; path: string };
  try {
    result = freezeSpec({ projectRoot, specId: args.specId, approval });
  } catch (err) {
    if (err instanceof SpecValidationError) {
      const msg = err.message;
      // The specApproval:'always' rejection is the one case a bulk batch can
      // resolve in one shot via `validity onboard review --approve`. Append the
      // hint ONLY to that error (not e.g. "spec not found" while approval is
      // 'always'), so the agent isn't misled.
      const hint = /specApproval: 'always'/.test(msg)
        ? `\nBulk batches can be approved and frozen in one action: run \`validity onboard review --approve\`.`
        : '';
      return errorText(`Validity spec freeze error: ${msg}${hint}`);
    }
    throw err;
  }

  const { spec, path } = result;
  const migrated =
    preFreeze && preFreeze.status !== 'frozen' && isStaleStamp(preFreeze.source.compiledWith);
  // Criterion weakening (surface, never gate): freezing locks a v+1 that relaxed
  // a check vs its predecessor. Name the downgrades on the freeze receipt so a
  // quietly-lowered bar can't slip in unnoticed.
  const weakened = weakenedSincePrevVersion(projectRoot, spec);
  const lines = [
    `Spec frozen: ${spec.id} @v${spec.version} (specApproval: ${approval}).`,
    ...(migrated
      ? [
          `Compiler migration: re-stamped to v${CHECK_COMPILER_VERSION}` +
            `${args.acceptRecompile ? ' and adopted the recompiled checks' : ' (bar unchanged)'}.`,
        ]
      : []),
    ...(weakened
      ? [
          `⚠ WEAKENED since v${weakened.fromVersion}: ${weakened.weakenings.length} criterion(s) had a ` +
            `check relaxed (a prior fail can now read as a pass) — confirm this was intended:`,
          ...weakened.weakenings.map((w) => `    • ${w.detail}`),
        ]
      : []),
    `Saved to: ${path}`,
    '',
    ...specHeader(spec),
    '',
    'Frozen specs are immutable — a later validity__spec_update creates v+1 with lineage.',
    `Verify against it: validity__verify with specId/planId "${spec.id}".`,
  ];
  return text(lines.join('\n'));
}

/** Local mirror of core's `isCompilerStale` for the freeze summary line. */
function isStaleStamp(compiledWith: string | undefined): boolean {
  return compiledWith !== CHECK_COMPILER_VERSION;
}

/**
 * Query specs, optionally filtered by status and/or target component.
 */
export async function handleSpecList(args: SpecListArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const malformed: string[] = [];
  let specs = listSpecs(projectRoot, (id) => malformed.push(id));

  if (args.status) specs = specs.filter((s) => s.status === args.status);
  if (args.component) {
    const needle = args.component.toLowerCase();
    specs = specs.filter((s) =>
      (s.targets?.components ?? []).some((c) => c.toLowerCase() === needle),
    );
  }

  const filterDesc = [
    args.status ? `status=${args.status}` : null,
    args.component ? `component=${args.component}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const lines: string[] = [
    `Specs in .validity/specs/${filterDesc ? ` (filter: ${filterDesc})` : ''}: ${specs.length}`,
  ];
  if (specs.length === 0) {
    lines.push('', '(none) — create one with validity__spec_create.');
  } else {
    lines.push('');
    const config = await readConfigOrUndefined(projectRoot);
    const levels: MaturityAssessment['level'][] = [];
    for (const s of specs) {
      const targets = s.targets?.components?.length
        ? ` — components: ${s.targets.components.join(', ')}`
        : '';
      const maturity = assessSpecMaturity(projectRoot, s, config);
      levels.push(maturity.level);
      lines.push(
        `  • ${s.id} @v${s.version} [${s.status}/${s.runtime}/maturity:${maturity.level}] ` +
          `${s.criteria.length} criteria${targets}`,
      );
    }
    const tally = tallyMaturity(levels);
    lines.push(
      '',
      `Maturity: ${tally.certified} certified · ${tally.team} team · ${tally.dev} dev · ` +
        `${tally.probation} probation. Levels are DERIVED, never authored — spec_get shows each ` +
        `spec's path to certified (zero-token, exported to conventional CI tests).`,
    );
  }
  if (malformed.length) {
    lines.push('', `⚠ skipped ${malformed.length} malformed spec(s): ${malformed.join(', ')}`);
  }
  return text(lines.join('\n'));
}

/**
 * Show one spec in full, plus the last few entries of the spec's `runs.jsonl`
 * regression timeline (appended by `indexRunForSpec` on every verify against
 * the spec — and re-appended by submit_report with the scored verdicts).
 */
export async function handleSpecGet(args: SpecGetArgs): Promise<ServerResult> {
  if (!args.specId) return errorText('Validity spec get error: specId is required.');
  const projectRoot = resolveProjectRoot(args.projectRoot);

  let spec: Spec | null;
  try {
    spec = readSpec(projectRoot, args.specId);
  } catch (err) {
    if (err instanceof SpecValidationError) {
      return errorText(`Validity spec get error: ${err.message}`);
    }
    throw err;
  }
  if (!spec) {
    return errorText(
      `Validity spec get error: spec "${args.specId}" not found in .validity/specs/.`,
    );
  }

  const history = readSpecRunHistory(projectRoot, spec.id, 5);
  const historyLines =
    history.length === 0
      ? [
          'Recent run verdicts: none yet — run validity__verify with ' +
            `\`planId: "${spec.id}"\` to populate the timeline.`,
        ]
      : [
          `Recent run verdicts (last ${history.length}, newest last):`,
          ...history.map((r) => {
            const counts = `${r.counts.pass}✓ ${r.counts.fail}✗ ${r.counts.unverifiable}?`;
            const signedOff = r.signedOff === undefined ? '' : ` signedOff=${r.signedOff}`;
            // Mark the spec version each run was against (W2 #7) — the timeline
            // mixes versions across a re-freeze, and a verdict is only meaningful
            // against the version it ran on. Data's already on the row.
            const ver = r.specVersion != null ? ` @v${r.specVersion}` : '';
            return `  • ${r.createdAt}  ${r.runId}${ver}  ${r.verdict} (${counts})${signedOff}`;
          }),
        ];

  const config = await readConfigOrUndefined(projectRoot);
  // Pending hardening candidates (maturity Phase C) — machine-proposed hard
  // replacements for stable soft criteria. Ready-to-paste spec_update patches;
  // never auto-applied.
  const candidates = loadSignals(projectRoot).filter(
    (s) => s.kind === 'hardening-candidate' && s.status === 'open' && s.specId === spec.id,
  );
  const candidateLines =
    candidates.length === 0
      ? []
      : [
          '',
          `Pending hardening candidate${candidates.length === 1 ? '' : 's'} (machine-suggested, human-ratified — apply via validity__spec_update, then re-freeze):`,
          ...candidates.flatMap((c) => [
            `  ◇ ${c.detail}`,
            ...(c.hardening
              ? [`    patch: ${JSON.stringify({ criteria: [c.hardening.proposal] })}`]
              : []),
          ]),
        ];
  const lines: string[] = [
    ...specHeader(spec),
    '',
    ...maturityLines(assessSpecMaturity(projectRoot, spec, config)),
    ...candidateLines,
    '',
    `Criteria (${spec.criteria.length}):`,
    ...spec.criteria.map(criterionLine),
    '',
    'Full spec (spec.yaml):',
    '```yaml',
    serializeSpec(spec).trimEnd(),
    '```',
    '',
    ...historyLines,
  ];
  return text(lines.join('\n'));
}

/* ------------------------------------------------------------------ *
 * Deterministic audit internals (exported for unit testing).         *
 * ------------------------------------------------------------------ */

/** Action verbs that make a soft criterion a candidate for hard promotion. */
const ACTION_VERBS = [
  'submit',
  'click',
  'type',
  'fill',
  'open',
  'navigate',
  'save',
  'delete',
  'load',
];

/** Cheap stopword set so coverage matching keys on meaningful tokens. */
const STOPWORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'into',
  'when',
  'then',
  'must',
  'should',
  'will',
  'shall',
  'have',
  'they',
  'them',
  'their',
  'there',
  'which',
  'while',
  'where',
  'what',
  'your',
  'user',
  'users',
  'page',
  'able',
  'also',
  'each',
  'both',
  'using',
  'used',
  'about',
  'over',
]);

export interface SpecReviewFindings {
  /** Prompt clauses with no obviously-related criterion. */
  uncoveredClauses: string[];
  /**
   * Soft criteria worth promoting to hard. A candidate is flagged when its text
   * carries an action verb OR the deterministic NL→checks compiler can already
   * produce executable `checks` for it. `suggestedChecks` (when present) is the
   * compiler's output — copy it straight into a `validity__spec_update` patch.
   * `dataState` (when present) is the compiler-detected data-state condition
   * (A2) to auto-attach alongside the promotion.
   */
  promoteCandidates: Array<{
    id: string;
    text: string;
    verbs: string[];
    suggestedChecks?: Check[];
    dataState?: DataState;
  }>;
  /**
   * Soft criteria that hinge on structural a11y attributes (testID, aria-*,
   * accessible name/role). Screenshots cannot show these, so a soft score can
   * only guess — mis-tiered by construction, not merely promotable. Distinct
   * from `promoteCandidates`: flagged even when the compiler can't auto-compile
   * the text (the fix is to author a concrete hard `expect.element` check).
   */
  pixelInvisibleNotes: Array<{ id: string; terms: string[] }>;
  /** Hard criteria missing a checks block (defensive — the schema should reject these). */
  missingChecks: string[];
  /** Hard-criterion selectors that lean only on text/testId (durability note). */
  durabilityNotes: Array<{ id: string; basis: string }>;
  /** Missing nemesis coverage (no conditions / no viewports / no network). */
  nemesisNotes: string[];
  /**
   * Performance-criterion hygiene: a metric budgeted by more than one criterion
   * (duplicate), or a soft "feels fast"-style criterion that overlaps an
   * existing hard perf budget (double-counted). Keeps perf ACs from
   * proliferating across a spec.
   */
  perfNotes: string[];
}

/**
 * Structural a11y vocabulary a screenshot cannot show. Deliberately
 * conservative — bare "role" is skipped (it appears in visible copy like
 * "user role badge"); only attribute-shaped mentions match.
 */
const PIXEL_INVISIBLE_PATTERNS: Array<[RegExp, string]> = [
  [/\btest\s?-?ids?\b/i, 'testID'],
  [/\baria-\w+/i, 'aria-*'],
  [/\baccessib(?:le|ility)\s+(?:name|label|role)\b/i, 'accessible name/label/role'],
  [/\ba11y\b/i, 'a11y'],
  [/\brole\s*[=:]/i, 'role='],
];

/** The attribute-shaped terms in a criterion text that pixels can't verify. */
function pixelInvisibleTerms(text: string): string[] {
  return PIXEL_INVISIBLE_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/** Words that signal a soft criterion is really about performance/speed. */
const PERF_WORDS = new Set([
  'fast',
  'quick',
  'quickly',
  'snappy',
  'instant',
  'instantly',
  'responsive',
  'performant',
  'performance',
  'perf',
  'laggy',
  'smooth',
  'speed',
  'latency',
]);

/** Pull the performance metric a check budgets, if any. */
function perfMetricOf(check: Check): string | undefined {
  if (isExpectCheck(check)) return check.expect.performance?.metric;
  return undefined;
}

/** Tokenize text into lowercase content words (≥4 chars, not stopwords). */
function contentTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 4 && !STOPWORDS.has(w),
  );
}

/**
 * Split a prompt into clauses. Heuristic: break on sentence terminators
 * (`.!?;`), newlines, and the conjunctions ` and ` / ` but `. Trimmed,
 * empties dropped, very short fragments ignored.
 */
export function splitClauses(prompt: string): string[] {
  return prompt
    .split(/[.!?;\n]+|\band\b|\bbut\b/gi)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && contentTokens(c).length > 0);
}

/** Pull the selector-like fields out of a check (click/fill/expect element). */
function selectorOf(check: Check): Selector | undefined {
  if (isClickCheck(check)) return check.click;
  if (isFillCheck(check)) return check.fill;
  if (isExpectCheck(check)) return check.expect.element;
  return undefined;
}

/** Run the full deterministic audit over a spec + the request to audit against. */
export function auditSpec(spec: Spec, prompt: string): SpecReviewFindings {
  // Coverage: a clause is "covered" when any of its content tokens appears in
  // any criterion's text tokens.
  const criterionTokens = spec.criteria.map((c) => new Set(contentTokens(c.text)));
  const uncoveredClauses: string[] = [];
  for (const clause of splitClauses(prompt)) {
    const tokens = contentTokens(clause);
    const covered = tokens.some((t) => criterionTokens.some((set) => set.has(t)));
    if (!covered) uncoveredClauses.push(clause);
  }

  // Tier audit: soft criteria whose text contains an action verb.
  const promoteCandidates: SpecReviewFindings['promoteCandidates'] = [];
  const pixelInvisibleNotes: SpecReviewFindings['pixelInvisibleNotes'] = [];
  // Hard-check sanity.
  const missingChecks: string[] = [];
  const durabilityNotes: SpecReviewFindings['durabilityNotes'] = [];

  for (const c of spec.criteria) {
    if (c.tier === 'soft') {
      const invisibleTerms = pixelInvisibleTerms(c.text);
      if (invisibleTerms.length > 0) pixelInvisibleNotes.push({ id: c.id, terms: invisibleTerms });
      const words = new Set(c.text.toLowerCase().match(/[a-z]+/g) ?? []);
      const verbs = ACTION_VERBS.filter((v) => words.has(v));
      // The compiler is a stronger signal than the verb heuristic: if it can
      // produce checks, this soft criterion is genuinely machine-checkable.
      const compiled = compileCriterion(c.text);
      const suggestedChecks =
        compiled.tier === 'hard' && compiled.checks?.length ? compiled.checks : undefined;
      if (verbs.length > 0 || suggestedChecks) {
        promoteCandidates.push({
          id: c.id,
          text: c.text,
          verbs,
          suggestedChecks,
          // Compiler-detected data-state condition (A2) — surfaced so the
          // promotion patch attaches it and the checks run against the
          // matching forced render.
          ...(compiled.dataState ? { dataState: compiled.dataState } : {}),
        });
      }
    }

    if (c.tier === 'hard') {
      if (!c.checks || c.checks.length === 0) {
        missingChecks.push(c.id);
        continue;
      }
      for (const check of c.checks) {
        const sel = selectorOf(check);
        if (!sel) continue;
        const hasDurable = Boolean(sel.role || sel.name || sel.label || sel.placeholder);
        if (!hasDurable && (sel.text || sel.testId)) {
          durabilityNotes.push({ id: c.id, basis: sel.testId ? 'testId' : 'text' });
        }
      }
    }
  }

  // Nemesis coverage.
  const nemesisNotes: string[] = [];
  const viewports = spec.conditions?.viewports ?? [];
  const network = spec.conditions?.network ?? [];
  if (!spec.conditions || (viewports.length === 0 && network.length === 0)) {
    nemesisNotes.push(
      'no conditions matrix — add viewports (e.g. [375, 768, 1280]) and network ' +
        '(e.g. [normal, slow-3g, api-500]) so property/hard checks fan across the nemesis matrix.',
    );
  } else {
    if (viewports.length === 0)
      nemesisNotes.push('conditions.viewports is empty — no responsive coverage.');
    if (network.length === 0)
      nemesisNotes.push('conditions.network is empty — no degraded-network coverage.');
  }
  // dataState coverage (A2): the criterion's text names a degraded data state
  // but carries no `dataState` condition — hand-authored specs miss the
  // compiler's auto-attach, so its checks/scoring would run against the
  // populated render instead of the forced one.
  for (const c of spec.criteria) {
    const detected = detectDataState(c.text);
    if (detected && !c.dataState) {
      nemesisNotes.push(
        `criterion ${c.id} mentions a '${detected}' data state but has no dataState condition — ` +
          `patch { dataState: '${detected}' } via spec_update so it verifies against the forced ` +
          `'${detected}' render.`,
      );
    }
  }

  // Perf-criterion hygiene: dedup metrics across criteria + flag soft "fast"
  // criteria that overlap an existing hard perf budget.
  const perfNotes: string[] = [];
  const metricToIds = new Map<string, string[]>();
  for (const c of spec.criteria) {
    for (const check of c.checks ?? []) {
      const metric = perfMetricOf(check);
      if (!metric) continue;
      const ids = metricToIds.get(metric) ?? [];
      if (!ids.includes(c.id)) ids.push(c.id);
      metricToIds.set(metric, ids);
    }
  }
  for (const [metric, ids] of metricToIds) {
    if (ids.length > 1) {
      perfNotes.push(
        `metric "${metric}" is budgeted by ${ids.join(', ')} — consolidate into ONE perf criterion.`,
      );
    }
  }
  if (metricToIds.size > 0) {
    for (const c of spec.criteria) {
      if (c.tier !== 'soft') continue;
      const words = new Set(c.text.toLowerCase().match(/[a-z]+/g) ?? []);
      if ([...words].some((w) => PERF_WORDS.has(w))) {
        perfNotes.push(
          `soft criterion ${c.id} ("${c.text}") describes performance, but a hard perf budget ` +
            `already exists — drop the soft one (it double-counts) or fold it into the budget.`,
        );
      }
    }
  }

  return {
    uncoveredClauses,
    promoteCandidates,
    pixelInvisibleNotes,
    missingChecks,
    durabilityNotes,
    nemesisNotes,
    perfNotes,
  };
}
