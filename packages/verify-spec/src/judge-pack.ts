/**
 * Judge pack — a self-contained blind-judging bundle for a verify run.
 *
 * `validity judge-pack <runId>` (and any future caller) emits a directory —
 * default `.validity/runs/<runId>/judge-pack/` — that a FRESH-CONTEXT judge
 * (a clean subagent or a human) can score from without any build context:
 *
 *   rubric.json         — frozen soft criteria + the citable screenshot list
 *   screenshots/*.png   — copies of the run's evidence
 *   scores.schema.json  — JSON Schema for the judge's output (mirrors
 *                         validity__record_soft_scores' args)
 *   SCORING.md          — blind-judging instructions
 *
 * DELIBERATE EXCLUSIONS (the whole point): no component source, no diff, no
 * prompt history, no spec `source.prompt`. The judge scores blind from the
 * screenshots against EXACTLY the frozen criterion text. The pack writes no
 * verdicts anywhere — scores come back through the same MCP tools, where the
 * soft-only / citation / taint gates still apply.
 *
 * Gate integrity: the rubric is only emitted when it can be pinned to the
 * exact frozen content the run verified against (`meta.specHash`). A drifted
 * spec is a hard error — a re-worded criterion must never be scored as if
 * frozen.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runDir, runsDir } from './runs.js';
import { readRunMeta, type RunMeta } from './run.js';
import { computeSpecHash, readSpec, readSpecVersion } from './specs.js';
import type { Spec } from './spec-schema.js';
import { containedFile, readContainedPng } from './contained-file.js';
import type { JudgeMode, ScoringConfig } from './types.js';

export const JUDGE_PACK_DIRNAME = 'judge-pack';

/** Same cap as the MCP screenshot inliner — a pathological PNG is not packed. */
const MAX_PACK_SCREENSHOT_BYTES = 25 * 1024 * 1024;

/**
 * The ONE place the default judge mode is expressed (§9.6). Everything that
 * needs the knob — scorecard-tools warnings, submit_report stamping, the
 * report badge — resolves through here, so flipping the default is one line.
 */
export function resolveJudgeMode(
  config: { scoring?: ScoringConfig } | null | undefined,
): JudgeMode {
  return config?.scoring?.judge ?? 'self';
}

export function judgePackDir(projectRoot: string, runId: string): string {
  return resolve(runDir(projectRoot, runId), JUDGE_PACK_DIRNAME);
}

/** User-ready error from `emitJudgePack`; `code` routes the CLI's hints. */
export class JudgePackError extends Error {
  readonly code: 'unknown-run' | 'unplanned-run' | 'rubric-unreconstructable';
  constructor(code: JudgePackError['code'], message: string) {
    super(message);
    this.name = 'JudgePackError';
    this.code = code;
  }
}

export interface JudgePackScreenshot {
  /** PNG filename inside the pack's screenshots/ dir. Absent when evidence is missing. */
  file?: string;
  /** The citable id (== ComponentRender.id / PageRender.id) the judge's scores must reference. */
  screenshotId: string;
  label: string;
  /**
   * Present ⇒ no file; the criteria resting on this render are `unverifiable`.
   * Scrubbed (first line, paths stripped, truncated) — never the raw error,
   * which is build context the blind judge must not see.
   */
  renderError?: string;
  /** PNG not on disk / outside the runs dir / skipped — same unverifiable rule. */
  missing?: boolean;
}

export interface JudgePackRubricCriterion {
  id: string;
  text: string;
  softThreshold?: number;
  severity?: 'blocking' | 'advisory';
}

export interface JudgePackRubric {
  formatVersion: 1;
  runId: string;
  createdAt: string;
  specId: string;
  specVersion: number;
  /** Frozen content hash when the run recorded one (binds rubric to exact content). */
  specHash?: string;
  judgeInstructions: 'SCORING.md';
  criteria: JudgePackRubricCriterion[];
  screenshots: JudgePackScreenshot[];
}

