/**
 * Drift-checked spec exports (maturity ladder, Phase B).
 *
 * Exported Playwright/Maestro files stop being one-shot forks and become
 * DETERMINISTIC COMPILATION TARGETS of the frozen spec (regenerate from one
 * source of truth; fail CI on divergence). Canonical
 * layout, committed to git (they are the team's tests):
 *
 *   .validity/exports/
 *     playwright/<specId>.v<version>.spec.ts        (+ .fixtures.ts sibling)
 *     maestro/<specId>.v<version>.flow.yaml
 *     exports-manifest.json
 *     .gitattributes                                 (* text eol=lf)
 *
 * The manifest pins everything a drift needs for an EXPLAINABLE cause:
 *   - `specHash`        — the frozen contract the artifact compiles from;
 *   - `exporterVersion` — {@link SPEC_EXPORTER_VERSION}, bumped whenever
 *                         codegen output changes between releases;
 *   - `inputsHash`      — the NON-SPEC inputs that flow into artifact bytes
 *                         (baseUrl + fixtures handlers for web, appId for
 *                         native). Only byte-affecting inputs are hashed, so a
 *                         config edit that can't change the artifact can never
 *                         masquerade as (or mask) a hand edit;
 *   - per-file sha256s + `generatedAt` — metadata ONLY; `--check` compares
 *     RECOMPILED BYTES, never manifest hashes alone, so a poisoned manifest
 *     cannot fake freshness (§7 anti-gaming).
 *
 * `checkSpecExports` classifies each mismatch, worst-cause-first:
 *   spec hash moved      → stale artifact ("spec changed; re-run spec export")
 *   exporterVersion moved→ toolchain change (reviewed codegen bump)
 *   inputsHash moved     → config change (baseUrl/appId/handlers moved)
 *   otherwise            → hand edit ("edit the spec, not the test")
 * plus pruning causes: superseded/deleted/un-frozen specs and orphaned files
 * from older versions. `--fix` regenerates/prunes in place; CI runs bare
 * `--check`. Byte comparison normalizes CRLF→LF (belt) on top of the
 * generated `.gitattributes` (braces) so Windows checkouts can't false-drift.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  hash,
  stableStringify,
  readSpec,
  validityDir,
  type MaestroExportConfig,
  type Spec,
  type SpecRuntime,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  computeHasFixtures,
  exportSpecToPlaywright,
  type ExportedFile,
} from './spec-playwright.js';
import { exportSpecToMaestro } from './spec-maestro.js';
import type { ExportWarning } from './spec-export-warnings.js';

/**
 * Version of the spec→test codegen CONTRACT. Bump on ANY change to exporter
 * output bytes (header format, emitted assertions, file naming) so committed
 * artifacts from an older Validity classify as a reviewed "toolchain change"
 * in `spec export --check`, never as a hand edit. Release notes for a bump
 * must say "run `validity spec export --all` after upgrading".
 */
export const SPEC_EXPORTER_VERSION = '2';

/**
 * The verdict of actually EXECUTING an exported artifact — the run-the-export
 * provenance, recorded next to the artifacts it ran against.
 *
 * Web's Playwright export earned its graduation by having CI execute the
 * generated `.spec.ts` against a live page (spec-export-run.e2e.test.ts). A
 * Maestro flow cannot be executed in CI (it needs a booted device), so the same
 * proof has to be USER-DRIVEN — `validity spec export <id> --run` — and its
 * outcome has to be durable, or the proof evaporates the moment the terminal
 * scrolls. Hence this record.
 *
 * Three invariants keep it from ever manufacturing trust:
 *
 *   1. `files` pins the exact artifact sha256s the run executed. A byte change
 *      (re-export, hand edit, exporter bump) makes the record STALE, and stale
 *      reads as "not run" — never as a pass. See {@link exportRunStanding}.
 *   2. Only a real invocation writes one. `--dry-run` is a lint, not a run, and
 *      deliberately records nothing.
 *   3. `status` is four-valued, and the absent/`not-run` case is inert: it
 *      never blocks and never vouches. Only `failed` / `unsupported` are
 *      consequential (they block the portable badge).
 */
