/**
 * Companion-app generator — the "no flipping between apps" model.
 *
 * Rather than repointing the user's app root at the playground (a manual,
 * destructive edit), Validity generates a SEPARATE Expo app — literally named
 * "Validity" — under `.validity/native-app/`, builds it once, and installs it
 * alongside the real app in the same simulator/emulator. "Show me my Button"
 * then just deep-links into the Validity app; the user's app is untouched and
 * never has to be edited or swapped.
 *
 * The companion app declares NO dependencies of its own. Its `metro.config.js`
 * points `watchFolders` at the user's project root and forces a single copy of
 * `react` / `react-native` from the user's `node_modules`. That does two
 * things: (1) avoids the duplicate-React "invalid hook call" crash, and (2)
 * lets Expo autolinking pick up the user's native modules — so components that
 * use real native modules render for real, no extra wiring.
 *
 * Pure file emission (reuses {@link prepareNative} for the harness/registry/
 * mocks) + command builders. It never installs or builds anything itself, so
 * it compiles and unit-tests without Expo/RN present; the returned commands
 * are what the CLI / MCP tool run on the user's machine.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ValidityConfig } from '@validity.ai/verify-spec';
import { prepareNative, type PrepareNativeResult } from './prepare-native.js';
import { defaultRunner, type CommandRunner } from './agent-device-driver.js';

export interface PrepareNativeAppOptions {
  projectRoot: string;
  /** Build receipts are platform-specific: an iOS build cannot validate an Android install. */
  platform?: 'ios' | 'android';
  config?: Partial<ValidityConfig>;
  /** Where the companion app is generated. Default `<projectRoot>/.validity/native-app`. */
  appDir?: string;
  /** Display name. Default "Validity". */
  appName?: string;
  /**
   * URL scheme. Default `config.native.scheme` ?? a COMPANION-UNIQUE derived
   * scheme (see {@link defaultCompanionScheme}). The default is deliberately
   * never the host app's own scheme: two installed apps registering the same
   * scheme make `scheme://…` deep links nondeterministic on iOS, so the flow
   * can open (and screenshot) the USER'S dev-client instead of the companion.
   * Setting this (or `native.scheme`) is an explicit override for users who
   * know they want a specific scheme — not a way to "match app.json".
   */
  scheme?: string;
  /** iOS bundle id / Android package. Default 'ai.validity.playground'. */
  bundleId?: string;
  maxComponents?: number;
}

/**
 * Dedicated Metro port for the companion app so it never collides with the
 * host app's default 8081. Shared by the generated `expo run`/`expo start`
 * args and the CLI's "is Metro up?" probe.
 */
export const COMPANION_METRO_PORT = 8082;

/**
 * Dedicated port for the native control bridge — the WebSocket the running
 * companion connects back to so the host (MCP/CLI) can drive the active view
 * IN-PLACE ("show me Button", then "show me Dropdown") without a deep-link
 * reload, with a per-token `rendered` ack confirming each navigation painted.
 * The native analog of the web sandbox's `/__validity/bridge`; it also carries
 * the `hello` (contentHash/identity/capabilities) and the in-place `reload`
 * that replaced the terminate+cold-launch refresh ladder. iOS simulators reach
 * it on `localhost` directly; Android via `adb reverse`.
 */
export const COMPANION_BRIDGE_PORT = 8083;

/** ws:// URL the generated native-entry hands to ValidityNativeRoot's bridge. */
export const COMPANION_BRIDGE_URL = `ws://localhost:${COMPANION_BRIDGE_PORT}`;

/**
 * Revision of the GENERATED companion app shell, hashed into buildHash so
 * bumping it forces a one-time rebuild of every existing install. buildHash
 * already tracks the HOST's binary inputs (native dep versions + the resolved
 * expo config — see {@link CompanionBuildInputs}); the revision covers the one
 * input that lives in Validity itself: a change to the generated shell that
 * alters what prebuild compiles (e.g. the splash strip). Bump it ONLY for such
 * binary-affecting generator changes. The revision is also written into the
 * build marker so the readiness checklist can explain WHY a rebuild is needed
 * instead of reading like the old flakiness returning.
 *
 *   - rev 1 (implicit): every marker written before the revision field existed
 *     (legacy plain-hash markers parse as revision 1).
 *   - rev 2: expo-splash-screen plugin + splash config stripped from the
 *     companion, enabling the bridge's in-place reload (no more terminate +
 *     cold-launch ladder on stale bundles).
 *   - rev 3: the companion's DEFAULT URL scheme became companion-unique
 *     (validity-<bundleId-slug>, see {@link defaultCompanionScheme}) instead
 *     of the shared 'validity' — the installed binary must re-register the
 *     scheme or every deep link/control link targets a scheme it doesn't own.
 *   - rev 4: the companion bundle now measures in-app performance
 *     (React.Profiler mount/update timing + a monotonic navStart->paint
 *     stamp) and ships ready/mount/update/commitCount over the bridge
 *     'rendered' ack's new 'perf' field. Old binaries send no 'perf' object,
 *     so they must be detected as outdated and rebuilt — otherwise native
 *     expect.performance silently degrades to unverifiable forever.
 *
 *   - rev 5: the companion now acks TOKENIZED DEEP LINKS too (announced as the
 *     'deep-link-ack' capability), not just bridge `navigate` messages. The
 *     ack is the only carrier of the per-render observation channels, so on
 *     an old binary every capture that fell to the deep-link rung — routine
 *     whenever a bridge ack times out — reported `expect.performance` (and
 *     network/console) unavailable for a render the device HAD measured. Old
 *     binaries never send it, so the host must detect them and say so rather
 *     than losing one mount metric per sweep to a silent lottery.
 *
 * NOTE: revs 2+3 also cover the buildHash-input change (structure dropped,
 * dep versions + expo config + scheme added) — all shipped together so
 * existing installs pay ONE rebuild, not several.
 */
// rev 6: companion branding no longer references uncopied host icon assets.
export const COMPANION_BUILD_REVISION = 6;

/**
 * What the readiness checklist tells the user when the rebuild is
 * revision-driven. A marker can be several revisions behind, so the reason
 * names every change since the oldest shipped revision — an unexplained
 * rebuild prompt reads like the old flakiness returning.
 */
export const COMPANION_REVISION_REBUILD_REASON =
  'companion config changed: splash screen removed for reliable reloads, and the companion ' +
  'now registers its own unique URL scheme (deep links can no longer open your app by ' +
  'mistake), and host icon assets are no longer inherited — rebuild once';

/**
 * Env for the Metro-SERVING steps (`expo start` / `expo run`). We deliberately
 * do NOT set `CI=1` here even though we spawn detached: Expo gates the file
 * watcher on `!CI` (`isWatchEnabled()` in @expo/cli's instantiateMetro — it even
 * logs "Metro is running in CI mode, reloads are disabled"). With CI set, saving
 * a source file never triggers an incremental rebuild, so Fast Refresh / HMR
 * never reaches the companion — edits only show up on a manual full reload. The
 * spawn is already non-interactive because it has no TTY (`isInteractive()` is
 * `!CI && stdout.isTTY`), so CI bought us nothing for interactivity. We swap in
 * `EXPO_OFFLINE=1` to keep the one useful thing CI also did — suppress Expo's
 * network "development session" advertising — WITHOUT disabling the watcher.
 * (One-shot build steps — prebuild, pod install — still use CI; watch is moot
 * there.)
 *
 * Not setting CI is only HALF the fix: the child also INHERITS the parent's
 * env, and an agent harness / task runner / CI shell commonly exports `CI=1`
 * already — Expo's gate only checks truthiness, so the inherited value
 * disables the watcher exactly like setting it ourselves would. Spawners must
 * assemble the child env with {@link metroServeSpawnEnv}, which strips the
 * inherited flags too.
 */
export const METRO_SERVE_ENV: Record<string, string> = { EXPO_OFFLINE: '1' };

