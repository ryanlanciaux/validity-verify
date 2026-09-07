import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Reader for `.validity/app-manifest.json` — the file `@validity.ai/verify-plugin-vite`
 * writes from inside the user's real Vite pipeline.
 *
 * WHY VALIDITY WANTS IT
 *
 * The sandbox boots its own Vite rooted at `node_modules/.validity/` and
 * re-reads the user's `vite.config.*`, which gets aliases and user plugins
 * right. Three things it cannot get right from that position, because Vite
 * resolves them relative to `root`:
 *
 *   1. `.env` files — never loaded, so `import.meta.env.VITE_*` is empty in
 *      the sandbox and every env-driven branch renders its fallback.
 *   2. `postcss.config.*` — never discovered, so a Tailwind v3 project (which
 *      wires Tailwind through PostCSS) renders with no Tailwind at all.
 *   3. The app's real entry module — currently guessed from a 17-name
 *      candidate list in wrapper-generator.
 *
 * WHY THIS DELIBERATELY RE-DECLARES THE SHAPE
 *
 * The types below are a hand-written twin of `@validity.ai/verify-plugin-vite`'s
 * `schema.ts`, NOT an import of it. That is intentional and load-bearing: the
 * writer ships inside the user's app and upgrades on the user's cadence, the
 * reader ships inside Validity and upgrades on ours. They must be free to skew
 * by a version or three. Importing the writer's types would create a false
 * compile-time guarantee about a file that is really a wire format, and would
 * drag a user-facing package into Validity's dependency graph.
 *
 * The reader therefore behaves like a wire-format parser:
 *   - unknown fields are ignored, never rejected;
 *   - a `schemaVersion` it doesn't know is refused outright rather than
 *     guessed at (a manifest from the future may have changed a field's
 *     MEANING, and silently mirroring it would be a fidelity lie);
 *   - every field is individually validated, and a malformed one is dropped
 *     while the rest of the manifest survives;
 *   - nothing here throws. A broken manifest degrades to "no manifest", which
 *     is exactly the behavior Validity had before the plugin existed.
 */

/** Schema versions this reader understands. */
export const SUPPORTED_APP_MANIFEST_VERSIONS = [1];

/** Path of the manifest relative to the Validity project root. */
export const APP_MANIFEST_RELATIVE_PATH = '.validity/app-manifest.json';

/** A resolved alias the sandbox may mirror. `replacement` is absolute or a bare specifier. */
export interface AppManifestAlias {
  find: string;
  replacement: string;
}

/** An alias the writer recorded but refused to mirror, with its reason. */
export interface AppManifestOmittedAlias {
  find: string;
  reason: string;
}

/** Client env exposure facts. `dir` is what repairs `.env` loading in the sandbox. */
export interface AppManifestEnv {
  dir: string;
  prefixes: string[];
  exposedKeyCount: number;
  exposedKeys?: string[];
}

/** Tailwind integration summary. `major: 3` means PostCSS-based — the shim does NOT cover it. */
export interface AppManifestTailwind {
  detected: boolean;
  via: 'vite-plugin' | 'postcss' | null;
  major: 3 | 4 | null;
}

/** CSS pipeline facts. */
export interface AppManifestCss {
  tailwind: AppManifestTailwind;
  postcssPlugins: string[];
  /** Absolute path to the app's PostCSS config, or null. */
  postcssConfigPath: string | null;
  /** Entry stylesheets, relative to {@link AppManifest.root}. */
  entryCss: string[];
}

/** The app's authoritative entry pair, relative to {@link AppManifest.root}. */
export interface AppManifestEntry {
  html: string | null;
  module: string | null;
}

/**
 * Framework labels this reader recognizes. Writers may ship newer labels than
 * this reader knows (the writer lives in the user's app and upgrades on the
 * user's cadence); anything unrecognized collapses to `'vite'`, the plain-web
 * default, which is exactly what this reader did before the label existed.
 *
 * - `'vite'` / `'expo-web'` — written by `@validity.ai/verify-plugin-vite`.
 * - `'tanstack-start'` — `@validity.ai/verify-plugin-vite` in a TanStack Start app
 *   (still a Vite pipeline; the label is provenance, not a render-target
 *   switch — target selection stays with `ValidityConfig.framework`).
 * - `'next'` — written by `@validity.ai/verify-plugin-next` (no Vite involved; env/CSS
 *   facts come from Next conventions instead of a resolved Vite config).
 */
export type AppManifestFramework = 'vite' | 'expo-web' | 'tanstack-start' | 'next';

/** A validated manifest. Every field is present; malformed inputs are normalized away. */
export interface AppManifest {
  schemaVersion: number;
  generator: { name: string; version: string };
  framework: AppManifestFramework;
  /** The app's Vite root, absolute POSIX-style. */
  root: string;
  entry: AppManifestEntry;
  env: AppManifestEnv;
  css: AppManifestCss;
  aliases: AppManifestAlias[];
  aliasesOmitted: AppManifestOmittedAlias[];
  plugins: string[];
}

