/**
 * `.validity/app-manifest.json` — the public contract between a user's real
 * Next.js app and Validity's isolated sandbox, as written by
 * `@validity.ai/verify-plugin-next`.
 *
 * WHY THIS FILE IS A TWIN, NOT AN IMPORT
 *
 * These types are a hand-written twin of `@validity.ai/verify-plugin-vite`'s `schema.ts`
 * (and of the reader's twin in `@validity.ai/verify-spec`'s `app-manifest.ts`). Nothing
 * here imports from either. That is deliberate and load-bearing: this package
 * is installed INSIDE the user's app and upgrades on the user's cadence, while
 * the reader ships inside Validity and upgrades on ours. The file on disk is a
 * WIRE FORMAT; sharing a compile-time type across the boundary would create a
 * false guarantee that the two sides move together, and would drag Validity's
 * internals into a package a user installs.
 *
 * WHAT NEXT CAN AND CANNOT ANSWER
 *
 * `@validity.ai/verify-plugin-vite` reports what Vite RESOLVED — it hooks `configResolved`
 * and reads a fully normalized config object. Next has no equivalent: a config
 * wrapper runs when `next.config.*` is evaluated, before Next has resolved
 * anything, and Next never hands the config file a resolved view back. So every
 * fact here is derived from Next's own on-disk CONVENTIONS (`.env*`,
 * `tsconfig.json` paths, PostCSS config discovery, package.json deps) and
 * anything a convention cannot establish is recorded as its honest empty value
 * — never guessed. See the per-field docs for exactly which is which.
 *
 * CONTRACT RULES (identical to the Vite writer's — this is the same file)
 *
 * 1. `schemaVersion` is a monotonically increasing integer, bumped only for
 *    BREAKING changes. Adding optional fields is not a bump; readers tolerate
 *    unknown fields.
 * 2. Every field is written on every run, in the declaration order of
 *    {@link AppManifest}. The serializer is deterministic, so the same app
 *    always produces byte-identical JSON — the file can be committed, and a
 *    re-run produces no diff (the writer content-hashes before touching it).
 * 3. Readers MUST tolerate unknown fields and MUST refuse an unrecognized
 *    `schemaVersion` rather than guessing.
 * 4. NOTHING here may carry a secret. Env variable VALUES are never recorded,
 *    and variable NAMES are opt-in only. See {@link AppManifestEnv}.
 */

/**
 * Current schema version. `framework: 'next'` and everything this writer
 * records fit schema v1 — the framework label is an additive VALUE, not a
 * shape change, and readers that predate it collapse it to `'vite'` safely.
 */
export const APP_MANIFEST_SCHEMA_VERSION = 1;

/** Conventional path of the manifest, relative to the Validity project root. */
export const APP_MANIFEST_RELATIVE_PATH = '.validity/app-manifest.json';

/**
 * Validity's framework labels. Provenance only: they record WHICH producer and
 * pipeline a manifest came from, and never switch a render target (target
 * selection stays with `ValidityConfig.framework` / Validity's own app
 * detection). This writer only ever emits `'next'`; the full union is declared
 * so the twin describes the wire format rather than one writer's slice of it.
 */
export type AppManifestFramework = 'vite' | 'expo-web' | 'tanstack-start' | 'next';

/**
 * A path alias Validity's sandbox can mirror verbatim.
 *
 * `find` is the bare specifier prefix (`"@"`), `replacement` an ABSOLUTE
 * POSIX-style path. Absolutizing happens here, not in the reader, because only
 * this side knows the app's real root — the sandbox's root is
 * `node_modules/.validity/`, where the same relative path means something else.
 */
export interface AppManifestAlias {
  /** The specifier prefix being aliased, e.g. `"@"` for a `"@/*"` tsconfig path. */
  find: string;
  /** Absolute POSIX-style path the prefix resolves to. */
  replacement: string;
}

