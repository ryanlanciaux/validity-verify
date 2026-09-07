/**
 * Drift-signature schema + hashing for the auto-config orchestrator.
 *
 * Captures the small set of inputs the generated `wrapper.gen.tsx`
 * actually depends on, so we can detect drift between runs cheaply and
 * regenerate without false positives. The signature is persisted to
 * `.validity/.shape-signature.json` and re-computed on every verify.
 *
 * Two-tier check:
 *   - Cheap tier — `stat`-based mtime+size epochs of the inputs. If
 *     these match the persisted ones, we're confident nothing relevant
 *     changed; bail in ~1 ms.
 *   - Authoritative tier — full content-hash signature. Used only when
 *     the cheap tier's epoch mismatches.
 *
 * Drift is computed per field, not as a whole-signature equality, so
 * the orchestrator can attribute changes ("real-app entry now mounts
 * <NewProvider>") and the report can surface them actionably.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findEntryFile, resolveEntryAppModule } from './wrapper-generator.js';
import type { WrapperFidelityInfo } from './wrapper-fidelity.js';

/** Bump when the cloner / signature schema changes — forces regen project-wide. */
export const SHAPE_SIGNATURE_SCHEMA_VERSION = 1;

/** Vite-config files we look for. Order = priority. */
const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];

/** Common global-CSS file paths Validity treats as "the project's globals". */
const GLOBAL_CSS_CANDIDATES = [
  'src/index.css',
  'src/main.css',
  'src/global.css',
  'src/globals.css',
  'src/styles/global.css',
  'src/styles/globals.css',
  'src/app.css',
  'app/globals.css',
];

/**
 * Subset of package.json deps that influence wrapper generation. Drift
 * in any of these triggers a regen; drift in other deps (lodash, zod,
 * eslint plugins) is ignored. Keep this list small — every entry is a
 * dep whose presence/absence the cloner cares about.
 */
const RELEVANT_DEP_NAMES = new Set<string>([
  // Routing
  'react-router-dom',
  '@tanstack/react-router',
  // State
  '@reduxjs/toolkit',
  'react-redux',
  'zustand',
  'jotai',
  'recoil',
  '@xstate/react',
  // Data
  '@tanstack/react-query',
  'react-query',
  'swr',
  '@apollo/client',
  'urql',
  // Styling
  'tailwindcss',
  '@tailwindcss/vite',
  'styled-components',
  '@emotion/react',
  '@vanilla-extract/vite-plugin',
  '@pandacss/dev',
  // Auth
  '@clerk/clerk-react',
  '@auth0/auth0-react',
  'next-auth',
  // i18n
  'react-i18next',
  // SSG / framework
  'vite-react-ssg',
  'vite',
  'next',
]);

export interface ShapeSignatureFile {
  /** Project-relative path. */
  path: string;
  /** First 16 chars of sha256 of the file contents. */
  contentHash: string;
  /** Stat-based fingerprint for the cheap-tier check. */
  mtimeMs: number;
  size: number;
}

