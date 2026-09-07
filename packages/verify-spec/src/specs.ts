/**
 * Spec persistence — durable, versioned, reviewable specs on disk.
 *
 * Layout (per the spec doc):
 *
 *   .validity/
 *     specs/
 *       spec-7f3a/
 *         spec.yaml          # current version
 *         history/           # prior frozen versions (v1.yaml, v2.yaml)
 *
 * Pure I/O + schema validation — no LLM lives here. Specs are stored as
 * YAML because they are meant to be human-reviewed and committed; YAML's
 * comment support and block scalars make the `checks` action lists readable
 * in a PR.
 *
 * Immutability contract: a `frozen` spec is never edited in place. An edit
 * snapshots the frozen content into `history/v<n>.yaml` and writes a new
 * `draft` at version n+1 with `supersedes: <id>@v<n>`. The hash binds reports
 * and approvals to exact content.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { hash, writeFileAtomic } from './util.js';
import { validityDir } from './runs.js';
import {
  criterionIsBlocking,
  parseSpec,
  SpecValidationError,
  type Spec,
  type SpecCriterion,
  type SpecGitBinding,
} from './spec-schema.js';
import { collectGitBinding } from './git.js';
import { compileCriteria, CHECK_COMPILER_VERSION } from './compile-checks.js';
import { RUBRIC_VERSION } from './rubric-version.js';
import type { AcceptanceCriterion, ValidityPlan } from './types.js';

export function specsDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'specs');
}

export function specDir(projectRoot: string, specId: string): string {
  return resolve(specsDir(projectRoot), specId);
}

export function specPathFor(projectRoot: string, specId: string): string {
  return resolve(specDir(projectRoot, specId), 'spec.yaml');
}

export function specHistoryDir(projectRoot: string, specId: string): string {
  return resolve(specDir(projectRoot, specId), 'history');
}

/**
 * Mint a short, readable spec id (`spec-7f3a` style). Collisions are
 * vanishingly unlikely with 4 hex chars, but we still loop against the
 * filesystem to be safe and widen to 8 hex on the rare clash.
 */
export function newSpecId(projectRoot?: string): string {
  for (let width = 2; width <= 6; width += 2) {
    const id = `spec-${randomBytes(width).toString('hex')}`;
    if (!projectRoot || !existsSync(specDir(projectRoot, id))) return id;
  }
  return `spec-${randomBytes(8).toString('hex')}`;
}

/**
 * Deterministic serializer: recursively sorts object keys at EVERY nesting
 * level (arrays keep their order — criterion/check order is meaningful) and
 * JSON-encodes. Used by `computeSpecHash` so the hash covers the WHOLE content
 * tree.
 *
 * Why not `JSON.stringify(value, keyAllowlist)`? When the second arg is an
 * array, JSON.stringify treats it as a property ALLOWLIST applied at every
 * nesting level — so any key not in the list (criteria[].text/tier/checks,
 * source.prompt, targets, conditions, …) is silently DROPPED from the output.
 * That made the old hash blind to nested edits.
 *
 * Exported so `plans.ts` can reuse the EXACT same canonical serializer for the
 * plan content hash — keeping spec and plan hashing on one implementation.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined) // mirror JSON.stringify: drop undefined members
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Scoring-contract version. Folded into `computeSpecHash` so a spec frozen
 * under one soft-scoring contract can never be silently re-scored under a
 * different one: bumping this constant changes the hash of every newly frozen
 * spec, surfacing as a spec change (not a silent pass). Stamped onto run-meta
 * by `submit_report` and surfaced in the report. Bump when the soft-scoring
 * rules change in a way that invalidates prior verdicts.
 */
export const SCORING_CONTRACT_VERSION = 'v1';

/**
 * Canonical content hash. Excludes the volatile/derived fields (`hash`,
 * `updatedAt`) so re-freezing identical content yields a stable hash that
 * reports and approvals can bind to. Uses a deep key-sort serializer so the
 * hash reflects EVERY nested field, not just the top-level keys. The
 * `SCORING_CONTRACT_VERSION` is mixed in (as a synthetic `scoringContract`
 * key, never written to disk) so re-scoring under a new contract changes the
 * hash rather than silently reusing the old verdict.
 */