/**
 * Why something alias-shaped was recorded but NOT mirrored.
 *
 * On the wire this field is a free-form string (the reader in `@validity.ai/verify-spec`
 * types it as `string` precisely so writers can add reasons without a schema
 * bump). These three are the values THIS writer emits; `@validity.ai/verify-plugin-vite`
 * emits a different set (`regexp-find`, `custom-resolver`, …) drawn from what a
 * resolved Vite config can contain.
 *
 * - `unsupported-tsconfig-pattern` — a `compilerOptions.paths` entry that is
 *   not a simple single-wildcard-suffix mapping (`"@/*": ["./src/*"]`).
 *   Multiple targets, a mid-pattern wildcard, and exact non-wildcard mappings
 *   all land here: each would need resolution semantics Validity does not
 *   implement, and a subtly different re-implementation silently mis-resolves
 *   modules, which is worse than an honest omission.
 * - `unresolved-tsconfig-extends` — an `extends` this writer deliberately did
 *   not follow: a bare package specifier (resolving it would mean running
 *   Node's resolver against the user's `node_modules` from a config file), or
 *   a chain deeper than one level. Recorded so a report can say the alias list
 *   may be incomplete instead of implying it is exhaustive.
 * - `unparsable-tsconfig` — the config file exists but is not parseable, even
 *   after comment/trailing-comma tolerance. Recorded rather than swallowed:
 *   "no aliases" and "we could not read your aliases" are different facts.
 */
export type AppManifestAliasOmissionReason =
  | 'unsupported-tsconfig-pattern'
  | 'unresolved-tsconfig-extends'
  | 'unparsable-tsconfig';

/** Something alias-shaped that was observed but deliberately not mirrored. */
export interface AppManifestOmittedAlias {
  /**
   * Human-readable rendering of what was skipped — the `paths` pattern, the
   * `extends` specifier, or the config filename. Display text for a report; it
   * is not required to be re-parseable.
   */
  find: string;
  /** Why it wasn't mirrored. */
  reason: AppManifestAliasOmissionReason;
}

/**
 * Client env exposure facts. **The highest-value field in the manifest**:
 * without `dir` the sandbox loads no `.env` at all and every env-driven branch
 * renders its fallback.
 *
 * SECURITY: values are NEVER recorded — the `.env*` files are scanned for
 * variable NAMES only, and even those are written only when the wrapper is
 * given `includeEnvKeys: true`, because `.validity/app-manifest.json` is a
 * committable file and a name like `NEXT_PUBLIC_STRIPE_KEY` leaks product
 * surface on its own. The count alone supports the honest report line "this app
 * exposes N client env vars".
 */
export interface AppManifestEnv {
  /**
   * Directory Next loads `.env*` from — the app root, as an absolute
   * POSIX-style path. Next has no `envDir` knob: it is always the project
   * directory, which is why this always equals {@link AppManifest.root}.
   */
  dir: string;
  /**
   * Prefixes that expose a variable to client code. Always exactly
   * `["NEXT_PUBLIC_"]` — Next's inlining prefix is not configurable, so unlike
   * Vite's `envPrefix` there is nothing to resolve here.
   */
  prefixes: string[];
  /**
   * How many distinct `NEXT_PUBLIC_*` names appear across the `.env*` files at
   * {@link AppManifestEnv.dir}.
   *
   * HONEST LIMIT: this counts what is written down on disk. Variables injected
   * by the shell, a CI secret store, or a hosting provider's dashboard are
   * invisible to a config-time file scan, so the real number a deployed app
   * sees can be higher. A file scan is the only thing that is checkable without
   * reading `process.env`, which would put values one mistake away from a
   * committed file.
   */
  exposedKeyCount: number;
  /**
   * The `NEXT_PUBLIC_*` NAMES, sorted. Present only when the wrapper was given
   * `includeEnvKeys: true`. Never contains values.
   */
  exposedKeys?: string[];
}

/**
 * How Tailwind (if any) is wired in. Recorded so a report can EXPLAIN an
 * unstyled render instead of just showing one: Validity's sandbox ships a
 * Tailwind v4 shim and a v3 (PostCSS) project currently gets no Tailwind there.
 */
export interface AppManifestTailwind {
  /** True when a Tailwind integration was detected. */
  detected: boolean;
  /**
   * Which integration. Always `'postcss'` when detected: Next has no Vite
   * plugin pipeline, so `@tailwindcss/vite` is not a path a Next app can take.
   * `null` when undetected.
   */
  via: 'vite-plugin' | 'postcss' | null;
  /**
   * Major version when it can be established WITHOUT guessing: `4` for a
   * `@tailwindcss/postcss` dependency (v4's PostCSS entry point moved to its
   * own package), `3` for a bare `tailwindcss` dependency alongside a PostCSS
   * config. `null` when undetected.
   */
  major: 3 | 4 | null;
}

