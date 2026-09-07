/**
 * Onboard MCP tools — cold-start spec coverage for an existing React codebase.
 *
 * The loop the host agent runs (often under /loop or as a goal):
 *   1. validity__onboard_enumerate → a page of UN-COVERED components/screens
 *      (path + name + source preview + suggested targets).
 *   2. For each: draft acceptance criteria from the source, call
 *      validity__spec_create then validity__spec_freeze (the agent supplies the
 *      LLM judgement; Validity has none).
 *   3. validity__onboard_progress to mark it done/skipped (resumable).
 *   4. Repeat with the returned nextCursor until hasMore is false.
 *
 * Enumerate is paginated so a huge repo never truncates silently — the totals,
 * hasMore, and nextCursor always describe the full remainder.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  buildCatalog,
  computeOnboardReport,
  countCriteriaByTier,
  enumerateUncovered,
  generateCandidateCriteria,
  listSpecs,
  loadOnboardState,
  readSpec,
  recordOnboardBaseline,
  recordOnboardProgress,
  ONBOARD_DEFAULT_PAGE,
  ONBOARD_MAX_PAGE,
  type CatalogEntry,
  type OnboardCandidate,
  type OnboardReport,
} from '@validity.ai/verify-spec';

function text(body: string): ServerResult {
  return { content: [{ type: 'text', text: body }] };
}
function errorText(body: string): ServerResult {
  return { isError: true, content: [{ type: 'text', text: body }] };
}
function resolveProjectRoot(input?: string): string {
  return input ? resolve(input) : process.cwd();
}

/** First N chars of a file, for quick agent context. Undefined on read failure. */
function sourcePreview(projectRoot: string, relPath: string, max = 600): string | undefined {
  try {
    return readFileSync(resolve(projectRoot, relPath), 'utf-8').slice(0, max);
  } catch {
    return undefined;
  }
}

export interface OnboardEnumerateArgs {
  projectRoot?: string;
  pageSize?: number;
  cursor?: string;
  /** Which target kinds to onboard. Default ['component','screen']. */
  kinds?: Array<'component' | 'screen' | 'view'>;
}

export async function handleOnboardEnumerate(args: OnboardEnumerateArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  let config;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    return errorText(`Validity onboard error: ${(err as Error).message}`);
  }

  const kinds = new Set(args.kinds ?? ['component', 'screen']);
  let catalog;
  try {
    // includeProps so the deterministic generator can detect literal-union
    // variant props (one criterion per variant value, not one per variant).
    catalog = buildCatalog(projectRoot, config, { includeProps: true });
  } catch (err) {
    return errorText(
      `Validity onboard error: could not build the component catalog — ${(err as Error).message}. ` +
        `Check .validity/config.ts.`,
    );
  }
  const candidates: OnboardCandidate[] = catalog.entries
    .filter((e) => kinds.has(e.kind))
    .map((e) => ({ path: e.path, name: e.name, kind: e.kind }));

  if (candidates.length === 0) {
    return text(
      `No ${[...kinds].join('/')} targets discovered under ${projectRoot}. ` +
        `Check .validity/config.ts or that the project has React components.`,
    );
  }

  const result = enumerateUncovered({
    candidates,
    specs: listSpecs(projectRoot),
    state: loadOnboardState(projectRoot),
    cursor: args.cursor,
    pageSize: args.pageSize,
  });

  // Stamp the self-reported 'before' coverage for this bulk pass. First-write-
  // wins in core, so re-calling enumerate mid-pass (coverage grows as specs are
  // created) never moves the 'before' goalposts — calling on every page is safe.
  recordOnboardBaseline({
    projectRoot,
    totalUncovered: result.totalUncovered,
    alreadyCovered: result.alreadyCovered,
    now: new Date().toISOString(),
  });

  // Index catalog entries by path so each worklist row can attach the
  // deterministic draft criteria + tier counts without an O(n²) scan.
  const entryByPath = new Map<string, CatalogEntry>();
  for (const e of catalog.entries) entryByPath.set(e.path, e);
  const scenarioNames = Object.keys(config.scenarios ?? {});

  const worklist = result.page.map((c) => {
    const entry = entryByPath.get(c.path);
    const draftCriteria = entry
      ? generateCandidateCriteria({
          entry,
          navigation: catalog.navigation,
          scenarioNames,
        })
      : [];
    const draftSummary = countCriteriaByTier({ criteria: draftCriteria });
    return {
      path: c.path,
      name: c.name,
      kind: c.kind,
      // Path is the durable target for change-mapping (`verify --all --changed`).
      suggestedTargets: [c.path],
      sourcePreview: sourcePreview(projectRoot, c.path),
      // DETERMINISTIC mechanical starter criteria — a safe default spec, NOT a
      // rubber stamp. REVIEW AND EDIT (promote, demote, drop, rewrite) before
      // validity__spec_create. ≤4 normative (hard/property) criteria; any
      // judgment-flavored criterion is emitted as `tier: soft,
      // severity: 'advisory'` (advisory only — it can't gate sign-off).
      draftCriteria,
      draftSummary,
    };
  });

  const header = [
    `Onboard worklist for ${projectRoot}`,
    `${result.totalUncovered} uncovered · ${result.alreadyCovered} already have specs · ${result.skippedCount} skipped.`,
    result.staleCursor
      ? 'Your cursor sorted past all remaining work (the catalog changed) — restarted from the front; no items were skipped.'
      : '',
    `Showing ${worklist.length}${result.hasMore ? ` (more available — re-call with cursor="${result.nextCursor}")` : ' (last page)'}.`,
    '',
    'Each entry carries `draftCriteria` — a DETERMINISTIC mechanical starting point (≤4 normative',
    'hard/property criteria; judgment-flavored ones are soft + advisory ONLY). They are a safe',
    'default, NOT a rubber stamp: REVIEW AND EDIT each draft (promote, demote, drop, or rewrite)',
    'before calling validity__spec_create. Pass `bulk: true` and one shared `batchId` for the whole',
    'pass to validity__spec_create so the created specs start ON PROBATION (failures surface as',
    'low-severity `needs-review` until a human confirms a clean pass), then validity__spec_freeze,',
    'then validity__onboard_progress. Finish the pass with validity__onboard_report for a',
    'before→after coverage self-report.',
    '',
    '```json',
    JSON.stringify(
      { components: worklist, hasMore: result.hasMore, nextCursor: result.nextCursor ?? null },
      null,
      2,
    ),
    '```',
  ];
  return text(header.join('\n'));
}