export interface JudgePackResult {
  dir: string;
  specId: string;
  specVersion: number;
  softCriteria: number;
  /** PNGs actually copied into the pack. */
  screenshots: number;
  warnings: string[];
}

/**
 * Screenshot entries from a run-meta, isolation OR url mode, with the citable
 * id + human label. Single source shared by the MCP scoring rubric
 * (scorecard-tools) and the judge pack, so the two surfaces can't drift.
 * `error` mirrors renderError/errorMessage; `skipped` mirrors the cost-control
 * flag (the PNG was intentionally never written — not evidence).
 */
export function screenshotsFromRunMeta(
  meta: RunMeta,
): Array<{ id: string; label: string; path: string; error?: string; skipped?: boolean }> {
  const out: Array<{ id: string; label: string; path: string; error?: string; skipped?: boolean }> =
    [];
  for (const c of meta.components ?? []) {
    // Pre-interaction companion first (present only when interactive checks
    // mutated the page): initial-state soft criteria are scored against the
    // pristine render, not post-click residue. Citable under `<id>::pre` —
    // render ids are path/url-derived slugs, so `::` can't collide.
    if (c.preInteractionScreenshotPath && !c.renderError && !c.screenshotSkipped) {
      out.push({
        id: `${c.id}::pre`,
        label: `${c.id}${c.scenarioId ? ` · ${c.scenarioId}` : ''} · base state (before interaction checks)`,
        path: c.preInteractionScreenshotPath,
      });
    }
    out.push({
      id: c.id,
      label: `${c.id}${c.scenarioId ? ` · ${c.scenarioId}` : ''}${c.viewport ? ` · ${c.viewport.name}` : ''}`,
      path: c.screenshotPath,
      error: c.renderError,
      skipped: c.screenshotSkipped,
    });
  }
  for (const p of meta.pages ?? []) {
    out.push({
      id: p.id,
      label: `${p.url}${p.scenarioId ? ` · ${p.scenarioId}` : ''}`,
      path: p.screenshotPath,
      error: p.errorMessage,
    });
  }
  return out;
}

/**
 * The citation floor's valid-id set: every REAL, citable render id in a run —
 * errored and cost-control-skipped renders excluded (their screenshot is
 * missing or isn't evidence). Derived from {@link screenshotsFromRunMeta} so
 * the ids an agent is SHOWN (scoring rubric, judge pack) and the ids a
 * submission may CITE (submit_report, record_soft_scores) can never drift —
 * including the `<id>::pre` pre-interaction companions.
 */
export function citableScreenshotIds(meta: RunMeta): Set<string> {
  return new Set(
    screenshotsFromRunMeta(meta)
      .filter((s) => !s.error && !s.skipped)
      .map((s) => s.id),
  );
}

/** Post-scrub cap on renderError characters allowed into the pack. */
const MAX_PACK_RENDER_ERROR_CHARS = 200;

/**
 * Scrub a render error before it reaches the blind pack. A raw runtime
 * exception routinely carries a component stack / code frame with source file
 * paths, component names, and prop values — build context the BLIND-PACK
 * INVARIANT promises the judge never sees. Keep only the first line (stacks
 * and code frames live below it), replace path-like tokens, and truncate: the
 * judge only needs "this render errored — its criteria are unverifiable".
 */