/** Why a manifest on disk was not usable. Surfaced so the failure is never silent. */
export type AppManifestRejection =
  | 'absent'
  | 'unreadable'
  | 'malformed-json'
  | 'not-an-object'
  | 'unsupported-version'
  | 'root-outside-project';

/** Outcome of {@link readAppManifest}: a manifest, or a named reason there isn't one. */
export type AppManifestReadResult =
  | { ok: true; manifest: AppManifest; path: string }
  | { ok: false; reason: AppManifestRejection; path: string };

/* ------------------------------------------------------------------ *
 * Field-level coercion. Every helper drops bad input instead of        *
 * throwing — see the file docstring on wire-format posture.            *
 * ------------------------------------------------------------------ */

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

function readAliases(v: unknown): AppManifestAlias[] {
  if (!Array.isArray(v)) return [];
  const out: AppManifestAlias[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const find = str((raw as { find?: unknown }).find);
    const replacement = str((raw as { replacement?: unknown }).replacement);
    if (find && replacement) out.push({ find, replacement });
  }
  return out;
}

function readOmittedAliases(v: unknown): AppManifestOmittedAlias[] {
  if (!Array.isArray(v)) return [];
  const out: AppManifestOmittedAlias[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const find = str((raw as { find?: unknown }).find);
    const reason = str((raw as { reason?: unknown }).reason);
    if (find && reason) out.push({ find, reason });
  }
  return out;
}

function readEnv(v: unknown, rootFallback: string): AppManifestEnv {
  const o = (v ?? {}) as Record<string, unknown>;
  const count =
    typeof o.exposedKeyCount === 'number' && o.exposedKeyCount >= 0 ? o.exposedKeyCount : 0;
  const env: AppManifestEnv = {
    dir: str(o.dir) ? toPosix(str(o.dir)!) : rootFallback,
    prefixes: strArray(o.prefixes).length > 0 ? strArray(o.prefixes) : ['VITE_'],
    exposedKeyCount: Math.trunc(count),
  };
  if (Array.isArray(o.exposedKeys)) env.exposedKeys = strArray(o.exposedKeys);
  return env;
}

function readTailwind(v: unknown): AppManifestTailwind {
  const o = (v ?? {}) as Record<string, unknown>;
  const via = o.via === 'vite-plugin' || o.via === 'postcss' ? o.via : null;
  const major = o.major === 3 || o.major === 4 ? o.major : null;
  return { detected: o.detected === true, via, major };
}

function readCss(v: unknown): AppManifestCss {
  const o = (v ?? {}) as Record<string, unknown>;
  const postcssConfigPath = str(o.postcssConfigPath);
  return {
    tailwind: readTailwind(o.tailwind),
    postcssPlugins: strArray(o.postcssPlugins),
    postcssConfigPath: postcssConfigPath ? toPosix(postcssConfigPath) : null,
    entryCss: strArray(o.entryCss).map(toPosix),
  };
}

/** Known labels pass through; anything else is the pre-label default, `'vite'`. */
function readFramework(v: unknown): AppManifestFramework {
  return v === 'expo-web' || v === 'tanstack-start' || v === 'next' ? v : 'vite';
}

function readEntry(v: unknown): AppManifestEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const html = str(o.html);
  const mod = str(o.module);
  return { html: html ? toPosix(html) : null, module: mod ? toPosix(mod) : null };
}

/* ------------------------------------------------------------------ *
 * Reader                                                              *
 * ------------------------------------------------------------------ */

/**
 * Read + validate the app manifest for `projectRoot`.
 *
 * The `root-outside-project` rejection guards a specific accident: a manifest
 * committed by one app and inherited by a sibling checkout would point every
 * mirrored path at the wrong tree. A manifest whose `root` is neither the
 * project root nor a directory inside it is refused rather than trusted.
 */
export function readAppManifest(projectRoot: string): AppManifestReadResult {
  const path = resolve(projectRoot, APP_MANIFEST_RELATIVE_PATH);
  if (!existsSync(path)) return { ok: false, reason: 'absent', path };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, reason: 'unreadable', path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed-json', path };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object', path };
  }

  const o = parsed as Record<string, unknown>;
  const version = typeof o.schemaVersion === 'number' ? o.schemaVersion : -1;
  if (!SUPPORTED_APP_MANIFEST_VERSIONS.includes(version)) {
    return { ok: false, reason: 'unsupported-version', path };
  }

  const projectRootAbs = toPosix(resolve(projectRoot));
  const rootRaw = str(o.root);
  const root = rootRaw ? toPosix(resolve(rootRaw)) : projectRootAbs;
  const rel = relative(projectRootAbs, root);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'root-outside-project', path };
  }

  const generator = (o.generator ?? {}) as Record<string, unknown>;
  const manifest: AppManifest = {
    schemaVersion: version,
    generator: {
      name: str(generator.name) ?? 'unknown',
      version: str(generator.version) ?? '0.0.0',
    },
    framework: readFramework(o.framework),
    root,
    entry: readEntry(o.entry),
    env: readEnv(o.env, root),
    css: readCss(o.css),
    aliases: readAliases(o.aliases),
    aliasesOmitted: readOmittedAliases(o.aliasesOmitted),
    plugins: strArray(o.plugins),
  };
  return { ok: true, manifest, path };
}