export interface OnboardProgressArgs {
  projectRoot?: string;
  path?: string;
  status?: 'done' | 'skipped';
  specId?: string;
  reason?: string;
}

export async function handleOnboardProgress(args: OnboardProgressArgs): Promise<ServerResult> {
  if (!args.path) return errorText('Validity onboard error: `path` is required.');
  if (args.status !== 'done' && args.status !== 'skipped') {
    return errorText('Validity onboard error: `status` must be "done" or "skipped".');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const state = recordOnboardProgress({
    projectRoot,
    path: args.path,
    status: args.status,
    specId: args.specId,
    reason: args.reason,
    now: new Date().toISOString(),
  });
  const doneCount = Object.keys(state.done).length;
  const skippedCount = Object.keys(state.skipped).length;
  return text(
    `Recorded ${args.path} as ${args.status}${args.specId ? ` (spec ${args.specId})` : ''}. ` +
      `Onboard progress: ${doneCount} done · ${skippedCount} skipped.`,
  );
}

export interface OnboardReportArgs {
  projectRoot?: string;
}

/**
 * Self-reported before→after coverage for a bulk onboard pass. Rebuilds the
 * same candidate set as `validity__onboard_enumerate` (same default kinds,
 * same catalog), feeds it to the pure core `computeOnboardReport`, then
 * reads each created spec to attach per-tier criterion counts. Renders the
 * full report as prose + a verbatim JSON block.
 */
export async function handleOnboardReport(args: OnboardReportArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  let config;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    return errorText(`Validity onboard error: ${(err as Error).message}`);
  }

  let catalog;
  try {
    catalog = buildCatalog(projectRoot, config);
  } catch (err) {
    return errorText(
      `Validity onboard error: could not build the component catalog — ${(err as Error).message}. ` +
        `Check .validity/config.ts.`,
    );
  }
  // Same default kinds as enumerate so 'after' coverage matches the worklist
  // the agent was iterating over.
  const kinds = new Set<'component' | 'screen' | 'view'>(['component', 'screen']);
  const candidates: OnboardCandidate[] = catalog.entries
    .filter((e) => kinds.has(e.kind))
    .map((e) => ({ path: e.path, name: e.name, kind: e.kind }));

  const report: OnboardReport = computeOnboardReport({
    candidates,
    specs: listSpecs(projectRoot),
    state: loadOnboardState(projectRoot),
  });

  // Attach per-tier criterion counts to each created entry that has a specId,
  // by reading the spec back from disk. Entries without a specId (progress
  // recorded without the spec id) keep `tierCounts: undefined`.
  const createdWithCounts = report.created.map((c) => {
    if (!c.specId) return c;
    const spec = readSpec(projectRoot, c.specId);
    if (!spec) return c;
    return { ...c, tierCounts: countCriteriaByTier(spec) };
  });

  const beforeLine = report.before
    ? `before: ${report.before.covered}/${report.before.total} covered (${report.before.pct}%)`
    : 'before: unknown (no baseline was stamped — call validity__onboard_enumerate first)';
  const afterLine = `after: ${report.after.covered}/${report.after.total} covered (${report.after.pct}%)`;

  const lines: string[] = [];
  lines.push(`Onboard report for ${projectRoot}`);
  lines.push('');
  lines.push('Coverage:');
  lines.push(`  ${beforeLine}`);
  lines.push(`  ${afterLine}`);
  lines.push(`  remaining uncovered: ${report.remainingUncovered}`);
  lines.push('');

  lines.push('Created specs (per-spec criterion counts by tier):');
  if (createdWithCounts.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of createdWithCounts) {
      const tc = 'tierCounts' in c && c.tierCounts ? c.tierCounts : null;
      const counts = tc
        ? `${tc.hard} hard · ${tc.property} property · ${tc.soft} soft (${tc.advisorySoft} advisory)`
        : 'spec not found or has no specId';
      lines.push(`  ${c.path} → ${c.specId ?? '—'}: ${counts} (marked done at ${c.at})`);
    }
  }
  lines.push('');

  // EXPLICIT full skipped list — never truncated, no silent caps. Every
  // skipped path + reason is listed so a reviewer can audit the whole pass.
  lines.push('Skipped (FULL list — no silent caps):');
  if (report.skipped.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of report.skipped) {
      lines.push(`  ${s.path}${s.reason ? ` — ${s.reason}` : ''} (at ${s.at})`);
    }
  }
  lines.push('');

  // Verbatim JSON of the whole report (with per-spec tier counts) so an agent
  // can parse the structured form without scraping prose.
  lines.push('```json');
  lines.push(JSON.stringify({ ...report, created: createdWithCounts }, null, 2));
  lines.push('```');

  return text(lines.join('\n'));
}

