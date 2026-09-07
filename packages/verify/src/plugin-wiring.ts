/**
 * `validity init --plugins` — wires the installable Validity plugins
 * (`@validity.ai/verify-plugin-vite`, `@validity.ai/verify-plugin-next`, `@validity.ai/verify-plugin-expo`)
 * into the USER's app.
 *
 * Plugins resolve from a staged `.tgz` next to the CLI (if present), or from
 * the in-repo `packages/verify-plugin-*` packages during development. This
 * module:
 *
 *   1. Resolves where the staged plugin package lives on disk for the
 *      running install (or falls back to an in-repo dev build).
 *   2. Extracts it into `.validity/plugins/<shortName>/` — a real,
 *      committable directory (not a binary blob) the app can `file:`-depend
 *      on.
 *   3. Adds a `file:.validity/plugins/<shortName>` dependency to the app's
 *      package.json.
 *   4. Wires the platform config: a Vite plugins-array entry, a
 *      `withValidity(...)` wrap in `next.config.*`, or an Expo
 *      `expo.plugins` entry.
 *
 * SAFETY PHILOSOPHY: every text edit here is a NARROW,
 * provably-safe transform, never a speculative rewrite. JSON edits
 * (package.json, app.json) round-trip through `JSON.parse` + a structural
 * deep-equal check before ever being written — if the edit didn't produce
 * EXACTLY "the old object plus the one field we meant to add," it is
 * discarded and the caller gets a paste stanza instead. The JS/TS config
 * edits (vite.config, next.config — no JSON safety net available) are each
 * scoped to a handful of recognized "simple" export shapes and re-validated
 * against their own idempotency probe before being accepted; anything else
 * falls back to a paste stanza. Nothing here ever silently no-ops without
 * saying so, and re-running is always safe (every step detects its own prior
 * work and reports 'unchanged').
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAppTarget } from '@validity.ai/verify-spec';
import pc from 'picocolors';

/* ------------------------------------------------------------------ */
/* Plugin identity                                                     */
/* ------------------------------------------------------------------ */

export type PluginShortName = 'vite' | 'next' | 'expo';

/** Short-name → npm package name (also the import specifier apps use). */
export const PLUGIN_PACKAGE_NAMES: Record<PluginShortName, string> = {
  vite: '@validity.ai/verify-plugin-vite',
  next: '@validity.ai/verify-plugin-next',
  expo: '@validity.ai/verify-plugin-expo',
};

/** `--plugins[=web|native|all]` / `--no-plugins` resolved to an intent. */
export type PluginSelectionMode = 'auto' | 'web' | 'native' | 'all' | 'skip';

/**
 * Validate the `--plugins` value cac hands back. cac's `[target]` (optional
 * value) + a separately-declared `--no-plugins` gives: omitted → `true`
 * (cac's default-on for a boolean-negatable option), bare `--plugins` →
 * `true`, `--plugins=X` → `'X'`, `--no-plugins` → `false`.
 *
 * Wiring is the DEFAULT (decision: Ryan, 2026-08-07): omitting the flag and
 * a bare `--plugins` both resolve to `'auto'`; `--no-plugins` is the one
 * opt-out. Two reasons this is safe enough to be the default: every config
 * edit is provably-safe-or-paste-stanza and independently idempotent
 * (re-runs report 'unchanged'), and `withValidity`/`validity()` are
 * behavior-identity for the app's own build. History note: the 2026-08-06
 * session shipped this as opt-in at the `runInit` layer, but cac's
 * negatable-flag default (`--no-plugins` declared → omitted resolves to
 * `true`) meant the real CLI auto-wired all along — the flip makes intent,
 * code and docs agree. An unknown string is a hard error (never a silent
 * fallback).
 */
export function resolvePluginSelectionFlag(
  raw: string | boolean | undefined,
): { ok: true; mode: PluginSelectionMode } | { ok: false; message: string } {
  if (raw === false) return { ok: true, mode: 'skip' };
  if (raw === undefined) return { ok: true, mode: 'auto' };
  if (raw === true) return { ok: true, mode: 'auto' };
  if (raw === 'web' || raw === 'native' || raw === 'all') return { ok: true, mode: raw };
  return {
    ok: false,
    message: `Unknown --plugins target "${raw}". Valid: web, native, all (or pass --plugins alone to auto-detect).`,
  };
}

/**
 * WHICH web plugin this app needs. There is exactly one web manifest
 * contract (`.validity/app-manifest.json`) with two producers, because the
 * hook they attach to differs: `@validity.ai/verify-plugin-vite` is a Vite plugin
 * (`configResolved`), `@validity.ai/verify-plugin-next` is a `next.config.*` wrapper.
 * So "web" is a role, not a package — the bundler picks the implementation.
 *
 * Deliberately NOT new flag vocabulary: `--plugins=web` on a Next app means
 * "wire the web plugin", and the only honest answer to that on a Next app is
 * plugin-next. TanStack Start apps are Vite apps (Start ships as a Vite
 * plugin today), so they land on plugin-vite via the `else` — no special
 * case, and none wanted.
 */
function resolveWebPlugin(cwd: string): PluginShortName {
  return detectAppTarget(cwd).kind === 'next' ? 'next' : 'vite';
}