export interface ShapeSignature {
  schemaVersion: number;
  validityVersion: string;
  entryFile: ShapeSignatureFile | null;
  globalCssFile: ShapeSignatureFile | null;
  viteConfig: ShapeSignatureFile | null;
  /** Sorted list of "relevant dep name → semver range string". */
  relevantDeps: Array<[string, string]>;
  /** Hash of the full package.json for the cheap-tier check. */
  packageJsonContentHash: string;
  packageJsonMtimeMs: number;
  packageJsonSize: number;
  /** Hash of the wrapper.gen.tsx body (sans marker) at last write. Used to detect user edits. */
  wrapperGenContentHash: string | null;
  /** True at compute time if a `.validity/wrapper.user.tsx` exists. Drift toggles regen. */
  wrapperUserExists: boolean;
  /**
   * Fingerprint of `.validity/wrapper.user.tsx` when present. Wrapper fidelity
   * is a function of its CONTENT (the user wrapper's providers count toward
   * the chain), so a content edit must invalidate the cheap tier — otherwise
   * the cached fidelity verdict goes stale: a `degraded` persists after the
   * user follows the warning's own advice (add the provider there), and a
   * `verified` survives deleting a provider. Optional — legacy signatures fall
   * through to the authoritative tier once (compute-on-miss, no schema bump).
   */
  wrapperUserFile?: ShapeSignatureFile | null;
  /**
   * Wrapper fidelity computed at the last authoritative pass (A1), echoed by
   * the cheap-tier short-circuit. Absent in legacy files (compute-on-miss).
   * DELIBERATELY not a schema bump: a bump reads as `otherDrift`, which would
   * force `manual-required` on users with hand-edited wrappers merely for
   * upgrading Validity. `compareShapeSignatures` never looks at this field —
   * fidelity is derived state, not a drift input.
   */
  wrapperFidelity?: Pick<
    WrapperFidelityInfo,
    'status' | 'missingProviders' | 'expectedProviders' | 'detail'
  >;
  /**
   * The module the entry's mount indirection resolves to (Ignite:
   * `registerRootComponent(App)` in index.tsx with `App` from app/app.tsx) —
   * the file that actually declares the provider tree. Tracked so editing it
   * re-triggers regen even though the entry file itself never changes.
   * Optional — legacy signatures miss the cheap tier once and self-migrate,
   * same no-schema-bump pattern as `wrapperUserFile`.
   */
  appModuleFile?: ShapeSignatureFile | null;
}

export interface ComputeShapeSignatureArgs {
  projectRoot: string;
  validityVersion: string;
  /** Defaults to `<projectRoot>/.validity/wrapper.gen.tsx`. */
  wrapperGenPath?: string;
  /** Defaults to `<projectRoot>/.validity/wrapper.user.tsx`. */
  wrapperUserPath?: string;
}

export function computeShapeSignature(args: ComputeShapeSignatureArgs): ShapeSignature {
  const { projectRoot, validityVersion } = args;
  const wrapperGenPath = args.wrapperGenPath ?? resolve(projectRoot, '.validity/wrapper.gen.tsx');
  const wrapperUserPath =
    args.wrapperUserPath ?? resolve(projectRoot, '.validity/wrapper.user.tsx');

  const entryRel = findEntryFile(projectRoot) ?? null;
  const entryFile = entryRel ? readSignatureFile(projectRoot, entryRel) : null;
  const appModuleRel = entryRel ? resolveEntryAppModule(projectRoot, entryRel) : undefined;
  const appModuleFile = appModuleRel ? readSignatureFile(projectRoot, appModuleRel) : null;
  const globalCssRel = pickFirstExisting(projectRoot, GLOBAL_CSS_CANDIDATES);
  const globalCssFile = globalCssRel ? readSignatureFile(projectRoot, globalCssRel) : null;
  const viteConfigRel = pickFirstExisting(projectRoot, VITE_CONFIG_NAMES);
  const viteConfig = viteConfigRel ? readSignatureFile(projectRoot, viteConfigRel) : null;

  const pkg = readPackageJson(projectRoot);
  const relevantDeps = pkg
    ? Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
        .filter(([name]) => RELEVANT_DEP_NAMES.has(name))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  const pkgPath = resolve(projectRoot, 'package.json');
  const pkgStat = safeStat(pkgPath);
  const packageJsonContentHash = pkg ? sha256First16(JSON.stringify(pkg, null, 2)) : '';
  const packageJsonMtimeMs = pkgStat?.mtimeMs ?? 0;
  const packageJsonSize = pkgStat?.size ?? 0;

  const wrapperGenContentHash = readWrapperBodyHash(wrapperGenPath);
  const wrapperUserExists = existsSync(wrapperUserPath);
  const wrapperUserFile = wrapperUserExists
    ? readSignatureFileAbs(wrapperUserPath, relForSignature(wrapperUserPath, projectRoot))
    : null;

  return {
    schemaVersion: SHAPE_SIGNATURE_SCHEMA_VERSION,
    validityVersion,
    entryFile,
    globalCssFile,
    viteConfig,
    relevantDeps,
    packageJsonContentHash,
    packageJsonMtimeMs,
    packageJsonSize,
    wrapperGenContentHash,
    wrapperUserExists,
    wrapperUserFile,
    appModuleFile,
  };
}

/* ------------------------------------------------------------------ */
/* Drift comparison                                                    */
/* ------------------------------------------------------------------ */

