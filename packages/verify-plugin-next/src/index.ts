import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildAppManifest, serializeAppManifest, toPosix } from './build-manifest.js';
import { APP_MANIFEST_RELATIVE_PATH, type AppManifest } from './schema.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.js';

export type {
  AppManifest,
  AppManifestAlias,
  AppManifestAliasOmissionReason,
  AppManifestCss,
  AppManifestEntry,
  AppManifestEnv,
  AppManifestFramework,
  AppManifestOmittedAlias,
  AppManifestPlugins,
  AppManifestTailwind,
} from './schema.js';
export { APP_MANIFEST_RELATIVE_PATH, APP_MANIFEST_SCHEMA_VERSION } from './schema.js';
export {
  buildAppManifest,
  detectTailwind,
  envNamesFrom,
  parseJsonc,
  probePostcssConfig,
  readCssFacts,
  readDependencyNames,
  readEnvFacts,
  readTsconfigAliases,
  serializeAppManifest,
  stripJsonComments,
  toPosix,
  NEXT_ENV_FILES,
  NEXT_PUBLIC_PREFIX,
  POSTCSS_CONFIG_FILES,
  TSCONFIG_FILES,
  type BuildManifestOptions,
  type ManifestFs,
} from './build-manifest.js';
export { PLUGIN_NAME, PLUGIN_VERSION } from './version.js';

/* ------------------------------------------------------------------ *
 * Next config shapes                                                  *
 * ------------------------------------------------------------------ */

/**
 * Next's phase constants, copied rather than imported.
 *
 * `next/constants` is a real module, but importing it would make this package
 * depend on `next` being resolvable from wherever the config is evaluated, and
 * would turn a missing/renamed export in a future Next major into a crash
 * inside the user's config file. The values are part of Next's public API and
 * have been stable since Next 9; comparing strings costs nothing and cannot
 * throw. An unrecognized phase falls back to the `NODE_ENV` heuristic below, so
 * a new phase degrades instead of misfiring.
 */
export const NEXT_PHASE = {
  developmentServer: 'phase-development-server',
  productionBuild: 'phase-production-build',
  productionServer: 'phase-production-server',
  export: 'phase-export',
  test: 'phase-test',
  info: 'phase-info',
} as const;

/**
 * The object form of `next.config.*`.
 *
 * `object`, not a shape: this wrapper never reads a single field, and Next's
 * own `NextConfig` is an INTERFACE — interfaces get no implicit index
 * signature, so a `Record<string, unknown>` constraint would reject the exact
 * type Next tells users to annotate their config with.
 */
export type NextConfigObject = object;

/**
 * The function form of `next.config.*`: `(phase, { defaultConfig }) => config`.
 * The return type is `unknown` because Next accepts a config or a promise of
 * one, and this wrapper passes whatever it gets straight through.
 */
export type NextConfigFunction = (phase: string, context?: { defaultConfig?: unknown }) => unknown;

/** Either shape Next accepts from `next.config.*`. */
export type NextConfigLike = NextConfigObject | NextConfigFunction;

/* ------------------------------------------------------------------ *
 * Options                                                             *
 * ------------------------------------------------------------------ */

/**
 * When the manifest is written.
 *
 * - `'dev'` (DEFAULT) — during `next dev` only. A production build then has
 *   **zero** observable difference from not using the wrapper: no file write,
 *   nothing in the output. That matters because plenty of CI pipelines treat a
 *   dirty tree after `next build` as a failure.
 * - `'build'` — during `next build` (and `next export`) only. The right choice
 *   for a repo where nobody runs the dev server locally.
 * - `'both'` — either of the above. The recorded facts come from files on disk,
 *   not from a command-specific resolved config, so unlike the Vite plugin's
 *   `'both'` this cannot make the manifest flip between commands.
 *
 * With the FUNCTION config form — the one Next hands a phase — no mode ever
 * writes during `next start`, `next info`, or a `next/jest` run: those neither
 * develop nor build the app, and a diagnostic command that mutates the working
 * tree is a bad neighbour.
 *
 * The OBJECT form gets no phase, so that guarantee is only as good as the
 * `NODE_ENV` fallback, and there is one known gap: `apply: 'build'` plus
 * `next start` looks exactly like `apply: 'build'` plus `next build`
 * (`NODE_ENV=production`, no phase) and WILL write. Use the function form if
 * your production server runs from a tree that must stay clean.
 */
export type ValidityNextApply = 'dev' | 'build' | 'both';

