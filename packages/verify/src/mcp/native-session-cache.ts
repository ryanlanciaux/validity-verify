/**
 * Warm-session cache for native_browse, scoped to the long-lived MCP process.
 *
 * WHY: every native_browse used to RE-DERIVE everything from scratch — two
 * buildCatalog scans + a font scan + ~14 generated-file writes (prepareNativeApp)
 * AND a readiness probe chain that spawns child processes (agent-device
 * --version, simctl list/get_app_container, up-to-3 `adb reverse` asserts). On a
 * warm device that floor was 3-6s of pure spawn/scan latency BEFORE the
 * screenshot, even when nothing changed since the previous call. Phase A made
 * the device's render ack authoritative, so re-deriving these facts every call
 * is now pure waste.
 *
 * The cache splits invalidation by what each fact actually depends on:
 *   - PREPARED (catalog + companion app): keyed by a source signature
 *     (config-file mtimes + the discovered source-file set). A component edit
 *     rides Fast Refresh and does NOT change the registry, so prepared is reused
 *     across edits; adding/removing a file or touching config recomputes it.
 *   - DEVICE FACTS (booted devices, the readiness checklist): these probe the
 *     environment, not the source, so they are NOT tied to the signature. They
 *     persist across calls and are nuked only by {@link invalidate} — which the
 *     handler calls on ANY capture that wasn't a clean success, and on an
 *     explicit `reload`. That "one failed capture re-derives from scratch" rule
 *     is the cheap safety net: a device that slept, a companion that was
 *     reinstalled, a killed Metro all surface as a capture miss, which clears
 *     the stale facts so the next call re-probes. The booted-device list is
 *     ADDITIONALLY platform-keyed (ios `simctl` and android `adb` return
 *     disjoint device sets) so a mid-session platform switch re-probes WITHOUT
 *     waiting for a failed capture — which it couldn't, since the readiness gate
 *     returns before a capture is attempted.
 *   - READINESS is additionally keyed by a caller-supplied string (the handler
 *     folds the build hash + pinned device into it) so a native-dep / expo
 *     config change — which flips the build hash and can make an installed
 *     companion stale — re-runs the freshness probe even though the device set
 *     is unchanged.
 *   - ADB REVERSE is asserted once per (project, device); the flag rides the
 *     same entry, so an invalidate re-asserts it on the retry.
 *
 * The cache holds only data the handler computes and feeds back in — it spawns
 * nothing and reads no files itself, so it is deterministic and unit-testable
 * with plain fakes (see native-session-cache.test.ts).
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Catalog } from '@validity.ai/verify-spec';
import { discoverComponentFiles, discoverScreenFiles } from '@validity.ai/verify-spec';
import type { BootedDevice, NativeReadiness, PrepareNativeAppResult } from '@validity.ai/verify-native';

/**
 * The host files whose edits change what prepareNativeApp emits (and therefore
 * the bundle Metro serves): the Validity config + wrappers, and the host build
 * config the companion mirrors (deps, aliases, expo/metro/babel config). A
 * change to any of these must recompute the prepared bundle.
 */
const SIGNATURE_CONFIG_FILES = [
  '.validity/config.ts',
  '.validity/config.js',
  '.validity/wrapper.tsx',
  '.validity/wrapper.native.tsx',
  'package.json',
  'tsconfig.json',
  'app.json',
  'app.config.js',
  'app.config.ts',
  'metro.config.js',
  'metro.config.cjs',
  'babel.config.js',
  'babel.config.cjs',
];

/**
 * A cheap signature of the native source inputs: the mtime+size of the config
 * files above plus the discovered component/screen path SET. Adding, removing,
 * or renaming a source file changes the set (a new component must appear in the
 * registry); editing an existing component's BODY does not — that rides Fast
 * Refresh and never changes the generated registry, so it correctly reuses the
 * cached prepared bundle. Stats files (no child processes), so it never spends
 * the simctl/agent-device budget the cache exists to save. `scheme` is folded
 * in because it is baked into the generated app.config and the deep links.
 */
export function computeNativeSourceSignature(projectRoot: string, scheme?: string): string {
  const hash = createHash('sha256');
  hash.update(`scheme:${scheme ?? ''}\n`);
  for (const rel of SIGNATURE_CONFIG_FILES) {
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(resolve(projectRoot, rel));
    } catch {
      stat = undefined;
    }
    hash.update(`${rel}:${stat ? `${stat.mtimeMs}:${stat.size}` : 'absent'}\n`);
  }
  let components: string[] = [];
  let screens: string[] = [];
  try {
    components = discoverComponentFiles(projectRoot);
  } catch {
    components = [];
  }
  try {
    screens = discoverScreenFiles(projectRoot).map((s) => s.path);
  } catch {
    screens = [];
  }
  hash.update('components\n');
  for (const p of [...components].sort()) hash.update(`${p}\n`);
  hash.update('screens\n');
  for (const p of [...screens].sort()) hash.update(`${p}\n`);
  return hash.digest('hex');
}

/** The source-derived output reused across calls with an unchanged signature. */
export interface NativePreparedBundle {
  catalog: Catalog;
  app: PrepareNativeAppResult;
}