/**
 * Which plugin(s) a selection mode implies. `auto` reuses
 * `detectAppTarget` (the same "what kind of app is this" brain `verify`/
 * `browse` use) — a Vite app gets plugin-vite, a Next app gets plugin-next,
 * an Expo app gets the native plugin. Bare React Native (no Expo) and web
 * toolchains with no manifest producer (Remix, Astro, CRA…) get nothing:
 * `@validity.ai/verify-plugin-expo` is an Expo CONFIG plugin (no bare-RN equivalent
 * this round), and there is no manifest hook to attach to on a toolchain
 * Validity doesn't ship a plugin for.
 *
 * `web`/`native`/`all` are explicit user overrides in the sense that they
 * skip the "is this even a supported app?" gate — but the WEB half still
 * consults detection to choose between the two web producers (see
 * {@link resolveWebPlugin}); handing a Next app a Vite plugin because the
 * user typed `--plugins=web` would wire a package that can never run.
 */
export function resolvePluginTargets(
  cwd: string,
  selection: PluginSelectionMode,
): PluginShortName[] {
  if (selection === 'skip') return [];
  if (selection === 'native') return ['expo'];
  if (selection === 'web') return [resolveWebPlugin(cwd)];
  if (selection === 'all') return [resolveWebPlugin(cwd), 'expo'];
  const target = detectAppTarget(cwd);
  const targets: PluginShortName[] = [];
  if (target.kind === 'vite') targets.push('vite');
  if (target.kind === 'next') targets.push('next');
  if (target.kind === 'expo') targets.push('expo');
  return targets;
}

/* ------------------------------------------------------------------ */
/* Source resolution                                                   */
/* ------------------------------------------------------------------ */

export type PluginSource = { kind: 'tgz'; path: string } | { kind: 'dir'; path: string };

export interface ResolvePluginSourceOptions {
  /**
   * Directory to resolve candidates FROM — the compiled module's own
   * directory in production (`import.meta.url`-derived); override with a
   * fixture dir in tests.
   */
  moduleDir?: string;
  /** `npm root -g` probe, injected for tests. Null means "unavailable". */
  npmRootGlobal?: () => string | null;
}

