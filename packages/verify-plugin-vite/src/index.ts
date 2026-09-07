import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { buildAppManifest, serializeAppManifest, toPosix } from './build-manifest.js';
import type { ResolvedConfigLike } from './build-manifest.js';
import { APP_MANIFEST_RELATIVE_PATH, type AppManifest } from './schema.js';

export type {
  AppManifest,
  AppManifestAlias,
  AppManifestAliasOmissionReason,
  AppManifestCss,
  AppManifestEntry,
  AppManifestEnv,
  AppManifestOmittedAlias,
  AppManifestPlugins,
  AppManifestTailwind,
} from './schema.js';
export { APP_MANIFEST_RELATIVE_PATH, APP_MANIFEST_SCHEMA_VERSION } from './schema.js';
export {
  buildAppManifest,
  serializeAppManifest,
  detectFramework,
  detectTailwind,
  htmlEntries,
  readEntryFacts,
  serializeAliases,
  summarizeEnv,
  toPosix,
  userPluginNames,
  type BuildManifestOptions,
  type ManifestFs,
  type ResolvedConfigLike,
} from './build-manifest.js';

/**
 * When the manifest is written.
 *
 * - `'serve'` (DEFAULT) — during `vite dev` only. A production build then has
 *   **literally zero** behavior difference from not installing the plugin: no
 *   file write, no timing cost, nothing in the output. That matters because
 *   plenty of CI pipelines treat a dirty tree after `vite build` as a failure,
 *   and because the resolved plugin list differs between commands (a user
 *   plugin declared `apply: 'build'` appears in one and not the other), so
 *   pinning to a single command is what makes "same config → byte-identical
 *   manifest" true rather than aspirational.
 * - `'build'` — during `vite build` only. The right choice for a repo where
 *   nobody runs the dev server locally.
 * - `'both'` — both commands. Churn-free for the common case (no
 *   `apply`-gated user plugins, which is most apps), but if the app DOES have
 *   command-specific plugins the `plugins` array will flip between a dev run
 *   and a build run, and the committed file will show a diff each time. Opt in
 *   knowing that.
 *
 * Whichever mode is chosen, generating the manifest is a side effect on
 * `.validity/` and nothing else. The plugin adds no middleware, no virtual
 * modules, no transforms, and no dev-server hooks — a Validity verify never
 * needs the user's dev server to be running, and this plugin does not change
 * that.
 */
export type ValidityPluginApply = 'serve' | 'build' | 'both';