function scrubRenderError(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const scrubbed = firstLine
    // Path-like tokens (absolute, relative, or windows; optional :line:col) —
    // anything with a directory separator is a codebase-layout leak.
    .replace(/(?:[A-Za-z]:)?(?:[.~]?[\w@.-]*[/\\])+[\w@.-]+(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  const capped =
    scrubbed.length > MAX_PACK_RENDER_ERROR_CHARS
      ? `${scrubbed.slice(0, MAX_PACK_RENDER_ERROR_CHARS - 1)}…`
      : scrubbed;
  return capped.length > 0 ? capped : 'render errored';
}

/** Slug a screenshot label into a pack filename; collisions get -2, -3, … */
function slugFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'shot';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/**
 * JSON Schema (draft-07) for the judge's output — field-compatible with
 * `validity__record_soft_scores` args plus `screenshotIds` compatible with
 * `submit_report` citations. A test pins the required fields so a change to
 * those tool schemas can't silently strand the pack contract.
 */
export function judgeScoresSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Validity judge scores',
    description:
      'Output contract for a blind judge. Field-compatible with validity__record_soft_scores; ' +
      'screenshotIds values are the screenshotId fields from rubric.json.',
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Criterion id from rubric.json, e.g. "AC-3".' },
            status: { type: 'string', enum: ['pass', 'fail', 'unverifiable'] },
            reasoning: {
              type: 'string',
              minLength: 1,
              description: 'Quote what you saw in the cited screenshot(s).',
            },
            score: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'Required when the criterion has a softThreshold — pass with score < threshold does not sign off.',
            },
            screenshotIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'screenshotId values from rubric.json this score rests on.',
            },
          },
          required: ['id', 'status', 'reasoning', 'screenshotIds'],
        },
      },
      scoredBy: {
        type: 'string',
        minLength: 1,
        description: 'Your model/agent identity. Must differ from the builder.',
      },
    },
    required: ['scores', 'scoredBy'],
  };
}

export interface BuiltJudgePack {
  rubric: JudgePackRubric;
  scoringMd: string;
  scoresSchema: Record<string, unknown>;
  /** Copy plan for the emitter: run-meta screenshot path → pack-relative file. */
  copies: Array<{ from: string; to: string }>;
  warnings: string[];
}

/**
 * Pure assembly of the pack's contents from a run-meta + the frozen spec the
 * run verified against. Returns null when the spec has zero soft criteria
 * (nothing for a judge to score). `screenshotUsable` is the emitter's fs
 * gate (containment + existence + size); tests pass a stub.
 *
 * BLIND-PACK INVARIANT: nothing from `meta.prompt`, `meta.componentSources`,
 * `meta.diff`, or `spec.source` may reach the output — a denylist test pins it.
 */
