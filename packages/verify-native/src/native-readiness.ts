/**
 * Native-readiness walkthrough. Answers "what do I need to do to run Validity
 * on this mobile app?" as an ordered checklist where each unmet step carries
 * the exact command to satisfy it — so `validity browse --native` can guide a
 * first-time user step-by-step instead of dumping a wall of prose, and stop at
 * the single next action.
 *
 * All probes take an injectable runner, so the whole walkthrough is unit-
 * testable without a device / RN install.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { detectNative } from './detect-native.js';
import {
  COMPANION_BUILD_REVISION,
  COMPANION_METRO_PORT,
  COMPANION_REVISION_REBUILD_REASON,
  EXPO_ROUTER_STORE_SPECIFIER,
  describeBuildInputDiff,
  isCompanionAppInstalled,
  isCompanionBuildFresh,
  readBuildMarker,
  type CompanionBuildInputs,
} from './prepare-native-app.js';
import {
  EXPO_ROUTER_ROUTE_SPECIFIER,
  RN_INITIALIZE_CORE_SPECIFIER,
  RN_LAZY_GLOBAL_CANARY_SPECIFIER,
} from './prepare-native.js';
import {
  defaultRunner,
  parseCapabilitiesJson,
  type CapabilityProbe,
  type CommandRunner,
} from './agent-device-driver.js';
import { ensureAndroidReverse } from './android-reverse.js';
import { readMetroOwnerMarker } from './companion-metro.js';
import {
  describeReleasedClaims,
  detectForeignMetro,
  diagnoseDaemon,
  diagnosePhantomClaimState,
  probeAgentDeviceDaemon,
  probeMetroPortOwners,
  releaseStaleDeviceClaims,
  type DeviceClaim,
  type DiagnosisFs,
} from './environment-diagnosis.js';

export interface ReadinessStep {
  id: string;
  label: string;
  status: 'ok' | 'todo';
  detail: string;
  /** Exact command (or edit) that satisfies a `todo` step. */
  action?: string;
}

export interface NativeReadiness {
  /** True when every prerequisite is met and a component can be shown right now. */
  ready: boolean;
  steps: ReadinessStep[];
  /** The first unmet step — the single thing to do next. */
  nextAction?: ReadinessStep;
}

export interface NativeReadinessOptions {
  projectRoot: string;
  platform: 'ios' | 'android';
  /** The configured native.scheme, if any (passed by the caller from config). */
  scheme?: string;
  /** Companion app bundle id. Default 'ai.validity.playground'. */
  bundleId?: string;
  /**
   * The udid/serial the capture flow pinned for this call (see
   * listBootedDevices). Threaded into the device-touching probes
   * (companion-installed, adb reverse): with >1 booted device an unpinned
   * `simctl … booted` / bare `adb` is ambiguous, so the checklist could claim
   * "companion not installed" for a device it IS installed on — wrong rebuild
   * guidance on exactly the multi-device sessions pinning exists for. Absent →
   * legacy single-device behavior.
   */
  device?: string;
  /** Current build hash + marker path — when given, an installed-but-stale app is flagged for rebuild. */
  buildHash?: string;
  buildMarkerPath?: string;
  /**
   * The inputs the current buildHash was derived from (native dep versions +
   * resolved expo config). When given alongside a marker that persisted its
   * own inputs, a stale install's message names WHICH input flipped
   * ("native deps changed: expo-router 3.4.0→4.0.0") instead of a generic
   * "rebuild".
   */
  buildInputs?: CompanionBuildInputs;
  run?: CommandRunner;
  /**
   * The generated companion app dir (Metro's cwd + where the port-owner marker
   * lives). Default `<projectRoot>/.validity/native-app`, matching
   * prepareNativeApp.
   */
  appDir?: string;
  /** agent-device state dir for the daemon/claim probes. Default `$HOME/.agent-device`. */
  stateDir?: string;
  /** Injected filesystem for the daemon/claim probes (tests). */
  diagnosisFs?: DiagnosisFs;
  /** Injected pid-liveness probe (tests). */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Skip the ENVIRONMENT probes (daemon state, phantom claim, companion-port
   * ownership). They are read-only and cheap, but they shell out — callers that
   * must not spawn anything can turn them off.
   */
  skipEnvironmentProbes?: boolean;
}

const MOCK_DEPS = [
  'msw',
  'react-native-url-polyfill',
  'fast-text-encoding',
  '@react-native-async-storage/async-storage',
];

/**
 * One package-internal module path the generated native harness couples to —
 * see the specifier constants in prepare-native.ts / prepare-native-app.ts
 * (they are interpolated into the generated bodies, so this preflight can
 * never drift from what the runtime actually requires/matches).
 */
export interface InternalPathProbe {
  /** The package the internal path lives in (what gets version-bumped). */
  pkg: string;
  /** The package-internal specifier the generated code requires / matches. */
  specifier: string;
  /** The SILENT runtime degradation that lands when it stops resolving. */
  symptom: string;
}

export interface InternalPathCheck {
  probe: InternalPathProbe;
  /**
   * - 'ok': the internal path resolves in the host's installed copy.
   * - 'missing': the package IS installed but no longer ships the path — the
   *   version-coupling broke (this is the loud-signal case).
   * - 'package-absent': the package isn't installed under the host (e.g.
   *   node_modules not installed yet) — nothing to preflight, NOT an error;
   *   other readiness steps own "install your deps".
   */
  status: 'ok' | 'missing' | 'package-absent';
  /** The installed package's version (read from its package.json), when found. */
  installedVersion?: string;
}

/**
 * The version-coupled internals to preflight for a given project shape. The
 * expo-router probes only apply when the host actually uses expo-router (the
 * store mock + Route require are only generated then).
 */