/** Options for {@link withValidity}. All optional; the defaults are the intended setup. */
export interface ValidityNextOptions {
  /**
   * The Next app directory — the one holding `next.config.*`, `.env*` and
   * `tsconfig.json`. Defaults to `process.cwd()`, which is where Next evaluates
   * a config from for every normal invocation. Set it when it isn't: notably
   * `next dev ./apps/web`, where Next reads the config from the given directory
   * while the process cwd stays put.
   *
   * NAMED `appDir` RATHER THAN `projectRoot` ON PURPOSE:
   * `@validity.ai/verify-plugin-vite`'s `projectRoot` names the directory that OWNS
   * `.validity/` (Vite already tells that plugin the app root). This option
   * names the app root itself; the `.validity/` owner is always discovered by
   * walking up from it — see {@link resolveValidityRoot}. Two sibling packages
   * a user installs side by side must not share an option name with opposite
   * meanings.
   */
  appDir?: string;
  /** See {@link ValidityNextApply}. Default `'dev'`. */
  apply?: ValidityNextApply;
  /**
   * Record client env variable NAMES in `env.exposedKeys`. Default `false` —
   * the manifest is a committable file and a name like
   * `NEXT_PUBLIC_STRIPE_KEY` leaks product surface on its own. The exposed-
   * variable COUNT is always recorded. Values are never recorded either way.
   */
  includeEnvKeys?: boolean;
  /**
   * Hard off switch. `false` makes the wrapper a pure identity function —
   * useful for gating on an env var (`enabled: !process.env.CI`) without
   * conditionally wrapping the config.
   */
  enabled?: boolean;
}

/** Result of a manifest write attempt. Returned by the internal writer for tests. */
export interface WriteManifestResult {
  /** Absolute POSIX path the manifest was (or would be) written to. */
  path: string;
  /** `'written'` on a real change, `'unchanged'` when the content-hash guard skipped it. */
  outcome: 'written' | 'unchanged';
}

/* ------------------------------------------------------------------ *
 * Gating                                                              *
 * ------------------------------------------------------------------ */

/**
 * Decide whether this evaluation of `next.config.*` should write the manifest.
 *
 * `phase` is Next's own signal and is only available in the FUNCTION config
 * form — Next passes it as the first argument. The object form gets nothing, so
 * the fallback reads `NODE_ENV`, which Next sets itself before loading the
 * config: `development` for `next dev`, `production` for `next build` and
 * `next start`. That fallback is exact for those commands and documented as a
 * heuristic because a user who runs `NODE_ENV=production next dev` (a thing
 * people do to reproduce a bug) will not get a manifest from the object form.
 * Switching to the function form, or `apply: 'both'`, is the answer there.
 */
export function shouldWriteManifest(apply: ValidityNextApply, phase?: string): boolean {
  switch (phase) {
    case NEXT_PHASE.developmentServer:
      return apply !== 'build';
    case NEXT_PHASE.productionBuild:
    case NEXT_PHASE.export:
      return apply !== 'dev';
    // `next start` serves an already-built app and `next info` is a diagnostic;
    // `phase-test` is next/jest. None of them is a dev or a build, so none of
    // them writes — including under `'both'`.
    case NEXT_PHASE.productionServer:
    case NEXT_PHASE.test:
    case NEXT_PHASE.info:
      return false;
    default:
      if (apply === 'both') return true;
      return apply === 'build'
        ? process.env.NODE_ENV === 'production'
        : process.env.NODE_ENV !== 'production';
  }
}

/**
 * Detect that we are running inside VALIDITY'S OWN sandbox rather than the
 * user's app, and must do nothing.
 *
 * The env var is the contract (Validity sets `VALIDITY_SANDBOX=1` for every
 * process it owns). The path marker is belt-and-braces for anything that
 * evaluates a config from inside `node_modules/.validity/` without inheriting
 * that env — the failure it prevents is silent corruption of a real manifest,
 * which is worth a second cheap check.
 */
export function isValidityManagedRoot(appRoot: string): boolean {
  if (process.env.VALIDITY_SANDBOX === '1') return true;
  return toPosix(appRoot).includes('node_modules/.validity');
}

/** The Next app directory: an explicit option, else the process cwd. POSIX-style. */
export function resolveAppRoot(explicit?: string): string {
  return toPosix(resolve(explicit ?? process.cwd()));
}

/**
 * Pick the directory that owns `.validity/`. Start at the app root and walk up
 * to five levels looking for a directory that already contains `.validity/`; if
 * none does, use the app root (first run in a single-package app, where
 * `validity init` will create it there).
 *
 * Bounded at five levels so a project nested inside an unrelated repo that
 * happens to use Validity can't reach out and claim a stranger's manifest.
 */