/**
 * Assemble the env for a SPAWNED Metro-SERVING process (`expo start` /
 * `expo run`): merge the step env (see {@link METRO_SERVE_ENV}) over the
 * parent's, then DELETE the CI flags (`CI`, `CONTINUOUS_INTEGRATION`) the
 * parent may have exported. Expo gates Metro's file watcher on `!env.CI`
 * (`isWatchEnabled()` in @expo/cli — it even logs "Metro is running in CI
 * mode, reloads are disabled"), so an inherited `CI=1` from an agent harness
 * silently kills Fast Refresh — user-component edits then never reach the
 * device until a manual --clear restart (contentHash only covers GENERATED
 * files, not ordinary source edits). Serve steps ONLY: one-shot build steps
 * (prebuild, pod install) deliberately run with CI=1 and keep the inherited
 * env as-is.
 */
export function metroServeSpawnEnv(
  base: NodeJS.ProcessEnv,
  stepEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(stepEnv ?? {}) };
  delete env.CI;
  delete env.CONTINUOUS_INTEGRATION;
  return env;
}

/** One ordered build step the CLI runs (and the MCP tool prints). */
export interface NativeBuildStep {
  label: string;
  bin: string;
  args: string[];
  cwd: string;
  /** Env merged over process.env (CI=1 etc.). */
  env?: Record<string, string>;
  /**
   * The step never exits on its own — it stays attached to the Metro dev
   * server (the `expo run:*` server). The CLI must spawn it DETACHED and poll
   * for readiness instead of awaiting its close, or the build loop hangs
   * forever and the navigating deep link is never fired.
   */
  longRunning?: boolean;
}