/** CSS pipeline facts. `postcssConfigPath` is consumed by the sandbox; the rest is provenance. */
export interface AppManifestCss {
  /** Tailwind integration summary. */
  tailwind: AppManifestTailwind;
  /**
   * ALWAYS EMPTY for a Next app. PostCSS plugin names would have to come from
   * executing `postcss.config.*`, which Next itself defers until it builds —
   * the config file is code, and a config-time wrapper that ran it would both
   * change the user's build timing and report a list Next may never use.
   * Same honesty rule as the Vite writer's deferred-config case.
   */
  postcssPlugins: string[];
  /**
   * Absolute POSIX-style path to the app's PostCSS config file, found by
   * probing the standard filenames next to {@link AppManifest.root}. `null`
   * when the app has none. This is the field that repairs PostCSS discovery in
   * a sandbox rooted at `node_modules/.validity/`.
   */
  postcssConfigPath: string | null;
  /**
   * ALWAYS EMPTY for a Next app. Entry stylesheets are imported from the root
   * layout of an App Router tree (or `pages/_app`), which is a module graph
   * question, not a convention — see {@link AppManifestEntry} for why this
   * writer refuses to guess at Next's entry.
   */
  entryCss: string[];
}

/**
 * The app's entry pair. **ALWAYS `{ html: null, module: null }` for Next.**
 *
 * The field exists because a Vite app's `index.html` + its module script is a
 * fact the sandbox cannot otherwise recover. Next has no such pair: there is no
 * HTML entry (the server renders one), and "the entry module" is whichever
 * `app/layout.tsx` or `pages/_app.tsx` the router picks per route. Reporting
 * one of those would be inventing a fact — Validity's own entry discovery is a
 * better answer than a confident wrong one, and a `null` here is what tells it
 * to keep using that.
 */
export interface AppManifestEntry {
  /** Always `null` for Next. */
  html: string | null;
  /** Always `null` for Next. */
  module: string | null;
}

/**
 * Build-pipeline plugin names. **ALWAYS EMPTY for Next.** Next has no
 * enumerable plugin list — the closest analogue is a chain of config wrappers
 * (`withBundleAnalyzer(withMDX(config))`) that is invisible from inside any one
 * of them. Fabricating entries here would corrupt the one thing this array is
 * for: provenance a reader can trust.
 */
export type AppManifestPlugins = string[];

/**
 * The manifest. Field order here is the field order on disk — the serializer
 * writes keys in this declaration order, byte-compatible with
 * `@validity.ai/verify-plugin-vite`'s output, so a diff between a Vite-produced and a
 * Next-produced manifest shows only real differences.
 */
export interface AppManifest {
  /** See {@link APP_MANIFEST_SCHEMA_VERSION}. Readers reject versions they don't know. */
  schemaVersion: number;
  /** What produced this file. `name` is the npm package; `version` its version. */
  generator: {
    name: string;
    version: string;
  };
  /** Always `'next'` from this writer. See {@link AppManifestFramework}. */
  framework: AppManifestFramework;
  /**
   * The Next app directory, absolute POSIX-style. The reader uses it to detect
   * a manifest written for a DIFFERENT directory (a stale copy committed in a
   * monorepo) and to resolve relative paths in this file.
   */
  root: string;
  /** Always the null pair for Next — see {@link AppManifestEntry}. */
  entry: AppManifestEntry;
  /** Client env exposure facts. `dir` + `prefixes` are consumed by the sandbox. */
  env: AppManifestEnv;
  /** CSS pipeline facts. `postcssConfigPath` is consumed; the rest is provenance. */
  css: AppManifestCss;
  /** Mirrorable tsconfig/jsconfig path aliases, in declaration order. */
  aliases: AppManifestAlias[];
  /** Alias-shaped things observed but deliberately not mirrored, with reasons. */
  aliasesOmitted: AppManifestOmittedAlias[];
  /** Always empty for Next — see {@link AppManifestPlugins}. */
  plugins: AppManifestPlugins;
}