export function packageInternalProbes(opts: { expoRouter: boolean }): InternalPathProbe[] {
  const probes: InternalPathProbe[] = [
    {
      pkg: 'react-native',
      specifier: RN_INITIALIZE_CORE_SPECIFIER,
      symptom:
        "the generated polyfills could no longer force-install RN's lazy web globals — " +
        "the \"Property 'FormData' doesn't exist\" cold-open redbox returns with zero signal",
    },
    {
      pkg: 'react-native',
      specifier: RN_LAZY_GLOBAL_CANARY_SPECIFIER,
      symptom:
        'RN moved the module backing the lazy FormData global — the force-resolved ' +
        'lazy-global list in the generated polyfills needs review (same redbox class)',
    },
  ];
  if (opts.expoRouter) {
    probes.push(
      {
        pkg: 'expo-router',
        specifier: EXPO_ROUTER_STORE_SPECIFIER,
        symptom:
          "the metro redirect that swaps expo-router's global store for the isolation " +
          "mock would stop matching — screens crash on the real store's null navigationRef",
      },
      {
        pkg: 'expo-router',
        specifier: EXPO_ROUTER_ROUTE_SPECIFIER,
        symptom:
          'LocalRouteParamsContext could not be required — useLocalSearchParams() would ' +
          'silently return {} for every screen',
      },
    );
  }
  return probes;
}

/**
 * Standard node_modules walk-up: the directory of `pkg` visible from
 * `startDir`, or null when not installed. Plain fs (no require.resolve) so the
 * check matches how Metro reaches these files — Node's "exports" maps don't
 * apply to Metro's resolution of the generated requires, and require.resolve
 * would false-negative on packages that gate deep subpaths.
 */