export interface ExportRunRecord {
  /** Which exported suite ran. Target-shaped so a future web run fits here. */
  target: 'maestro' | 'playwright';
  /**
   * - `passed`      — the engine executed the flow and every step held;
   * - `failed`      — the engine executed it and a step/assertion did not hold;
   * - `unsupported` — the engine REFUSED the flow's syntax (out of subset);
   * - `not-run`     — no verdict was produced here (no device, tool missing,
   *                   unreadable output). Never a pass, never a failure.
   */
  status: 'passed' | 'failed' | 'unsupported' | 'not-run';
  /** ISO timestamp of the run. */
  at: string;
  /** One line, in the product's register, safe to print verbatim. */
  detail: string;
  /** The artifact bytes this run executed — the staleness anchor. */
  files: Array<{ path: string; sha256: string }>;
  /** The tool that produced the verdict (provenance, never inferred). */
  tool: { name: string; command: string; version?: string };
  /** Where it ran, when the caller named a target. */
  device?: { platform?: string; id?: string };
  /** Suite counts, when the engine reported them. */
  counts?: { total: number; passed: number; failed: number; skipped: number; notRun: number };
}

/** One spec's manifest row. Keyed by specId in {@link ExportsManifest}. */
export interface ExportManifestEntry {
  specId: string;
  version: number;
  /** Content hash of the frozen spec the artifacts compile from. */
  specHash: string;
  runtime: SpecRuntime;
  exporterVersion: string;
  /** Hash over the byte-affecting non-spec inputs — see the module header. */
  inputsHash: string;
  /** Recorded verbatim for transparency (also folded into `inputsHash`). */
  baseUrl?: string;
  appId?: string;
  /** Paths relative to `.validity/exports/`, with content sha256s (metadata). */
  files: Array<{ path: string; sha256: string }>;
  /** ISO export time. Manifest-only — NEVER in artifact bytes (determinism). */
  generatedAt: string;
  /**
   * The last recorded EXECUTION of these artifacts (run-the-export). Additive
   * and optional: a repo that never ran an export simply has no field, which
   * every reader treats as "not run". Never folded into `inputsHash` or any
   * byte comparison — it is provenance about the artifacts, not an input to
   * them, so recording a run can never look like drift.
   */
  lastRun?: ExportRunRecord;
}

export interface ExportsManifest {
  version: 1;
  entries: Record<string, ExportManifestEntry>;
}

export function specExportsDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'exports');
}

export function exportsManifestPath(projectRoot: string): string {
  return resolve(specExportsDir(projectRoot), 'exports-manifest.json');
}

