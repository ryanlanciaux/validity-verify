import { describeAppManifest, readAppManifest, type AppManifestReadResult } from '@validity.ai/verify-spec';
import type { UserConfig } from 'vite';

/**
 * Sandbox-side consumption of `.validity/app-manifest.json`.
 *
 * The manifest is written by `@validity.ai/verify-plugin-vite` from inside the user's
 * REAL Vite pipeline. This module turns it into a small set of additive
 * overrides for the sandbox's own Vite config, plus a provenance line naming
 * exactly what was acted on versus merely read.
 *
 * WHAT THIS FIXES, AND WHAT IT DELIBERATELY DOESN'T
 *
 * The sandbox already loads the user's `vite.config.*` (`loadUserViteConfig`)
 * and merges it, so user plugins and statically-declared aliases ALREADY reach
 * the sandbox. The manifest is not there to re-do that. It exists for the
 * facts Vite resolves relative to `root` — and the sandbox's root is
 * `node_modules/.validity/`, not the project:
 *
 *   - `envDir`: Vite loads `.env*` from `<root>`, so today the sandbox reads
 *     NO env files and `import.meta.env.VITE_*` is empty. Every env-gated
 *     branch in the user's components renders its fallback path, silently.
 *   - `envPrefix`: an app using a non-default prefix (`PUBLIC_`) would still
 *     see nothing even once envDir is right.
 *   - PostCSS config discovery: also root-relative. A Tailwind **v3** project
 *     wires Tailwind through PostCSS, and the sandbox's Tailwind shim only
 *     covers v4 (`detectsTailwindV4` keys off `@tailwindcss/vite` in deps) —
 *     so a v3 app currently renders with no Tailwind at all.
 *   - Aliases a static config read cannot see: anything a plugin injected or
 *     the config computed at runtime.
 *
 * ISOLATION IS UNCHANGED. Nothing here starts, contacts, or depends on the
 * user's dev server; the manifest is a file on disk. The sandbox still boots
 * its own Vite, still mocks the network, still renders in its own root.
 *
 * ALIAS PRECEDENCE (highest wins; documented because it is load-bearing):
 *
 *   1. **Sandbox-owned aliases** — react/react-dom dedupe, the MSW
 *      interceptors shim, expo-web and next-web overrides. These are what make
 *      the sandbox work at all; a manifest may never displace them.
 *   2. **The user's own `vite.config` aliases** — already merged in by
 *      `startDevServer`, and authored deliberately by the user.
 *   3. **Manifest-only aliases** — contributed ONLY for `find` keys neither of
 *      the above declares.
 *
 * Implemented as a gap-fill rather than a priority ordering, because Vite's
 * `mergeAlias` puts override entries FIRST (higher priority) and a
 * priority-based scheme would therefore silently let a stale manifest outrank
 * a live config. Filtering by `find` makes the rule true by construction:
 * a manifest can only ever ADD resolution, never redirect it.
 */

/** Additive overrides the sandbox folds into its Vite config. */
export interface AppManifestOverrides {
  /** Directory Vite loads `.env*` from. Absent when the manifest is absent/ignored. */
  envDir?: string;
  /** Client env prefixes, mirrored from the app. */
  envPrefix?: string[];
  /** Absolute path to the app's PostCSS config, when the sandbox should adopt it. */
  postcssConfigPath?: string;
  /** Aliases the manifest contributes that nothing else declares. */
  alias: Array<{ find: string; replacement: string }>;
  /**
   * One-line provenance in the plan's shape ("app manifest present; mirrored:
   * …; recorded: …"). Always populated, including for the absent case, so the
   * run log can distinguish "no manifest" from "manifest ignored" from
   * "manifest rejected as unreadable".
   */
  provenance: string;
  /** Whether any override was actually produced. */
  applied: boolean;
}