/** Options for {@link validity}. All optional; the defaults are the intended setup. */
export interface ValidityPluginOptions {
  /**
   * Directory that owns the `.validity/` folder. Defaults to Vite's resolved
   * `root`, then walks up looking for an existing `.validity/` directory —
   * so a monorepo whose Vite root is `apps/web` but whose Validity setup lives
   * at the repo root writes to the repo root, which is where `validity verify`
   * will look.
   */
  projectRoot?: string;
  /** See {@link ValidityPluginApply}. Default `'serve'`. */
  apply?: ValidityPluginApply;
  /**
   * Record client env variable NAMES (never values) in `env.exposedKeys`.
   * Default `false` — the manifest is a committable file and a name like
   * `VITE_STRIPE_PUBLISHABLE_KEY` leaks product surface on its own. The
   * exposed-variable COUNT is always recorded.
   */
  includeEnvKeys?: boolean;
  /**
   * Hard off switch. `false` makes the plugin an inert no-op — useful for
   * gating on an env var (`enabled: !process.env.CI`) without conditionally
   * building the plugins array.
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

const require_ = createRequire(import.meta.url);

/**
 * Read this package's own name + version for the `generator` field. Falls back
 * to a stable placeholder rather than throwing: a missing package.json is a
 * packaging problem, not a reason to break the user's dev server.
 */
function readGeneratorIdentity(): { name: string; version: string } {
  try {
    const pkg = require_('../package.json') as { name?: string; version?: string };
    return { name: pkg.name ?? '@validity.ai/verify-plugin-vite', version: pkg.version ?? '0.0.0' };
  } catch {
    return { name: '@validity.ai/verify-plugin-vite', version: '0.0.0' };
  }
}

/**
 * Detect that we are running inside VALIDITY'S OWN sandbox rather than the
 * user's app, and must do nothing.
 *
 * This is not a theoretical case. `packages/verify-web/src/server.ts` boots its
 * own Vite with `configFile: false` but explicitly loads the user's
 * `vite.config.*` and merges it (`loadUserViteConfig` → `mergeConfig`), so
 * every user plugin — including this one — is instantiated inside the sandbox
 * too. Without this guard, `validity verify` would fire `configResolved` with
 * the SANDBOX's config (root = `node_modules/.validity/`, no user plugins, no
 * env) and overwrite the real manifest with a description of Validity's own
 * scaffolding. The manifest would then be wrong until the next `vite dev`,
 * and the sandbox would consume its own garbage on the following run.
 *
 * Three independent signals, because a single one is a single point of
 * failure for a bug whose symptom is silent corruption:
 *   1. `VALIDITY_SANDBOX=1` in the environment (explicit, future-proofed);
 *   2. a root inside `node_modules/.validity`;
 *   3. a cacheDir inside `node_modules/.validity` (the sandbox pins
 *      `cacheDir: <validityDir>/.vite-cache`).
 */
export function isValidityManagedConfig(config: ResolvedConfigLike): boolean {
  if (process.env.VALIDITY_SANDBOX === '1') return true;
  const marker = 'node_modules/.validity';
  if (toPosix(config.root ?? '').includes(marker)) return true;
  if (typeof config.cacheDir === 'string' && toPosix(config.cacheDir).includes(marker)) return true;
  return false;
}

/**
 * Pick the directory that owns `.validity/`. An explicit option wins. Otherwise
 * start at Vite's root and walk up to five levels looking for a directory that
 * already contains `.validity/`; if none does, use Vite's root (first run in a
 * single-package app, where `validity init` will create it there).
 *
 * Bounded at five levels so a project nested inside an unrelated repo that
 * happens to use Validity can't reach out and claim a stranger's manifest.
 */
export function resolveValidityRoot(viteRoot: string, explicit?: string): string {
  if (explicit) return toPosix(resolve(explicit));
  let cur = resolve(viteRoot);
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
  return toPosix(resolve(viteRoot));
}

/**
 * Write the manifest, but only when its bytes actually changed.
 *
 * The guard is the whole reason this is safe to run on every `configResolved`:
 * Vite re-resolves its config on every `vite.config.ts` edit, and a file
 * written under a watched tree on each of those would either restart the
 * server in a loop or churn git. Comparing the serialized content against
 * what's already on disk makes a no-op run a pure read.
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
 * Minimal structural stand-in for Vite's `Plugin`. Declared locally so the
 * package's public type surface never depends on which Vite major is
 * installed — `vite` is a peer dependency with a deliberately wide range, and
 * a real `Plugin` is assignable to this.
 */
export interface ValidityVitePlugin {
  name: string;
  apply?: 'serve' | 'build';
  configResolved(config: ResolvedConfigLike & { logger?: { warn(msg: string): void } }): void;
}

/**
 * Vite plugin that records your app's resolved build facts to
 * `.validity/app-manifest.json` so Validity's isolated sandbox renders against
 * the same env, CSS pipeline, and entry module your real app uses.
 *
 * ```ts
 * // vite.config.ts
 * import validity from '@validity.ai/verify-plugin-vite';
 * export default defineConfig({ plugins: [react(), validity()] });
 * ```
 *
 * The plugin is write-only and read-only-of-config: it registers no
 * middleware, transforms nothing, and never contacts the network. Its entire
 * observable effect is one deterministic JSON file. If anything about
 * producing that file fails, it warns once through Vite's logger and gets out
 * of the way — a Validity integration must never be the reason someone's dev
 * server won't start.
 */
export default function validity(options: ValidityPluginOptions = {}): ValidityVitePlugin {
  const mode: ValidityPluginApply = options.apply ?? 'serve';
  const plugin: ValidityVitePlugin = {
    name: 'validity:app-manifest',
    configResolved(config) {
      if (options.enabled === false) return;
      if (isValidityManagedConfig(config)) return;
      try {
        const identity = readGeneratorIdentity();
        const manifest = buildAppManifest(config, {
          generatorName: identity.name,
          generatorVersion: identity.version,
          includeEnvKeys: options.includeEnvKeys === true,
        });
        const projectRoot = resolveValidityRoot(config.root, options.projectRoot);
        writeManifestIfChanged(resolve(projectRoot, APP_MANIFEST_RELATIVE_PATH), manifest);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        config.logger?.warn(
          `[validity] could not write ${APP_MANIFEST_RELATIVE_PATH}: ${detail}. ` +
            `Validity will fall back to inferring your app's setup.`,
        );
      }
    },
  };
  // `apply` is Vite's own command filter; omitting it means "both". Setting it
  // is what makes the `'serve'` default a genuine zero-cost no-op in builds
  // rather than a runtime early-return.
  if (mode !== 'both') plugin.apply = mode;
  return plugin;
}

export { validity };
