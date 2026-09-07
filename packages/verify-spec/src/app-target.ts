/**
 * App-target detection — the single "what kind of app is this, and how should
 * Validity validate it?" brain. Used by `validity__verify` / `validity browse`
 * so the user can just say "validate this app" and Validity routes to the
 * right pipeline (web sandbox, Expo Web, or on-device native) on its own.
 *
 * Dependency-only + shallow (reads package.json + a couple of well-known
 * files), like detect-project.ts — no AST work, no sandbox/native imports, so
 * it stays at the bottom of the dependency graph and both the web and native
 * layers can consume it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppKind = 'vite' | 'next' | 'expo' | 'react-native' | 'unknown';

/** A concrete pipeline Validity can run. */
export type ValidationMode =
  /** Vite/Next component or page rendered in the web sandbox + Playwright. */
  | 'web'
  /** Expo app rendered via react-native-web in the web sandbox (CI-friendly, no device). */
  | 'expo-web'
  /** Component/screen mounted on a real simulator/emulator (device required). */
  | 'native';

export interface AppTarget {
  kind: AppKind;
  /** Modes this project can be validated with, best/most-automated first. */
  modes: ValidationMode[];
  /**
   * The mode "validate this app" should use by default.
   *
   * For web toolchains (Vite/Next) that's the web sandbox. For React Native
   * and Expo it is **always `'native'`** unless the project has *explicitly*
   * opted into Expo Web — a mobile app's real runtime is the device, and
   * rendering it through `react-native-web` is a proxy the user did not ask
   * for. See {@link expoWebOptIn} for what counts as explicit.
   */
  recommended: ValidationMode;
  /** True when an on-device native path is available (Expo or bare RN). */
  nativeAvailable: boolean;
  /**
   * True when the project explicitly asked for the `react-native-web` proxy
   * (config `framework: 'expo-web'`, or an app config that declares web as
   * its only platform). Never inferred from the mere presence of
   * `react-native-web` / `react-dom` in dependencies — Expo templates install
   * those by default, so their presence states nothing about intent.
   */
  webTargetExplicit: boolean;
  /** One-line, human-facing explanation of the routing decision. */
  summary: string;
}

/**
 * Options that let a caller feed *explicit* user intent into the routing
 * decision. Everything here has to come from something the user typed —
 * a config field or a command flag — never from dependency sniffing.
 */
export interface AppTargetOptions {
  /**
   * The project's resolved `.validity/config.ts` `framework` value, when the
   * caller has already loaded the config. `'expo-web'` is the explicit
   * opt-in to the react-native-web proxy; `'expo-native'` pins native.
   */
  configFramework?: string;
  /**
   * An explicit per-invocation web request — `validity browse --web`,
   * `validity__verify({ webTarget: true })`. Highest precedence.
   */
  webTargetFlag?: boolean;
}

/**
 * The one-liner every RN/Expo code path prints when it declines to silently
 * fall back to `react-native-web`. Kept here so the CLI, the MCP server, and
 * the sandbox all say the same thing.
 */
export const EXPO_WEB_OPT_IN_HINT =
  "Expo Web (react-native-web) is a proxy for the real app, so Validity never picks it for you. To use it anyway, set `framework: 'expo-web'` in .validity/config.ts (or pass the explicit web flag for this one call).";

/**
 * Does this project explicitly want the `react-native-web` proxy? Only a
 * config pin, a web-only app config, or an explicit flag counts.
 */
export function expoWebOptIn(projectRoot: string, opts: AppTargetOptions = {}): boolean {
  if (opts.webTargetFlag === true) return true;
  if (opts.configFramework === 'expo-web') return true;
  if (opts.configFramework === 'expo-native') return false;
  return declaresWebOnlyPlatforms(projectRoot);
}

/** The Expo/RN app-config filenames. Suggestive, never conclusive — see below. */
const APP_CONFIG_FILES = ['app.json', 'app.config.ts', 'app.config.js'];

/**
 * `app.json` with a top-level `expo` key. Unambiguous: no non-Expo tool writes
 * that shape, so it identifies an Expo project even when dependencies can't be
 * read.
 */
function appJsonDeclaresExpo(projectRoot: string): boolean {
  const p = resolve(projectRoot, 'app.json');
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return typeof j === 'object' && j !== null && 'expo' in j;
  } catch {
    return false;
  }
}

/** What a project's dependencies say about React Native. */
export interface ReactNativeSignals {
  /** Expo (managed or bare) is present. */
  isExpo: boolean;
  /** A `react-native` dependency is present. */
  isReactNative: boolean;
}