export function buildJudgePack(args: {
  meta: RunMeta;
  spec: Spec;
  createdAt?: string;
  screenshotUsable?: (path: string) => boolean;
  /** Provenance caveat appended to SCORING.md (old run-metas without a specHash). */
  provenanceCaveat?: string;
}): BuiltJudgePack | null {
  const { meta, spec } = args;
  const usable = args.screenshotUsable ?? (() => true);
  const soft = spec.criteria.filter((c) => c.tier === 'soft');
  if (soft.length === 0) return null;
  const mechanicalCount = spec.criteria.length - soft.length;

  const warnings: string[] = [];
  const copies: Array<{ from: string; to: string }> = [];
  const taken = new Set<string>();
  const screenshots: JudgePackScreenshot[] = [];
  for (const shot of screenshotsFromRunMeta(meta)) {
    const entry: JudgePackScreenshot = { screenshotId: shot.id, label: shot.label };
    if (shot.error) {
      // Scrubbed, never verbatim — a raw error string is build context
      // (component stacks embed source paths) the blind judge must not see.
      entry.renderError = scrubRenderError(shot.error);
    } else if (shot.skipped || !usable(shot.path)) {
      entry.missing = true;
    } else {
      entry.file = `screenshots/${slugFor(shot.label, taken)}.png`;
      copies.push({ from: shot.path, to: entry.file });
    }
    screenshots.push(entry);
  }
  const unusable = screenshots.filter((s) => !s.file).length;
  if (unusable > 0) {
    warnings.push(
      `${unusable} render${unusable === 1 ? ' has' : 's have'} no usable screenshot — ` +
        `the criteria depending on ${unusable === 1 ? 'it' : 'them'} must be scored unverifiable.`,
    );
  }

  const criteria: JudgePackRubricCriterion[] = soft.map((c) => ({
    id: c.id,
    text: c.text,
    ...(c.softThreshold != null ? { softThreshold: c.softThreshold } : {}),
    ...(c.severity ? { severity: c.severity } : {}),
  }));

  const rubric: JudgePackRubric = {
    formatVersion: 1,
    runId: meta.runId,
    createdAt: args.createdAt ?? new Date().toISOString(),
    specId: spec.id,
    specVersion: spec.version,
    ...(meta.specHash ? { specHash: meta.specHash } : {}),
    judgeInstructions: 'SCORING.md',
    criteria,
    screenshots,
  };

  const rubricLines = criteria.map((c) => {
    const annotations = [
      ...(c.softThreshold != null ? [`softThreshold ${c.softThreshold}`] : []),
      c.severity ?? 'blocking',
    ];
    return `- ${c.id} (${annotations.join(', ')}): ${c.text}`;
  });

  const scoringMd = [
    `# Blind scoring instructions — run ${meta.runId}, spec ${spec.id} v${spec.version}`,
    '',
    'You are a fresh-context judge. You were deliberately given NO component source,',
    'NO diff, and NO build conversation. Score ONLY from the screenshots in',
    './screenshots/ against the frozen rubric below.',
    '',
    'Rules (non-negotiable):',
    '',
    '1. Score against EXACTLY the criterion text. Do not reinterpret or improve it.',
    '2. pass / fail / unverifiable per criterion. `unverifiable` when the screenshots',
    '   genuinely cannot show it (motion, click behavior, missing/errored render) —',
    '   never as a soft "unsure-pass".',
    '3. Every score MUST cite the screenshot id(s) it rests on (see rubric.json →',
    '   screenshots[].screenshotId) and quote what you saw in `reasoning`.',
    '4. A criterion with a `softThreshold` also needs a numeric `score` in [0,1];',
    '   pass with score < threshold does not sign off.',
    '5. Screenshots marked with a render error or missing evidence: the criteria',
    '   depending on them are `unverifiable`. Do not infer what "would have" rendered.',
    '6. Identify yourself: set `scoredBy` to your model/agent identity. If you built',
    '   this change, STOP — you are not a fresh-context judge.',
    '',
    `## Rubric (soft criteria only — ${mechanicalCount} hard/property criteri${mechanicalCount === 1 ? 'on was' : 'a were'} decided mechanically and are not yours to score)`,
    '',
    ...rubricLines,
    '',
    '## How to return scores',
    '',
    'Either produce JSON matching ./scores.schema.json, or (with MCP access) call',
    `validity__record_soft_scores({ specId: "${spec.id}", scores: [...], scoredBy: "<you>" }).`,
    ...(args.provenanceCaveat ? ['', `_${args.provenanceCaveat}_`] : []),
    '',
  ].join('\n');

  return { rubric, scoringMd, scoresSchema: judgeScoresSchema(), copies, warnings };
}

/**
 * Resolve the exact frozen spec content the run verified against.
 *
 *  - `meta.specHash` recorded → the current spec.yaml or `history/v<n>.yaml`
 *    must re-hash to it; no match is a HARD error (never emit a rubric that
 *    differs from what the run verified — that's a laundering vector).
 *  - old run-meta without a specHash → best available version WITH a printed
 *    provenance caveat the judge can see.
 */
function resolveFrozenSpec(
  projectRoot: string,
  meta: RunMeta,
): { spec: Spec; provenanceCaveat?: string } {
  const specId = meta.specId!;
  let current: Spec | null = null;
  try {
    current = readSpec(projectRoot, specId);
  } catch {
    current = null; // malformed current spec — the history copy may still match
  }
  if (meta.specHash) {
    if (current && computeSpecHash(current) === meta.specHash) return { spec: current };
    if (meta.specVersion != null) {
      let historical: Spec | null = null;
      try {
        historical = readSpecVersion(projectRoot, specId, meta.specVersion);
      } catch {
        historical = null;
      }
      if (historical && computeSpecHash(historical) === meta.specHash) return { spec: historical };
    }
    throw new JudgePackError(
      'rubric-unreconstructable',
      `the frozen rubric for run ${meta.runId} cannot be reconstructed: spec "${specId}"` +
        `${meta.specVersion != null ? ` v${meta.specVersion}` : ''} no longer hashes to the ` +
        `content this run verified against (${meta.specHash}). The spec drifted since the run — ` +
        `re-run validity__verify against the current frozen spec instead of judging stale evidence.`,
    );
  }
  const fallback =
    (meta.specVersion != null
      ? (() => {
          try {
            return readSpecVersion(projectRoot, specId, meta.specVersion);
          } catch {
            return null;
          }
        })()
      : null) ?? current;
  if (!fallback) {
    throw new JudgePackError(
      'rubric-unreconstructable',
      `spec "${specId}" for run ${meta.runId} was not found in .validity/specs/ — ` +
        `the rubric cannot be reconstructed.`,
    );
  }
  return {
    spec: fallback,
    provenanceCaveat:
      'rubric provenance: spec hash was not recorded on this run (older Validity) — ' +
      'the rubric is the best-available frozen version, not hash-verified.',
  };
}