/** Tolerant load: missing or corrupt ⇒ empty manifest (mirrors loadSignals). */
export function loadExportsManifest(projectRoot: string): ExportsManifest {
  const p = exportsManifestPath(projectRoot);
  if (!existsSync(p)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as ExportsManifest;
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      return { version: 1, entries: parsed.entries };
    }
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveExportsManifest(projectRoot: string, manifest: ExportsManifest): void {
  const p = exportsManifestPath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  ensureExportsGitattributes(projectRoot);
  // Entries key-sorted so the committed manifest diffs stably.
  const sorted: ExportsManifest = {
    version: 1,
    entries: Object.fromEntries(
      Object.keys(manifest.entries)
        .sort()
        .map((k) => [k, manifest.entries[k]!]),
    ),
  };
  writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n');
}

/**
 * `.validity/exports/.gitattributes` — generated artifacts ship with `\n` and
 * must stay that way across Windows checkouts, or every byte-compare drifts.
 */
export function ensureExportsGitattributes(projectRoot: string): void {
  const dir = specExportsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, '.gitattributes');
  const line = '* text eol=lf';
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  if (existing.split('\n').some((l) => l.trim() === line)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}${line}\n`);
}

/* ------------------------------------------------------------------ *
 * Compilation — pure (no disk writes).                                 *
 * ------------------------------------------------------------------ */

/** The exporter subdir for a runtime. */
export function exportTargetDir(runtime: SpecRuntime): 'playwright' | 'maestro' {
  return runtime === 'native' ? 'maestro' : 'playwright';
}

/**
 * `export.maestro` minus the knobs that cannot reach a byte of the flow.
 *
 * `run` (the `spec export --run` device binding — see `MaestroRunConfig`) names
 * WHICH DEVICE the exported flows are handed to, never what they contain.
 * Hashing it would make a CI job adding `--platform` to its config read as an
 * export that drifted, demanding a re-export of files that did not change —
 * exactly the misclassification `inputsHash` exists to prevent.
 *
 * An object left with nothing byte-affecting collapses back to `undefined`, so
 * a project whose only Maestro config is a run binding hashes identically to
 * one with no `export.maestro` at all (both emit the same flow).
 */
function byteAffectingMaestro(
  maestro: MaestroExportConfig | undefined,
): MaestroExportConfig | undefined {
  if (!maestro) return undefined;
  const { run: _run, ...rest } = maestro;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The byte-affecting non-spec inputs for a (spec, config) pair. */
function exportInputs(
  spec: Spec,
  config: ValidityConfig | undefined,
  overrides?: { baseUrl?: string },
): { baseUrl?: string; appId?: string; maestro?: MaestroExportConfig; mockHandlers?: unknown } {
  if (spec.runtime === 'native') {
    // `export.maestro` (launch preamble + routes) changes the emitted flow
    // BYTES, so it must be hashed — a routes/clearState edit then classifies as
    // config drift in `--check`, never as a hand edit.
    return { appId: config?.export?.appId, maestro: byteAffectingMaestro(config?.export?.maestro) };
  }
  return {
    baseUrl: overrides?.baseUrl ?? config?.export?.baseUrl,
    // Handlers only flow into bytes when the fixtures file is actually emitted
    // — hashing them unconditionally would let an irrelevant handler edit
    // misclassify a later hand edit as "config changed".
    mockHandlers: computeHasFixtures(spec, config)
      ? (config?.mockNetwork?.handlers ?? [])
      : undefined,
  };
}

export interface CompiledSpecExport {
  target: 'playwright' | 'maestro';
  /** Paths RELATIVE to `.validity/exports/` (e.g. `playwright/spec-x.v2.spec.ts`). */
  files: ExportedFile[];
  warnings: ExportWarning[];
  inputs: { baseUrl?: string; appId?: string };
  inputsHash: string;
}

/**
 * Deterministically compile a spec's canonical export. Pure — same (spec,
 * config, exporter version) ⇒ same bytes; `--check` recompiles through this
 * exact function, so "the export lies" and "the check lies" are the same bug.
 */
export function compileSpecExport(
  spec: Spec,
  config: ValidityConfig | undefined,
  overrides?: { baseUrl?: string },
): CompiledSpecExport {
  const target = exportTargetDir(spec.runtime);
  const inputs = exportInputs(spec, config, overrides);
  const inputsHash = `sha256-${hash(stableStringify(inputs))}`;
  if (target === 'maestro') {
    // Compile with the SAME maestro config that was hashed above, so the
    // recompile `--check` runs is byte-identical to what was written.
    const result = exportSpecToMaestro({ spec, appId: inputs.appId, maestro: inputs.maestro });
    return {
      target,
      files: result.files.map((f) => ({ path: `maestro/${f.path}`, contents: f.contents })),
      warnings: result.warnings,
      inputs: { appId: inputs.appId },
      inputsHash,
    };
  }
  const result = exportSpecToPlaywright({ spec, config, baseUrl: inputs.baseUrl });
  return {
    target,
    files: result.files.map((f) => ({ path: `playwright/${f.path}`, contents: f.contents })),
    warnings: result.warnings,
    inputs: { baseUrl: inputs.baseUrl },
    inputsHash,
  };
}

/* ------------------------------------------------------------------ *
 * Write path.                                                          *
 * ------------------------------------------------------------------ */

/** Artifact filename shape this pipeline owns (never touches foreign files). */
const ARTIFACT_RE = /^spec-[A-Za-z0-9_-]+\.v\d+\.(spec\.ts|fixtures\.ts|flow\.yaml)$/;

/**
 * Containment guard for every manifest-supplied path: `exports-manifest.json`
 * is parsed from disk WITHOUT schema validation, so a crafted/corrupted
 * `files[].path` like `../../.env` must never reach an `rmSync`/`readFileSync`
 * outside `.validity/exports/`. Returns the resolved absolute path when it
 * stays inside the exports root, else null (callers skip — a non-contained
 * path is treated as "not our file", never followed). Same posture as the
 * CLI's one-shot `resolveWithin` guard.
 */
function containedExportPath(exportsRoot: string, relPath: string): string | null {
  const base = resolve(exportsRoot);
  const abs = resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/** Basenames in a target dir owned by `specId` (any version). */
function ownedArtifacts(dirAbs: string, specId: string): string[] {
  if (!existsSync(dirAbs)) return [];
  const prefix = `${specId}.v`;
  return readdirSync(dirAbs).filter((f) => ARTIFACT_RE.test(f) && f.startsWith(prefix));
}

export interface WriteSpecExportResult {
  entry: ExportManifestEntry;
  /** Absolute paths written. */
  written: string[];
  /** Absolute paths of pruned older-version artifacts for this spec. */
  pruned: string[];
  warnings: ExportWarning[];
}

/**
 * Write a spec's canonical export: artifacts under `.validity/exports/`, an
 * upserted manifest row, and pruning of the SAME spec's older-version files
 * (a superseded contract must not keep gating). Always overwrites — the
 * canonical layout is a derived output; hand edits are caught by `--check`,
 * not preserved by the writer.
 */
export function writeSpecExport(
  projectRoot: string,
  spec: Spec,
  config: ValidityConfig | undefined,
  opts?: { now?: string; baseUrl?: string },
): WriteSpecExportResult {
  const compiled = compileSpecExport(spec, config, { baseUrl: opts?.baseUrl });
  const exportsRoot = specExportsDir(projectRoot);
  const written: string[] = [];

  for (const file of compiled.files) {
    const abs = resolve(exportsRoot, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
    written.push(abs);
  }

  // Prune THIS spec's other artifact files (older versions, dropped fixtures).
  const targetDirAbs = resolve(exportsRoot, compiled.target);
  const keep = new Set(compiled.files.map((f) => f.path.split('/').pop()!));
  const pruned: string[] = [];
  for (const base of ownedArtifacts(targetDirAbs, spec.id)) {
    if (keep.has(base)) continue;
    const abs = resolve(targetDirAbs, base);
    rmSync(abs, { force: true });
    pruned.push(abs);
  }

  const files = compiled.files.map((f) => ({ path: f.path, sha256: hash(f.contents) }));
  const manifest = loadExportsManifest(projectRoot);
  const previous = manifest.entries[spec.id];
  const entry: ExportManifestEntry = {
    specId: spec.id,
    version: spec.version,
    specHash: spec.hash ?? 'unfrozen',
    runtime: spec.runtime,
    exporterVersion: SPEC_EXPORTER_VERSION,
    inputsHash: compiled.inputsHash,
    ...(compiled.inputs.baseUrl ? { baseUrl: compiled.inputs.baseUrl } : {}),
    ...(compiled.inputs.appId ? { appId: compiled.inputs.appId } : {}),
    files,
    generatedAt: opts?.now ?? new Date().toISOString(),
    // A prior run survives a re-export only when the bytes it executed are
    // byte-identical to the bytes just written (the ordinary "re-export an
    // unchanged spec" case). Anything else voids it — a run of DIFFERENT bytes
    // proves nothing about these, and carrying it forward would be the exact
    // false-green this record exists to prevent.
    ...(previous?.lastRun && sameFiles(previous.lastRun.files, files)
      ? { lastRun: previous.lastRun }
      : {}),
  };
  manifest.entries[spec.id] = entry;
  saveExportsManifest(projectRoot, manifest);

  return { entry, written, pruned, warnings: compiled.warnings };
}

/** Same path→sha256 set, order-insensitively. */
function sameFiles(
  a: Array<{ path: string; sha256: string }>,
  b: Array<{ path: string; sha256: string }>,
): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((f) => [f.path, f.sha256]));
  return a.every((f) => byPath.get(f.path) === f.sha256);
}

/* ------------------------------------------------------------------ *
 * Run-the-export provenance.                                           *
 * ------------------------------------------------------------------ */

/**
 * Stamp the outcome of executing a spec's exported artifacts onto its manifest
 * row. Refuses (returns false) when the spec has no manifest row — a run of
 * files nothing vouches for has nowhere honest to land.
 *
 * The caller supplies `record.files`; passing anything other than the sha256s
 * that were actually on disk at run time would defeat {@link exportRunStanding}
 * (see the `filesFor` helper the CLI uses).
 */
export function recordExportRun(
  projectRoot: string,
  specId: string,
  record: ExportRunRecord,
): boolean {
  const manifest = loadExportsManifest(projectRoot);
  const entry = manifest.entries[specId];
  if (!entry) return false;
  entry.lastRun = record;
  saveExportsManifest(projectRoot, manifest);
  return true;
}

export type ExportRunStandingStatus = ExportRunRecord['status'] | 'stale';

export interface ExportRunStanding {
  status: ExportRunStandingStatus;
  detail: string;
  /** The record itself, when one exists (even a stale one — provenance). */
  record?: ExportRunRecord;
}

/**
 * What a manifest row's recorded run is worth RIGHT NOW.
 *
 * The whole point of the `files` pin: a run that executed different bytes is
 * `stale`, and `stale` — like a missing record — means "not run". There is no
 * path through this function where an old pass vouches for current bytes.
 */
export function exportRunStanding(entry: ExportManifestEntry | undefined): ExportRunStanding {
  const record = entry?.lastRun;
  if (!entry || !record) {
    return {
      status: 'not-run',
      detail: 'the exported artifacts have never been executed here',
    };
  }
  if (!sameFiles(record.files, entry.files)) {
    return {
      status: 'stale',
      record,
      detail:
        `the recorded run (${record.status}, ${record.at}) executed DIFFERENT bytes than the ` +
        `artifacts on record — it proves nothing about the current export. Re-run it.`,
    };
  }
  return { status: record.status, record, detail: record.detail };
}

/* ------------------------------------------------------------------ *
 * The `--check` gate.                                                  *
 * ------------------------------------------------------------------ */

export type ExportCheckStatus =
  | 'ok'
  | 'stale-spec' // manifest specHash ≠ current frozen hash
  | 'toolchain' // exporterVersion moved (Validity upgrade changed codegen)
  | 'config' // inputsHash moved (baseUrl/appId/handlers changed)
  | 'hand-edit' // bytes differ with spec+toolchain+inputs all unchanged
  | 'missing-file' // manifest lists a file that is not on disk
  | 'unfrozen' // spec version bumped back to draft — contract left
  | 'superseded' // spec superseded — artifacts must not keep gating
  | 'spec-missing' // spec deleted (or unreadable) — see detail
  | 'orphaned-file'; // an artifact file no manifest row references

export interface ExportCheckFinding {
  specId: string;
  status: ExportCheckStatus;
  detail: string;
  /** Relative artifact path, when the finding is file-scoped. */
  path?: string;
  /** Set when `--fix` repaired it this run (re-exported or pruned). */
  fixed?: boolean;
}

export interface ExportCheckResult {
  /** True ⇔ every finding is `ok` (or was fixed). The CI exit-code answer. */
  ok: boolean;
  findings: ExportCheckFinding[];
}

const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * Recompile every manifest entry in-memory and byte-compare against the
 * committed artifacts — the CI verb behind `validity spec export --check`.
 * A repo with zero exported specs passes trivially (empty manifest). With
 * `fix`, drifted entries are re-exported and dead entries/orphans pruned.
 */
export function checkSpecExports(
  projectRoot: string,
  opts?: { config?: ValidityConfig; fix?: boolean; now?: string },
): ExportCheckResult {
  // The outer `manifest` is THE single source of truth for this run: every
  // fix (prune OR re-export) mutates it in place and it is saved exactly once
  // at the end — a re-export that only wrote its own disk copy would be
  // clobbered by the final save, and the orphan scan below must see the
  // POST-fix file set, not the load-time snapshot.
  const manifest = loadExportsManifest(projectRoot);
  const exportsRoot = specExportsDir(projectRoot);
  const findings: ExportCheckFinding[] = [];
  let manifestDirty = false;

  const pruneEntry = (entry: ExportManifestEntry): void => {
    for (const f of entry.files) {
      // Containment guard: manifest paths are untrusted input — a traversal
      // path is skipped, never deleted (see containedExportPath).
      const abs = containedExportPath(exportsRoot, f.path);
      if (abs) rmSync(abs, { force: true });
    }
    delete manifest.entries[entry.specId];
    manifestDirty = true;
  };

  for (const entry of Object.values(manifest.entries)) {
    let spec: Spec | null = null;
    let specReadError: string | null = null;
    try {
      spec = readSpec(projectRoot, entry.specId);
    } catch (err) {
      specReadError = (err as Error).message;
    }

    if (specReadError !== null) {
      // Corrupt spec file: report, but never prune — deleting a team's
      // committed tests over a parse error would be destructive guesswork.
      findings.push({
        specId: entry.specId,
        status: 'spec-missing',
        detail: `spec is unreadable (${specReadError}) — fix the spec.yaml; artifacts left in place`,
      });
      continue;
    }
    if (!spec) {
      const finding: ExportCheckFinding = {
        specId: entry.specId,
        status: 'spec-missing',
        detail: `spec no longer exists — prune the manifest row + artifacts (\`--fix\` does this)`,
      };
      if (opts?.fix) {
        pruneEntry(entry);
        finding.fixed = true;
      }
      findings.push(finding);
      continue;
    }
    if (spec.status === 'superseded') {
      const finding: ExportCheckFinding = {
        specId: entry.specId,
        status: 'superseded',
        detail: `spec is superseded — a retired contract must not keep gating; prune with \`--fix\``,
      };
      if (opts?.fix) {
        pruneEntry(entry);
        finding.fixed = true;
      }
      findings.push(finding);
      continue;
    }
    if (spec.status !== 'frozen') {
      const finding: ExportCheckFinding = {
        specId: entry.specId,
        status: 'unfrozen',
        detail:
          `spec moved to '${spec.status}' (v${spec.version}; artifact compiled from v${entry.version}) — ` +
          `re-freeze, then \`validity spec export ${spec.id}\`. \`--fix\` prunes the stale artifacts`,
      };
      if (opts?.fix) {
        pruneEntry(entry);
        finding.fixed = true;
      }
      findings.push(finding);
      continue;
    }

    const reExport = (finding: ExportCheckFinding): void => {
      if (opts?.fix) {
        const result = writeSpecExport(projectRoot, spec!, opts?.config, { now: opts?.now });
        // Keep the outer manifest current: the final save below must carry
        // this fresh entry, and the orphan scan must not flag its files.
        manifest.entries[spec!.id] = result.entry;
        manifestDirty = true;
        finding.fixed = true;
      }
      findings.push(finding);
    };

    if (spec.hash !== entry.specHash) {
      reExport({
        specId: entry.specId,
        status: 'stale-spec',
        detail: `spec changed (now @v${spec.version}, hash moved) — re-run \`validity spec export ${spec.id}\``,
      });
      continue;
    }
    if (entry.exporterVersion !== SPEC_EXPORTER_VERSION) {
      reExport({
        specId: entry.specId,
        status: 'toolchain',
        detail:
          `Validity upgrade changed codegen (exporter ${entry.exporterVersion} → ${SPEC_EXPORTER_VERSION}) — ` +
          `re-run \`validity spec export ${spec.id}\` and review the diff like any codegen bump`,
      });
      continue;
    }

    const compiled = compileSpecExport(spec, opts?.config);
    const configMoved = compiled.inputsHash !== entry.inputsHash;

    // File-set + byte comparison. RECOMPILED BYTES are the truth source — the
    // manifest's sha256s are display metadata a poisoned manifest can't lean on.
    const compiledByPath = new Map(compiled.files.map((f) => [f.path, f.contents]));
    const committedPaths = new Set(entry.files.map((f) => f.path));
    let entryDirty = false;
    for (const file of compiled.files) {
      // (Compiled paths are internally generated — spec ids are schema-bound
      // to /^spec-[A-Za-z0-9_-]+$/ — so they cannot traverse; only
      // MANIFEST-supplied paths need the containment guard.)
      const abs = resolve(exportsRoot, file.path);
      if (!existsSync(abs)) {
        entryDirty = true;
        reExport({
          specId: entry.specId,
          status: 'missing-file',
          path: file.path,
          detail: `expected artifact missing on disk — re-run \`validity spec export ${spec.id}\``,
        });
        break;
      }
      if (normalizeEol(readFileSync(abs, 'utf-8')) !== normalizeEol(file.contents)) {
        entryDirty = true;
        reExport({
          specId: entry.specId,
          status: configMoved ? 'config' : 'hand-edit',
          path: file.path,
          detail: configMoved
            ? `artifact differs because export inputs moved (baseUrl/appId/mock handlers) — re-run \`validity spec export ${spec.id}\``
            : `artifact differs from a deterministic recompile of the unchanged spec — regenerate ` +
              `(\`validity spec export ${spec.id}\`) or edit the spec, not the test`,
        });
        break;
      }
    }
    if (entryDirty) continue;
    // Committed files the recompile no longer produces (e.g. fixtures dropped).
    const extinct = [...committedPaths].filter((p) => !compiledByPath.has(p));
    if (extinct.length > 0) {
      reExport({
        specId: entry.specId,
        status: configMoved ? 'config' : 'hand-edit',
        path: extinct[0],
        detail: `manifest lists ${extinct.length} file(s) a fresh recompile no longer produces — re-run \`validity spec export ${spec.id}\``,
      });
      continue;
    }

    findings.push({
      specId: entry.specId,
      status: 'ok',
      detail: 'byte-identical to a fresh recompile',
    });
  }

  // Orphaned artifact files: match our naming shape but belong to no manifest
  // row (older versions left by a manual delete, files from a removed spec).
  const referenced = new Set(
    Object.values(manifest.entries).flatMap((e) => e.files.map((f) => f.path)),
  );
  for (const sub of ['playwright', 'maestro'] as const) {
    const dirAbs = resolve(exportsRoot, sub);
    if (!existsSync(dirAbs)) continue;
    for (const base of readdirSync(dirAbs)) {
      if (!ARTIFACT_RE.test(base)) continue;
      const rel = `${sub}/${base}`;
      if (referenced.has(rel)) continue;
      const finding: ExportCheckFinding = {
        specId: base.split('.')[0] ?? base,
        status: 'orphaned-file',
        path: rel,
        detail: `artifact referenced by no manifest row — prune with \`--fix\``,
      };
      if (opts?.fix) {
        rmSync(resolve(dirAbs, base), { force: true });
        finding.fixed = true;
      }
      findings.push(finding);
    }
  }

  if (opts?.fix && manifestDirty) saveExportsManifest(projectRoot, manifest);

  const ok = findings.every((f) => f.status === 'ok' || f.fixed === true);
  return { ok, findings };
}