export interface PrepareNativeAppResult {
  appDir: string;
  appName: string;
  scheme: string;
  bundleId: string;
  /** The harness/registry/mocks generated into appDir (registry imports the user's components). */
  prepared: PrepareNativeResult;
  /** Generated app-shell files (app.json, package.json, metro.config.js, babel.config.js). */
  appFiles: string[];
  /**
   * Ordered, NON-INTERACTIVE build steps to install the companion app on a
   * device for the given platform: install deps → prebuild → pod install (ios)
   * → run with a dedicated Metro port (so it doesn't collide with the host
   * app's 8081). The user/agent shouldn't have to run prebuild/pods by hand.
   *
   * `opts.nativeProjectExists` controls prebuild cost: when the companion's
   * `ios/`/`android/` dir is ALREADY present (a rebuild, not a first build), we
   * use an INCREMENTAL `expo prebuild` instead of `--clean`. The companion's
   * native project is fully generated and never hand-edited, so the from-scratch
   * `--clean` wipe (the multi-minute cost) is only needed on the first build /
   * when the dir is absent. This changes only HOW the prebuild runs, never WHEN
   * we rebuild (the buildHash freshness gate — native dep versions + expo
   * config — is unchanged), so it can't resurface the stale-installed-app bug.
   */
  buildSteps: (
    platform: 'ios' | 'android',
    opts?: { nativeProjectExists?: boolean },
  ) => NativeBuildStep[];
  /**
   * Hash of what must be COMPILED into the native binary — see
   * {@link CompanionBuildInputs}: the NATIVE-shipping host deps as
   * name@version pairs (autolinking compiles exactly those) plus the resolved
   * host expo-config fields prebuild consumes (plugins post-splash-strip,
   * newArchEnabled, jsEngine), salted with the generated-shell revision. If
   * the installed app's marker doesn't match this, the running binary is
   * stale and needs a rebuild (a native dep bump / expo-config change won't
   * take effect otherwise). Deliberately NOT in the hash: the registered
   * component/view set (the registry is plain JS, delivered by the
   * contentHash → Metro path) and pure-JS deps — neither changes the binary,
   * and folding them in used to prompt a minutes-long rebuild for adding a
   * component file or a lodash.
   */
  buildHash: string;
  /**
   * The exact inputs {@link buildHash} was derived from. Persisted into the
   * build marker (see {@link writeBuildMarker}) so the readiness checklist
   * can DIFF them against a stale install and name which input flipped
   * ("native deps changed: expo-router 3.4.0→4.0.0") instead of a generic
   * "rebuild" that reads like flakiness.
   */
  buildInputs: CompanionBuildInputs;
  /**
   * Hash of the exact source Metro serves (prepared bodies + app-shell config).
   * Changes on any content edit even when buildHash doesn't.
   * {@link ensureCompanionMetro} restarts Metro with `--clear` when this differs
   * from {@link metroContentMarkerPath}, so a stale transform cache can't keep
   * serving the old bundle after a fix lands.
   */
  contentHash: string;
  /** File the build marker is written to (after a successful build). */
  buildMarkerPath: string;
  /** File the last-served contentHash is written to (after Metro serves it). */
  metroContentMarkerPath: string;
  /** Number of host dependencies mirrored into the companion (for autolinking). */
  mirroredDepCount: number;
  /** Dev deps the user needs for native mocking (msw/native etc.) — missing ones disable that feature. */
  requiredDevDeps: string[];
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Detect the host's package manager from its lockfile (drives the install step). */
function detectPackageManager(projectRoot: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(resolve(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(projectRoot, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Read the host app's runtime dependencies — mirrored into the companion so autolinking compiles its native modules. */
function readHostDependencies(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies ?? {};
  } catch {
    return {};
  }
}

/**
 * The inputs that determine what gets COMPILED into the companion binary —
 * exactly what buildHash hashes and what the build marker persists, so a
 * stale install can be diffed against the current inputs to name the cause
 * of a rebuild (see {@link describeBuildInputDiff}).
 */
export interface CompanionBuildInputs {
  /**
   * Host deps that ship NATIVE code (ios/android dirs, podspec/gradle files,
   * expo-module/config-plugin markers, or expo-plugin membership), as
   * `name → installed version`. Versions are read from the host's
   * node_modules package.json — the truth the binary was actually built
   * against, not the package.json range. Pure-JS deps are excluded:
   * autolinking never compiles them, so adding one must not prompt a rebuild.
   */
  nativeDeps: Record<string, string>;
  /**
   * The resolved host expo-config fields prebuild bakes into the binary,
   * AFTER the companion's own overrides (the splash strip) — so a host
   * adding/removing expo-splash-screen never flips the companion's hash.
   */
  expoConfig: {
    /** Plugin entries verbatim (name or [name, options]) — options affect the binary (expo-build-properties!). */
    plugins: unknown[];
    newArchEnabled?: boolean;
    jsEngine?: string;
  };
  /**
   * The companion's URL scheme — baked into the generated app.config.js,
   * which prebuild compiles into the binary's URL-scheme registration. The
   * derived default only changes with the bundle id, but an explicit
   * `native.scheme` override edit must flip the hash (the installed binary
   * keeps answering the OLD scheme until rebuilt, so every deep link would
   * silently miss). Optional only because markers written before this field
   * existed lack it (those are also revision-outdated, so the revision
   * message owns their rebuild reason).
   */
  scheme?: string;
}

/**
 * Resolve the host's Expo config IN-PROCESS — the TS mirror of the generated
 * app.config.js's loadHostExpoConfig, used to fold the binary-affecting
 * fields into buildHash. PRIMARY: the host's own @expo/config (handles
 * app.config.ts + the static/dynamic merge; getConfig re-reads + re-evaluates
 * the config files on every call — no require-cache staleness in the
 * long-lived MCP process). FALLBACK: app.json layered with app.config.js/cjs,
 * with the require cache busted per call so an edited dynamic config is seen
 * without a process restart. Degrades to `{}` — a host whose config can't be
 * read simply contributes no expo fields to the hash (never a crash).
 */
function readHostExpoConfig(projectRoot: string): Record<string, unknown> {
  let req: NodeJS.Require | null = null;
  try {
    req = createRequire(resolve(projectRoot, 'package.json'));
  } catch {
    req = null;
  }
  if (req) {
    try {
      const { getConfig } = req('@expo/config') as {
        getConfig: (
          root: string,
          o: { skipSDKVersionRequirement: boolean },
        ) => { exp?: Record<string, unknown> };
      };
      const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
      if (exp) return exp;
    } catch {
      /* fall through to the manual merge */
    }
  }
  let host: Record<string, unknown> = {};
  try {
    const j = parseJsonc(readFileSync(resolve(projectRoot, 'app.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    host = (j.expo as Record<string, unknown> | undefined) ?? j ?? {};
  } catch {
    /* no app.json */
  }
  for (const f of ['app.config.js', 'app.config.cjs']) {
    const p = resolve(projectRoot, f);
    if (!req || !existsSync(p)) continue;
    try {
      // Bust the cache: this process is long-lived (MCP server) and the user
      // edits app.config.js mid-session — a cached module would freeze the
      // hash at the first read and miss e.g. a newArchEnabled toggle.
      delete req.cache[req.resolve(p)];
      const mod = req(p) as unknown;
      const m = mod as { default?: unknown } | ((a: { config: unknown }) => unknown) | null;
      const cfg = typeof m === 'function' ? m({ config: host }) : (m?.default ?? m);
      const cfgExp =
        ((cfg as { expo?: Record<string, unknown> } | null)?.expo ??
          (cfg as Record<string, unknown> | null)) ||
        {};
      host = { ...host, ...cfgExp };
    } catch {
      /* unreadable dynamic config — skip */
    }
  }
  return host;
}

/** The exact predicate the generated app.config.js uses to strip the splash plugin. */
function isSplashPlugin(p: unknown): boolean {
  return (Array.isArray(p) ? p[0] : p) === 'expo-splash-screen';
}

/**
 * Does this host dep ship NATIVE code (i.e. does autolinking/prebuild compile
 * it into the binary)? Checked against the INSTALLED package dir — what the
 * binary would actually be built from. Signals, any of:
 *   - membership in the host's expo plugins (config plugins mutate the native
 *     project even when the package dir looks JS-only);
 *   - an ios/ or android/ dir, or a .podspec/.gradle file at the package root
 *     (CocoaPods / Gradle build inputs);
 *   - app.plugin.js (expo config plugin), expo-module.config.json (Expo
 *     Modules autolinking), react-native.config.js (RN CLI autolinking).
 * A dep that is NOT installed and not a plugin is treated as pure-JS: we
 * can't inspect it, and a build can't include it either — once the user
 * installs it the next readiness pass re-evaluates and flips the hash.
 */
function depShipsNativeCode(
  projectRoot: string,
  dep: string,
  expoPluginNames: ReadonlySet<string>,
): boolean {
  if (expoPluginNames.has(dep)) return true;
  const dir = resolve(projectRoot, 'node_modules', dep);
  if (!existsSync(dir)) return false;
  if (existsSync(resolve(dir, 'ios')) || existsSync(resolve(dir, 'android'))) return true;
  if (existsSync(resolve(dir, 'app.plugin.js'))) return true;
  if (existsSync(resolve(dir, 'expo-module.config.json'))) return true;
  if (existsSync(resolve(dir, 'react-native.config.js'))) return true;
  try {
    return readdirSync(dir).some((f) => f.endsWith('.podspec') || f.endsWith('.gradle'));
  } catch {
    return false;
  }
}

/**
 * The version the binary was/will be built against: the INSTALLED package's
 * version (node_modules/<dep>/package.json), falling back to the declared
 * range only when the install can't be read (e.g. a plugin dep that isn't
 * installed yet).
 */
function installedDepVersion(projectRoot: string, dep: string, declared: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(projectRoot, 'node_modules', dep, 'package.json'), 'utf-8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* not installed / unreadable */
  }
  return declared;
}

/** Compute the binary inputs (see {@link CompanionBuildInputs}) for buildHash + the marker. */
function computeBuildInputs(
  projectRoot: string,
  hostDeps: Record<string, string>,
  scheme: string,
): CompanionBuildInputs {
  const hostExpo = readHostExpoConfig(projectRoot);
  // Post-companion-override plugins: the splash strip mirrors appConfigJs, and
  // the JSON round-trip normalizes non-serializable plugin options (functions
  // → null) ONCE, so the live value always compares equal to the marker's
  // JSON-parsed copy instead of spuriously reading "options changed".
  const rawPlugins = Array.isArray(hostExpo.plugins) ? hostExpo.plugins : [];
  let plugins: unknown[] = [];
  try {
    plugins = JSON.parse(JSON.stringify(rawPlugins.filter((p) => !isSplashPlugin(p)))) as unknown[];
  } catch {
    plugins = [];
  }
  const pluginNames = new Set(
    plugins
      .map((p) => (Array.isArray(p) ? p[0] : p))
      .filter((n): n is string => typeof n === 'string'),
  );
  const nativeDeps: Record<string, string> = {};
  for (const [name, declared] of Object.entries(hostDeps).sort(([a], [b]) => a.localeCompare(b))) {
    if (depShipsNativeCode(projectRoot, name, pluginNames)) {
      nativeDeps[name] = installedDepVersion(projectRoot, name, declared);
    }
  }
  return {
    nativeDeps,
    expoConfig: {
      plugins,
      newArchEnabled:
        typeof hostExpo.newArchEnabled === 'boolean' ? hostExpo.newArchEnabled : undefined,
      jsEngine: typeof hostExpo.jsEngine === 'string' ? hostExpo.jsEngine : undefined,
    },
    scheme,
  };
}

/**
 * Human-readable diff between the build inputs a stale install was built with
 * and the current ones — what lets the readiness checklist say WHICH input
 * flipped ("native deps changed: expo-router 3.4.0→4.0.0") instead of a
 * generic "rebuild". Returns [] when nothing visibly differs (then the caller
 * falls back to its generic message).
 */
export function describeBuildInputDiff(
  previous: CompanionBuildInputs,
  current: CompanionBuildInputs,
): string[] {
  const parts: string[] = [];

  const depParts: string[] = [];
  const names = new Set([...Object.keys(previous.nativeDeps), ...Object.keys(current.nativeDeps)]);
  for (const name of [...names].sort()) {
    const prev = previous.nativeDeps[name];
    const cur = current.nativeDeps[name];
    if (prev === cur) continue;
    if (prev === undefined) depParts.push(`${name}@${cur} added`);
    else if (cur === undefined) depParts.push(`${name} removed`);
    else depParts.push(`${name} ${prev}→${cur}`);
  }
  if (depParts.length) parts.push(`native deps changed: ${depParts.join(', ')}`);

  const cfgParts: string[] = [];
  const pc = previous.expoConfig;
  const cc = current.expoConfig;
  if ((pc.newArchEnabled ?? null) !== (cc.newArchEnabled ?? null)) {
    cfgParts.push(`newArchEnabled ${pc.newArchEnabled ?? 'unset'}→${cc.newArchEnabled ?? 'unset'}`);
  }
  if ((pc.jsEngine ?? null) !== (cc.jsEngine ?? null)) {
    cfgParts.push(`jsEngine ${pc.jsEngine ?? 'default'}→${cc.jsEngine ?? 'default'}`);
  }
  // Plugins: compare by name (added/removed), then by serialized entry
  // (options changed), then by order — order matters to prebuild, so a pure
  // reorder still flips the hash and must still be nameable.
  const pluginName = (p: unknown): string => String(Array.isArray(p) ? p[0] : p);
  const serialize = (p: unknown): string => {
    try {
      return JSON.stringify(p) ?? 'undefined';
    } catch {
      return 'unserializable';
    }
  };
  const prevByName = new Map(pc.plugins.map((p) => [pluginName(p), serialize(p)] as const));
  const curByName = new Map(cc.plugins.map((p) => [pluginName(p), serialize(p)] as const));
  for (const [name, body] of curByName) {
    if (!prevByName.has(name)) cfgParts.push(`plugin ${name} added`);
    else if (prevByName.get(name) !== body) cfgParts.push(`plugin ${name} options changed`);
  }
  for (const name of prevByName.keys()) {
    if (!curByName.has(name)) cfgParts.push(`plugin ${name} removed`);
  }
  if (
    cfgParts.every((p) => !p.startsWith('plugin ')) &&
    pc.plugins.map(pluginName).join(',') !== cc.plugins.map(pluginName).join(',')
  ) {
    cfgParts.push('plugin order changed');
  }
  if (cfgParts.length) parts.push(`expo config changed: ${cfgParts.join(', ')}`);

  // Companion URL scheme: an edited native.scheme override (or a bundle-id
  // change flipping the derived default) means the installed binary still
  // registers the OLD scheme — deep links miss until a rebuild. Markers
  // predating the field read as the legacy 'validity' default era; those are
  // also revision-outdated, so the revision message normally owns them.
  if ((previous.scheme ?? null) !== (current.scheme ?? null)) {
    parts.push(
      `companion URL scheme changed: ${previous.scheme ?? '(legacy default)'}→${current.scheme ?? '(unset)'}`,
    );
  }

  return parts;
}

/**
 * app.config.js — INHERITS the host app's Expo config (plugins, newArchEnabled,
 * jsEngine, build properties, expo-build-properties, etc.) so the companion's
 * native build matches the host's. Two override groups:
 *   - IDENTITY (name/scheme/bundle id), so it installs side-by-side. Generating
 *     a bare config instead is what caused the RN-0.83 core-init crash
 *     (missing newArch/plugin settings).
 *   - NO SPLASH SCREEN: exactly `expo-splash-screen` is stripped from the
 *     inherited plugins and `splash`/`ios.splash`/`android.splash` are nulled
 *     out. expo-splash-screen re-presents the native launch screen on every
 *     reload (`didReceiveReloadCommand`), and a mid-session re-present can't be
 *     dismissed from JS — the bug that forced the whole terminate+cold-launch
 *     workaround ladder. With the plugin/config gone the companion binary
 *     cannot re-present a launch screen, which is what makes the bridge's
 *     in-place `reload` a safe, cheap refresh. The host app's own config is
 *     untouched; only the companion loses its splash (it's a playground — a
 *     blank instant launch is correct).
 * Falls back to a minimal config if the host config can't be read.
 */
function appConfigJs(appName: string, scheme: string, bundleId: string): string {
  return `// @validity-generated — inherits the host app's Expo config, overriding
// only identity so the "Validity" app installs beside the real app.
const path = require('path');

function loadHostExpoConfig() {
  const userRoot = path.resolve(__dirname, '..', '..');

  // PRIMARY: Expo's own resolver evaluates the FULL host config — app.json +
  // app.config.js + app.config.TS + the static/dynamic merge + plugins. It's a
  // transitive dep of \`expo\`, so it resolves from the user's project. This is
  // the only path that handles app.config.ts (require() can't load raw TS) and
  // a host with BOTH app.json and a dynamic config layering on top.
  try {
    const { getConfig } = require('@expo/config');
    const { exp } = getConfig(userRoot, { skipSDKVersionRequirement: true });
    if (exp) return exp;
  } catch (e) {}

  // FALLBACK (no @expo/config): layer app.json THEN app.config.js/cjs by
  // MERGING (never early-returning), so a dynamic config that adds plugins /
  // newArchEnabled on top of a static app.json isn't dropped. Raw app.config.ts
  // still can't be read here — that's what the primary path is for.
  let host = {};
  try {
    const j = require(path.join(userRoot, 'app.json'));
    host = (j && j.expo) || j || {};
  } catch (e) {}
  for (const f of ['app.config.js', 'app.config.cjs']) {
    try {
      const mod = require(path.join(userRoot, f));
      const cfg = typeof mod === 'function' ? mod({ config: host }) : mod && (mod.default || mod);
      const cfgExp = (cfg && cfg.expo) || cfg || {};
      host = { ...host, ...cfgExp };
    } catch (e) {}
  }
  return host;
}

const host = loadHostExpoConfig();

module.exports = () => ({
  // Inherit everything (plugins, newArchEnabled, jsEngine, extra, …)…
  ...host,
  // …then override identity so it's a distinct, side-by-side app.
  name: ${JSON.stringify(appName)},
  slug: 'validity-playground',
  scheme: ${JSON.stringify(scheme)},
  // NO SPLASH SCREEN: strip exactly expo-splash-screen from the inherited
  // plugins (string or [name, options] entries) and null every splash config,
  // so the companion binary cannot re-present a launch screen on reload —
  // the bridge's in-place reload depends on this. The host app keeps its own.
  plugins: (host.plugins || []).filter(
    (p) => (Array.isArray(p) ? p[0] : p) !== 'expo-splash-screen',
  ),
  splash: undefined,
  // The separate companion does not need host branding. Relative icon paths
  // resolve under this app, where the host's assets directory does not exist.
  icon: undefined,
  ios: { ...(host.ios || {}), bundleIdentifier: ${JSON.stringify(bundleId)}, splash: undefined, icon: undefined },
  android: { ...(host.android || {}), package: ${JSON.stringify(bundleId)}, splash: undefined, icon: undefined, adaptiveIcon: undefined },
});
`;
}

/** A host path alias (from tsconfig `paths`) the companion must replicate. */
interface HostAlias {
  /** Import prefix, e.g. `@/` or `@assets/`. */
  prefix: string;
  /** Target dir relative to the user project root, e.g. `app` or `assets`. */
  rel: string;
}

/**
 * metro.config.js — the load-bearing file. Shares the user's node_modules so
 * react/react-native are singletons and autolinking sees the user's native
 * modules, AND replicates the host's tsconfig path aliases (`@/`, `@assets/`,
 * …) so the user's components — which import via those aliases — actually
 * resolve. `<appDir>` is `<projectRoot>/.validity/native-app`, so the user
 * root is two levels up.
 */
/**
 * Packages that MUST resolve to the host's single copy in the companion bundle.
 * A second copy of any of these is a hard runtime crash, not just bloat:
 *   - react / react-native / expo: "Invalid hook call" / two renderers.
 *   - react-native-safe-area-context: duplicate SafeAreaProvider context.
 *   - react-native-gesture-handler: RNGH registers native view components
 *     (RNGestureHandlerButton, …) into a MODULE-LEVEL registry on import; a second
 *     copy double-registers and leaves GestureHandlerRootView undefined (redbox).
 *   - react-native-reanimated: a second copy fails worklet/native-proxy init.
 * The GH/reanimated entries are added only when the host actually has them (so we
 * never remap a package the host lacks to a non-existent path).
 */
const BASE_SINGLETONS = [
  'react',
  'react-dom',
  'react-native',
  'expo',
  'react-native-safe-area-context',
];

/**
 * expo-router's global store singleton — the package-INTERNAL path the
 * generated metro.config matches (by resolved file path) to swap the real
 * store for the isolation mock. Version-coupled: if an expo-router release
 * moves/renames it, the redirect silently stops matching and screens crash on
 * the real store's null navigationRef. Exported so the readiness preflight
 * ({@link checkPackageInternalPaths} in native-readiness.ts) verifies it
 * against the HOST's installed expo-router at prepare time instead of letting
 * that degradation surface as an unexplained runtime crash.
 */
export const EXPO_ROUTER_STORE_SPECIFIER = 'expo-router/build/global-state/router-store.js';

function metroConfig(
  aliases: HostAlias[],
  opts: { expoRouterStoreMock?: boolean; extraSingletons?: string[] } = {},
): string {
  // For expo-router apps, swap the router's global store singleton for the
  // generated mock so screens render in isolation. Matched by RESOLVED file path
  // (expo-router require()s the store via relative paths internally), normalized
  // for separator so it works on macOS/Linux sim hosts. Emitted only when
  // expo-router is detected — a non-expo-router bundle never sees this branch.
  // The matched path is EXPO_ROUTER_STORE_SPECIFIER (interpolated, so the
  // readiness preflight that resolution-checks it can never drift from what the
  // generated config actually matches).
  const storeRedirect = opts.expoRouterStoreMock
    ? `  // 3. Validity: redirect expo-router's global store to the isolation mock.
  const validityRes = resolver(context, moduleName, platform);
  const validityFp =
    validityRes && validityRes.filePath ? String(validityRes.filePath).replace(/\\\\/g, '/') : '';
  if (
    validityRes &&
    validityRes.type === 'sourceFile' &&
    validityFp.endsWith('${EXPO_ROUTER_STORE_SPECIFIER}')
  ) {
    return resolver(context, path.resolve(appRoot, 'validity-expo-router-store-mock.js'), platform);
  }
  return validityRes;`
    : `  return resolver(context, moduleName, platform);`;
  // Dedupe so a host that listed a base singleton in extras doesn't repeat it.
  const singletons = Array.from(new Set([...BASE_SINGLETONS, ...(opts.extraSingletons ?? [])]));
  return metroConfigSource(aliases, storeRedirect, singletons);
}

function metroConfigSource(
  aliases: HostAlias[],
  storeRedirect: string,
  singletons: string[],
): string {
  return `// @validity-generated — companion-app Metro config.
// Shares the user's project deps so react/react-native stay singletons (no
// duplicate-React hook crash) and Expo autolinking sees the user's native
// modules, and replicates the host's tsconfig path aliases. Edit with care.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const appRoot = __dirname;
const userRoot = path.resolve(appRoot, '..', '..'); // .validity/native-app -> project root

const config = getDefaultConfig(appRoot);
// ponytail: node watcher; Watchman if Metro needs the speed and the socket stays up.
config.resolver.useWatchman = false;

// Watch the user's source so editing a component hot-reloads in the playground.
config.watchFolders = [userRoot];

// Keep Validity's OWN capture artifacts out of the file watcher. The screenshot
// dir (\`<appDir>/shots\`) and the Metro log (\`<appDir>/validity-native.log\`)
// live UNDER appDir, which is inside the watched userRoot — so every capture
// (a fresh .png) and every Metro log append used to fire a watcher event and
// churn the dev server right before we screenshot it. metro-file-map applies
// blockList to the crawl AND the watch, so excluding them here stops the churn
// without relocating the files (the MCP/CLI still read them from appDir). The
// pattern is anchored to THIS appRoot so it can't exclude an unrelated user
// file that happens to share the name.
// POSIX separators only — the companion runs on macOS/Linux sim hosts (iOS
// simctl / Android adb), never Windows, so appRoot is always a /-path.
const validityEscapeRe = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
const validityArtifactRe = new RegExp(
  '^' + validityEscapeRe(appRoot) + '/(shots(/|$)|validity-native\\\\.log$)',
);
const validityPriorBlockList = config.resolver.blockList;
config.resolver.blockList = Array.isArray(validityPriorBlockList)
  ? [...validityPriorBlockList, validityArtifactRe]
  : validityPriorBlockList
    ? [validityPriorBlockList, validityArtifactRe]
    : validityArtifactRe;

// Resolve modules from the user's node_modules (the app declares none of its own).
config.resolver.nodeModulesPaths = [
  path.resolve(appRoot, 'node_modules'),
  path.resolve(userRoot, 'node_modules'),
];

// Replicate the HOST metro.config's resolution-affecting settings so the
// companion resolves third-party packages EXACTLY like the real app. Without
// this, packages with conditional "exports" maps resolve to a different build
// in the companion than in the host — most notably axios (pulled in by Ignite's
// apisauce API layer): the host forces \`unstable_conditionNames\` so Metro picks
// axios' CommonJS build, but the companion's default config picks the browser/
// ESM build, which references \`FormData\` at MODULE SCOPE and crashes Hermes on
// load with "[runtime not ready]: Property 'FormData' doesn't exist". The user
// encodes that fix in their own metro.config (conditionNames / sourceExts); we
// mirror the relevant resolver+transformer knobs here. Guarded: a missing or
// throwing host config degrades to the companion's default resolution.
try {
  const hostConfigPath = ['metro.config.js', 'metro.config.cjs']
    .map((f) => path.resolve(userRoot, f))
    .find((p) => { try { require.resolve(p); return true; } catch (_) { return false; } });
  if (hostConfigPath) {
    const host = require(hostConfigPath);
    const hostCfg = (host && host.default) || host;
    const hr = (hostCfg && hostCfg.resolver) || {};
    if (hr.unstable_conditionNames) config.resolver.unstable_conditionNames = hr.unstable_conditionNames;
    if (typeof hr.unstable_enablePackageExports === 'boolean') {
      config.resolver.unstable_enablePackageExports = hr.unstable_enablePackageExports;
    }
    if (hr.resolverMainFields) config.resolver.resolverMainFields = hr.resolverMainFields;
    if (Array.isArray(hr.sourceExts)) {
      config.resolver.sourceExts = Array.from(new Set([...(config.resolver.sourceExts || []), ...hr.sourceExts]));
    }
    if (Array.isArray(hr.assetExts)) {
      config.resolver.assetExts = Array.from(new Set([...(config.resolver.assetExts || []), ...hr.assetExts]));
    }
    const ht = (hostCfg && hostCfg.transformer) || {};
    if (typeof ht.getTransformOptions === 'function') config.transformer.getTransformOptions = ht.getTransformOptions;
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[validity] could not replicate host metro.config resolver settings:', (e && e.message) || e);
}

// Force ONE copy of these libs — a second react/react-native is the classic
// "Invalid hook call" / "two renderers" failure in a shared-deps setup; a second
// react-native-gesture-handler double-registers its native view components and
// leaves GestureHandlerRootView undefined; a second reanimated fails worklet init.
// Map ONLY these (a catch-all here would swallow path aliases like '@/'). The list
// is computed host-side so GH/reanimated are pinned only when the host has them.
const SINGLETONS = ${JSON.stringify(singletons)};
config.resolver.extraNodeModules = Object.fromEntries(
  SINGLETONS.map((name) => [name, path.resolve(userRoot, 'node_modules', name)]),
);

// Replicate the host's tsconfig path aliases (e.g. '@/' -> the host's app dir)
// so components imported into the playground resolve their own imports.
const VALIDITY_ALIASES = ${JSON.stringify(aliases)};
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolver = defaultResolveRequest || context.resolveRequest;
  // 1. Pin the core libs to the host's ONE copy. extraNodeModules is only a
  //    fallback, so the companion's own node_modules copy would otherwise win
  //    for some requires → two react-natives → InitializeCore runs twice →
  //    RN 0.83 "property is not writable" core-init crash. This is authoritative.
  for (const s of SINGLETONS) {
    if (moduleName === s || moduleName.startsWith(s + '/')) {
      return resolver(context, path.resolve(userRoot, 'node_modules', moduleName), platform);
    }
  }
  // 2. Replicate the host's tsconfig path aliases.
  for (const a of VALIDITY_ALIASES) {
    if (moduleName === a.prefix.replace(/\\/$/, '') || moduleName.startsWith(a.prefix)) {
      const sub = moduleName.slice(a.prefix.length);
      return resolver(context, path.resolve(userRoot, a.rel, sub), platform);
    }
  }
${storeRedirect}
};

module.exports = config;
`;
}

/**
 * Tolerant JSONC parse for tsconfig — strips line + block comments and trailing
 * commas. A character scanner (NOT a regex) so comment-open / comment-close
 * sequences and `//` *inside string values* are left intact: tsconfig path
 * globs (e.g. an `"@/*"` alias) and include globs (e.g. a recursive
 * double-star `.ts` glob) contain those sequences, and a naive regex stripper
 * eats from the first glob's `/*` to the next glob's comment-close, corrupting
 * the JSON so every `paths` alias silently disappears.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        // Preserve the escaped character verbatim.
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(text: string): unknown {
  const noComments = stripJsonComments(text);
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(noTrailingCommas);
}

/**
 * Read the host's tsconfig `paths` and translate them into companion aliases.
 * `"@/*": ["./app/*"]` (baseUrl `.`) → `{ prefix: '@/', rel: 'app' }`. Targets
 * are made relative to the user project root so the generated metro config can
 * resolve them against `userRoot` at runtime (portable — no absolute paths
 * baked in).
 */
export function readHostAliases(projectRoot: string): HostAlias[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = resolve(projectRoot, name);
    if (!existsSync(p)) continue;
    try {
      const cfg = parseJsonc(readFileSync(p, 'utf-8')) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = cfg.compilerOptions ?? {};
      const paths = co.paths ?? {};
      const baseUrl = co.baseUrl ?? '.';
      const out: HostAlias[] = [];
      for (const [key, targets] of Object.entries(paths)) {
        const target = targets[0];
        if (!target) continue;
        const prefix = key.replace(/\*$/, ''); // '@/*' -> '@/'
        const targetBase = target.replace(/\*$/, ''); // './app/*' -> './app/'
        // Dir relative to the user root (baseUrl is relative to the tsconfig).
        const absDir = resolve(projectRoot, baseUrl, targetBase);
        let rel = relative(projectRoot, absDir).replaceAll('\\', '/');
        if (rel === '') rel = '.';
        if (prefix) out.push({ prefix, rel });
      }
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * babel.config.js — reuse the host's config (so required plugins like
 * `react-native-reanimated/plugin` and module-resolver match; a missing
 * reanimated plugin is its own crash), THEN layer on the transforms the
 * companion's own injected deps need.
 *
 * Specifically: the mock-network module statically `require('msw/native')`, so
 * Metro bundles `@mswjs/interceptors` — whose `.mjs` uses STATIC CLASS BLOCKS.
 * `babel-preset-expo` doesn't enable that transform for node_modules, so
 * without the plugin Metro fails the WHOLE bundle ("Static class blocks are not
 * enabled") — not just mocking, the entire app. We append
 * `@babel/plugin-transform-class-static-block`, resolved from the HOST's
 * node_modules (the companion declares no deps of its own) and skipped if it
 * isn't installed, so this never makes things worse.
 */
function babelConfig(hostBabelRel: string | null): string {
  const hostExpr = hostBabelRel
    ? `require(${JSON.stringify(hostBabelRel)})`
    : `function (api) { api.cache(true); return { presets: ['babel-preset-expo'] }; }`;
  return `// @validity-generated — host babel config + the transforms the
// companion's injected deps (msw/native) need. Edit your config upstream.
const path = require('path');
const userRoot = path.resolve(__dirname, '..', '..');
const host = ${hostExpr};

function resolveFromHost(name) {
  try {
    return require.resolve(name, { paths: [userRoot] });
  } catch (e) {
    return null;
  }
}

module.exports = function (api) {
  const cfg = typeof host === 'function' ? host(api) : host;
  // @mswjs/interceptors (.mjs) ships static class blocks Metro must transform.
  const staticBlock = resolveFromHost('@babel/plugin-transform-class-static-block');
  const extraPlugins = staticBlock ? [staticBlock] : [];
  return { ...cfg, plugins: [...(cfg.plugins || []), ...extraPlugins] };
};
`;
}

/** Path (relative to the companion dir) of the host's babel config, if any. */
function hostBabelConfigRel(projectRoot: string): string | null {
  for (const name of ['babel.config.js', 'babel.config.cjs']) {
    if (existsSync(resolve(projectRoot, name))) return `../../${name}`;
  }
  return null;
}

/**
 * package.json that MIRRORS the host's dependencies. This is load-bearing:
 * Expo autolinking compiles the native modules listed in the app's OWN
 * package.json — sharing the host's node_modules via Metro only resolves the
 * JS, NOT the native side. Without the host's deps here, the binary ships
 * without gesture-handler/reanimated/screens/etc. and the app redboxes with
 * "RNGestureHandlerModule could not be found". `main` is the generated entry.
 */
function appPackageJson(
  hostDeps: Record<string, string>,
  projectRoot: string,
  appDir: string,
): string {
  const pnpm = detectPackageManager(projectRoot) === 'pnpm';
  const dependencies = Object.fromEntries(
    Object.entries(hostDeps).map(([name, specifier]) => {
      // Rebase host-relative file: and link: paths so they resolve from the companion appDir.
      if (specifier.startsWith('file:') || specifier.startsWith('link:')) {
        const prefix = specifier.startsWith('file:') ? 'file:' : 'link:';
        const p = specifier.slice(prefix.length);
        // Absolute and home-relative paths don't depend on the manifest's directory.
        if (!isAbsolute(p) && !p.startsWith('~')) {
          const abs = resolve(projectRoot, p);
          let rel = relative(appDir, abs).replaceAll('\\', '/');
          if (!rel.startsWith('.')) rel = './' + rel;
          return [name, `${prefix}${rel}`];
        }
        return [name, specifier];
      }
      if (!pnpm || !/^(workspace|catalog):/.test(specifier)) return [name, specifier];
      // The companion has its own pnpm workspace. Reuse the host's resolved copy
      // (including named catalogs/aliases), rather than guessing a registry version.
      const installed = resolve(projectRoot, 'node_modules', name);
      if (!existsSync(installed)) {
        throw new Error(
          `Install the host project's dependencies first: ${name} (${specifier}) is not installed.`,
        );
      }
      return [name, `link:${relative(appDir, installed).replaceAll('\\', '/')}`];
    }),
  );
  return (
    JSON.stringify(
      {
        name: 'validity-native-app',
        version: '0.0.0',
        private: true,
        main: 'native-entry.tsx',
        dependencies,
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * The companion's default URL scheme: `validity-<bundleId-slug>` — UNIQUE to
 * the companion by construction. The default must never be a scheme another
 * installed app can plausibly register: the user's own dev build is usually a
 * dev-client too, and when both apps own one scheme, iOS resolves
 * `scheme://…` nondeterministically — the deep link "succeeds" (exit 0) into
 * the USER'S app, which has no validity route, and the flow screenshots the
 * wrong app. (The old guidance even steered users into that collision by
 * recommending `native.scheme` match app.json.) Slugged from the companion
 * bundle id so a non-default `bundleId` keeps the derived scheme distinct too.
 */
export function defaultCompanionScheme(bundleId: string): string {
  const slug = bundleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `validity-${slug}` : 'validity-playground';
}

/**
 * The companion's binary IDENTITY — everything the readiness gate and device
 * pinning need to reason about an install WITHOUT regenerating a single file:
 * the app dir, scheme, bundle id, the {@link CompanionBuildInputs}, the
 * buildHash they hash to, and the marker path that records the install's last
 * build. Deliberately a PURE READ (package.json + node_modules + @expo/config)
 * with NO writes, so an agent can cheaply ask "is native ready?" — see
 * {@link companionBuildIdentity}.
 */
export interface CompanionBuildIdentity {
  appDir: string;
  appName: string;
  bundleId: string;
  scheme: string;
  buildInputs: CompanionBuildInputs;
  buildHash: string;
  buildMarkerPath: string;
  metroContentMarkerPath: string;
}

/**
 * Compute the companion's build identity ({@link CompanionBuildIdentity})
 * WITHOUT generating the app. {@link prepareNativeApp} regenerates the whole
 * app shell (registry, mocks, metro/babel/app config) as a side effect — far
 * too expensive (and file-touching) for a readiness preflight, which only needs
 * the scheme/bundle id/buildHash to pin a device and diff the install marker.
 * This is the cheap, side-effect-free half, single-sourced so the buildHash it
 * returns is byte-identical to the one {@link prepareNativeApp} bakes in.
 */
export function companionBuildIdentity(
  opts: Pick<
    PrepareNativeAppOptions,
    'projectRoot' | 'config' | 'appDir' | 'appName' | 'scheme' | 'bundleId' | 'platform'
  >,
): CompanionBuildIdentity {
  const { projectRoot } = opts;
  const appDir = opts.appDir ?? resolve(projectRoot, '.validity', 'native-app');
  const appName = opts.appName ?? 'Validity';
  const bundleId = opts.bundleId ?? 'ai.validity.playground';
  // An explicit scheme (call arg, then config.native.scheme) is a deliberate
  // override; the DEFAULT is always companion-unique (see defaultCompanionScheme
  // — never the host's scheme, never the old shared 'validity').
  const scheme = opts.scheme ?? opts.config?.native?.scheme ?? defaultCompanionScheme(bundleId);

  const hostDeps = readHostDependencies(projectRoot);
  const buildInputs = computeBuildInputs(projectRoot, hostDeps, scheme);
  const buildHash = createHash('sha256')
    .update(
      JSON.stringify({
        rev: COMPANION_BUILD_REVISION,
        deps: Object.keys(buildInputs.nativeDeps)
          .sort()
          .map((n) => `${n}@${buildInputs.nativeDeps[n]}`),
        expo: buildInputs.expoConfig,
        scheme: buildInputs.scheme,
      }),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    appDir,
    appName,
    bundleId,
    scheme,
    buildInputs,
    buildHash,
    buildMarkerPath: resolve(
      appDir,
      `.validity-build.${opts.platform ?? (opts.config?.native?.target === 'android' ? 'android' : 'ios')}`,
    ),
    metroContentMarkerPath: resolve(appDir, '.validity-metro-content'),
  };
}

/**
 * Generate the companion Validity app. Reuses {@link prepareNative} to write
 * the harness + registry + mocks into the app dir, then adds the Expo
 * app-shell files around them.
 */
export function prepareNativeApp(opts: PrepareNativeAppOptions): PrepareNativeAppResult {
  const { projectRoot } = opts;
  // The cheap, write-free identity (app dir + scheme + buildHash + inputs) is
  // single-sourced through companionBuildIdentity so the readiness preflight and
  // this full regeneration can never disagree on the buildHash.
  const identity = companionBuildIdentity(opts);
  const { appDir, appName, bundleId, scheme } = identity;

  ensureDir(appDir);

  // Harness + registry + mocks + templates land in appDir; the registry's
  // component imports are computed relative to appDir, so they reach back into
  // the user's source (../../src/...).
  const prepared = prepareNative({
    projectRoot,
    config: opts.config,
    outDir: appDir,
    maxComponents: opts.maxComponents,
    // Bake the control-bridge URL into native-entry so the companion connects
    // back on mount and the host can re-target the active view in-place. It's a
    // fixed JS constant (not part of buildHash — see prepare-native.ts),
    // so wiring it changes only the bundle Metro serves,
    // never forcing a native rebuild. The bridge is optional at runtime: if no
    // host is listening, the template's WS effect degrades to deep-link open.
    bridgeUrl: COMPANION_BRIDGE_URL,
  });

  const hostDeps = readHostDependencies(projectRoot);
  const appFiles: string[] = [];
  // Accumulate the app-shell bodies (alongside prepared.contentHash) so the
  // companion's contentHash also flips when metro/babel/app config or the
  // mirrored-dep set changes — all of which affect the bundle Metro serves.
  const appShellParts: Record<string, string> = {};
  const write = (name: string, body: string) => {
    appShellParts[name] = body;
    const p = resolve(appDir, name);
    // Write only when changed — prepareNativeApp runs on every native_browse
    // call; rewriting identical config would make Metro log "config changed —
    // restart the server" mid-session.
    try {
      if (!existsSync(p) || readFileSync(p, 'utf-8') !== body) writeFileSync(p, body);
    } catch {
      writeFileSync(p, body);
    }
    appFiles.push(p);
  };
  // app.config.js (inherits host) — NOT app.json, so we don't fight a host
  // that also has app.json, and so plugins/newArch/jsEngine carry over.
  write('app.config.js', appConfigJs(appName, scheme, bundleId));
  // Pin native libs that crash when double-bundled to the host's one copy — but
  // ONLY when the host actually has them (else we'd remap to a missing path).
  const extraSingletons: string[] = [];
  if (prepared.detection.hasGestureHandler) extraSingletons.push('react-native-gesture-handler');
  if (prepared.detection.hasReanimated) extraSingletons.push('react-native-reanimated');
  // React Navigation's context objects (NavigationContext, NavigationRouteContext,
  // …) are created in @react-navigation/core and re-exported by
  // @react-navigation/native. The generated nav mock (validity-native-nav) imports
  // them from .validity/native-app/node_modules while the user's screens + wrapper
  // import them from the host's node_modules — TWO different copies → two distinct
  // context objects, so the screen reads the user wrapper's mock instead of
  // NavContexts' innermost provider (→ "navigation.setOptions is not a function").
  // Pin both to the host's one copy so the contexts are identical and the mock that
  // mounts the full navigation (with setOptions) wins. Only when a router is
  // detected AND the package resolves at the host (else we'd remap to a missing path).
  if (prepared.detection.router !== 'none') {
    for (const navPkg of ['@react-navigation/native', '@react-navigation/core']) {
      if (existsSync(resolve(projectRoot, 'node_modules', navPkg))) extraSingletons.push(navPkg);
    }
  }
  write(
    'metro.config.js',
    metroConfig(readHostAliases(projectRoot), {
      expoRouterStoreMock: prepared.detection.router === 'expo-router',
      extraSingletons,
    }),
  );
  write('babel.config.js', babelConfig(hostBabelConfigRel(projectRoot)));
  write('package.json', appPackageJson(hostDeps, projectRoot, appDir));

  const pm = detectPackageManager(projectRoot);
  if (pm === 'pnpm') {
    // Isolate the install from any host workspace. Seed a narrow script policy
    // for pnpm 11's strict build approval; preserve subsequent user approvals.
    const policyPath = resolve(appDir, 'pnpm-workspace.yaml');
    if (!existsSync(policyPath)) {
      writeFileSync(
        policyPath,
        '# Companion-only policy. Review other scripts with pnpm approve-builds here.\n' +
          "packages:\n  - '.'\nallowBuilds:\n  esbuild: true\n  msw: false\n",
      );
    }
    appFiles.push(policyPath);
  }
  const buildSteps = (
    platform: 'ios' | 'android',
    stepsOpts: { nativeProjectExists?: boolean } = {},
  ): NativeBuildStep[] => {
    const ci = { CI: '1' };
    // First build (no native dir yet) → `--clean` regenerates from scratch so a
    // stale ios/ from a half-run can't bake the wrong bundle id. A rebuild on an
    // existing native project → plain (incremental) `expo prebuild`, which is
    // Expo's idempotent default and skips the from-scratch wipe (the slow part).
    const nativeDir = resolve(appDir, platform);
    const projectExists = stepsOpts.nativeProjectExists ?? existsSync(nativeDir);
    const prebuildArgs = ['expo', 'prebuild', '--platform', platform, '--no-install'];
    if (!projectExists) prebuildArgs.splice(2, 0, '--clean');
    const steps: NativeBuildStep[] = [
      // Install the mirrored deps so autolinking + prebuild can see them.
      {
        label: `${pm} install`,
        bin: pm,
        // This generated manifest tracks host edits; its lock is not a frozen CI input.
        args: pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'],
        cwd: appDir,
        ...(pm === 'pnpm' ? { env: ci } : {}),
      },
      // Regenerate the native project. --no-install: we do pods explicitly below
      // so the step is non-interactive.
      {
        label: projectExists ? 'expo prebuild' : 'expo prebuild --clean',
        bin: 'npx',
        args: prebuildArgs,
        cwd: appDir,
        env: ci,
      },
    ];
    if (platform === 'ios') {
      steps.push({ label: 'pod install', bin: 'npx', args: ['pod-install'], cwd: appDir, env: ci });
    }
    steps.push({
      // Expo rejects --port with --no-bundler. The separately managed Metro
      // and the driver's control deep link select the companion's port.
      label: `expo run:${platform}`,
      bin: 'npx',
      args: ['expo', `run:${platform}`, '--no-install', '--no-bundler'],
      cwd: appDir,
      // --no-bundler otherwise launches against Expo's default 8081. Its URL
      // override keeps the companion off the user's app server on that port.
      env: {
        ...METRO_SERVE_ENV,
        EXPO_PACKAGER_PROXY_URL: `http://localhost:${COMPANION_METRO_PORT}`,
      },
      // Finish build/install before recording success. Metro is managed separately;
      // an old installed app + running Metro cannot prove this build succeeded.
    });
    return steps;
  };

  // What must be COMPILED in — and ONLY that (see CompanionBuildInputs):
  //   - native-shipping deps as name@version pairs (autolinking compiles
  //     exactly those; a version bump means a different binary),
  //   - the resolved host expo config fields prebuild consumes (plugins
  //     post-splash-strip, newArchEnabled, jsEngine),
  //   - the generated app-shell revision (rev: see COMPANION_BUILD_REVISION —
  //     a binary-affecting change to the generated config, like the splash
  //     strip, must flip this hash or every install keeps a stale binary),
  //   - the companion's URL scheme (compiled into the binary's URL-scheme
  //     registration — an edited override leaves the installed binary
  //     answering the OLD scheme until rebuilt).
  // Deliberately ABSENT: the component/view structure (the registry is plain
  // JS, delivered via contentHash → Metro) and pure-JS dep names — neither
  // changes the binary, and hashing them used to prompt a minutes-long
  // rebuild for adding a component file or a lodash.
  // (Computed once in companionBuildIdentity above so the readiness preflight
  // and this regeneration can't drift on the buildHash.)
  const { buildInputs, buildHash, buildMarkerPath, metroContentMarkerPath } = identity;

  // contentHash = the prepared bodies' hash + the app-shell bodies. Flips on any
  // change to the served bundle (a fixed polyfills/mocks body, a new view's
  // registry entry, an edited metro/babel/app config). The companion-Metro
  // helper restarts Metro with --clear when it differs from the last-served
  // marker — see ensureCompanionMetro / .validity-metro-content.
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        prepared: prepared.contentHash,
        shell: Object.keys(appShellParts)
          .sort()
          .map((k) => [k, appShellParts[k]]),
      }),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    appDir,
    appName,
    scheme,
    bundleId,
    prepared,
    appFiles,
    buildSteps,
    buildHash,
    buildInputs,
    contentHash,
    buildMarkerPath,
    metroContentMarkerPath,
    mirroredDepCount: Object.keys(hostDeps).length,
    requiredDevDeps: [
      'msw',
      'react-native-url-polyfill',
      'fast-text-encoding',
      '@react-native-async-storage/async-storage',
    ],
  };
}

/** Parsed contents of the `.validity-build` marker. */
export interface CompanionBuildMarker {
  /** The buildHash the installed companion was last built for. */
  hash: string;
  /**
   * The COMPANION_BUILD_REVISION the marker was written at. Legacy plain-hash
   * markers (written before the field existed) parse as revision 1 — that's
   * what lets the readiness checklist say "companion config changed" (the
   * splash strip) instead of the generic STALE message for every pre-splashless
   * install.
   */
  revision: number;
  /**
   * The {@link CompanionBuildInputs} the install was built with — what
   * {@link describeBuildInputDiff} compares against the current inputs to
   * name WHICH input flipped. Absent on markers written by older Validity
   * (or hand-tampered files): those get one generic-reason rebuild, after
   * which the rewritten marker carries inputs.
   */
  inputs?: CompanionBuildInputs;
}

/** Lenient shape-check for marker inputs — a tampered/partial field reads as absent, never throws. */
function parseMarkerInputs(v: unknown): CompanionBuildInputs | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { nativeDeps?: unknown; expoConfig?: unknown; scheme?: unknown };
  if (typeof o.nativeDeps !== 'object' || o.nativeDeps === null) return undefined;
  if (Object.values(o.nativeDeps).some((x) => typeof x !== 'string')) return undefined;
  if (typeof o.expoConfig !== 'object' || o.expoConfig === null) return undefined;
  if (!Array.isArray((o.expoConfig as { plugins?: unknown }).plugins)) return undefined;
  // `scheme` is optional (pre-rev-3 markers lack it); a tampered non-string
  // value is dropped, not fatal — the diff then reads it as absent.
  if (o.scheme !== undefined && typeof o.scheme !== 'string') delete o.scheme;
  return o as CompanionBuildInputs;
}

/**
 * Record that the companion was built for this buildHash (called after a
 * successful build). Written as JSON `{hash, rev, inputs}` so the readiness
 * checklist can tell a revision-driven rebuild (generated config changed)
 * apart from an input-driven one AND diff the persisted inputs to name the
 * exact cause ("native deps changed: expo-router 3.4.0→4.0.0");
 * {@link readBuildMarker} still parses legacy plain-hash and `{hash, rev}`
 * markers from older Validity versions (those just lose the named diff).
 */
export function writeBuildMarker(
  buildMarkerPath: string,
  buildHash: string,
  inputs?: CompanionBuildInputs,
): void {
  try {
    writeFileSync(
      buildMarkerPath,
      JSON.stringify({ hash: buildHash, rev: COMPANION_BUILD_REVISION, inputs }),
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Read + parse the build marker (JSON `{hash, rev, inputs?}` or a legacy bare
 * hash → revision 1). Null when the marker is missing/unreadable — i.e. never
 * built.
 */
export function readBuildMarker(buildMarkerPath: string): CompanionBuildMarker | null {
  try {
    if (!existsSync(buildMarkerPath)) return null;
    const raw = readFileSync(buildMarkerPath, 'utf-8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { hash?: unknown; rev?: unknown; inputs?: unknown };
      if (typeof parsed.hash !== 'string' || parsed.hash === '') return null;
      return {
        hash: parsed.hash,
        revision: typeof parsed.rev === 'number' ? parsed.rev : 1,
        inputs: parseMarkerInputs(parsed.inputs),
      };
    }
    // Legacy format: the bare buildHash, written before revisions existed.
    return { hash: raw, revision: 1 };
  } catch {
    return null;
  }
}

/** Is the installed companion's last build current for this buildHash? */
export function isCompanionBuildFresh(buildMarkerPath: string, buildHash: string): boolean {
  return readBuildMarker(buildMarkerPath)?.hash === buildHash;
}

/**
 * Is the companion Metro bundler up on its port? Metro answers `/status` with
 * `packager-status:running`. The deep link only renders if Metro is serving the
 * bundle, so the CLI probes this before firing it (and starts Metro if down).
 */
export async function isCompanionMetroUp(
  port: number = COMPANION_METRO_PORT,
  run: CommandRunner = defaultRunner,
): Promise<boolean> {
  try {
    const res = await run('curl', ['-s', '-m', '2', `http://localhost:${port}/status`]);
    return res.code === 0 && res.stdout.includes('packager-status:running');
  } catch {
    return false;
  }
}

/**
 * The detached step that brings Metro up WITHOUT rebuilding — used when the
 * companion binary is already installed + fresh but its Metro isn't running
 * (e.g. a previous session's server was killed). `expo start` serves the
 * bundle the installed dev-client connects to.
 */
export function startMetroStep(
  appDir: string,
  opts: { clearCache?: boolean } = {},
): NativeBuildStep {
  // --clear resets Metro's transform + file-map caches. We pay it ONLY when the
  // served content changed (see ensureCompanionMetro) — a stale transform-cache
  // hit would otherwise keep serving the OLD bundle even though the generated
  // file on disk is fixed (the "my edit never took effect" bug). On an unchanged
  // warm session we omit it, so ordinary re-opens stay fast.
  const args = ['expo', 'start', '--port', String(COMPANION_METRO_PORT)];
  if (opts.clearCache) args.push('--clear');
  return {
    label: opts.clearCache ? 'expo start --clear' : 'expo start',
    bin: 'npx',
    args,
    cwd: appDir,
    // Keep the Metro file watcher ON so Fast Refresh / HMR reaches the companion
    // when a host source file is saved. `CI=1` here would disable it (Expo gates
    // the watcher on `!CI`); the detached spawn is already non-interactive (no
    // TTY). See METRO_SERVE_ENV.
    env: METRO_SERVE_ENV,
    longRunning: true,
  };
}

/**
 * Command that exits 0 iff the companion app is already installed. Pinnable to
 * a specific udid/serial: with >1 booted device, `simctl … booted` / a bare
 * `adb shell` is ambiguous (errors or picks arbitrarily), so an unpinned probe
 * can report "not installed" for a device the capture flow IS pinned to —
 * wrong "rebuild" guidance on exactly the multi-device sessions pinning exists
 * for. No device → the legacy single-device behavior.
 */
export function isAppInstalledCommand(
  bundleId: string,
  platform: 'ios' | 'android',
  device?: string,
): { bin: string; args: string[] } {
  if (platform === 'ios') {
    return { bin: 'xcrun', args: ['simctl', 'get_app_container', device ?? 'booted', bundleId] };
  }
  // adb: list packages and grep — caller checks stdout for the id.
  const base = ['shell', 'pm', 'list', 'packages', bundleId];
  return { bin: 'adb', args: device ? ['-s', device, ...base] : base };
}

/**
 * Is the companion Validity app installed on the booted device (or the pinned
 * `device`)? Drives the "build once, then automatic" UX: install → deep-link;
 * missing → build first.
 */
export async function isCompanionAppInstalled(
  bundleId: string,
  platform: 'ios' | 'android',
  run: CommandRunner = defaultRunner,
  device?: string,
): Promise<boolean> {
  const cmd = isAppInstalledCommand(bundleId, platform, device);
  const res = await run(cmd.bin, cmd.args);
  // iOS: get_app_container exits non-zero when not installed.
  if (platform === 'ios') return res.code === 0;
  // Android: pm list packages prints `package:<id>` only when present.
  return res.stdout.includes(bundleId);
}