/**
 * Emit the blind-judge bundle. Pure read + derived-directory write — never
 * touches scorecard/signals/run-meta. Throws {@link JudgePackError} on unknown
 * runId, an unplanned (spec-less) run, or an unreconstructable frozen rubric.
 * Returns null when the spec has zero soft criteria (nothing written).
 *
 * Idempotent: re-emitting overwrites the derived files; foreign files already
 * in the directory are left alone.
 */
export function emitJudgePack(args: {
  projectRoot: string;
  runId: string;
  outDir?: string;
}): JudgePackResult | null {
  const { projectRoot, runId } = args;
  const meta = readRunMeta(projectRoot, runId);
  if (!meta) {
    throw new JudgePackError('unknown-run', `no run-meta found for "${runId}".`);
  }
  if (!meta.specId) {
    throw new JudgePackError(
      'unplanned-run',
      `run ${runId} has no frozen spec — judge packs require one. Re-run with validity__plan ` +
        `first (the rubric must be frozen BEFORE scoring, or the judge is just re-extracting criteria).`,
    );
  }
  const { spec, provenanceCaveat } = resolveFrozenSpec(projectRoot, meta);

  // Path containment (defense-in-depth, same rule as the MCP screenshot
  // inliner): only copy a PNG that lives inside `.validity/runs/` and is under
  // the size cap. A crafted run-meta must never exfiltrate an arbitrary host
  // file into a bundle that is BY DESIGN handed to another context.
  const runsRoot = runsDir(projectRoot);
  const screenshotUsable = (path: string): boolean => {
    const resolved = resolve(projectRoot, path);
    if (!containedFile(projectRoot, resolved) || !containedFile(runsRoot, resolved)) return false;
    try {
      return (
        statSync(resolved).size <= MAX_PACK_SCREENSHOT_BYTES &&
        readContainedPng(runsRoot, resolved) !== null
      );
    } catch {
      return false;
    }
  };

  const built = buildJudgePack({ meta, spec, screenshotUsable, provenanceCaveat });
  if (!built) return null;

  const dir = args.outDir ?? judgePackDir(projectRoot, runId);
  mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
  writeFileSync(resolve(dir, 'rubric.json'), JSON.stringify(built.rubric, null, 2));
  writeFileSync(resolve(dir, 'scores.schema.json'), JSON.stringify(built.scoresSchema, null, 2));
  writeFileSync(resolve(dir, 'SCORING.md'), built.scoringMd);
  let copied = 0;
  for (const copy of built.copies) {
    try {
      const source = resolve(projectRoot, copy.from);
      const bytes = containedFile(projectRoot, source) && readContainedPng(runsRoot, source);
      if (!bytes) throw new Error('unsafe or invalid PNG');
      writeFileSync(resolve(dir, copy.to), bytes);
      copied++;
    } catch {
      built.warnings.push(`screenshot copy failed for ${copy.to} — entry is missing evidence.`);
    }
  }
  return {
    dir,
    specId: spec.id,
    specVersion: spec.version,
    softCriteria: built.rubric.criteria.length,
    screenshots: copied,
    warnings: built.warnings,
  };
}