/* ------------------------------------------------------------------ *
 * Maturity wiring (predicate property 4).                              *
 * ------------------------------------------------------------------ */

/**
 * Artifact standing for ONE spec — the `checkArtifacts` dep `assessMaturity`
 * injects. `missing` ⇒ "run spec export"; `drift` ⇒ the classified cause.
 * Reads the manifest + disk and recompiles this spec only (cheap enough for a
 * watch tick).
 */
export function specArtifactCheck(
  projectRoot: string,
  spec: Spec,
  config?: ValidityConfig,
): { status: 'ok' | 'missing' | 'drift'; detail?: string } {
  const entry = loadExportsManifest(projectRoot).entries[spec.id];
  if (!entry) {
    return {
      status: 'missing',
      detail: `no exported artifacts recorded — run \`validity spec export ${spec.id}\``,
    };
  }
  if (entry.specHash !== (spec.hash ?? 'unfrozen')) {
    return {
      status: 'drift',
      detail: `exported artifacts compile from an older contract (v${entry.version}) — re-run \`validity spec export ${spec.id}\``,
    };
  }
  if (entry.exporterVersion !== SPEC_EXPORTER_VERSION) {
    return {
      status: 'drift',
      detail: `Validity upgrade changed codegen (exporter ${entry.exporterVersion} → ${SPEC_EXPORTER_VERSION}) — re-run \`validity spec export ${spec.id}\``,
    };
  }
  const compiled = compileSpecExport(spec, config);
  const configMoved = compiled.inputsHash !== entry.inputsHash;
  const exportsRoot = specExportsDir(projectRoot);
  for (const file of compiled.files) {
    // Single read + catch (no existsSync race): this runs on every watch tick
    // and dashboard render, so a file vanishing mid-read must degrade to an
    // honest 'missing', never throw into the tick.
    let onDisk: string;
    try {
      onDisk = readFileSync(resolve(exportsRoot, file.path), 'utf-8');
    } catch {
      return {
        status: 'missing',
        detail: `artifact ${file.path} missing on disk — run \`validity spec export ${spec.id}\``,
      };
    }
    if (normalizeEol(onDisk) !== normalizeEol(file.contents)) {
      return {
        status: 'drift',
        detail: configMoved
          ? `artifact ${file.path} differs — export inputs moved; re-run \`validity spec export ${spec.id}\``
          : `artifact ${file.path} differs from a deterministic recompile — regenerate or edit the spec, not the test`,
      };
    }
  }
  return { status: 'ok' };
}