interface ProjectEntry {
  /** Signature of the source inputs `prepared` was derived from. */
  signature: string;
  prepared: NativePreparedBundle;
  /** Probed booted-device list (device fact — survives a source change). */
  bootedDevices?: BootedDevice[];
  /**
   * The platform `bootedDevices` was probed for. `simctl` (ios) and `adb`
   * (android) return DISJOINT device sets, so a mid-session platform switch
   * must re-probe — reusing the iOS list for an Android call would pin an iOS
   * udid into an Android driver, and the resulting readiness checklist (not a
   * capture) returns BEFORE the invalidate-on-failure net can fire, stranding
   * the session. Tracking the platform here keeps that switch self-healing.
   */
  bootedPlatform?: string;
  /** The key `readiness` was computed for (device + build hash); see class docs. */
  readinessKey?: string;
  readiness?: NativeReadiness;
  /** The device `adb reverse` was last asserted for this session. */
  adbReversedDevice?: string;
}

/** `{ value, reused }` — `reused: true` means the compute callback did NOT run. */
export interface CacheLookup<T> {
  value: T;
  reused: boolean;
}

export class NativeSessionCache {
  private readonly byRoot = new Map<string, ProjectEntry>();

  /**
   * Get-or-compute the prepared bundle, keyed by `signature`. The compute
   * callback (buildCatalog + prepareNativeApp) runs ONLY on a miss or a
   * signature change. A source change recomputes `prepared` but PRESERVES the
   * device facts (they don't depend on source) — the handler's readinessKey
   * still re-runs readiness if the build hash moved.
   */
  prepared(
    projectRoot: string,
    signature: string,
    compute: () => NativePreparedBundle,
  ): CacheLookup<NativePreparedBundle> {
    const prev = this.byRoot.get(projectRoot);
    if (prev && prev.signature === signature) {
      return { value: prev.prepared, reused: true };
    }
    const prepared = compute();
    this.byRoot.set(projectRoot, {
      signature,
      prepared,
      // Carry device facts forward across a pure source change.
      bootedDevices: prev?.bootedDevices,
      bootedPlatform: prev?.bootedPlatform,
      readinessKey: prev?.readinessKey,
      readiness: prev?.readiness,
      adbReversedDevice: prev?.adbReversedDevice,
    });
    return { value: prepared, reused: false };
  }

  /**
   * Get-or-compute the booted-device list for `platform`. Cached until
   * {@link invalidate} OR a platform switch (the cached list is for the OTHER
   * platform's disjoint device set — see ProjectEntry.bootedPlatform). A switch
   * also resets the adb-reverse flag: the new platform's devices have different
   * ids, so the forward must be re-asserted. Requires a prepared entry to exist
   * first (the handler always resolves prepared before probing devices) — if it
   * doesn't, the result is returned uncached (degrade, never throw).
   */
  async bootedDevices(
    projectRoot: string,
    platform: string,
    compute: () => Promise<BootedDevice[]>,
  ): Promise<CacheLookup<BootedDevice[]>> {
    const entry = this.byRoot.get(projectRoot);
    if (entry?.bootedDevices && entry.bootedPlatform === platform) {
      return { value: entry.bootedDevices, reused: true };
    }
    const devices = await compute();
    if (entry) {
      // A platform switch invalidates the device facts derived from the OLD
      // platform (readiness re-keys on platform itself; adb reverse must re-run
      // for the new device ids).
      if (entry.bootedPlatform !== undefined && entry.bootedPlatform !== platform) {
        entry.adbReversedDevice = undefined;
      }
      entry.bootedDevices = devices;
      entry.bootedPlatform = platform;
    }
    return { value: devices, reused: false };
  }

  /**
   * Get-or-compute the readiness checklist, keyed by `key` (the handler folds
   * the pinned device + build hash into it). Recomputes when the key changes so
   * a native-dep/expo-config bump re-probes companion freshness.
   */
  async readiness(
    projectRoot: string,
    key: string,
    compute: () => Promise<NativeReadiness>,
  ): Promise<CacheLookup<NativeReadiness>> {
    const entry = this.byRoot.get(projectRoot);
    if (entry?.readiness && entry.readinessKey === key) {
      return { value: entry.readiness, reused: true };
    }
    const readiness = await compute();
    if (entry) {
      entry.readiness = readiness;
      entry.readinessKey = key;
    }
    return { value: readiness, reused: false };
  }

  /**
   * True until `adb reverse` has been asserted for this (project, device) — the
   * capture flow forwards Metro/bridge ports once per session, not per call.
   * Always true for an unknown project (no entry yet).
   */
  needsAdbReverse(projectRoot: string, device: string | undefined): boolean {
    const entry = this.byRoot.get(projectRoot);
    return !(entry && entry.adbReversedDevice === device);
  }

  /** Record that `adb reverse` has been asserted for this (project, device). */
  markAdbReversed(projectRoot: string, device: string | undefined): void {
    const entry = this.byRoot.get(projectRoot);
    if (entry) entry.adbReversedDevice = device;
  }

  /**
   * Nuke the whole entry. The handler calls this on ANY non-clean capture
   * (thrown error, or a render status that isn't 'confirmed') and on an explicit
   * `reload` — so one bad capture forces a full re-derivation (prepared + device
   * facts + adb reverse) on the next call.
   */
  invalidate(projectRoot: string): void {
    this.byRoot.delete(projectRoot);
  }
}