export function resolveValidityRoot(appRoot: string): string {
  let cur = resolve(appRoot);
  for (let i = 0; i < 5; i++) {
    try {
      const candidate = resolve(cur, '.validity');
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return toPosix(cur);
    } catch {
      /* unreadable dir — keep walking */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return toPosix(resolve(appRoot));
}

/**
 * Write the manifest, but only when its bytes actually changed.
 *
 * The guard is what makes this safe to run on every config evaluation: `next
 * dev` re-evaluates `next.config.*` whenever it changes, and a file written
 * under a watched tree on each of those would either restart the server in a
 * loop or churn git. Comparing serialized content against what is already on
 * disk makes a no-op run a pure read.
 */
export function writeManifestIfChanged(
  manifestPath: string,
  manifest: AppManifest,
): WriteManifestResult {
  const next = serializeAppManifest(manifest);
  try {
    if (existsSync(manifestPath) && readFileSync(manifestPath, 'utf-8') === next) {
      return { path: manifestPath, outcome: 'unchanged' };
    }
  } catch {
    /* unreadable existing file — fall through and rewrite it */
  }
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, next, 'utf-8');
  return { path: manifestPath, outcome: 'written' };
}

/**
 * The whole side effect, wrapped so it cannot escape. Returns the write result
 * (or `null` when gating declined) purely so tests can assert on it — no caller
 * in a user's app ever sees it.
 */
function runManifestWrite(
  options: ValidityNextOptions,
  phase?: string,
): WriteManifestResult | null {
  if (options.enabled === false) return null;
  if (!shouldWriteManifest(options.apply ?? 'dev', phase)) return null;
  try {
    const appRoot = resolveAppRoot(options.appDir);
    if (isValidityManagedRoot(appRoot)) return null;
    const manifest = buildAppManifest(appRoot, {
      generatorName: PLUGIN_NAME,
      generatorVersion: PLUGIN_VERSION,
      includeEnvKeys: options.includeEnvKeys === true,
    });
    const owner = resolveValidityRoot(appRoot);
    return writeManifestIfChanged(resolve(owner, APP_MANIFEST_RELATIVE_PATH), manifest);
  } catch (err) {
    // Fail open, loudly but once. A Validity integration must never be the
    // reason `next dev` won't start, and a stack trace in someone's config
    // output would read like Next itself broke.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[validity] could not write ${APP_MANIFEST_RELATIVE_PATH}: ${detail}. ` +
        `Validity will fall back to inferring your app's setup.`,
    );
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The wrapper                                                         *
 * ------------------------------------------------------------------ */

/**
 * Record your Next app's setup to `.validity/app-manifest.json` so Validity's
 * isolated sandbox renders against the same env vars, CSS pipeline and path
 * aliases your real app uses.
 *
 * ```js
 * // next.config.mjs
 * import { withValidity } from '@validity.ai/verify-plugin-next';
 * export default withValidity({ reactStrictMode: true });
 * ```
 *
 * ```js
 * // next.config.js (CommonJS)
 * const { withValidity } = require('@validity.ai/verify-plugin-next');
 * module.exports = withValidity({ reactStrictMode: true });
 * ```
 *
 * **Your config is returned unchanged.** Not cloned, not merged, not extended:
 * the object you pass in is the object Next receives, `===` identical. Nothing
 * here wraps `webpack`, adds a plugin, sets a header, or touches the build in
 * any way. The entire observable effect is one deterministic JSON file under
 * `.validity/`, and if writing it fails the config is still returned — see
 * {@link ValidityNextApply} for when the write happens at all.
 *
 * The function form of a Next config is supported too, and is slightly better:
 * Next passes it the phase, so gating uses Next's own signal instead of the
 * `NODE_ENV` heuristic.
 *
 * ```js
 * module.exports = withValidity((phase, { defaultConfig }) => ({ ...defaultConfig }));
 * ```
 */
export function withValidity<T extends NextConfigLike>(
  nextConfig: T,
  options: ValidityNextOptions = {},
): T {
  if (typeof nextConfig === 'function') {
    const userConfigFn = nextConfig as unknown as NextConfigFunction;
    // Delegate FIRST: if the user's own config function throws, that is their
    // error to surface, and a side effect that ran before it would be a lie
    // about an app that never loaded.
    const wrapped: NextConfigFunction = (phase, context) => {
      const resolved = userConfigFn(phase, context);
      runManifestWrite(options, phase);
      return resolved;
    };
    return wrapped as unknown as T;
  }
  runManifestWrite(options);
  return nextConfig;
}

export default withValidity;