export type DriftCategory =
  | 'schema-bump'
  | 'validity-version'
  | 'entry-file'
  | 'global-css'
  | 'vite-config'
  | 'relevant-deps'
  | 'wrapper-gen-edited'
  | 'wrapper-user-toggled';

export interface DriftReason {
  category: DriftCategory;
  field: string;
  before: string | null;
  after: string;
  /**
   * - `silent`  — auto-regen, nothing surfaced (e.g., schema bump).
   * - `warn`    — auto-regen, mention in the verify report.
   * - `block`   — preserve, surface as `manual-required` (e.g., user-edited gen file with other drift).
   */
  severity: 'silent' | 'warn' | 'block';
}

/**
 * Per-field comparison. Returns the list of reasons drift was detected.
 * Empty list = no drift.
 */
export function compareShapeSignatures(
  prev: ShapeSignature | null,
  next: ShapeSignature,
): DriftReason[] {
  if (!prev)
    return [
      {
        category: 'schema-bump',
        field: 'first-run',
        before: null,
        after: 'present',
        severity: 'silent',
      },
    ];

  const out: DriftReason[] = [];

  if (prev.schemaVersion !== next.schemaVersion) {
    out.push({
      category: 'schema-bump',
      field: 'schemaVersion',
      before: String(prev.schemaVersion),
      after: String(next.schemaVersion),
      severity: 'silent',
    });
  }
  if (prev.validityVersion !== next.validityVersion) {
    out.push({
      category: 'validity-version',
      field: 'validityVersion',
      before: prev.validityVersion,
      after: next.validityVersion,
      severity: 'silent',
    });
  }

  // Entry file: identity + content hash matter; mtime/size alone don't.
  if ((prev.entryFile?.path ?? null) !== (next.entryFile?.path ?? null)) {
    out.push({
      category: 'entry-file',
      field: 'entryFile.path',
      before: prev.entryFile?.path ?? null,
      after: next.entryFile?.path ?? '(none)',
      severity: 'warn',
    });
  } else if ((prev.entryFile?.contentHash ?? null) !== (next.entryFile?.contentHash ?? null)) {
    out.push({
      category: 'entry-file',
      field: 'entryFile.content',
      before: prev.entryFile?.contentHash ?? null,
      after: next.entryFile?.contentHash ?? '(removed)',
      severity: 'warn',
    });
  }

  // App module (entry indirection target): the file that declares the
  // provider tree when the entry just registers an imported component.
  // Same category/severity as the entry — it IS the tree. Legacy prev
  // signatures (field absent) read as null, so a non-indirection project
  // never drifts here; an indirection project drifts once and migrates.
  if ((prev.appModuleFile?.path ?? null) !== (next.appModuleFile?.path ?? null)) {
    out.push({
      category: 'entry-file',
      field: 'appModuleFile.path',
      before: prev.appModuleFile?.path ?? null,
      after: next.appModuleFile?.path ?? '(none)',
      severity: 'warn',
    });
  } else if (
    (prev.appModuleFile?.contentHash ?? null) !== (next.appModuleFile?.contentHash ?? null)
  ) {
    out.push({
      category: 'entry-file',
      field: 'appModuleFile.content',
      before: prev.appModuleFile?.contentHash ?? null,
      after: next.appModuleFile?.contentHash ?? '(removed)',
      severity: 'warn',
    });
  }

  // Global CSS: only path drift is surfaced (the wrapper imports it).
  if ((prev.globalCssFile?.path ?? null) !== (next.globalCssFile?.path ?? null)) {
    out.push({
      category: 'global-css',
      field: 'globalCssFile.path',
      before: prev.globalCssFile?.path ?? null,
      after: next.globalCssFile?.path ?? '(none)',
      severity: 'warn',
    });
  }

  // Vite config: silent regen — wrapper itself doesn't change, but the
  // sandbox plumbing (publicDir, alias, plugins) might.
  if ((prev.viteConfig?.contentHash ?? null) !== (next.viteConfig?.contentHash ?? null)) {
    out.push({
      category: 'vite-config',
      field: 'viteConfig.content',
      before: prev.viteConfig?.contentHash ?? null,
      after: next.viteConfig?.contentHash ?? '(none)',
      severity: 'silent',
    });
  }

  // Relevant deps: stringify-and-compare. Cheap and correct because we
  // sorted at compute time.
  const prevDeps = JSON.stringify(prev.relevantDeps);
  const nextDeps = JSON.stringify(next.relevantDeps);
  if (prevDeps !== nextDeps) {
    out.push({
      category: 'relevant-deps',
      field: 'relevantDeps',
      before: prevDeps,
      after: nextDeps,
      severity: 'warn',
    });
  }

  // wrapper-user.tsx toggling matters because the entry composes through
  // it when present; flip → silent regen.
  if (prev.wrapperUserExists !== next.wrapperUserExists) {
    out.push({
      category: 'wrapper-user-toggled',
      field: 'wrapperUserExists',
      before: String(prev.wrapperUserExists),
      after: String(next.wrapperUserExists),
      severity: 'silent',
    });
  }

  // wrapper.gen.tsx body changed since we last wrote it AND the marker
  // is present → user-edited a managed file. The orchestrator decides
  // what to do with the `block` severity (fork-and-warn vs. preserve).
  if (
    prev.wrapperGenContentHash !== null &&
    next.wrapperGenContentHash !== null &&
    prev.wrapperGenContentHash !== next.wrapperGenContentHash
  ) {
    out.push({
      category: 'wrapper-gen-edited',
      field: 'wrapperGenContentHash',
      before: prev.wrapperGenContentHash,
      after: next.wrapperGenContentHash,
      severity: 'block',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Cheap-tier check                                                    */
/* ------------------------------------------------------------------ */

/**
 * Returns true if the two signatures are byte-identical on the cheap
 * fields (mtime+size of every tracked file). When true, the caller can
 * skip the content-hash recompute. False = recompute everything.
 *
 * NB: this is a *necessary* but not sufficient condition for "no drift"
 * — content-hash drift on the same mtime+size (e.g., from `git checkout`
 * with sub-second timestamps) won't be caught. The persisted signature
 * still uses content hashes, so even when the cheap tier short-circuits
 * incorrectly, the next regen will fix it. Cost of a false short-circuit
 * is one stale verify; cost of false-negative drift detection is a wrong
 * wrapper.
 */
export function cheapTierMatches(prev: ShapeSignature | null, projectRoot: string): boolean {
  if (!prev) return false;
  // package.json
  const pkgPath = resolve(projectRoot, 'package.json');
  const pkgStat = safeStat(pkgPath);
  if (!pkgStat) return false;
  if (pkgStat.mtimeMs !== prev.packageJsonMtimeMs || pkgStat.size !== prev.packageJsonSize) {
    return false;
  }
  // entry file
  if (prev.entryFile) {
    const stat = safeStat(resolve(projectRoot, prev.entryFile.path));
    if (!stat) return false;
    if (stat.mtimeMs !== prev.entryFile.mtimeMs || stat.size !== prev.entryFile.size) return false;
  } else if (findEntryFile(projectRoot) !== undefined) {
    // The signature cached `entryFile: null` but an entry is discoverable
    // NOW (entry-discovery improved across a Validity upgrade, or the user
    // added one). Fall through to the authoritative tier so the frozen
    // no-entry verdict — and its degraded wrapper fidelity — can heal
    // without `validity init --force`.
    return false;
  }
  // app module (entry indirection target) — regen must retrigger when the
  // provider tree's real file changes even though the entry file doesn't.
  // Legacy signatures (field absent) miss once and self-migrate.
  if (prev.appModuleFile === undefined) return false;
  if (prev.appModuleFile) {
    const stat = safeStat(resolve(projectRoot, prev.appModuleFile.path));
    if (!stat) return false;
    if (stat.mtimeMs !== prev.appModuleFile.mtimeMs || stat.size !== prev.appModuleFile.size) {
      return false;
    }
  } else if (resolveEntryAppModule(projectRoot) !== undefined) {
    // The signature cached `appModuleFile: null` but an app module resolves
    // NOW (resolution learned the JSX-mount splice target across a Validity
    // upgrade, or the user restructured the entry). Fall through so the
    // wrapper regenerates with the deep-cloned provider tree — mirrors the
    // `entryFile: null` heal above. Costs one entry-file parse per verify,
    // and only for projects whose mount has no resolvable app module.
    return false;
  }
  // global CSS
  if (prev.globalCssFile) {
    const stat = safeStat(resolve(projectRoot, prev.globalCssFile.path));
    if (!stat) return false;
    if (stat.mtimeMs !== prev.globalCssFile.mtimeMs || stat.size !== prev.globalCssFile.size) {
      return false;
    }
  }
  // vite config
  if (prev.viteConfig) {
    const stat = safeStat(resolve(projectRoot, prev.viteConfig.path));
    if (!stat) return false;
    if (stat.mtimeMs !== prev.viteConfig.mtimeMs || stat.size !== prev.viteConfig.size)
      return false;
  }
  // wrapper.user.tsx existence — toggling this flips composeWithUserWrapper
  // in the next regen, so a stat-level check is required even though the
  // file's content isn't part of the drift comparison.
  const wrapperUserPath = resolve(projectRoot, '.validity/wrapper.user.tsx');
  const wrapperUserStat = safeStat(wrapperUserPath);
  if ((wrapperUserStat !== null) !== prev.wrapperUserExists) return false;
  // wrapper.user.tsx CONTENT — the cached wrapper fidelity is a function of
  // it, so an edit must fall through to the authoritative tier (which
  // re-analyzes fidelity) instead of echoing a stale verdict. Legacy
  // signatures (no `wrapperUserFile`) miss once and self-migrate.
  if (wrapperUserStat) {
    if (!prev.wrapperUserFile) return false;
    if (
      wrapperUserStat.mtimeMs !== prev.wrapperUserFile.mtimeMs ||
      wrapperUserStat.size !== prev.wrapperUserFile.size
    ) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export const SHAPE_SIGNATURE_FILE = '.validity/.shape-signature.json';

export function shapeSignaturePath(projectRoot: string): string {
  return resolve(projectRoot, SHAPE_SIGNATURE_FILE);
}

export function readShapeSignature(projectRoot: string): ShapeSignature | null {
  try {
    const raw = readFileSync(shapeSignaturePath(projectRoot), 'utf-8');
    return JSON.parse(raw) as ShapeSignature;
  } catch {
    return null;
  }
}

export function writeShapeSignature(projectRoot: string, sig: ShapeSignature): void {
  // Caller is expected to have run `ensureValidityGitignore` already so
  // the dir exists and the signature is excluded from git.
  writeFileSync(shapeSignaturePath(projectRoot), JSON.stringify(sig, null, 2));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pickFirstExisting(projectRoot: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (existsSync(resolve(projectRoot, c))) return c;
  }
  return undefined;
}

function readSignatureFile(projectRoot: string, rel: string): ShapeSignatureFile | null {
  return readSignatureFileAbs(resolve(projectRoot, rel), rel);
}

/** Project-relative `path` for signature files addressed by absolute path (wrapper overrides). */
function relForSignature(abs: string, projectRoot: string): string {
  return abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
}

function readSignatureFileAbs(abs: string, rel: string): ShapeSignatureFile | null {
  try {
    const buf = readFileSync(abs);
    const stat = statSync(abs);
    return {
      path: rel,
      contentHash: sha256First16FromBuffer(buf),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function readPackageJson(projectRoot: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  try {
    return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Hash the body of an existing wrapper.gen.tsx (everything below the
 * marker header, three lines). Returns null when the file doesn't exist
 * or has no marker — drift comparison treats null-vs-null as "no drift"
 * but null-vs-set as a regen trigger. Exported so the orchestrator's
 * cheap tier can notice hand-edits (the stat-epoch fields don't track
 * wrapper.gen.tsx) without recomputing the whole signature.
 */
export function readWrapperBodyHash(wrapperGenPath: string): string | null {
  try {
    const raw = readFileSync(wrapperGenPath, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length < 4) return null;
    if (!lines[0]?.startsWith('// @validity-generated')) return null;
    return sha256First16(lines.slice(3).join('\n'));
  } catch {
    return null;
  }
}

function sha256First16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function sha256First16FromBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