function defaultNpmRootGlobal(): string | null {
  try {
    const out = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export class PluginSourceNotFoundError extends Error {
  constructor(
    public readonly shortName: PluginShortName,
    public readonly checked: readonly string[],
  ) {
    super(
      `Plugins are not staged in this install (looked for the "${shortName}" plugin at: ` +
        `${checked.join(', ')}). Reinstall Validity to get the staged plugin tarball, or — in a ` +
        `monorepo checkout — build it first: pnpm --filter @validity.ai/verify-plugin-${shortName} build`,
    );
    this.name = 'PluginSourceNotFoundError';
  }
}

/**
 * Resolve where the given plugin's installable package lives on disk, in
 * priority order:
 *
 *   1. Staged tarball — `plugins/<shortName>.tgz` next to the CLI. Checked at
 *      3 relative depths from this module to cover tsc (`dist/plugin-wiring.js`)
 *      and a bundled `cli.js` (import.meta.url then points at the CLI directory).
 *   2. `npm root -g` fallback, for installs where a renamed/wrapped binary
 *      means the module-relative candidates don't land on the real install
 *      root.
 *   3. In-repo dev fallback: `packages/verify-plugin-<shortName>` in the
 *      monorepo, gated on its `dist/` directory existing (i.e. it has been
 *      built). Reached only when running validity FROM the monorepo source
 *      tree. The COPY source is the package ROOT (not just `dist/`) — `dist/`
 *      alone lacks a package.json, and a `file:` dependency needs one at its
 *      target root to resolve at all; `dist/` existing is used purely as the
 *      "has this been built" gate.
 *
 * Throws {@link PluginSourceNotFoundError} (never returns undefined) when
 * none of the above exist — plugin wiring has nothing safe to fall back to,
 * unlike the config-edit steps below, which always have a paste-stanza
 * escape hatch.
 */
export function resolvePluginSource(
  shortName: PluginShortName,
  opts: ResolvePluginSourceOptions = {},
): PluginSource {
  const moduleDir = opts.moduleDir ?? fileURLToPath(new URL('.', import.meta.url));
  const checked: string[] = [];

  const tgzCandidates = [
    resolve(moduleDir, `plugins/${shortName}.tgz`),
    resolve(moduleDir, `../plugins/${shortName}.tgz`),
    resolve(moduleDir, `../../plugins/${shortName}.tgz`),
  ];
  for (const c of tgzCandidates) {
    checked.push(c);
    if (existsSync(c)) return { kind: 'tgz', path: c };
  }

  const npmRootGlobal = opts.npmRootGlobal ?? defaultNpmRootGlobal;
  const npmRoot = npmRootGlobal();
  if (npmRoot) {
    const p = resolve(npmRoot, 'validity/plugins', `${shortName}.tgz`);
    checked.push(p);
    if (existsSync(p)) return { kind: 'tgz', path: p };
  }

  const pkgDirCandidates = [
    resolve(moduleDir, `../../verify-plugin-${shortName}`),
    resolve(moduleDir, `../../../packages/verify-plugin-${shortName}`),
    resolve(moduleDir, `../../../../packages/verify-plugin-${shortName}`),
  ];
  for (const pkgDir of pkgDirCandidates) {
    checked.push(pkgDir);
    if (existsSync(resolve(pkgDir, 'package.json')) && existsSync(resolve(pkgDir, 'dist'))) {
      return { kind: 'dir', path: pkgDir };
    }
  }

  throw new PluginSourceNotFoundError(shortName, checked);
}

/* ------------------------------------------------------------------ */
/* Extraction — staged tgz / dev dir → .validity/plugins/<shortName>/  */
/* ------------------------------------------------------------------ */

export interface ExtractResult {
  action: 'wrote' | 'unchanged' | 'error';
  path: string;
  message?: string;
}

/**
 * Extract `source` into `.validity/plugins/<shortName>/`. Idempotent by
 * presence: a destination that already has a `package.json` is left alone
 * (`'unchanged'`) unless `force` is set, mirroring `ensureValidityConfigured`
 * (`init --force`) — re-running plain `init` never silently re-extracts (and
 * therefore never silently discards) a directory the user might have poked
 * at.
 */
export function extractPluginPackage(
  cwd: string,
  shortName: PluginShortName,
  source: PluginSource,
  opts: { force?: boolean } = {},
): ExtractResult {
  const destDir = resolve(cwd, '.validity/plugins', shortName);
  const relDest = `.validity/plugins/${shortName}`;
  const alreadyExtracted = existsSync(resolve(destDir, 'package.json'));
  if (alreadyExtracted && !opts.force) {
    return { action: 'unchanged', path: relDest };
  }
  try {
    if (alreadyExtracted) rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    if (source.kind === 'tgz') {
      // npm pack always wraps tarball contents in a top-level `package/` dir.
      execFileSync('tar', ['-xzf', source.path, '-C', destDir, '--strip-components=1']);
    } else {
      cpSync(source.path, destDir, {
        recursive: true,
        filter: (src) =>
          !/(^|[\\/])node_modules([\\/]|$)/.test(src) && !/\.test\.[tj]sx?$/.test(src),
      });
    }
    return { action: 'wrote', path: relDest };
  } catch (err) {
    return { action: 'error', path: relDest, message: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* JSON-safe editing primitives (shared: package.json + app.json)      */
/* ------------------------------------------------------------------ */

/** String-aware `{`/`}` (or `[`/`]`) matcher for JSON text — no comments, no
 *  template literals, just double-quoted strings with backslash escapes. */
function findMatchingJsonSpan(
  text: string,
  openIndex: number,
  openCh: string,
  closeCh: string,
): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i = skipJsonString(text, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipJsonString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i;
    i++;
  }
  return text.length - 1;
}

/** Indentation of the first key inside the outermost `{`. Falls back to 2
 *  spaces (the near-universal npm/pnpm/prettier default) when undetectable. */
function detectTopIndent(text: string): string {
  const openIdx = text.indexOf('{');
  if (openIdx === -1) return '  ';
  const m = text.slice(openIdx + 1).match(/^\r?\n([ \t]+)/);
  return m?.[1] ?? '  ';
}

/** `JSON.stringify(value, null, indentUnit)`, with every line after the
 *  first re-prefixed by `baseIndent` — lets a rebuilt sub-value slot into
 *  the middle of hand-formatted JSON at the right nesting depth. */
function stringifyIndented(value: unknown, baseIndent: string, indentUnit: string): string {
  const raw = JSON.stringify(value, null, indentUnit);
  return raw
    .split('\n')
    .map((line, i) => (i === 0 ? line : baseIndent + line))
    .join('\n');
}

/** Structural equality — the round-trip safety net every JSON edit below
 *  runs before it is allowed to write anything. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

export interface JsonEditResult {
  source: string;
  changed: boolean;
  reason: 'added' | 'already' | 'unparseable' | 'verification-failed';
}

/**
 * Add `"<depName>": "<depSpec>"` to `dependencies` in a package.json source
 * string, preserving indentation and every other field byte-for-byte.
 * Rebuilds ONLY the `dependencies` object's text span (or inserts a new one
 * right after the top-level `{` when absent) — narrow by construction — then
 * re-parses the result and structurally compares it against "the original
 * object plus exactly this one dependency" before accepting the edit.
 * Anything that doesn't round-trip cleanly (non-standard formatting the span
 * finder mis-locates, a genuinely malformed package.json, …) is REJECTED —
 * `changed: false`, original `source` returned untouched — never written.
 */
export function addFileDependency(
  source: string,
  depName: string,
  depSpec: string,
): JsonEditResult {
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(source);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      return { source, changed: false, reason: 'unparseable' };
    }
    parsed = p as Record<string, unknown>;
  } catch {
    return { source, changed: false, reason: 'unparseable' };
  }

  const existingDeps = (parsed.dependencies as Record<string, unknown> | undefined) ?? {};
  if (existingDeps[depName] === depSpec) {
    return { source, changed: false, reason: 'already' };
  }

  const topIndent = detectTopIndent(source);
  const depsMatch = /"dependencies"\s*:\s*\{/.exec(source);
  let next: string;

  if (depsMatch && depsMatch.index !== undefined) {
    const openIdx = depsMatch.index + depsMatch[0].length - 1;
    const closeIdx = findMatchingJsonSpan(source, openIdx, '{', '}');
    if (closeIdx === -1) return { source, changed: false, reason: 'unparseable' };
    const inner = source.slice(openIdx + 1, closeIdx);
    const entryIndentMatch = inner.match(/\r?\n([ \t]+)"/);
    const entryIndent = entryIndentMatch ? entryIndentMatch[1] : topIndent + topIndent;
    const mergedDeps = { ...existingDeps, [depName]: depSpec };
    const body = Object.entries(mergedDeps)
      .map(([k, v]) => `${entryIndent}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n');
    next = source.slice(0, openIdx + 1) + '\n' + body + '\n' + topIndent + source.slice(closeIdx);
  } else {
    const openBraceIdx = source.indexOf('{');
    if (openBraceIdx === -1) return { source, changed: false, reason: 'unparseable' };
    const entryIndent = topIndent + topIndent;
    const block =
      `\n${topIndent}"dependencies": {\n` +
      `${entryIndent}${JSON.stringify(depName)}: ${JSON.stringify(depSpec)}\n` +
      `${topIndent}},`;
    next = source.slice(0, openBraceIdx + 1) + block + source.slice(openBraceIdx + 1);
  }

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(next);
  } catch {
    return { source, changed: false, reason: 'verification-failed' };
  }
  const expected = { ...parsed, dependencies: { ...existingDeps, [depName]: depSpec } };
  if (!deepEqual(reparsed, expected)) {
    return { source, changed: false, reason: 'verification-failed' };
  }
  return { source: next, changed: true, reason: 'added' };
}

export interface ExpoPluginEditResult {
  source: string;
  changed: boolean;
  reason: 'added' | 'already' | 'unparseable' | 'unsupported-shape' | 'verification-failed';
}

/**
 * Append `pluginName` to `expo.plugins` in an app.json source string. Only
 * the standard `{ "expo": { ... } }` wrapped shape is handled — a bare
 * top-level Expo config (rare; app-target.ts's detector tolerates it for
 * READS, but this is a WRITE) reads as `'unsupported-shape'` rather than
 * guessing. Same round-trip-verify-before-write discipline as
 * {@link addFileDependency}: rebuilds only the `plugins` array's text span
 * (or inserts a new one as the first key of `expo`), then structurally
 * re-checks before accepting.
 */
export function addExpoConfigPlugin(source: string, pluginName: string): ExpoPluginEditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { source, changed: false, reason: 'unparseable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { source, changed: false, reason: 'unparseable' };
  }
  const root = parsed as Record<string, unknown>;
  const expo = root.expo;
  if (typeof expo !== 'object' || expo === null || Array.isArray(expo)) {
    return { source, changed: false, reason: 'unsupported-shape' };
  }
  const expoObj = expo as Record<string, unknown>;
  const existingPlugins = Array.isArray(expoObj.plugins)
    ? (expoObj.plugins as unknown[])
    : undefined;
  const already = (existingPlugins ?? []).some(
    (p) => p === pluginName || (Array.isArray(p) && p[0] === pluginName),
  );
  if (already) return { source, changed: false, reason: 'already' };

  const expoMatch = /"expo"\s*:\s*\{/.exec(source);
  if (!expoMatch || expoMatch.index === undefined) {
    return { source, changed: false, reason: 'unsupported-shape' };
  }
  const expoOpenIdx = expoMatch.index + expoMatch[0].length - 1;
  const expoCloseIdx = findMatchingJsonSpan(source, expoOpenIdx, '{', '}');
  if (expoCloseIdx === -1) return { source, changed: false, reason: 'unparseable' };

  const topIndent = detectTopIndent(source);
  const newPlugins = [...(existingPlugins ?? []), pluginName];
  const expoInner = source.slice(expoOpenIdx, expoCloseIdx);
  const pluginsLocalMatch = /"plugins"\s*:\s*\[/.exec(expoInner);

  let next: string;
  if (pluginsLocalMatch && pluginsLocalMatch.index !== undefined && existingPlugins) {
    const matchAbsIdx = expoOpenIdx + pluginsLocalMatch.index;
    const pluginsOpenIdx = matchAbsIdx + pluginsLocalMatch[0].length - 1;
    const pluginsCloseIdx = findMatchingJsonSpan(source, pluginsOpenIdx, '[', ']');
    if (pluginsCloseIdx === -1) return { source, changed: false, reason: 'unparseable' };
    const lineStart = source.lastIndexOf('\n', matchAbsIdx) + 1;
    const propIndent =
      source.slice(lineStart, matchAbsIdx).match(/^[ \t]*/)?.[0] ?? topIndent + topIndent;
    const rendered = stringifyIndented(newPlugins, propIndent, topIndent);
    next = source.slice(0, pluginsOpenIdx) + rendered + source.slice(pluginsCloseIdx + 1);
  } else {
    const propIndent = topIndent + topIndent;
    const rendered = stringifyIndented(newPlugins, propIndent, topIndent);
    const insertion = `\n${propIndent}"plugins": ${rendered},`;
    next = source.slice(0, expoOpenIdx + 1) + insertion + source.slice(expoOpenIdx + 1);
  }

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(next);
  } catch {
    return { source, changed: false, reason: 'verification-failed' };
  }
  const expected = { ...root, expo: { ...expoObj, plugins: newPlugins } };
  if (!deepEqual(reparsed, expected)) {
    return { source, changed: false, reason: 'verification-failed' };
  }
  return { source: next, changed: true, reason: 'added' };
}

/* ------------------------------------------------------------------ */
/* Vite config editing (plain JS/TS — no JSON safety net available)    */
/* ------------------------------------------------------------------ */

const VITE_CONFIG_CANDIDATES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
const VITE_ALREADY_WIRED_RE = /from\s+['"]@validity\.ai\/verify-plugin-vite['"]/;

/** String/template/comment-aware `{`/`}` (or `[`/`]`) matcher for JS/TS. */
function findMatchingJsSpan(
  text: string,
  openIndex: number,
  openCh: string,
  closeCh: string,
): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipJsStringLike(text, i, ch);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipJsStringLike(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i;
    i++;
  }
  return text.length - 1;
}

function detectObjectIndent(objectBody: string): string {
  const m = objectBody.match(/\{\r?\n([ \t]+)/);
  return m?.[1] ?? '  ';
}

/**
 * Insert a module-binding line (an ESM `import`, or a CJS `const … =
 * require(…)`) after the LAST existing binding of the same style, so the new
 * line lands in the file's own import block rather than above a leading
 * license header / JSDoc `@type` annotation. No binding of that style in the
 * file → the line goes to the very top (still correct for both module
 * systems: a leading `/** @type … *\/` comment stays attached to the
 * declaration it precedes).
 */
function insertModuleBinding(source: string, statement: string, style: 'esm' | 'cjs'): string {
  const re =
    style === 'esm'
      ? /^import .+ from ['"].+['"];?\s*$/gm
      : /^(?:const|let|var)\s+.+=\s*require\(['"].+['"]\);?\s*$/gm;
  const bindings = [...source.matchAll(re)];
  if (bindings.length === 0) return statement + source;
  const last = bindings[bindings.length - 1]!;
  const insertAt = (last.index ?? 0) + last[0].length;
  const afterNewline = source.indexOf('\n', insertAt);
  const at = afterNewline === -1 ? source.length : afterNewline + 1;
  return source.slice(0, at) + statement + source.slice(at);
}

export interface ViteWireResult {
  source: string;
  changed: boolean;
  reason: 'added' | 'already' | 'not-simple-shape';
}

/**
 * Wire `@validity.ai/verify-plugin-vite` into a vite.config source string — ONLY when
 * it matches one of two recognized "simple" shapes:
 *
 *   - `export default defineConfig({ ... })` — object literal passed
 *     directly (the overwhelmingly common case, and the shape TanStack Start
 *     apps use: `defineConfig({ plugins: [tanstackStart(), …] })`).
 *   - `export default { ... }` — a bare object literal, no `defineConfig`
 *     wrapper.
 *
 * A function form (`defineConfig(({ mode }) => ({...}))`), a
 * `mergeConfig(...)` wrapper, an export of a variable, or anything else
 * reads as `'not-simple-shape'` — the caller prints a paste stanza instead
 * of guessing at arbitrary JS. There is no JSON-style parser to round-trip
 * through here, so as a substitute safety net the edited source is re-run
 * through the SAME "already wired" probe used for idempotency before being
 * accepted — the edit only ships once it can prove it left the file in the
 * state re-running this function would recognize as done.
 */
export function wireViteConfigSource(source: string): ViteWireResult {
  if (VITE_ALREADY_WIRED_RE.test(source)) {
    return { source, changed: false, reason: 'already' };
  }

  const defineConfigMatch = /export\s+default\s+defineConfig\s*\(\s*\{/.exec(source);
  const bareObjectMatch = defineConfigMatch ? null : /export\s+default\s*\{/.exec(source);
  const match = defineConfigMatch ?? bareObjectMatch;
  if (!match || match.index === undefined) {
    return { source, changed: false, reason: 'not-simple-shape' };
  }

  const openBraceIdx = match.index + match[0].length - 1;
  const closeBraceIdx = findMatchingJsSpan(source, openBraceIdx, '{', '}');
  if (closeBraceIdx === -1) {
    return { source, changed: false, reason: 'not-simple-shape' };
  }

  const objectBody = source.slice(openBraceIdx, closeBraceIdx);
  const pluginsMatch = /plugins\s*:\s*\[/.exec(objectBody);

  let withPluginsWired: string;
  if (pluginsMatch && pluginsMatch.index !== undefined) {
    const pluginsOpenIdx = openBraceIdx + pluginsMatch.index + pluginsMatch[0].length - 1;
    withPluginsWired =
      source.slice(0, pluginsOpenIdx + 1) + 'validity(), ' + source.slice(pluginsOpenIdx + 1);
  } else {
    const indent = detectObjectIndent(objectBody);
    withPluginsWired =
      source.slice(0, openBraceIdx + 1) +
      `\n${indent}plugins: [validity()],` +
      source.slice(openBraceIdx + 1);
  }

  const next = insertModuleBinding(
    withPluginsWired,
    "import validity from '@validity.ai/verify-plugin-vite';\n",
    'esm',
  );

  if (!VITE_ALREADY_WIRED_RE.test(next)) {
    // Should be unreachable — the import line we just inserted is exactly
    // what the probe looks for — but never write something we can't
    // re-confirm.
    return { source, changed: false, reason: 'not-simple-shape' };
  }

  return { source: next, changed: true, reason: 'added' };
}

/* ------------------------------------------------------------------ */
/* Next config editing (plain JS/TS — no JSON safety net available)    */
/* ------------------------------------------------------------------ */

/**
 * Next's own config-file resolution order (`CONFIG_FILES` in
 * next/dist/shared/lib/constants): `.js`, then `.mjs`, then `.ts`. First
 * match wins — if an app somehow has two, Next loads the `.js` one, so that
 * is the one we edit. (`.cjs` is deliberately absent: Next doesn't load it
 * either, and wiring a file the framework ignores would be a silent no-op
 * dressed up as a success.)
 */
const NEXT_CONFIG_CANDIDATES = ['next.config.js', 'next.config.mjs', 'next.config.ts'];

/** Matches both the ESM import and the CJS require form. */
const NEXT_ALREADY_WIRED_RE = /['"]@validity\.ai\/verify-plugin-next['"]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface NextConfigLiteral {
  /** Index of the `{` that opens the config object literal. */
  openBraceIdx: number;
  /** The module system THIS FILE already uses, read off the export site. */
  style: 'esm' | 'cjs';
}

/**
 * Locate the config object literal in a `next.config.*` source, for the
 * three shapes that can be wrapped without reasoning about arbitrary JS:
 *
 *   1. `export default { … }`
 *   2. `module.exports = { … }`
 *   3. `const nextConfig = { … }` (or `let`/`var`, with an optional simple
 *      type annotation) later re-exported verbatim as `export default
 *      nextConfig` / `module.exports = nextConfig`.
 *
 * Shape 3 is the one that matters most in practice — it is what
 * `create-next-app` emits for all three file extensions: a JSDoc `@type`
 * annotation above `const nextConfig = {}` in JS/MJS, and
 * `const nextConfig: NextConfig = {…}` in TS. The annotation survives the
 * edit untouched in both cases, because only the initializer moves.
 *
 * The re-export match requires a BARE identifier followed by nothing but an
 * optional semicolon to end of line, which is exactly what rules out the
 * shapes we must not touch: `export default withBundleAnalyzer(nextConfig)`
 * and friends hit the `(` and fail to match, so they fall through to the
 * paste stanza instead of being half-wrapped. Likewise the declaration match
 * requires the initializer to START with `{`, so a `const nextConfig =
 * withMDX({…})` declaration is not recognized either.
 *
 * Returns null for everything else — function configs (`export default
 * (phase) => ({…})`), existing wrappers, spreads of an imported base — where
 * the honest answer is "a human should place this call."
 */
function findNextConfigLiteral(source: string): NextConfigLiteral | null {
  const esmDirect = /export\s+default\s*\{/.exec(source);
  if (esmDirect && esmDirect.index !== undefined) {
    return { openBraceIdx: esmDirect.index + esmDirect[0].length - 1, style: 'esm' };
  }
  const cjsDirect = /module\.exports\s*=\s*\{/.exec(source);
  if (cjsDirect && cjsDirect.index !== undefined) {
    return { openBraceIdx: cjsDirect.index + cjsDirect[0].length - 1, style: 'cjs' };
  }

  const esmIdent = /export\s+default\s+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*(?:\r?\n|$)/.exec(source);
  const cjsIdent = esmIdent
    ? null
    : /module\.exports\s*=\s*([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*(?:\r?\n|$)/.exec(source);
  const identMatch = esmIdent ?? cjsIdent;
  if (!identMatch || identMatch.index === undefined) return null;
  const name = identMatch[1]!;

  // `(?::[^=;{]*)?` allows a simple type annotation (`: NextConfig`) while
  // excluding anything containing `=` — a function-typed annotation like
  // `: (phase: string) => NextConfig` must NOT be treated as a plain object.
  const declRe = new RegExp(
    `(?:^|[\\r\\n;])[ \\t]*(?:const|let|var)\\s+${escapeRegExp(name)}\\s*(?::[^=;{]*)?=\\s*\\{`,
  );
  const decl = declRe.exec(source);
  if (!decl || decl.index === undefined) return null;
  return {
    openBraceIdx: decl.index + decl[0].length - 1,
    style: esmIdent ? 'esm' : 'cjs',
  };
}

export interface NextWireResult {
  source: string;
  changed: boolean;
  reason: 'added' | 'already' | 'not-simple-shape';
}

/**
 * Wire `@validity.ai/verify-plugin-next` into a `next.config.*` source string by
 * wrapping the config object literal as `withValidity({ … })` and prepending
 * the matching binding — an `import` for an ESM file, a `require` for a
 * CommonJS one, decided by which export form the file itself uses.
 *
 * Same philosophy as {@link wireViteConfigSource}, and the same substitute
 * for a JSON round-trip: only the narrow shapes {@link findNextConfigLiteral}
 * recognizes are touched, and the result must satisfy this function's OWN
 * idempotency probe (the package specifier is present AND a `withValidity({`
 * call exists) before the edit is accepted. Re-running on an already-wired
 * file reports `'already'` and returns the source untouched.
 *
 * `withValidity` is behaviour-identity by contract — it returns the config
 * unchanged and only writes `.validity/app-manifest.json` as a side effect —
 * so wrapping the literal cannot change how the app builds even if Validity
 * is later uninstalled from the toolchain's perspective.
 */
export function wireNextConfigSource(source: string): NextWireResult {
  if (NEXT_ALREADY_WIRED_RE.test(source)) {
    return { source, changed: false, reason: 'already' };
  }

  const shape = findNextConfigLiteral(source);
  if (!shape) return { source, changed: false, reason: 'not-simple-shape' };

  const closeBraceIdx = findMatchingJsSpan(source, shape.openBraceIdx, '{', '}');
  if (closeBraceIdx === -1) return { source, changed: false, reason: 'not-simple-shape' };

  const wrapped =
    source.slice(0, shape.openBraceIdx) +
    'withValidity(' +
    source.slice(shape.openBraceIdx, closeBraceIdx + 1) +
    ')' +
    source.slice(closeBraceIdx + 1);

  const binding =
    shape.style === 'esm'
      ? "import { withValidity } from '@validity.ai/verify-plugin-next';\n"
      : "const { withValidity } = require('@validity.ai/verify-plugin-next');\n";
  const next = insertModuleBinding(wrapped, binding, shape.style);

  if (!NEXT_ALREADY_WIRED_RE.test(next) || !/withValidity\s*\(\s*\{/.test(next)) {
    // Should be unreachable — we just inserted both halves — but never write
    // something we can't re-confirm.
    return { source, changed: false, reason: 'not-simple-shape' };
  }

  return { source: next, changed: true, reason: 'added' };
}

export function renderVitePluginStanza(): string {
  return [
    "import validity from '@validity.ai/verify-plugin-vite';",
    '',
    'export default defineConfig({',
    '  plugins: [',
    '    // ...your existing plugins',
    '    validity(),',
    '  ],',
    '});',
  ].join('\n');
}

export function renderNextPluginStanza(): string {
  return [
    "import { withValidity } from '@validity.ai/verify-plugin-next';",
    '',
    'export default withValidity({',
    '  // ...your existing Next config',
    '});',
    '',
    '// CommonJS next.config.js:',
    "//   const { withValidity } = require('@validity.ai/verify-plugin-next');",
    '//   module.exports = withValidity({ /* ...your config */ });',
    '// Already wrapping your config (withBundleAnalyzer, withMDX, next-intl)?',
    '// Wrap the OUTERMOST value: withValidity(withBundleAnalyzer({ ... })).',
  ].join('\n');
}

export function renderExpoPluginStanza(): string {
  return [
    "import withValidity from '@validity.ai/verify-plugin-expo';",
    '',
    'export default ({ config }) => withValidity(config);',
    '// If you already export a config object/function, wrap ITS return',
    '// value with withValidity(...) instead of replacing your export.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Per-plugin config wiring (file discovery + write-or-stanza)         */
/* ------------------------------------------------------------------ */

export interface PluginWireStepReport {
  plugin: PluginShortName;
  step: 'extract' | 'package-json' | 'vite-config' | 'next-config' | 'app-json' | 'app-config-js';
  action: 'wrote' | 'unchanged' | 'skipped' | 'paste-stanza' | 'error';
  path?: string;
  message?: string;
  stanza?: string;
}

function wireVite(cwd: string): PluginWireStepReport {
  const configPath = VITE_CONFIG_CANDIDATES.map((f) => resolve(cwd, f)).find(existsSync);
  if (!configPath) {
    return {
      plugin: 'vite',
      step: 'vite-config',
      action: 'paste-stanza',
      message: 'No vite.config.{ts,js,mjs} found.',
      stanza: renderVitePluginStanza(),
    };
  }
  const relPath = relative(cwd, configPath);
  const source = readFileSync(configPath, 'utf-8');
  const result = wireViteConfigSource(source);
  if (result.reason === 'already') {
    return { plugin: 'vite', step: 'vite-config', action: 'unchanged', path: relPath };
  }
  if (result.changed) {
    writeFileSync(configPath, result.source);
    return { plugin: 'vite', step: 'vite-config', action: 'wrote', path: relPath };
  }
  return {
    plugin: 'vite',
    step: 'vite-config',
    action: 'paste-stanza',
    path: relPath,
    message: `${relPath} doesn't match a simple defineConfig({...}) / export default {...} shape — paste manually.`,
    stanza: renderVitePluginStanza(),
  };
}

function wireNext(cwd: string): PluginWireStepReport {
  const configPath = NEXT_CONFIG_CANDIDATES.map((f) => resolve(cwd, f)).find(existsSync);
  if (!configPath) {
    // Next runs happily with no config file at all, so "absent" is a normal
    // state — but Validity never CREATES one (a config file Next didn't have
    // is a new thing in the user's build, not a wiring edit). Paste stanza.
    return {
      plugin: 'next',
      step: 'next-config',
      action: 'paste-stanza',
      message: 'No next.config.{js,mjs,ts} found — create one with this content.',
      stanza: renderNextPluginStanza(),
    };
  }
  const relPath = relative(cwd, configPath);
  const source = readFileSync(configPath, 'utf-8');
  const result = wireNextConfigSource(source);
  if (result.reason === 'already') {
    return { plugin: 'next', step: 'next-config', action: 'unchanged', path: relPath };
  }
  if (result.changed) {
    writeFileSync(configPath, result.source);
    return { plugin: 'next', step: 'next-config', action: 'wrote', path: relPath };
  }
  return {
    plugin: 'next',
    step: 'next-config',
    action: 'paste-stanza',
    path: relPath,
    message:
      `${relPath} isn't a plain config object (function config, or an existing wrapper like ` +
      `withBundleAnalyzer) — wrap it by hand.`,
    stanza: renderNextPluginStanza(),
  };
}

function wireExpo(cwd: string): PluginWireStepReport {
  const appJsonPath = resolve(cwd, 'app.json');
  if (existsSync(appJsonPath)) {
    const source = readFileSync(appJsonPath, 'utf-8');
    const result = addExpoConfigPlugin(source, PLUGIN_PACKAGE_NAMES.expo);
    if (result.reason === 'already') {
      return { plugin: 'expo', step: 'app-json', action: 'unchanged', path: 'app.json' };
    }
    if (result.changed) {
      writeFileSync(appJsonPath, result.source);
      return { plugin: 'expo', step: 'app-json', action: 'wrote', path: 'app.json' };
    }
    return {
      plugin: 'expo',
      step: 'app-json',
      action: 'paste-stanza',
      path: 'app.json',
      message: `app.json doesn't have the expected { "expo": { ... } } shape (${result.reason}) — add manually.`,
      stanza: `"plugins": ["${PLUGIN_PACKAGE_NAMES.expo}"]`,
    };
  }
  const dynamicConfig = ['app.config.ts', 'app.config.js']
    .map((f) => resolve(cwd, f))
    .find(existsSync);
  if (dynamicConfig) {
    const relPath = relative(cwd, dynamicConfig);
    const source = readFileSync(dynamicConfig, 'utf-8');
    if (source.includes(PLUGIN_PACKAGE_NAMES.expo)) {
      return { plugin: 'expo', step: 'app-config-js', action: 'unchanged', path: relPath };
    }
    return {
      plugin: 'expo',
      step: 'app-config-js',
      action: 'paste-stanza',
      path: relPath,
      message: `${relPath} is a dynamic config — Validity never rewrites JS/TS Expo configs.`,
      stanza: renderExpoPluginStanza(),
    };
  }
  return {
    plugin: 'expo',
    step: 'app-json',
    action: 'skipped',
    message: 'No app.json or app.config.{ts,js} found — cannot wire the Expo plugin automatically.',
  };
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export interface WirePluginsArgs {
  cwd: string;
  selection: PluginSelectionMode;
  /** Force re-extraction even when `.validity/plugins/<name>/` exists. */
  force?: boolean;
  /** Injectable for tests / callers that already resolved a source. */
  resolveSource?: (shortName: PluginShortName) => PluginSource;
}

export interface WirePluginsResult {
  targets: PluginShortName[];
  steps: PluginWireStepReport[];
  warnings: string[];
}

/**
 * Wire every plugin implied by `selection` into the app at `cwd`. Never
 * throws — a missing staged plugin source is caught and surfaced as a
 * warning + an `'error'` step so `validity init` can finish reporting
 * everything else it did. Each plugin's steps run independently: a failed
 * extraction for one plugin never blocks another plugin's wiring.
 */
export function wirePlugins(args: WirePluginsArgs): WirePluginsResult {
  const steps: PluginWireStepReport[] = [];
  const warnings: string[] = [];
  const targets = resolvePluginTargets(args.cwd, args.selection);
  if (targets.length === 0) {
    return { targets, steps, warnings };
  }
  const resolveSource =
    args.resolveSource ?? ((name: PluginShortName) => resolvePluginSource(name));

  for (const shortName of targets) {
    let source: PluginSource;
    try {
      source = resolveSource(shortName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(message);
      steps.push({ plugin: shortName, step: 'extract', action: 'error', message });
      continue;
    }

    const extraction = extractPluginPackage(args.cwd, shortName, source, { force: args.force });
    steps.push({
      plugin: shortName,
      step: 'extract',
      action: extraction.action,
      path: extraction.path,
      message: extraction.message,
    });
    if (extraction.action === 'error') {
      warnings.push(`Failed to extract the ${shortName} plugin: ${extraction.message}`);
      continue;
    }

    const pkgPath = resolve(args.cwd, 'package.json');
    if (!existsSync(pkgPath)) {
      warnings.push(
        `No package.json found at ${args.cwd} — cannot add the ${shortName} plugin dependency.`,
      );
      steps.push({
        plugin: shortName,
        step: 'package-json',
        action: 'error',
        message: 'package.json missing',
      });
    } else {
      const depName = PLUGIN_PACKAGE_NAMES[shortName];
      const depSpec = `file:.validity/plugins/${shortName}`;
      const pkgSource = readFileSync(pkgPath, 'utf-8');
      const result = addFileDependency(pkgSource, depName, depSpec);
      if (result.changed) {
        writeFileSync(pkgPath, result.source);
        steps.push({
          plugin: shortName,
          step: 'package-json',
          action: 'wrote',
          path: 'package.json',
        });
      } else if (result.reason === 'already') {
        steps.push({
          plugin: shortName,
          step: 'package-json',
          action: 'unchanged',
          path: 'package.json',
        });
      } else {
        warnings.push(
          `Could not add ${depName} to package.json (${result.reason}) — add by hand: ` +
            `"${depName}": "${depSpec}"`,
        );
        steps.push({
          plugin: shortName,
          step: 'package-json',
          action: 'paste-stanza',
          path: 'package.json',
          stanza: `"${depName}": "${depSpec}"`,
        });
      }
    }

    steps.push(
      shortName === 'vite'
        ? wireVite(args.cwd)
        : shortName === 'next'
          ? wireNext(args.cwd)
          : wireExpo(args.cwd),
    );
  }

  return { targets, steps, warnings };
}

/**
 * Render `wirePlugins`'s result in `init.ts`'s picocolors style. Stays
 * silent when nothing was selected/detected so a plain `validity init` on a
 * project with no recognized Vite/Next/Expo target doesn't print an empty
 * section.
 */
export function printPluginWiringResult(
  result: WirePluginsResult,
  out: Pick<NodeJS.WritableStream, 'write'>,
  err: Pick<NodeJS.WritableStream, 'write'>,
): void {
  if (result.targets.length === 0) return;

  out.write('\n' + pc.bold('Plugins') + '\n');
  for (const step of result.steps) {
    switch (step.action) {
      case 'wrote':
        out.write(`${pc.green('✓')} ${step.plugin}: wrote ${step.path}\n`);
        break;
      case 'unchanged':
        out.write(`${pc.dim('•')} ${step.plugin}: ${step.path} unchanged\n`);
        break;
      case 'skipped':
        out.write(
          `${pc.dim('•')} ${step.plugin}: ${step.step} skipped${step.message ? ` — ${step.message}` : ''}\n`,
        );
        break;
      case 'paste-stanza':
        out.write(`${pc.yellow('!')} ${step.plugin}: ${step.message ?? 'paste manually'}\n`);
        if (step.stanza) out.write('\n' + step.stanza + '\n\n');
        break;
      case 'error':
        err.write(
          `${pc.red('✗')} ${step.plugin}: ${step.step} failed${step.message ? ` — ${step.message}` : ''}\n`,
        );
        break;
    }
  }
  for (const w of result.warnings) err.write(pc.yellow(`! ${w}\n`));
}