export function computeSpecHash(spec: Spec): string {
  // `git` (B2 freeze binding) is EXCLUDED like `hash`/`updatedAt` — it's freeze
  // provenance, not content, so it must never perturb a frozen content hash.
  // `probation` (Phase C bulk-onboarding marker) is the SAME kind of provenance:
  // clearing it must never perturb a frozen hash or fire spec-changed. The
  // signal-severity downgrade keyed on its presence is a runtime concern, not a
  // contract one — the hash binds content only.
  // `rubric` (E2.2 freeze-time rubric baseline) joins them for the same reason:
  // the rubric says how a judge is INSTRUCTED, not what the spec asks for.
  // Hashing it would make a rubric bump silently unbind every frozen spec's
  // reports and approvals — verify's advisory drift warning is the surface.
  const {
    hash: _omitHash,
    updatedAt: _omitUpdated,
    git: _omitGit,
    probation: _omitProbation,
    rubric: _omitRubric,
    ...content
  } = spec;
  return `sha256-${hash(stableStringify({ ...content, scoringContract: SCORING_CONTRACT_VERSION }))}`;
}

/** Serialize a spec to the on-disk YAML form. */
export function serializeSpec(spec: Spec): string {
  return stringifyYaml(spec, { lineWidth: 0 });
}

