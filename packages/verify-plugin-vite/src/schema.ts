/**
 * `.validity/app-manifest.json` — the public contract between a user's real
 * Vite build and Validity's isolated sandbox.
 *
 * WHY THIS FILE EXISTS
 *
 * Validity never boots the user's dev server. It stands up its OWN Vite server
 * rooted at `node_modules/.validity/` and re-derives the app's facts by reading
 * `vite.config.*` off disk (`loadUserViteConfig` → `mergeConfig`) and guessing
 * the rest. That gets aliases and user plugins right, but three things are
 * structurally unreachable from a sandbox whose `root` is inside
 * `node_modules/`:
 *
 *   1. **`.env` files.** Vite resolves `envDir` against `root`, so the
 *      project's `.env`/`.env.local` are never read and `import.meta.env.VITE_*`
 *      is EMPTY in the sandbox — every env-driven branch renders its fallback.
 *   2. **`postcss.config.*`.** Same root problem: PostCSS config discovery
 *      starts at the sandbox root and finds nothing, so a Tailwind v3
 *      (PostCSS-based) project gets no Tailwind at all.
 *   3. **The real entry module.** Validity walks a 17-entry hardcoded
 *      candidate list (`ENTRY_CANDIDATES` in core's wrapper-generator). The
 *      app's `index.html` `<script type="module" src>` is authoritative and
 *      knows the answer exactly.
 *
 * `@validity.ai/verify-plugin-vite` closes those from the other side. It runs INSIDE the
 * user's real Vite pipeline, waits for `configResolved` (the point where every
 * plugin has had its say and Vite has normalized everything), and writes the
 * resolved facts to disk. The sandbox reads that file and mirrors what it can.
 *
 * CONTRACT RULES
 *
 * 1. `schemaVersion` is a monotonically increasing integer. Bump it only for
 *    BREAKING changes (a field changes meaning or type, or a required field is
 *    removed). Adding optional fields is NOT a bump — readers are required to
 *    tolerate unknown fields (see rule 3).
 * 2. Every field documented here is written on every run, in the declaration
 *    order of {@link AppManifest}. The serializer is deterministic: the same
 *    resolved config always produces byte-identical JSON, so the file can be
 *    committed and a re-run of the plugin produces no diff (and no watch churn
 *    — the writer content-hashes before touching the file).
 * 3. Readers MUST be unknown-field tolerant and MUST refuse a manifest whose
 *    `schemaVersion` they don't recognize rather than guessing. The reference
 *    reader is `packages/verify-spec/src/app-manifest.ts`, which deliberately
 *    RE-DECLARES this shape instead of importing it: the writer ships into the
 *    user's app on the user's upgrade cadence, the reader ships inside
 *    Validity on ours, and the two must be free to skew.
 * 4. NOTHING here may carry a secret. Env variable VALUES are never recorded,
 *    and variable NAMES are opt-in only. See {@link AppManifestEnv}.
 */

/**
 * Current schema version. Bump ONLY on a breaking change to
 * {@link AppManifest}; additive optional fields do not bump.
 */
export const APP_MANIFEST_SCHEMA_VERSION = 1;

/** Conventional path of the manifest, relative to the Validity project root. */
export const APP_MANIFEST_RELATIVE_PATH = '.validity/app-manifest.json';

/**
 * A resolved alias entry that Validity's sandbox can mirror verbatim.
 *
 * Both halves are plain strings: `find` is the bare specifier or prefix the
 * user's build matches on, `replacement` is an ABSOLUTE POSIX-style path (or,
 * for a package-to-package alias, another bare specifier). Absolutizing happens
 * in the plugin, not the reader, because only the plugin knows the user's real
 * Vite `root`; the sandbox's root is `node_modules/.validity/`, so a relative
 * replacement would resolve to the wrong place there.
 *
 * NOTE ON REDUNDANCY: the sandbox already re-reads the user's `vite.config.*`
 * and inherits its aliases, so mirroring these is belt-and-braces, not the
 * headline win. It matters for aliases a static config read cannot see —
 * anything a plugin injects, or anything computed at config time.
 */
export interface AppManifestAlias {
  /** The specifier (or specifier prefix) being aliased, e.g. `"@"` or `"@app/ui"`. */
  find: string;
  /**
   * What it resolves to. Absolute POSIX-style path when the original
   * replacement pointed at the filesystem; otherwise the literal replacement
   * string (a bare specifier such as `"react-native-web"`).
   */
  replacement: string;
}