function findPackageDir(startDir: string, pkg: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, 'node_modules', pkg);
    if (existsSync(resolve(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readInstalledVersion(pkgDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Does the package-internal specifier resolve inside the installed package dir? */
function internalPathResolves(pkgDir: string, pkg: string, specifier: string): boolean {
  const subpath = specifier.slice(pkg.length + 1);
  const base = resolve(pkgDir, subpath);
  // Mirror the resolution the consumers use: the metro redirect matches an
  // exact .js file path; the generated require()s resolve extensionless
  // specifiers to <path>.js / <path>/index.js.
  return [base, `${base}.js`, `${base}.cjs`, resolve(base, 'index.js')].some((p) => existsSync(p));
}

/**
 * Prepare-time preflight for the version-coupled package internals: resolve
 * each probe against the HOST's installed node_modules so a bumped
 * expo-router / react-native that moved an internal surfaces as a readiness
 * 'todo' NAMING the unresolved path + installed version, instead of the
 * historical silent runtime degradation (FormData redbox / null-navigationRef
 * crash with zero signal). Purely additive signal — when everything resolves,
 * runtime behavior is unchanged.
 */
export function checkPackageInternalPaths(
  projectRoot: string,
  opts: { expoRouter: boolean },
): InternalPathCheck[] {
  return packageInternalProbes(opts).map((probe) => {
    const pkgDir = findPackageDir(projectRoot, probe.pkg);
    if (!pkgDir) return { probe, status: 'package-absent' as const };
    return {
      probe,
      status: internalPathResolves(pkgDir, probe.pkg, probe.specifier)
        ? ('ok' as const)
        : ('missing' as const),
      installedVersion: readInstalledVersion(pkgDir),
    };
  });
}

/**
 * Can `pkg` be require-resolved from the project root? Catches deps that are
 * INSTALLED but not LISTED — e.g. carried transitively by
 * `@validity.ai/verify-plugin-expo` under a hoisting package manager. Resolution is the
 * truth the harness actually needs (the generated mock modules import these
 * by name from the companion, whose metro shares the project's node_modules).
 */
function resolvableFrom(projectRoot: string, pkg: string): boolean {
  try {
    createRequire(resolve(projectRoot, 'package.json')).resolve(pkg);
    return true;
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

async function deviceBooted(platform: 'ios' | 'android', run: CommandRunner): Promise<boolean> {
  try {
    if (platform === 'ios') {
      const res = await run('xcrun', ['simctl', 'list', 'devices', 'booted']);
      return res.code === 0 && /\(Booted\)/.test(res.stdout);
    }
    const res = await run('adb', ['devices']);
    // Lines after the header look like "emulator-5554\tdevice".
    return res.code === 0 && /\n\S+\s+device\b/.test('\n' + res.stdout);
  } catch {
    return false;
  }
}

/** One booted simulator/emulator a capture session can be pinned to. */
export interface BootedDevice {
  /** simctl udid (iOS) / adb serial (Android) — what every driver command pins on. */
  id: string;
  /** Human-readable device name/model, for "which one?" listings. */
  name: string;
  /**
   * OS/runtime version when the platform reports one — iOS parses it from the
   * simctl runtime key (`iOS 26.3`), Android reads `ro.build.version.release`
   * off the device (`Android 14`). Provenance for run-meta: a screenshot means
   * little without the OS that drew it, and Android runs used to ship without
   * this field at all, so their evidence was quietly weaker than iOS's.
   * Absent when the runtime key is unrecognized or the getprop probe fails —
   * "no version recorded" beats a wrong one.
   */
  osVersion?: string;
}

/**
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-3` → `iOS 26.3`. Returns undefined
 * for any key that doesn't match, so an Apple naming change degrades to "no
 * version recorded" rather than a wrong one.
 */
function parseSimRuntime(key: string): string | undefined {
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(key);
  if (!m) return undefined;
  return `${m[1]} ${m[2]!.replace(/-/g, '.')}`;
}

/**
 * `adb -s <serial> shell getprop ro.build.version.release` → `Android 14`.
 * `adb devices -l` carries model/product but no OS version, so this is one
 * extra round-trip per booted device — cheap (there is rarely more than one)
 * and the only way Android runs get the same provenance iOS already had.
 *
 * Returns undefined on any non-zero exit or unrecognized output rather than
 * guessing: the release string is a bare version (`14`, `13`, `11.0`), so
 * anything else means the property was missing or adb printed an error into
 * stdout, and a wrong OS on a screenshot is worse than none.
 */
async function androidOsVersion(serial: string, run: CommandRunner): Promise<string | undefined> {
  try {
    const res = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.release']);
    if (res.code !== 0) return undefined;
    const release = res.stdout.trim();
    if (!/^\d+(\.\d+)*$/.test(release)) return undefined;
    return `Android ${release}`;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate the booted devices with their udids/serials — the pinning source
 * for the capture flow. `simctl openurl booted` (and an unpinned agent-device
 * session) picks ARBITRARILY with >1 device booted, so the deep link can land
 * on one device while the screenshot/snapshot run on another; callers resolve
 * this list ONCE per call and pin exactly one id into the driver, erroring
 * (machine-readably) when the choice is ambiguous. Distinct from the cheap
 * boolean `deviceBooted` readiness probe above: this one needs structured
 * output (`-j` / `-l`), and degrades to [] on any spawn/parse failure so
 * callers fall back to the legacy unpinned behavior rather than crash.
 */
export async function listBootedDevices(
  platform: 'ios' | 'android',
  run: CommandRunner = defaultRunner,
): Promise<BootedDevice[]> {
  try {
    if (platform === 'ios') {
      const res = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      if (res.code !== 0) return [];
      const parsed = JSON.parse(res.stdout) as {
        devices?: Record<string, Array<{ udid?: unknown; name?: unknown; state?: unknown }>>;
      };
      const out: BootedDevice[] = [];
      for (const [runtimeKey, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
        if (!Array.isArray(runtimeDevices)) continue;
        const osVersion = parseSimRuntime(runtimeKey);
        for (const d of runtimeDevices) {
          // `booted` pre-filters, but keep the state check — older simctl
          // versions include shutdown devices in the same payload.
          if (d?.state !== 'Booted' || typeof d.udid !== 'string') continue;
          out.push({
            id: d.udid,
            name: typeof d.name === 'string' ? d.name : d.udid,
            ...(osVersion ? { osVersion } : {}),
          });
        }
      }
      return out;
    }
    const res = await run('adb', ['devices', '-l']);
    if (res.code !== 0) return [];
    const out: BootedDevice[] = [];
    for (const line of res.stdout.split('\n')) {
      // "emulator-5554   device product:sdk_gphone64 model:Pixel_7 …" — only
      // state `device` counts (offline/unauthorized can't be driven). The
      // header line ("List of devices attached") never matches this shape.
      const m = line.trim().match(/^(\S+)\s+device\b(.*)$/);
      if (!m) continue;
      const serial = m[1]!;
      const model = m[2]?.match(/model:(\S+)/)?.[1];
      out.push({ id: serial, name: model ? model.replace(/_/g, ' ') : serial });
    }
    // OS version needs a second call per device (see androidOsVersion). Done in
    // parallel and strictly additively — a failed probe leaves the device in the
    // list without the field, never drops it.
    const versions = await Promise.all(out.map((d) => androidOsVersion(d.id, run)));
    return out.map((d, i) => (versions[i] ? { ...d, osVersion: versions[i] } : d));
  } catch {
    return [];
  }
}

/** A companion APK found on disk — its path and last-modified time (newest wins). */
export interface DiscoveredApk {
  /** Absolute path to the `.apk` file. */
  path: string;
  /** Last-modified time (ms since epoch) — the recency `findNewestApk` ranks on. */
  mtimeMs: number;
}

/**
 * The default build-output roots {@link findNewestApk} scans for a companion
 * APK, in priority order. The ONLY default is the COMPANION app's gradle
 * output: Validity generates + builds the separate "Validity" app under
 * `<projectRoot>/.validity/native-app` (see prepareNativeApp), so
 * `validity browse --native` leaves the installable dev-client APK at
 * `…/.validity/native-app/android/app/build/outputs/apk/**` — the exact binary
 * `installCompanion` needs (bundle id `ai.validity.playground`, with the
 * Validity harness + control bridge compiled in).
 *
 * The HOST project's own `android/app/build/outputs/apk` is deliberately NOT a
 * default: that directory holds the USER'S real app (a different bundle id, no
 * Validity harness/bridge), so installing it would render nothing to verify.
 * Callers who really want to point elsewhere pass explicit `candidates`.
 */
export function defaultCompanionApkRoots(projectRoot: string): string[] {
  return [
    resolve(projectRoot, '.validity', 'native-app', 'android', 'app', 'build', 'outputs', 'apk'),
  ];
}

/** Recursively yield every `*.apk` under `dir` (nothing when `dir` is absent/unreadable). */
function* walkApks(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // absent or unreadable root — not an error, just no APKs here
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkApks(full);
    } else if (entry.isFile() && entry.name.endsWith('.apk')) {
      yield full;
    }
  }
}

/**
 * Find the newest `*.apk` under the given candidate roots (default: the
 * companion app's gradle output — see {@link defaultCompanionApkRoots}).
 * Recursively scans each root, ranks every `.apk` by mtime, and returns the
 * freshest — the "you just built it" heuristic behind `verify --all`'s APK
 * auto-discovery when no `--native-apk` is passed. Returns `undefined` when no
 * root exists or none contains an `.apk`. Pure fs (no injected runner): the
 * unit tests point it at tmp dirs with real files and touched mtimes.
 */
export function findNewestApk(
  projectRoot: string,
  candidates?: string[],
): DiscoveredApk | undefined {
  const roots = candidates ?? defaultCompanionApkRoots(projectRoot);
  let best: DiscoveredApk | undefined;
  for (const root of roots) {
    for (const file of walkApks(root)) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue; // vanished between readdir and stat — skip it
      }
      if (!best || mtimeMs > best.mtimeMs) best = { path: file, mtimeMs };
    }
  }
  return best;
}

/**
 * The oldest agent-device this checklist will call READY.
 *
 * Not a guess and not the newest-for-its-own-sake: 0.16.4 cannot open a
 * Validity deep link on Android at all. `agent-device open
 * 'validity://…?component=…&token=…'` exits 127 with
 *
 *     Error (COMMAND_FAILED): /system/bin/sh: -p: inaccessible or not found
 *
 * while the equivalent `adb shell am start -a android.intent.action.VIEW -d
 * <url>` succeeds on the same device and URL. Verified fixed on 0.20.1 (same
 * emulator, same URL, same second: 0.16.4 errors, 0.20.1 answers `Opened: …`).
 * The exact release that fixed it was not bisected, so the floor is the version
 * actually observed working rather than an inferred earlier one.
 *
 * Every rung below this degrades to `unverifiable`, never to a failing
 * criterion — but a whole sweep of "no mechanical verdict produced" with no
 * explanation is a bad way to learn your tooling is four minors stale, which is
 * why this is surfaced as a readiness step instead of left to the run output.
 *
 * RAISED 0.20.3 → 0.20.5 on 2026-08-06, when the driver was aligned with the
 * 0.20.5 reference loop. Everything in this rung is a behaviour Validity now
 * ISSUES, not one it tolerates, which is what makes it a floor rather than a
 * recommendation. Verified against the 0.20.5 CLI's own help/typings on the dev
 * box (`agent-device --help`, `help workflow`, `help remote`, `diff --help`,
 * and the installed package's `dist/src/interaction.d.ts`); NOT re-measured on
 * a device, because none exists on this machine — the device-observed claims
 * below are the 0.20.3 ones, and they are labelled as such.
 *
 *  - **`press` is the canonical tap.** `agent-device --help`: "Taps are press
 *    or click; tap is an alias for press". The driver's default tap argv is now
 *    `press` (see `DEFAULT_TAP_ARGS`).
 *  - **`--settle` on press/click/fill/longpress.** The documented default loop
 *    is "mutate with --settle, continue from that settled diff". The driver
 *    issues it on every mutation and parses `data.settle` (typed upstream as
 *    `SettleObservation`) for the diff, its `refsGeneration` and the
 *    unchanged-interactive tail.
 *  - **Versioned refs (`@e12~s<n>`).** "On iOS, stale refs are rejected for
 *    press/fill/click/longpress before dispatch." The driver pins refs a
 *    settled tree minted, which is only meaningful at or above this floor.
 *  - **`diff snapshot [-i]`.** The purpose-built before/after read, rung 2 of
 *    the driver's post-action ladder.
 *  - **`--cost`.** `cost.wallClockMs` per command, folded into the per-capture
 *    metrics row.
 *  - **`--remote-config <path>` on every operational command** (`help remote`),
 *    which is how `native.remote` drives a cloud/proxy device.
 *
 * The 0.20.3 rung it replaced, kept because those behaviours are still relied
 * on (each verified live on `emulator-5554`, 2026-07-30):
 *
 *  - **Claim GC on `close` (0.20.2).** `close` now releases the device claim
 *    instead of leaking it. Measured across one `close`: one file in
 *    `~/.agent-device/device-claims/` → zero. This is what lets
 *    `releaseStaleClaimAndRetryOpen` drop to a single quiet retry and the
 *    phantom-claim probe stop advertising a daemon kill (see
 *    `environment-diagnosis.ts`). Below this version the claim survives, so the
 *    loud recovery has to stay for anyone under the floor — which is exactly
 *    why it moved behind the floor rather than being deleted.
 *  - **Fail-closed positional parsing (0.20.2).** `type <ref> <text>` is now
 *    rejected with INVALID_ARGS; the driver's text-input argv is `fill <ref>
 *    <text>`. `fill` exists well below this floor, so this is a correctness
 *    alignment, not a capability gain.
 *  - **`wait stable` capture stats (0.20.3).** `wait stable --json` answers
 *    `{waitedMs, captures, nodeCount}`, which the settle gate consumes as its
 *    quiescence wait (`snapshot-settle.ts`).
 *  - **`capabilities` (0.19.0, relied on from here).** Replaces duck-typed
 *    "does this verb exist" probing in the check executor and adds a readiness
 *    row, so an unsupported verb is reported as unsupported instead of being
 *    inferred from a failed exec.
 *
 * NOT a reason for the raise, and deliberately recorded so nobody re-litigates
 * it: Android `snapshot -i` still drops standalone static `<Text>` on 0.20.3
 * (re-verified on the Ignite WelcomeScreen), and the `Snapshot unchanged since
 * previous read` dedup placeholder still fires — the 0.20.5 CLI still ships
 * both the interactive filter and that placeholder text, so nothing suggests
 * either changed. The per-platform snapshot argv split and `--force-full` stay
 * exactly as they are — see {@link ANDROID_SNAPSHOT_ARGS} and
 * Re-verify on a 0.20.5 device run.
 */
export const MIN_AGENT_DEVICE_VERSION = '0.20.5';

/**
 * Compare dotted numeric versions. Returns <0, 0, >0 like a comparator.
 * Non-numeric/extra segments (`0.20.1-beta.2`) compare on their numeric prefix,
 * so a prerelease of the required version is treated as that version rather
 * than being rejected on punctuation. PURE — unit-tested without a device.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, '')
      // Drop any prerelease/build suffix FIRST, so only the numeric release
      // prefix is compared. Splitting on `-` instead would make
      // '0.20.1-beta.2' sort ABOVE '0.20.1' (it grows a 4th segment), which is
      // backwards and would let a prerelease satisfy a floor it precedes.
      .split(/[-+]/)[0]!
      .split('.')
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** First dotted-numeric version token in `agent-device --version` output. */
export function parseAgentDeviceVersion(stdout: string): string | undefined {
  // No leading \b: it would not match the `v` form (`agent-device v0.20.1`),
  // because there is no word boundary between `v` and `0`.
  return stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

interface AgentDeviceProbe {
  present: boolean;
  /** Undefined when the CLI is absent, or its output carried no version. */
  version?: string;
  /** True only when a version was READ and is below the floor. */
  outdated: boolean;
}

async function probeAgentDevice(run: CommandRunner): Promise<AgentDeviceProbe> {
  try {
    const res = await run('agent-device', ['--version']);
    if (res.code !== 0) return { present: false, outdated: false };
    const version = parseAgentDeviceVersion(`${res.stdout} ${res.stderr}`);
    // An unreadable version is NOT treated as outdated. The floor exists to
    // explain a specific broken behavior; refusing to call a working install
    // ready because its `--version` output changed shape would be a worse
    // failure than the one being prevented.
    if (!version) return { present: true, outdated: false };
    return {
      present: true,
      version,
      outdated: compareVersions(version, MIN_AGENT_DEVICE_VERSION) < 0,
    };
  } catch {
    return { present: false, outdated: false };
  }
}

/**
 * The agent-device verbs a native capture actually issues.
 *
 * `open`/`snapshot`/`screenshot` are the capture itself; `wait` backs the
 * settle gate and the render-marker wait; `press`/`fill` back interaction
 * criteria; `scroll` backs scroll-to-find; `diff` is rung 2 of the driver's
 * post-action ladder. This list exists to notice the day one of them is missing
 * from a device.
 *
 * `press` REPLACED `click` here on 2026-08-06 because the driver's default tap
 * argv did (see `DEFAULT_TAP_ARGS`) — this row must name the verb Validity will
 * actually send, or it certifies a capability the capture never uses. Both are
 * present in 0.20.5's command surface (`agent-device --help`, captured
 * 2026-08-06: `press`, `click`, `fill`, `scroll`, `snapshot`, `screenshot`,
 * `wait`, `open`, `diff` all listed), and all of them except `diff` and `press`
 * were in the 40-verb list 0.20.3 reported for `emulator-5554` on 2026-07-30 —
 * that measurement predates this change and has NOT been repeated on a 0.20.5
 * device. A device that reports neither verb still degrades exactly as before:
 * a `todo` readiness row, never a failed criterion.
 */
const NATIVE_CAPTURE_VERBS = [
  'open',
  'snapshot',
  'screenshot',
  'wait',
  'press',
  'fill',
  'scroll',
  'diff',
] as const;

/** `agent-device capabilities` for the platform, or undefined when unreadable. */
async function probeCapabilities(
  platform: 'ios' | 'android',
  run: CommandRunner,
): Promise<CapabilityProbe | undefined> {
  try {
    const res = await run('agent-device', ['capabilities', '--platform', platform, '--json']);
    if (res.code !== 0) return undefined;
    return parseCapabilitiesJson(res.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Build the readiness checklist. Steps are ordered so the first `todo` is the
 * right next action; `ready` is true only when all are satisfied.
 */
export async function checkNativeReadiness(opts: NativeReadinessOptions): Promise<NativeReadiness> {
  const run = opts.run ?? defaultRunner;
  const platform = opts.platform;
  const bundleId = opts.bundleId ?? 'ai.validity.playground';
  const steps: ReadinessStep[] = [];

  // 1. Is this a native app at all?
  const detection = detectNative(opts.projectRoot);
  steps.push(
    detection.isNative
      ? {
          id: 'native-project',
          label: 'React Native / Expo project',
          status: 'ok',
          detail: `Detected (${detection.usesExpo ? 'Expo' : 'bare RN'}, router: ${detection.router}).`,
        }
      : {
          id: 'native-project',
          label: 'React Native / Expo project',
          status: 'todo',
          detail: detection.reason ?? 'Not a native project.',
        },
  );

  // 1b. Version-coupled package internals. The generated harness requires /
  //     path-matches a handful of package-INTERNAL files (expo-router's store,
  //     expo-router/build/Route, RN's InitializeCore, the lazy-global backing
  //     module) that a dependency bump can move — and every runtime consumer
  //     degrades SILENTLY (try/catch, warn-once), which historically resurfaced
  //     as the FormData redbox / null-navigationRef crash with zero signal.
  //     Preflight them here so the breakage is a named 'todo' BEFORE a device
  //     is driven. Probes whose package isn't installed at all are skipped —
  //     "install your deps" is owned elsewhere, and an uninstalled host can't
  //     bundle anyway.
  if (detection.isNative) {
    const internalChecks = checkPackageInternalPaths(opts.projectRoot, {
      expoRouter: detection.router === 'expo-router',
    });
    const broken = internalChecks.filter((c) => c.status === 'missing');
    const probed = internalChecks.filter((c) => c.status !== 'package-absent');
    steps.push(
      broken.length === 0
        ? {
            id: 'internal-paths',
            label: 'Version-coupled package internals',
            status: 'ok',
            detail:
              probed.length === 0
                ? 'Host packages not installed locally — internals not probed.'
                : `All ${probed.length} package-internal paths Validity couples to resolve.`,
          }
        : {
            id: 'internal-paths',
            label: 'Version-coupled package internals',
            status: 'todo',
            detail: broken
              .map(
                (c) =>
                  `${c.probe.pkg}@${c.installedVersion ?? 'unknown version'} no longer ships ` +
                  `"${c.probe.specifier}" — ${c.probe.symptom}.`,
              )
              .join(' '),
            action:
              'Update Validity (its native harness pins these package internals per version), or pin ' +
              [...new Set(broken.map((c) => c.probe.pkg))].join(', ') +
              ' back to a version that ships them.',
          },
    );
  }

  // 2. Mocking dev deps. Listed in package.json OR resolvable from the
  //    project root — `@validity.ai/verify-plugin-expo` carries msw/url-polyfill/
  //    fast-text-encoding as its own deps, which satisfies the harness on
  //    npm/yarn (hoisted). Under pnpm's isolated node_modules that carriage
  //    does NOT hoist, so the probe correctly still reports missing there and
  //    the `npm i -D` action line stays the right fix.
  const deps = readDeps(opts.projectRoot);
  const missing = MOCK_DEPS.filter((d) => !deps[d] && !resolvableFrom(opts.projectRoot, d));
  steps.push(
    missing.length === 0
      ? {
          id: 'mock-deps',
          label: 'Mocking dev deps',
          status: 'ok',
          detail: 'All present (listed or resolvable — e.g. carried by @validity.ai/verify-plugin-expo).',
        }
      : {
          id: 'mock-deps',
          label: 'Mocking dev deps',
          status: 'todo',
          detail: `Missing: ${missing.join(', ')}.`,
          action: `npm i -D ${missing.join(' ')}`,
        },
  );

  // 3. URL scheme (for deep links). The companion derives a UNIQUE scheme by
  //    default (defaultCompanionScheme in prepare-native-app.ts), so this is
  //    ok on every normal path; the todo only fires for direct callers that
  //    passed none. The guidance deliberately does NOT say "match app.json":
  //    reusing the host app's scheme makes both installed apps register it,
  //    and iOS then opens the USER'S app for our deep links nondeterministically
  //    — the flow would screenshot the wrong app.
  steps.push(
    opts.scheme
      ? {
          id: 'scheme',
          label: 'URL scheme',
          status: 'ok',
          detail: `Deep links use "${opts.scheme}" (companion-unique unless overridden).`,
        }
      : {
          id: 'scheme',
          label: 'URL scheme',
          status: 'todo',
          detail: 'No URL scheme — needed for deep links.',
          action:
            'Use the scheme prepareNativeApp derives (companion-unique by default). Only set ' +
            "native.scheme in .validity/config.ts to override it deliberately — never your own app's scheme.",
        },
  );

  // 4. agent-device CLI (for capture) — present AND recent enough.
  const agentDevice = await probeAgentDevice(run);
  steps.push(
    !agentDevice.present
      ? {
          id: 'agent-device',
          label: 'agent-device CLI',
          status: 'todo',
          detail: 'Not found — needed for screenshot + accessibility capture.',
          action: 'npm i -g agent-device',
        }
      : agentDevice.outdated
        ? {
            id: 'agent-device',
            label: 'agent-device CLI',
            status: 'todo',
            detail:
              `On PATH, but v${agentDevice.version} is older than the v${MIN_AGENT_DEVICE_VERSION} ` +
              'Validity needs. Far enough back (0.16.x) it cannot open a Validity deep link on ' +
              'Android at all (`agent-device open` exits 127 with "/system/bin/sh: -p: inaccessible ' +
              'or not found"), so every spec it has to deep-link into reports `unverifiable` with no ' +
              'verdict — a whole sweep of silence rather than an error pointing here. Nearer the ' +
              'floor the failures are quieter but still real: before 0.20.2 a closed session leaks ' +
              'its device claim, so the NEXT run is refused with "device is already in use" until ' +
              'the stale claim is closed by name. And the argv Validity now sends was verified ' +
              'against 0.20.5 specifically — `--settle` on taps/fills, `~s<n>` ref pins, `diff ' +
              'snapshot`, `--remote-config` — none of which was bisected backwards, so on an older ' +
              'build those flags may be rejected outright rather than ignored.',
            action: `npm i -g agent-device@latest  (then re-run; asdf users: asdf reshim nodejs)`,
          }
        : {
            id: 'agent-device',
            label: 'agent-device CLI',
            status: 'ok',
            detail: agentDevice.version
              ? `On PATH (v${agentDevice.version}).`
              : 'On PATH (version not reported).',
          },
  );

  // 5. A booted device.
  const booted = await deviceBooted(platform, run);
  steps.push(
    booted
      ? {
          id: 'device',
          label: `Booted ${platform} device`,
          status: 'ok',
          detail: 'Found a booted device.',
        }
      : {
          id: 'device',
          label: `Booted ${platform} device`,
          status: 'todo',
          detail: `No booted ${platform === 'ios' ? 'simulator' : 'emulator'}.`,
          action:
            platform === 'ios'
              ? 'Open a Simulator in Xcode (or `xcrun simctl boot <device>`).'
              : 'Start an Android emulator (Android Studio, or `emulator -avd <name>`).',
        },
  );

  // 5a. What the tool says it can actually DO on this device.
  //
  //     Runs only once a device is booted, because `capabilities` is
  //     device-scoped — asking without one answers about nothing. Reported as a
  //     ROW rather than enforced: the verbs Validity needs for a capture
  //     (`open`/`snapshot`/`screenshot`) are universal, and the optional ones
  //     (`scroll`, `fill`) already degrade to `unverifiable` rather than to a
  //     failing criterion. The value here is that a missing verb is now
  //     something the checklist can NAME before a sweep, instead of something
  //     the run infers from a command that failed for unstated reasons.
  if (agentDevice.present && booted) {
    const caps = await probeCapabilities(platform, run);
    const missing = caps ? NATIVE_CAPTURE_VERBS.filter((v) => !caps.commands.includes(v)) : [];
    steps.push(
      !caps
        ? {
            id: 'agent-device-capabilities',
            label: 'agent-device capabilities',
            status: 'ok',
            detail:
              'Not reported — `agent-device capabilities` answered nothing readable. Treated as ' +
              '"cannot tell", not as unsupported; capture proceeds and any unsupported verb still ' +
              'degrades to `unverifiable`.',
          }
        : missing.length === 0
          ? {
              id: 'agent-device-capabilities',
              label: 'agent-device capabilities',
              status: 'ok',
              detail:
                `${caps.commands.length} verbs supported on this device, including everything ` +
                `capture needs (${NATIVE_CAPTURE_VERBS.join(', ')}).`,
            }
          : {
              id: 'agent-device-capabilities',
              label: 'agent-device capabilities',
              status: 'todo',
              detail:
                `This device reports ${caps.commands.length} supported verbs, but not ` +
                `${missing.join(', ')}. Criteria that need ${missing.length > 1 ? 'those' : 'that'} ` +
                'will come back `unverifiable` rather than scored.',
              action:
                'Check the device/platform is fully supported (`agent-device capabilities`), or ' +
                'upgrade: npm i -g agent-device@latest',
            },
    );
  }

  // 5b. Android only: the emulator reaches host Metro via `adb reverse`. iOS
  //     sims share the host network, so this step is iOS-irrelevant and only
  //     runs once a device is booted (adb reverse needs a target).
  if (platform === 'android' && booted) {
    const reversed = await ensureAndroidReverse('android', opts.device, run);
    steps.push(
      reversed
        ? {
            id: 'android-reverse',
            label: 'Android Metro reachability',
            status: 'ok',
            detail: 'adb reverse tcp:8082 set up — the emulator can reach host Metro.',
          }
        : {
            id: 'android-reverse',
            label: 'Android Metro reachability',
            status: 'todo',
            detail:
              'Could not set up `adb reverse tcp:8082 tcp:8082` — the dev-client may not reach host Metro.',
            action: 'adb reverse tcp:8082 tcp:8082   (check `adb devices` shows the emulator)',
          },
    );
  }

  // 6. Companion app installed AND current. "Current" = the installed build's
  //    marker matches the binary inputs (native dep versions + the resolved
  //    expo config — see CompanionBuildInputs) AND the generated app-shell
  //    revision: a native dep bump / expo-config change needs a rebuild for
  //    the installed binary to gain it, and a revision bump (a generated
  //    expo-config change like the splash strip) needs one for the new shell
  //    behavior. The cases get DIFFERENT messages — an unexplained "rebuild"
  //    prompt reads like the old flakiness returning:
  //      - revision-driven → the canned reason for that revision;
  //      - input-driven, marker persisted its inputs → diff old vs new and
  //        NAME the cause ("native deps changed: expo-router 3.4.0→4.0.0");
  //      - input-driven, marker predates input tracking (older Validity) →
  //        one generic-reason rebuild, after which the marker carries inputs.
  const installed = booted
    ? await isCompanionAppInstalled(bundleId, platform, run, opts.device).catch(() => false)
    : false;
  const fresh =
    installed &&
    (!opts.buildHash ||
      !opts.buildMarkerPath ||
      isCompanionBuildFresh(opts.buildMarkerPath, opts.buildHash));
  const marker = opts.buildMarkerPath ? readBuildMarker(opts.buildMarkerPath) : null;
  const revisionOutdated = marker !== null && marker.revision < COMPANION_BUILD_REVISION;
  const inputDiff =
    marker?.inputs && opts.buildInputs
      ? describeBuildInputDiff(marker.inputs, opts.buildInputs)
      : [];
  const staleDetail = revisionOutdated
    ? `Installed but built from an older Validity — ${COMPANION_REVISION_REBUILD_REASON}.`
    : inputDiff.length > 0
      ? `Installed but STALE — ${inputDiff.join('; ')} — rebuild needed.`
      : marker !== null && marker.inputs === undefined
        ? 'Installed but STALE — the native build inputs (native deps / expo config) changed since it was built, but the marker predates input tracking so the exact cause is unknown. Rebuild once.'
        : 'Installed but STALE — the native build inputs changed since it was built, so the running app would use the old binary. Rebuild.';
  steps.push(
    fresh
      ? {
          id: 'companion-app',
          label: 'Validity companion app',
          status: 'ok',
          detail: 'Installed and current.',
        }
      : {
          id: 'companion-app',
          label: 'Validity companion app',
          status: 'todo',
          detail: installed
            ? staleDetail
            : 'The separate "Validity" dev app is not installed yet (built once, beside your app).',
          action: 'validity browse --native   (rebuilds + installs)',
        },
  );

  // 7-9. ENVIRONMENT probes. These do not gate a first-time setup — they catch
  //       the states that make an ALREADY-working setup produce "no mechanical
  //       verdict produced for this criterion" with nothing pointing at a cause
  //       (handoff-2026-07-28: five different causes, one indistinguishable
  //       message). They come last for exactly that reason: a machine that has
  //       never run Validity should be walked through installs first.
  //
  //       Every one of them degrades the way the version gate does: UNKNOWN is
  //       'ok' with a dim note, never 'todo'. Flagging a working environment is
  //       worse than the silence being fixed, because it sends a developer to
  //       reset something that was fine.
  if (!opts.skipEnvironmentProbes) {
    const daemon = probeAgentDeviceDaemon({
      stateDir: opts.stateDir,
      fs: opts.diagnosisFs,
      isPidAlive: opts.isPidAlive,
    });
    const daemonDiag = diagnoseDaemon(daemon);
    steps.push(
      daemonDiag
        ? {
            id: 'agent-device-daemon',
            label: 'agent-device daemon state',
            status: 'todo',
            detail: `${daemonDiag.symptom} ${daemonDiag.detail}`,
            action: daemonDiag.fixCommand,
          }
        : {
            id: 'agent-device-daemon',
            label: 'agent-device daemon state',
            status: 'ok',
            detail: describeDaemonState(daemon),
          },
    );

    // 8. Phantom device claim. Only worth a (read-only) `session list` when a
    //    claim actually exists — with no claim files there is nothing to be
    //    phantom about.
    //
    //    AUTO-HEAL FIRST. A claim whose owner pid is dead cannot be anyone's,
    //    and the remedy this step used to print for it ends in
    //    `rm -rf …/device-claims` — so releasing that ONE file here is strictly
    //    gentler than the instruction it replaces, and it is the difference
    //    between a checklist that reports the same phantom claim after every
    //    native run and one that clears it. Live and unreadable claims are
    //    never touched; whatever survives the release is what gets diagnosed.
    if (agentDevice.present && daemon.claimCount > 0) {
      const claims = daemon.claims ?? [];
      const release = releaseStaleDeviceClaims(claims, opts.diagnosisFs);
      const releasedPaths = new Set(release.released.map((c) => c.path));
      const remaining = claims.filter((c) => !releasedPaths.has(c.path));
      const releasedNote = describeReleasedClaims(release.released);
      const listed =
        remaining.length > 0
          ? await run('agent-device', ['session', 'list']).catch(() => null)
          : null;
      const phantom = listed ? diagnosePhantomClaimState(remaining, `${listed.stdout}`) : undefined;
      steps.push(
        phantom
          ? {
              id: 'device-claim',
              label: 'agent-device device claim',
              status: 'todo',
              detail: joinDetail(releasedNote, `${phantom.symptom} ${phantom.detail}`),
              action: phantom.fixCommand,
            }
          : {
              id: 'device-claim',
              label: 'agent-device device claim',
              status: 'ok',
              detail: joinDetail(releasedNote, describeHeldClaims(remaining, listed !== null)),
            },
      );
    }

    // 9. Who owns the companion Metro port. Skipped entirely when nothing is
    //    bound to it (Validity brings Metro up itself) or when lsof is
    //    unavailable — probeMetroPortOwners returns [] in both cases, which is
    //    "cannot tell", not "foreign".
    const owners = await probeMetroPortOwners(run, COMPANION_METRO_PORT).catch(() => []);
    if (owners.length > 0) {
      const appDir = opts.appDir ?? resolve(opts.projectRoot, '.validity', 'native-app');
      const foreign = detectForeignMetro({
        owners,
        ownerMarker: readMetroOwnerMarker(appDir),
        appDir,
        port: COMPANION_METRO_PORT,
      });
      steps.push(
        foreign?.confidence === 'confirmed'
          ? {
              id: 'companion-metro-owner',
              label: `Companion Metro (port ${COMPANION_METRO_PORT})`,
              status: 'todo',
              detail: `${foreign.symptom} ${foreign.detail}`,
              action: foreign.fixCommand,
            }
          : {
              id: 'companion-metro-owner',
              label: `Companion Metro (port ${COMPANION_METRO_PORT})`,
              status: 'ok',
              detail: foreign
                ? // Suspected-only: the identity signals were incomplete (no
                  // readable cwd), so this is a note, not a gate.
                  `${foreign.symptom} Could not confirm ownership — if renders come back blank, check that no \`expo start\` was launched by hand on this port.`
                : `Port ${COMPANION_METRO_PORT} is served by the Validity-managed Metro.`,
            },
      );
    }
  }

  const nextAction = steps.find((s) => s.status === 'todo');
  return { ready: !nextAction, steps, nextAction };
}

/** Join the optional auto-heal note to a step detail, dropping empty halves. */
function joinDetail(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(' ');
}

/** What the claim step says once the provably-dead claims have been released. */
function describeHeldClaims(remaining: DeviceClaim[], listed: boolean): string {
  if (remaining.length === 0) return 'No device claim is held now.';
  if (!listed) return 'Could not list sessions — claim state not checked.';
  return remaining.every((c) => c.state === 'live')
    ? `${remaining.length} claim(s) held by a live agent-device process.`
    : `${remaining.length} claim(s) held, and agent-device reports live sessions for them.`;
}

/** Dim note for a daemon state that is NOT a problem (see the degradation rule). */
function describeDaemonState(daemon: ReturnType<typeof probeAgentDeviceDaemon>): string {
  switch (daemon.state) {
    case 'alive':
      return `Running (pid ${daemon.pid}${daemon.version ? `, v${daemon.version}` : ''}).`;
    case 'not-running':
      return 'Not running — agent-device starts it on demand.';
    case 'no-state-dir':
      return 'No ~/.agent-device state yet — nothing to check.';
    case 'unreadable':
      return 'daemon.json could not be read — skipped (an unreadable file is not a broken daemon).';
    case 'dead-pid':
      return `The recorded daemon pid ${daemon.pid} is gone, but no session or claim state was left behind — nothing to clear.`;
  }
}