/**
 * Every `find` string already claimed by the sandbox's own alias array or by
 * the user's `vite.config`. Handles both alias shapes Vite accepts (array of
 * `{find, replacement}` and the plain object map) and ignores RegExp finds —
 * a RegExp can overlap a string `find` in ways that can't be decided by
 * comparison, and the safe reading of "can't decide" is "don't add".
 */
export function claimedAliasFinds(
  sandboxAlias: ReadonlyArray<{ find: string | RegExp; replacement: string }>,
  userConfig: UserConfig,
): Set<string> {
  const claimed = new Set<string>();
  for (const entry of sandboxAlias) {
    if (typeof entry.find === 'string') claimed.add(entry.find);
  }
  const userAlias = userConfig.resolve?.alias;
  if (Array.isArray(userAlias)) {
    for (const entry of userAlias) {
      const find = (entry as { find?: unknown }).find;
      if (typeof find === 'string') claimed.add(find);
    }
  } else if (userAlias && typeof userAlias === 'object') {
    for (const key of Object.keys(userAlias as Record<string, unknown>)) claimed.add(key);
  }
  return claimed;
}

/**
 * Read the manifest and turn it into sandbox overrides.
 *
 * `useAppManifest` mirrors `ValidityConfig.web.useAppManifest`: undefined means
 * ON, because installing `@validity.ai/verify-plugin-vite` is itself the opt-in and
 * demanding a second flag would just be a footgun. Only an explicit `false`
 * makes the sandbox ignore a manifest that is sitting right there.
 *
 * `read` is injectable so tests can exercise the merge without a real file;
 * production callers omit it and get a disk read.
 */
export function buildAppManifestOverrides(args: {
  projectRoot: string;
  useAppManifest?: boolean;
  userConfig: UserConfig;
  sandboxAlias: ReadonlyArray<{ find: string | RegExp; replacement: string }>;
  read?: AppManifestReadResult;
}): AppManifestOverrides {
  const inert = (provenance: string): AppManifestOverrides => ({
    alias: [],
    provenance,
    applied: false,
  });

  if (args.useAppManifest === false) {
    return inert('app manifest ignored (web.useAppManifest: false)');
  }

  const read = args.read ?? readAppManifest(args.projectRoot);
  if (!read.ok) return inert(describeAppManifest(read, []));

  const m = read.manifest;
  const mirrored: string[] = [];
  const overrides: AppManifestOverrides = { alias: [], provenance: '', applied: false };

  // 1. env. The highest-value field: without it `import.meta.env.VITE_*` is
  //    empty in the sandbox no matter what else is right.
  overrides.envDir = m.env.dir;
  mirrored.push(
    `envDir (${m.env.exposedKeyCount} client var${m.env.exposedKeyCount === 1 ? '' : 's'})`,
  );
  // Only mirror a NON-default prefix set: passing the default back in is noise
  // in the config and in the provenance line.
  if (!(m.env.prefixes.length === 1 && m.env.prefixes[0] === 'VITE_')) {
    overrides.envPrefix = m.env.prefixes;
    mirrored.push(`envPrefix (${m.env.prefixes.join(', ')})`);
  }

  // 2. PostCSS. The user's OWN vite.config wins — if they declared
  //    `css.postcss` there, the sandbox already inherited it and re-pointing
  //    it from a possibly-staler manifest would be a downgrade.
  const userDeclaresPostcss = args.userConfig.css?.postcss !== undefined;
  if (!userDeclaresPostcss && m.css.postcssConfigPath) {
    overrides.postcssConfigPath = m.css.postcssConfigPath;
    mirrored.push('postcss config');
  }

  // 3. Aliases — gap-fill only. See the precedence note in the file docstring.
  const claimed = claimedAliasFinds(args.sandboxAlias, args.userConfig);
  for (const a of m.aliases) {
    if (claimed.has(a.find)) continue;
    claimed.add(a.find);
    overrides.alias.push(a);
  }
  if (overrides.alias.length > 0) mirrored.push(`aliases (${overrides.alias.length})`);

  overrides.applied = true;
  overrides.provenance = describeAppManifest(read, mirrored);
  return overrides;
}