/**
 * Why an alias present in the user's resolved config was NOT mirrored into
 * {@link AppManifest.aliases}.
 *
 * - `regexp-find` — the alias matches with a RegExp. Vite supports these; JSON
 *   does not round-trip them safely, and re-hydrating a pattern into a
 *   different resolver is a fidelity risk (a subtly different pattern silently
 *   mis-resolves). Recorded, not mirrored.
 * - `custom-resolver` — the entry carries a `customResolver` function. Code
 *   cannot cross a JSON boundary.
 * - `non-string-replacement` — the replacement isn't a string. Nothing to mirror.
 * - `vite-internal` — an alias Vite itself injects (`/@vite/client`,
 *   `/@vite/env`). Mirroring these would point the sandbox's client runtime at
 *   the USER's Vite install, which is exactly the isolation breach the sandbox
 *   exists to prevent.
 */
export type AppManifestAliasOmissionReason =
  | 'regexp-find'
  | 'custom-resolver'
  | 'non-string-replacement'
  | 'vite-internal';

/**
 * An alias that was observed but deliberately not mirrored. Recorded so a
 * report can say honestly "your build has 3 aliases Validity did not mirror"
 * instead of silently rendering against a different module graph.
 */
export interface AppManifestOmittedAlias {
  /**
   * Human-readable rendering of the `find` side. A RegExp is rendered in
   * `/source/flags` form so it is recognizable in a report without implying it
   * can be re-parsed.
   */
  find: string;
  /** Why it wasn't mirrored. */
  reason: AppManifestAliasOmissionReason;
}

/**
 * Environment-variable exposure facts. **This is the highest-value field in
 * the manifest**: without `envDir` the sandbox reads no `.env` at all.
 *
 * SECURITY: values are NEVER recorded. Names are recorded only when the plugin
 * is constructed with `includeEnvKeys: true`, because
 * `.validity/app-manifest.json` is a committable file and a name like
 * `VITE_STRIPE_PUBLISHABLE_KEY` leaks product surface even when the value
 * doesn't. The count alone lets a report say "the app exposes N client env
 * vars", which is the honest statement Validity needs.
 */
export interface AppManifestEnv {
  /**
   * Vite's resolved `envDir` as an absolute POSIX-style path — the directory
   * `.env`, `.env.local`, `.env.<mode>` are loaded from. The sandbox sets its
   * own `envDir` to this so `import.meta.env.VITE_*` is populated the way the
   * real app sees it.
   */
  dir: string;
  /**
   * Resolved `envPrefix`, sorted. Vite's default is `["VITE_"]`; a project that
   * sets `envPrefix: ['VITE_', 'PUBLIC_']` shows both. The sandbox mirrors this
   * so a non-default prefix isn't silently dropped.
   */
  prefixes: string[];
  /**
   * How many variables Vite actually exposed to client code under those
   * prefixes — `Object.keys(config.env)` minus Vite's own built-ins
   * (`BASE_URL`, `MODE`, `DEV`, `PROD`, `SSR`, `LEGACY`).
   */
  exposedKeyCount: number;
  /**
   * The exposed variable NAMES, sorted. Present only when the plugin was
   * constructed with `includeEnvKeys: true`. Never contains values.
   */
  exposedKeys?: string[];
}

/**
 * How Tailwind (if any) is wired into the user's build. The sandbox ships a
 * Tailwind **v4-only** shim, keyed off `'@tailwindcss/vite' in deps`
 * (`detectsTailwindV4`, packages/verify-web/src/prepare.ts). A v3 project — which
 * wires Tailwind through PostCSS — currently gets NO Tailwind in the sandbox
 * and renders unstyled. Recording the integration path is what lets the report
 * explain that instead of just showing it.
 */
export interface AppManifestTailwind {
  /** True when any Tailwind integration was detected. */
  detected: boolean;
  /**
   * Which integration: the first-party Vite plugin (`@tailwindcss/vite`, v4),
   * a PostCSS plugin entry (`tailwindcss` / `@tailwindcss/postcss`, v3-style),
   * or `null` when undetected.
   */
  via: 'vite-plugin' | 'postcss' | null;
  /**
   * Major version, when it can be established WITHOUT guessing: `4` for the
   * `@tailwindcss/vite` plugin, `4` for a `@tailwindcss/postcss` PostCSS
   * entry, `3` for a bare `tailwindcss` PostCSS entry. `null` when Tailwind
   * wasn't detected or the integration doesn't pin a major.
   */
  major: 3 | 4 | null;
}

/**
 * CSS pipeline facts. `postcssConfigPath` is consumed by the sandbox (it
 * repairs PostCSS discovery); the rest is provenance.
 */