/**
 * Does this project actually target React Native?
 *
 * Deliberately dependency-driven. The tempting shortcut — "there's an
 * `app.json`, so it's Expo" — is wrong for real web repos in two common ways:
 * `app.json` is also Heroku's app manifest, and `app.config.ts` is TanStack
 * Start / Solid Start / Vinxi. Those filenames used to be treated as proof,
 * which was survivable when they only picked a sandbox alias, but is not now
 * that this decides whether someone gets sent to build a simulator app.
 *
 * So a config FILE only counts as Expo evidence when the project also depends
 * on `react-native` — or when `app.json` literally declares an `expo` key,
 * which nothing else does. A web project cannot fall into the mobile path by
 * filename alone.
 */
export function detectReactNativeSignals(projectRoot: string): ReactNativeSignals {
  const deps = readDeps(projectRoot);
  const isReactNative = Boolean(deps['react-native']);
  const hasAppConfig = hasAnyFile(projectRoot, APP_CONFIG_FILES);
  return {
    isReactNative,
    isExpo:
      Boolean(deps.expo) || appJsonDeclaresExpo(projectRoot) || (hasAppConfig && isReactNative),
  };
}

/**
 * Dependencies that mean "this project builds for a browser."
 *
 * Validity renders in isolation for Vite / Next / Expo-Web only, but the
 * question here is narrower and more important: is this a WEB app? Anything on
 * this list is, whatever else its package.json contains — and that has to hold
 * for the whole web ecosystem, not just the toolchains Validity can render.
 * A Remix or Astro user whose repo happens to carry an Expo-shaped filename
 * (or `react-native` for react-native-web) must land on the web path and get
 * an honest "isolation needs Vite/Next/Expo, use URL mode" — never a
 * simulator-build checklist for an app that has no simulator.
 */
const WEB_BUILD_DEPS = [
  'vite',
  'next',
  'astro',
  'gatsby',
  'nuxt',
  '@remix-run/dev',
  '@remix-run/react',
  '@tanstack/react-start',
  '@solidjs/start',
  'react-scripts',
  '@rsbuild/core',
  '@rspack/core',
  'parcel',
  'webpack',
  '@angular/core',
  'vue',
  'svelte',
];

/** Does this project build for a browser, by any recognised toolchain? */
function hasWebBuildTool(deps: Record<string, string>): boolean {
  return WEB_BUILD_DEPS.some((d) => Boolean(deps[d]));
}

/**
 * `app.json` / `app.config.*` with `platforms: ["web"]` and nothing else — an
 * Expo project that has stated, in its own config, that web is the app. Any
 * list that also names ios/android is a mobile app and does not count.
 */
function declaresWebOnlyPlatforms(projectRoot: string): boolean {
  const appJson = resolve(projectRoot, 'app.json');
  if (!existsSync(appJson)) return false;
  try {
    const j = JSON.parse(readFileSync(appJson, 'utf-8')) as Record<string, unknown>;
    const root = (j.expo as Record<string, unknown> | undefined) ?? j ?? {};
    const platforms = root.platforms;
    if (!Array.isArray(platforms) || platforms.length === 0) return false;
    return platforms.every((p) => p === 'web');
  } catch {
    return false;
  }
}