/**
 * The app's entry module as a path relative to `projectRoot`, or `undefined`.
 *
 * Only returned when the file actually EXISTS on disk. A manifest can go stale
 * — the user renames `src/main.tsx` and doesn't re-run `vite dev` — and a
 * stale entry path is worse than no entry path, because it would send wrapper
 * generation, shape-signature drift detection, and auto-mock analysis at a
 * file that isn't there. Existence is the cheap check that makes the
 * authoritative answer safe to prefer.
 */
export function appManifestEntryFile(projectRoot: string): string | undefined {
  const read = readAppManifest(projectRoot);
  if (!read.ok || !read.manifest.entry.module) return undefined;
  const abs = resolve(read.manifest.root, read.manifest.entry.module);
  const rel = toPosix(relative(resolve(projectRoot), abs));
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return rel;
}

/**
 * One-line, PURELY OBSERVATIONAL description of the manifest on disk, for the
 * report's setup panel. `undefined` when there is no usable manifest — absence
 * is the normal case and must not paint a panel.
 *
 * Deliberately says only what the file RECORDS, never what Validity mirrored.
 * This runs in `ensureValidityConfigured`, before the sandbox exists; any
 * "mirrored" claim from here would be a prediction dressed as an observation.
 * The mirrored half is emitted by the sandbox itself (see
 * `DevServer.appManifest`), which is the only place that knows what it
 * actually folded into its Vite config.
 */
export function describeAppManifestRecord(projectRoot: string): string | undefined {
  const read = readAppManifest(projectRoot);
  if (!read.ok) return undefined;
  const m = read.manifest;
  const facts: string[] = [];
  facts.push(
    `env dir + ${m.env.exposedKeyCount} client var${m.env.exposedKeyCount === 1 ? '' : 's'}`,
  );
  if (m.entry.module) facts.push(`entry ${m.entry.module}`);
  if (m.css.tailwind.detected) {
    facts.push(`tailwind v${m.css.tailwind.major ?? '?'} via ${m.css.tailwind.via}`);
  }
  if (m.css.postcssConfigPath) facts.push('postcss config');
  if (m.aliases.length > 0) facts.push(`${m.aliases.length} alias(es)`);
  if (m.aliasesOmitted.length > 0) facts.push(`${m.aliasesOmitted.length} unmirrorable alias(es)`);
  if (m.plugins.length > 0) facts.push(`${m.plugins.length} plugin(s)`);
  return `App manifest v${m.schemaVersion} from ${m.generator.name}@${m.generator.version} — records ${facts.join(', ')}.`;
}

/**
 * One-line provenance for the report / logs, in the plan's shape:
 * "app manifest present; mirrored: …; recorded: …".
 *
 * `mirrored` names what the sandbox actually acted on; `recorded` names what
 * was read but only written down. Keeping those two lists separate is the
 * point — a reader must never be able to mistake "we know your app uses
 * Tailwind v3 through PostCSS" for "we rendered your app with Tailwind v3".
 */
export function describeAppManifest(read: AppManifestReadResult, mirrored: string[]): string {
  if (!read.ok) return `app manifest ${read.reason}`;
  const m = read.manifest;
  const recorded: string[] = [];
  if (m.plugins.length > 0) recorded.push(`plugins (${m.plugins.length})`);
  if (m.css.tailwind.detected) {
    recorded.push(`tailwind v${m.css.tailwind.major ?? '?'} via ${m.css.tailwind.via}`);
  }
  if (m.css.entryCss.length > 0) recorded.push(`entry css (${m.css.entryCss.length})`);
  if (m.env.exposedKeyCount > 0) recorded.push(`env vars (${m.env.exposedKeyCount})`);
  if (m.aliasesOmitted.length > 0) recorded.push(`unmirrored aliases (${m.aliasesOmitted.length})`);
  return [
    `app manifest present (v${m.schemaVersion}, ${m.generator.name}@${m.generator.version})`,
    `mirrored: ${mirrored.length > 0 ? mirrored.join(', ') : 'nothing'}`,
    `recorded: ${recorded.length > 0 ? recorded.join(', ') : 'nothing'}`,
  ].join('; ');
}