export interface AppManifestCss {
  /** Tailwind integration summary. */
  tailwind: AppManifestTailwind;
  /**
   * PostCSS plugin names in the order the resolved config lists them.
   * Empty when the app resolves PostCSS from a config FILE (see
   * {@link AppManifestCss.postcssConfigPath}) — Vite defers loading that file,
   * so the plugin list genuinely isn't known at `configResolved` time and
   * inventing one would be a fabricated fact.
   */
  postcssPlugins: string[];
  /**
   * Absolute POSIX-style path to the external PostCSS config file or search
   * directory, when `css.postcss` resolved to a path rather than an inline
   * object. `null` otherwise (inline config, or plain PostCSS-config discovery
   * which Vite performs relative to `root`).
   *
   * When `null` the writer falls back to probing the standard config filenames
   * next to {@link AppManifest.root}, because "Vite will discover it from
   * root" is exactly the assumption that breaks once the sandbox re-roots.
   */
  postcssConfigPath: string | null;
  /**
   * Stylesheets the app's HTML entry pulls in, relative to
   * {@link AppManifest.root}, in discovery order: `<link rel="stylesheet">`
   * hrefs in the HTML entry, then top-level `import './x.css'` statements in
   * the entry module that HTML loads. A deliberately shallow textual scan of
   * the entry pair only — no transitive CSS graph walk — so it can never
   * disagree with itself run to run.
   */
  entryCss: string[];
}

/**
 * The app's authoritative entry pair, read from the real config instead of
 * guessed. Validity's `findEntryFile` otherwise walks a 17-name candidate
 * list; `index.html`'s module script is the ground truth.
 */
export interface AppManifestEntry {
  /**
   * HTML entry, relative to {@link AppManifest.root}. Usually `index.html`;
   * a multi-page or custom `build.rollupOptions.input` app reports the first
   * HTML input in declaration order. `null` when no HTML entry exists
   * (library builds).
   */
  html: string | null;
  /**
   * The module the HTML entry loads via `<script type="module" src>`, relative
   * to {@link AppManifest.root}. `null` when no HTML entry exists, the script
   * is inline, or the src is a remote URL.
   */
  module: string | null;
}

/**
 * Vite plugin names in resolved order — the pipeline the app really runs,
 * including everything a framework preset expanded into. Vite's own internal
 * plugins (`vite:*`, `alias`, `commonjs`, …) are filtered out: they differ
 * between `serve` and `build` and would make the manifest churn.
 *
 * Recorded for provenance only. The sandbox never executes a user plugin from
 * this list — it re-reads `vite.config.*` and lets Vite instantiate them, so
 * running them from a name would be both redundant and unsafe.
 */
export type AppManifestPlugins = string[];

/**
 * The manifest. Field order here is the field order on disk — the serializer
 * writes keys in this declaration order so output is diff-stable.
 */
export interface AppManifest {
  /** See {@link APP_MANIFEST_SCHEMA_VERSION}. Readers reject versions they don't know. */
  schemaVersion: number;
  /** What produced this file. `name` is the npm package; `version` its version. */
  generator: {
    name: string;
    version: string;
  };
  /**
   * Validity framework label for this app. Derived from resolved aliases +
   * plugin names — see `detectFramework`.
   *
   * - `'vite'` — a plain web app.
   * - `'expo-web'` — React Native source routed through `react-native-web`.
   * - `'tanstack-start'` — a TanStack Start app. Still a Vite pipeline; Start
   *   is a Vite plugin, and this package is what writes the manifest either
   *   way.
   *
   * **Labels are provenance, not render-target switches.** Nothing in the
   * sandbox's merge path branches on this field — target selection belongs to
   * `ValidityConfig.framework` / `detectAppTarget`, which read the user's own
   * config rather than a file the user's build wrote. `'expo-web'` looks like
   * an exception and isn't: what the sandbox reacts to is the user's Validity
   * config, and this label only records that the same conclusion was visible
   * from the build side.
   *
   * Adding a value here is NOT a `schemaVersion` bump (rule 1): readers are
   * required to tolerate what they don't recognize, and the reference reader
   * (`packages/verify-spec/src/app-manifest.ts`) collapses any unknown label to
   * `'vite'` — so an older Validity install reading a `'tanstack-start'`
   * manifest behaves exactly as it did before the label existed.
   */
  framework: 'vite' | 'expo-web' | 'tanstack-start';
  /**
   * Vite's resolved `root`, as an absolute POSIX-style path. The reader uses
   * it to detect a manifest written for a DIFFERENT directory (a stale copy
   * committed in a monorepo, say) and to resolve every relative path in this
   * file.
   */
  root: string;
  /** Authoritative entry pair. */
  entry: AppManifestEntry;
  /** Client env exposure facts. `dir` + `prefixes` are consumed by the sandbox. */
  env: AppManifestEnv;
  /** CSS pipeline facts. `postcssConfigPath` is consumed; the rest is provenance. */
  css: AppManifestCss;
  /** Serializable resolved aliases, in resolved order. */
  aliases: AppManifestAlias[];
  /** Aliases observed but deliberately not mirrored, with reasons. */
  aliasesOmitted: AppManifestOmittedAlias[];
  /** User plugin names in resolved order. Recorded, not executed. */
  plugins: AppManifestPlugins;
}