export const ONBOARD_TOOL_DEFINITIONS = [
  {
    name: 'validity__onboard_enumerate',
    description:
      'Cold-start spec coverage on an existing React codebase. Returns a PAGE of renderable ' +
      'targets (components/screens) that have no spec yet, each with a source preview, ' +
      'suggested targets, and `draftCriteria` — DETERMINISTIC mechanical starting points (≤4 ' +
      'normative hard/property criteria; judgment-flavored ones soft + advisory ONLY). These ' +
      'drafts are a safe default to REVIEW AND EDIT, not rubber-stamp, before ' +
      '`validity__spec_create`. Pass `bulk: true` and one shared `batchId` to spec_create so the ' +
      'batch starts ON PROBATION, then `validity__spec_freeze` + `validity__onboard_progress`, ' +
      'then re-call with the returned `nextCursor` until `hasMore` is false. Finish the pass with ' +
      '`validity__onboard_report` for a before→after coverage self-report. Paginated so large ' +
      `repos never truncate silently (default page ${ONBOARD_DEFAULT_PAGE}, max ${ONBOARD_MAX_PAGE}).`,
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
        pageSize: {
          type: 'number',
          description: `Max targets per page (default ${ONBOARD_DEFAULT_PAGE}, max ${ONBOARD_MAX_PAGE}).`,
        },
        cursor: {
          type: 'string',
          description: 'nextCursor from a prior page. Omit for the first page.',
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['component', 'screen', 'view'] },
          description: "Target kinds to onboard. Default ['component','screen'].",
        },
      },
    },
  },
  {
    name: 'validity__onboard_progress',
    description:
      'Mark an onboard target done (a spec was created) or skipped (intentionally no spec). ' +
      'Skipped targets are excluded from future enumerate pages so the loop converges. ' +
      'Load-merge-saved to .validity/onboard-state.json (resumable, concurrency-safe).',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
        path: {
          type: 'string',
          description: 'The target path from the worklist (e.g. src/components/X.tsx).',
        },
        status: { type: 'string', enum: ['done', 'skipped'] },
        specId: {
          type: 'string',
          description: 'The spec id created for this target (when status=done).',
        },
        reason: { type: 'string', description: 'Why skipped (when status=skipped).' },
      },
      required: ['path', 'status'],
    },
  },
  {
    name: 'validity__onboard_report',
    description:
      'Self-reported before→after coverage for a bulk onboard pass. Rebuilds the same candidate ' +
      'set as validity__onboard_enumerate (same default kinds), reads the current specs + onboard ' +
      'state, and renders: coverage before → after (counts + %, "before unknown" when no baseline ' +
      'was stamped), per-spec criterion counts by tier for every created spec, the EXPLICIT FULL ' +
      'skipped list with reasons (never truncated — no silent caps), the remaining uncovered ' +
      'count, plus a verbatim JSON block of the whole report. Call once at the end of a bulk pass ' +
      'to review what landed.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
      },
    },
  },
] as const;