function ensureSpecDir(projectRoot: string, specId: string): void {
  const dir = specDir(projectRoot, specId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Write the current spec.yaml. Validates shape first so a malformed spec
 * never lands on disk. Returns the absolute path written.
 */
export function writeSpec(projectRoot: string, spec: Spec): string {
  const validated = parseSpec(spec);
  ensureSpecDir(projectRoot, validated.id);
  const path = specPathFor(projectRoot, validated.id);
  writeFileAtomic(path, serializeSpec(validated));
  return path;
}

/**
 * Load a spec by id. Returns null when not found; throws
 * `SpecValidationError` when the file exists but is malformed (a corrupt
 * spec is a real error the caller should surface, not silently swallow).
 */
export function readSpec(projectRoot: string, specId: string): Spec | null {
  const path = specPathFor(projectRoot, specId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new SpecValidationError(`spec ${specId} is not valid YAML: ${(err as Error).message}`);
  }
  return parseSpec(parsed);
}

/**
 * Read a specific frozen version of a spec: `history/v<n>.yaml` when the
 * version was superseded, else the live `spec.yaml` when its version matches.
 * Returns null when that version is unavailable; throws `SpecValidationError`
 * on a malformed history file (corruption is a real error, like `readSpec`).
 * Consumed by the judge pack (A6); B2 temporal binding / compare read it too.
 */
export function readSpecVersion(projectRoot: string, specId: string, version: number): Spec | null {
  const historyPath = resolve(specHistoryDir(projectRoot, specId), `v${version}.yaml`);
  if (existsSync(historyPath)) {
    const raw = readFileSync(historyPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new SpecValidationError(
        `spec ${specId} history v${version} is not valid YAML: ${(err as Error).message}`,
      );
    }
    return parseSpec(parsed);
  }
  const current = readSpec(projectRoot, specId);
  return current && current.version === version ? current : null;
}

/** List every spec id under `.validity/specs/`. */
export function listSpecIds(projectRoot: string): string[] {
  const dir = specsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(specPathFor(projectRoot, e.name)))
    .map((e) => e.name)
    .sort();
}

/** Load every spec, skipping malformed ones (logged via the onError hook). */
export function listSpecs(projectRoot: string, onError?: (id: string, err: Error) => void): Spec[] {
  const out: Spec[] = [];
  for (const id of listSpecIds(projectRoot)) {
    try {
      const spec = readSpec(projectRoot, id);
      if (spec) out.push(spec);
    } catch (err) {
      onError?.(id, err as Error);
    }
  }
  return out;
}

export interface CreateSpecArgs {
  projectRoot: string;
  prompt: string;
  criteria: SpecCriterion[];
  runtime?: Spec['runtime'];
  createdBy?: Spec['source']['createdBy'];
  targets?: Spec['targets'];
  conditions?: Spec['conditions'];
  /** Override the generated id (used by the plan→spec bridge for continuity). */
  specId?: string;
  createdAt?: string;
  /** Compiler contract version stamped onto `source.compiledWith` (hashed). */
  compiledWith?: string;
  /**
   * Bulk-onboarding probation (Phase C). When provided, the created draft is
   * stamped `probation: { since: now, batchId }` — the spec cannot generate
   * high-severity signals until `clearSpecProbation` lifts it after a confirmed
   * clean pass. Excluded from `computeSpecHash`.
   */
  probation?: { batchId?: string };
}

/** Create a new draft spec and persist it. */
export function createSpec(args: CreateSpecArgs): { specId: string; spec: Spec; path: string } {
  const specId = args.specId ?? newSpecId(args.projectRoot);
  const now = args.createdAt ?? new Date().toISOString();
  const spec: Spec = {
    id: specId,
    version: 1,
    status: 'draft',
    source: {
      prompt: args.prompt,
      createdBy: args.createdBy ?? 'agent',
      // Stamp the compiler contract the criteria were authored/compiled under
      // (W2 #4). Always present now — a spec with no stamp reads as stale and
      // would trip the migration path spuriously. Callers with a known compile
      // version (the plan→spec bridge) pass it; direct spec_create defaults to
      // the current contract.
      compiledWith: args.compiledWith ?? CHECK_COMPILER_VERSION,
    },
    runtime: args.runtime ?? 'web',
    targets: args.targets,
    criteria: args.criteria,
    conditions: args.conditions,
    // Bulk-onboarding probation (Phase C). Only the bulk-create path passes
    // this; the marker is hashed-out provenance and a runtime signal gate.
    probation: args.probation ? { since: now, batchId: args.probation.batchId } : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const path = writeSpec(args.projectRoot, spec);
  return { specId, spec, path };
}

export interface UpdateSpecArgs {
  projectRoot: string;
  specId: string;
  /** Partial mutation applied over the current spec content. */
  patch: Partial<
    Pick<Spec, 'criteria' | 'targets' | 'conditions' | 'runtime' | 'status' | 'source'>
  >;
  /** Agent/user id appended to source.reviewedBy when provided. */
  by?: string;
  updatedAt?: string;
}

/**
 * Amend a spec. A draft is mutated in place (version unchanged). A FROZEN
 * spec is immutable: the current frozen content is snapshotted into
 * `history/v<n>.yaml`, then a new draft at version n+1 is written with a
 * `supersedes: <id>@v<n>` lineage pointer and a cleared hash.
 */
export function updateSpec(args: UpdateSpecArgs): { spec: Spec; path: string; bumped: boolean } {
  // Guard the forge: `frozen` and `approved` are not free-text status writes.
  // Setting `frozen` here would mint an immutable spec with NO content hash
  // (unrepairable, and unbindable by reports/approvals); setting `approved`
  // would let the same agent self-clear the `specApproval: 'always'` gate.
  // Both must go through freezeSpec / the out-of-band approval flow.
  if (args.patch.status === 'frozen' || args.patch.status === 'approved') {
    throw new SpecValidationError(
      `cannot set spec "${args.specId}" status to "${args.patch.status}" via spec_update — ` +
        `use freezeSpec (validity__spec_freeze) to lock + hash a spec. spec_update only sets ` +
        `draft/reviewed/superseded.`,
    );
  }
  const current = readSpec(args.projectRoot, args.specId);
  if (!current) {
    throw new SpecValidationError(`spec "${args.specId}" not found in .validity/specs/.`);
  }
  const now = args.updatedAt ?? new Date().toISOString();
  const wasFrozen = current.status === 'frozen' || current.status === 'approved';

  const reviewedBy = args.by
    ? Array.from(new Set([...(current.source.reviewedBy ?? []), args.by]))
    : current.source.reviewedBy;

  // Re-stamp the compiler contract whenever the criteria/checks change (W2 #4):
  // the mechanical bar is being re-authored, so the old `compiledWith` (which
  // rode along via `...current.source`) would lie about which contract produced
  // this content and leave a genuinely-migrated spec looking stale. A metadata-
  // only edit (no criteria patch) keeps the existing stamp.
  const restamp = args.patch.criteria !== undefined ? { compiledWith: CHECK_COMPILER_VERSION } : {};

  if (wasFrozen) {
    snapshotToHistory(args.projectRoot, current);
    const next: Spec = {
      ...current,
      ...args.patch,
      source: { ...current.source, ...args.patch.source, ...restamp, reviewedBy },
      version: current.version + 1,
      status: 'draft',
      hash: undefined,
      // The v(n) freeze-time binding is provenance of THAT freeze — carrying
      // it onto v(n+1) would let a re-freeze that can't collect git inherit a
      // stale 'frozen-before-work' snapshot from a different version. The new
      // version stamps its own binding at freeze, or stays unstamped (honest
      // `unknown`).
      git: undefined,
      // NOTE: `probation` (Phase C bulk-onboarding marker) is INTENTIONALLY
      // carried onto v(n+1) via the `...current` spread above — unlike `git`,
      // probation is content-independent provenance that survives an edit: a
      // bulk spec re-edited before its first clean pass must stay on probation
      // (it has still not been confirmed). It is lifted ONLY by
      // `clearSpecProbation`, never by a version bump. Do not add
      // `probation: undefined` here.
      supersedes: `${current.id}@v${current.version}`,
      updatedAt: now,
    };
    const path = writeSpec(args.projectRoot, next);
    return { spec: next, path, bumped: true };
  }

  const next: Spec = {
    ...current,
    ...args.patch,
    source: { ...current.source, ...args.patch.source, ...restamp, reviewedBy },
    status: args.patch.status ?? current.status,
    updatedAt: now,
  };
  const path = writeSpec(args.projectRoot, next);
  return { spec: next, path, bumped: false };
}

function snapshotToHistory(projectRoot: string, spec: Spec): void {
  const dir = specHistoryDir(projectRoot, spec.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(resolve(dir, `v${spec.version}.yaml`), serializeSpec(spec));
}

/**
 * Freeze a spec: lock content, compute + bind the hash. Idempotent for an
 * already-frozen spec with matching content — the freeze-time git binding is
 * therefore stamped exactly ONCE per version (a re-freeze never re-stamps).
 * The `approval` gate mirrors the `specApproval` config — when `'always'`,
 * freezing requires `approved` to have been granted out of band (status
 * already `approved`).
 */
export function freezeSpec(args: {
  projectRoot: string;
  specId: string;
  approval?: 'always' | 'never' | 'auto';
  updatedAt?: string;
  /**
   * Freeze-time git snapshot (B2 temporal binding). `undefined` ⇒ self-collect
   * via {@link collectGitBinding}; `null` ⇒ explicitly skip (deterministic
   * YAML in tests). Excluded from the content hash either way — provenance,
   * not contract.
   */
  gitBinding?: SpecGitBinding | null;
  /**
   * Rubric version to stamp (E2.2). Defaults to the current `RUBRIC_VERSION`;
   * an override exists for tests and for a re-freeze that must reproduce an
   * older baseline. Excluded from the content hash.
   */
  rubricVersion?: string;
}): { spec: Spec; path: string } {
  const current = readSpec(args.projectRoot, args.specId);
  if (!current) {
    throw new SpecValidationError(`spec "${args.specId}" not found in .validity/specs/.`);
  }
  if (current.status === 'frozen') {
    return { spec: current, path: specPathFor(args.projectRoot, current.id) };
  }
  if (args.approval === 'always' && current.status !== 'approved') {
    throw new SpecValidationError(
      `spec "${args.specId}" requires out-of-band approval before freezing ` +
        `(specApproval: 'always'). Set status to 'approved' via spec_update first.`,
    );
  }
  const binding =
    args.gitBinding === null ? undefined : (args.gitBinding ?? collectGitBinding(args.projectRoot));
  const frozen: Spec = {
    ...current,
    status: 'frozen',
    // Rubric baseline (E2.2): record which soft-scoring rubric this spec's soft
    // criteria were frozen against. Excluded from the content hash, so stamping
    // it leaves the frozen hash exactly where it would have been.
    rubric: { version: args.rubricVersion ?? RUBRIC_VERSION },
    // `git: binding` (not a conditional spread): when collection failed or was
    // skipped, any binding inherited onto the draft must be CLEARED, not kept
    // — a stale binding from a different version would launder a mid-work
    // re-freeze into 'frozen-before-work'. No binding ⇒ honest `unknown`.
    git: binding,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
  };
  frozen.hash = computeSpecHash(frozen);
  const path = writeSpec(args.projectRoot, frozen);
  return { spec: frozen, path };
}

/**
 * Lift the bulk-onboarding probation marker (Phase C). Reads the spec, returns
 * `false` when the spec is absent or carries no `probation` field; otherwise
 * deletes the field and rewrites via `writeSpec` with NO version bump, NO status
 * change, and NO hash recompute. Because `probation` is excluded from
 * `computeSpecHash`, clearing it leaves a frozen spec's hash byte-identical —
 * the marker was always content-independent provenance, so lifting it cannot
 * fire spec-changed or unbind prior reports. Idempotent: a second call returns
 * `false` (the field is already gone).
 *
 * Call this after a bulk-created spec's first CONFIRMED clean pass — the
 * signal-severity downgrade keyed on `probation` presence is lifted here.
 */
export function clearSpecProbation(args: { projectRoot: string; specId: string }): boolean {
  const current = readSpec(args.projectRoot, args.specId);
  if (!current || !current.probation) return false;
  const { probation: _omitProbation, ...rest } = current;
  writeSpec(args.projectRoot, rest as Spec);
  return true;
}

/**
 * Out-of-band approval surface — the privileged write that
 * {@link updateSpec}'s status guard (the `frozen`/`approved` refusal) points at.
 * For each id: not found / status `frozen` / status `superseded` → skipped with
 * a reason; otherwise set status to `'approved'`, append `by` to
 * `source.reviewedBy` (deduped), stamp `updatedAt`, and persist via `writeSpec`.
 *
 * Call it ONLY from human-facing surfaces (the `validity onboard review` CLI)
 * — it must NEVER be exposed as an MCP tool, or an agent could self-clear the
 * `specApproval: 'always'` gate and mint its own frozen specs.
 */
export function approveSpecs(args: {
  projectRoot: string;
  specIds: string[];
  by?: string;
  updatedAt?: string;
}): { approved: string[]; skipped: Array<{ id: string; reason: string }> } {
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const now = args.updatedAt ?? new Date().toISOString();
  for (const id of args.specIds) {
    const current = readSpec(args.projectRoot, id);
    if (!current) {
      skipped.push({ id, reason: 'spec not found' });
      continue;
    }
    if (current.status === 'frozen' || current.status === 'superseded') {
      skipped.push({ id, reason: `status is ${current.status} (no re-approval needed)` });
      continue;
    }
    const reviewedBy = args.by
      ? Array.from(new Set([...(current.source.reviewedBy ?? []), args.by]))
      : current.source.reviewedBy;
    const next: Spec = {
      ...current,
      status: 'approved',
      source: { ...current.source, reviewedBy },
      updatedAt: now,
    };
    writeSpec(args.projectRoot, next);
    approved.push(id);
  }
  return { approved, skipped };
}

/* ------------------------------------------------------------------ *
 * Plan ↔ spec bridge.                                                 *
 *                                                                     *
 * `validity__plan` becomes a thin wrapper over create+freeze so       *
 * existing agent flows keep working: the planId IS a specId. The      *
 * NL criteria a plan carries are COMPILED — observable ones become     *
 * hard `checks`, the rest stay soft — so the deterministic gate        *
 * finally fires on the documented loop (see compile-checks.ts).        *
 * ------------------------------------------------------------------ */

/** True when an id was minted by the spec store (vs the legacy plan store). */
export function isSpecId(id: string): boolean {
  return id.startsWith('spec-');
}

/**
 * Compile plan criteria → spec criteria. Observable criteria become hard with
 * executable `checks`; ambiguous/aesthetic/negated ones stay soft (demote by
 * default — gate integrity over coverage). Delegates to the deterministic,
 * LLM-free compiler. Name kept for backward compatibility with existing call
 * sites; it is no longer "all soft".
 */
export function planCriteriaToSpecCriteria(criteria: AcceptanceCriterion[]): SpecCriterion[] {
  return compileCriteria(criteria);
}

/**
 * Adapt a frozen/draft spec back into the `ValidityPlan` shape that
 * `validity__verify` / `submit_report` already understand, so the spec layer
 * is backward-compatible with the planId code path. Hard-tier criteria carry
 * their `checks` through on a side channel for deterministic execution.
 */
export function specToPlan(spec: Spec): ValidityPlan {
  return {
    planId: spec.id,
    createdAt: spec.createdAt,
    prompt: spec.source.prompt,
    criteria: spec.criteria.map((c) => ({
      id: c.id,
      description: c.text,
      observable: undefined,
    })),
  };
}

/**
 * Resolve an id that may be either a spec id or a legacy plan id to a spec.
 * Returns null when neither exists.
 */
export function readSpecOrNull(projectRoot: string, id: string): Spec | null {
  if (!isSpecId(id)) return null;
  return readSpec(projectRoot, id);
}

/* ------------------------------------------------------------------ *
 * Change mapping — `verify --all --changed`.                          *
 * ------------------------------------------------------------------ */

/**
 * Map a set of changed files to the specs that target them. A spec matches
 * when any of its `targets.components` resolves (via the supplied resolver)
 * to one of the changed files, when a target path equals a changed file path,
 * OR when a changed file's basename matches a target's basename
 * case-insensitively (the cheap fallback when no resolver is available;
 * targets may be bare names or full paths). Specs with no targets are
 * returned in `unmapped` so the caller can decide whether to include them in
 * a full run.
 */
export function mapChangedFilesToSpecs(args: {
  specs: Spec[];
  changedFiles: string[];
  /** Optional resolver: target name → project-relative file path(s). */
  resolveTarget?: (name: string) => string[];
}): { matched: Spec[]; unmapped: Spec[] } {
  const changed = new Set(args.changedFiles.map((f) => f.replace(/^\.\//, '')));
  const changedBasenames = new Set(args.changedFiles.map((f) => baseNameNoExt(f).toLowerCase()));
  const matched: Spec[] = [];
  const unmapped: Spec[] = [];
  for (const spec of args.specs) {
    const targets = spec.targets?.components ?? [];
    if (targets.length === 0) {
      unmapped.push(spec);
      continue;
    }
    let hit = false;
    for (const t of targets) {
      const resolved = args.resolveTarget?.(t) ?? [];
      if (resolved.some((p) => changed.has(p.replace(/^\.\//, '')))) {
        hit = true;
        break;
      }
      // Targets may be bare component names ("ContactForm") or file paths
      // ("src/ContactForm.tsx" — validity__plan stores paths), so compare
      // exact paths first, then basenames with extensions stripped.
      if (changed.has(t.replace(/^\.\//, ''))) {
        hit = true;
        break;
      }
      if (changedBasenames.has(baseNameNoExt(t).toLowerCase())) {
        hit = true;
        break;
      }
    }
    if (hit) matched.push(spec);
  }
  return { matched, unmapped };
}

function baseNameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.(tsx|jsx|ts|js)$/, '');
}

/**
 * The component-basename key change-mapping matches targets on (path OR bare
 * name, extension stripped, lowercased). Exported so the citation-relevance
 * guard can decide whether a cited render's component belongs to a spec's
 * declared targets using the SAME matching rule as `matchSpecsToChangedFiles`.
 */
export function componentBaseKey(p: string): string {
  return baseNameNoExt(p).toLowerCase();
}

/**
 * One criterion that got WEAKER between two spec versions. "Weaker" means the
 * mechanical/sign-off bar dropped in a way that can turn a prior RED into a
 * silent GREEN:
 *   - `tier-softened`     — a mechanically-proven tier (hard/property) became
 *     `soft` (now scored from a screenshot, not proven).
 *   - `severity-downgrade`— a blocking criterion became `advisory` (it can now
 *     fail without blocking sign-off).
 *   - `threshold-lowered` — a soft criterion's numeric `softThreshold` was
 *     reduced or removed (a lower/absent score now counts as pass).
 * Detection is provenance/advisory only — it NEVER gates. It exists so a
 * re-freeze that quietly relaxes a check is visible to a reviewer / the loop.
 */
export type CriterionWeakening = {
  id: string;
  kind: 'tier-softened' | 'severity-downgrade' | 'threshold-lowered';
  detail: string;
};

/**
 * Compare two versions of a spec and report every criterion that got weaker
 * (by id). Only criteria present in BOTH versions are compared — a newly-added
 * or removed criterion is a coverage change, not a weakening. Pure; no I/O.
 */
export function detectWeakenedCriteria(prev: Spec, next: Spec): CriterionWeakening[] {
  const prevById = new Map(prev.criteria.map((c) => [c.id, c]));
  const out: CriterionWeakening[] = [];
  for (const nc of next.criteria) {
    const pc = prevById.get(nc.id);
    if (!pc) continue;
    // Tier softening: a mechanically-proven check became screenshot-scored.
    if ((pc.tier === 'hard' || pc.tier === 'property') && nc.tier === 'soft') {
      out.push({
        id: nc.id,
        kind: 'tier-softened',
        detail: `${nc.id}: tier ${pc.tier} → soft (was mechanically proven, now screenshot-scored)`,
      });
    }
    // Severity downgrade: a blocking criterion became advisory.
    if (criterionIsBlocking(pc) && !criterionIsBlocking(nc)) {
      out.push({
        id: nc.id,
        kind: 'severity-downgrade',
        detail: `${nc.id}: severity blocking → advisory (may now fail without blocking sign-off)`,
      });
    }
    // Threshold lowered/removed: only meaningful while the criterion stays soft
    // (a tier change to hard is already flagged, and threshold is soft-only).
    if (pc.tier === 'soft' && nc.tier === 'soft' && pc.softThreshold != null) {
      if (nc.softThreshold == null) {
        out.push({
          id: nc.id,
          kind: 'threshold-lowered',
          detail: `${nc.id}: softThreshold ${pc.softThreshold} → (none) (numeric pass floor removed)`,
        });
      } else if (nc.softThreshold < pc.softThreshold) {
        out.push({
          id: nc.id,
          kind: 'threshold-lowered',
          detail: `${nc.id}: softThreshold ${pc.softThreshold} → ${nc.softThreshold} (pass floor lowered)`,
        });
      }
    }
  }
  return out;
}

/**
 * Weakenings between `spec` and its immediate predecessor frozen version
 * (`history/v<version-1>.yaml`). Returns null for a first-version spec or when
 * the predecessor is unavailable (GC'd / malformed). Best-effort: a read/parse
 * failure yields null rather than throwing — this is an advisory surface.
 */
export function weakenedSincePrevVersion(
  projectRoot: string,
  spec: Spec,
): { fromVersion: number; weakenings: CriterionWeakening[] } | null {
  if (spec.version <= 1) return null;
  const fromVersion = spec.version - 1;
  let prev: Spec | null;
  try {
    prev = readSpecVersion(projectRoot, spec.id, fromVersion);
  } catch {
    return null;
  }
  if (!prev) return null;
  const weakenings = detectWeakenedCriteria(prev, spec);
  return weakenings.length > 0 ? { fromVersion, weakenings } : null;
}