function readDeps(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function hasAnyFile(projectRoot: string, names: string[]): boolean {
  return names.some((n) => existsSync(resolve(projectRoot, n)));
}

/**
 * Classify the project and recommend a validation mode. Precedence is chosen
 * so the most specific signal wins, and so a mobile app is never quietly
 * downgraded to a browser proxy:
 *   - Next.js        → web
 *   - Expo           → native (expo-web ONLY on an explicit opt-in)
 *   - Vite           → web
 *   - any other web
 *     build tool     → web (kind 'unknown' — no isolation pipeline, but a WEB
 *                     answer: URL mode covers Remix / Astro / the rest)
 *   - bare RN        → native only
 *
 * Every web toolchain is checked before bare React Native, not just Vite. A
 * `react-native` dependency next to a browser build is the react-native-web
 * pattern — Solito's Next apps, Vite + RNW — and those are web apps. A real
 * Expo app carries the `expo` dependency and is caught before any of them.
 *
 * The Expo rule is the important one. Rendering React Native through
 * `react-native-web` is faster and needs no device, which makes it a tempting
 * default — but it exercises a different runtime than the app ships on, so
 * choosing it *for* the user produces evidence about something they never
 * asked to validate. Expo Web stays available; it just has to be asked for.
 */
export function detectAppTarget(projectRoot: string, opts: AppTargetOptions = {}): AppTarget {
  const deps = readDeps(projectRoot);
  const { isExpo, isReactNative } = detectReactNativeSignals(projectRoot);
  const isNext = Boolean(deps.next);
  const isVite = Boolean(deps.vite);

  if (isNext) {
    return {
      kind: 'next',
      modes: ['web'],
      recommended: 'web',
      nativeAvailable: false,
      webTargetExplicit: true,
      summary:
        'Next.js app — validated in the web sandbox (isolation, or URL mode for full pages).',
    };
  }

  if (isExpo) {
    const wantsWeb = expoWebOptIn(projectRoot, opts);
    return {
      kind: 'expo',
      modes: wantsWeb ? ['expo-web', 'native'] : ['native', 'expo-web'],
      recommended: wantsWeb ? 'expo-web' : 'native',
      nativeAvailable: true,
      webTargetExplicit: wantsWeb,
      summary: wantsWeb
        ? 'Expo app with an explicit web target — validated via Expo Web (react-native-web) in ' +
          'the web sandbox. On-device native validation stays available with `--native`.'
        : 'Expo app — validated ON A SIMULATOR/EMULATOR, the runtime it actually ships on. ' +
          '`validity browse --native` builds a companion "Validity" app once, then renders are ' +
          `instant. ${EXPO_WEB_OPT_IN_HINT}`,
    };
  }

  // Vite before bare RN: `vite` + `react-native` in one package.json is the
  // react-native-web pattern (a WEB app), not a Metro project.
  if (isVite) {
    return {
      kind: 'vite',
      modes: ['web'],
      recommended: 'web',
      nativeAvailable: false,
      webTargetExplicit: true,
      summary: 'Vite + React app — validated in the web sandbox (isolation mode by default).',
    };
  }

  // Any OTHER recognised web toolchain — Remix, Astro, Gatsby, CRA, Rsbuild…
  // Validity has no isolation pipeline for these (that needs Vite/Next/Expo),
  // but they are unambiguously web, and saying so here is what keeps a stray
  // `app.json` or react-native-web dependency from routing them to a device.
  if (hasWebBuildTool(deps)) {
    return {
      kind: 'unknown',
      modes: ['web'],
      recommended: 'web',
      nativeAvailable: false,
      webTargetExplicit: true,
      summary:
        'Web app on a toolchain Validity has no isolation pipeline for (isolation needs Vite, ' +
        'Next.js, or Expo). Validate whole pages with URL mode against your running dev server.',
    };
  }

  if (isReactNative) {
    return {
      kind: 'react-native',
      modes: ['native'],
      recommended: 'native',
      nativeAvailable: true,
      webTargetExplicit: false,
      summary:
        'Bare React Native app — validated on a simulator/emulator via the companion "Validity" ' +
        'app (no Expo Web path without expo). Needs a booted device + a one-time build.',
    };
  }

  return {
    kind: 'unknown',
    modes: ['web'],
    recommended: 'web',
    nativeAvailable: false,
    webTargetExplicit: true,
    summary:
      'Could not detect the framework from package.json — defaulting to the web sandbox. ' +
      'Vite, Next.js, and Expo are the supported toolchains.',
  };
}

/** App ids are reverse-DNS-ish; reject anything else so we never emit invalid TS. */
const APP_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Best-effort read of the platform application id (Android package / iOS bundle
 * identifier) from an Expo/RN app config, for stamping into an exported Maestro
 * flow's `appId`. Prefers the Android package — Maestro on the Android emulator
 * is the primary dogfood path — and falls back to the iOS bundle id.
 *
 * Shallow + tolerant, in keeping with the rest of this module: `JSON.parse` for
 * the static `app.json`, and a narrow regex over the dynamic
 * `app.config.{ts,js,cjs}` (no jiti / evaluation — this runs on the
 * deterministic first-run bootstrap path). A config that can't be read, or a
 * pure-web project with no config file at all, simply yields `undefined`.
 */
export function detectExportAppId(projectRoot: string): string | undefined {
  // Static app.json — the common Expo case. `(expo ?? root)` handles both the
  // wrapped (`{ "expo": { … } }`) and bare top-level shapes.
  const appJson = resolve(projectRoot, 'app.json');
  if (existsSync(appJson)) {
    try {
      const j = JSON.parse(readFileSync(appJson, 'utf-8')) as Record<string, unknown>;
      const root = (j.expo as Record<string, unknown> | undefined) ?? j ?? {};
      const android = (root.android as { package?: unknown } | undefined)?.package;
      const ios = (root.ios as { bundleIdentifier?: unknown } | undefined)?.bundleIdentifier;
      const id = (typeof android === 'string' && android) || (typeof ios === 'string' && ios) || '';
      if (id && APP_ID_RE.test(id)) return id;
    } catch {
      /* malformed app.json — fall through to the dynamic configs */
    }
  }

  // Dynamic app.config.* — regex only, package preferred over bundle id.
  for (const f of ['app.config.ts', 'app.config.js', 'app.config.cjs']) {
    const p = resolve(projectRoot, f);
    if (!existsSync(p)) continue;
    let body: string;
    try {
      body = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    const id =
      body.match(/package:\s*['"]([^'"]+)['"]/)?.[1] ??
      body.match(/bundleIdentifier:\s*['"]([^'"]+)['"]/)?.[1];
    if (id && APP_ID_RE.test(id)) return id;
  }
  return undefined;
}
