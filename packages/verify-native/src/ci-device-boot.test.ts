/**
 * Tests for the CI device-boot lifecycle. NONE of these boot a real emulator —
 * they exercise the error paths (missing binary, missing APK, boot timeout) and
 * the teardown shape, so the orchestration is verified without an Android SDK
 * install. The headline test is the MUST-NOT-FALSE-POSITIVE binary detection
 * (a fake `emulator`/`adb` on PATH must be FOUND, not wrongly reported missing)
 * — the regression guard for the OS-model `command -v` bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  bootAndroidEmulator,
  installCompanion,
  teardownEmulator,
  type BootedEmulator,
} from './ci-device-boot.js';

const originalHome = process.env.ANDROID_HOME;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHome !== undefined) process.env.ANDROID_HOME = originalHome;
  else delete process.env.ANDROID_HOME;
  process.env.PATH = originalPath;
});

/** Write a tiny no-op shell executable at `dir/<name>` so it's discoverable on
 * PATH. The body exits immediately — we never actually drive a device. */
function writeFakeBinary(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('ci-device-boot — binary detection (missing)', () => {
  beforeEach(() => {
    delete process.env.ANDROID_HOME;
    // No $ANDROID_HOME and PATH points at an empty dir → nothing to find.
    process.env.PATH = '/nonexistent';
  });

  it('bootAndroidEmulator throws a clear error when the emulator binary is missing', async () => {
    await expect(bootAndroidEmulator({ avdName: 'test', bootTimeoutSec: 1 })).rejects.toThrow(
      /emulator binary not found/,
    );
  });

  it('installCompanion throws a clear error when adb is missing (APK exists)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'validity-ci-boot-'));
    try {
      const apk = join(dir, 'companion.apk');
      writeFileSync(apk, 'fake apk bytes');
      await expect(installCompanion({ apkPath: apk })).rejects.toThrow(/adb binary not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ci-device-boot — binary detection MUST NOT false-positive', () => {
  // Guards the OS-model `command -v` bug: with the tools present on PATH but NO
  // $ANDROID_HOME, detection must FIND them — `bootAndroidEmulator` gets PAST
  // detection and fails later at the boot wait (timeout), NOT at "binary not
  // found". A regression to `command -v` would throw "emulator binary not
  // found" here and fail this test.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validity-ci-bin-'));
    writeFakeBinary(dir, 'emulator');
    writeFakeBinary(dir, 'adb');
    delete process.env.ANDROID_HOME;
    process.env.PATH = dir; // ONLY the fake binaries on PATH, no real SDK.
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves emulator+adb on PATH and proceeds to the boot wait (not "not found")', async () => {
    // The fake adb always exits 0, so wait-for-device "succeeds" but
    // boot_completed never reports 1 → a clear boot timeout, proving detection
    // found the binaries (it never threw "binary not found").
    await expect(bootAndroidEmulator({ avdName: 'fake-avd', bootTimeoutSec: 0 })).rejects.toThrow(
      /did not finish booting|wait-for-device timed out/,
    );
  });

  it('installCompanion finds adb on PATH and reaches adb install', async () => {
    // The fake adb exits 0 for `install -r`, so installCompanion resolves
    // without throwing "adb binary not found" — detection found it on PATH.
    const apk = join(dir, 'companion.apk');
    writeFileSync(apk, 'fake apk bytes');
    await expect(installCompanion({ apkPath: apk })).resolves.toBeUndefined();
  });
});

describe('ci-device-boot — installCompanion APK-first ordering', () => {
  it('throws "companion APK not found" BEFORE any adb lookup', async () => {
    // No $ANDROID_HOME and an empty PATH → adb is "missing" too. The APK check
    // must run first, so we see the APK error, not the adb error.
    delete process.env.ANDROID_HOME;
    process.env.PATH = '/nonexistent';
    await expect(installCompanion({ apkPath: '/definitely/does/not/exist.apk' })).rejects.toThrow(
      /companion APK not found/,
    );
  });
});

describe('ci-device-boot — teardown', () => {
  it('teardownEmulator(undefined) is a safe no-op', async () => {
    await expect(teardownEmulator(undefined)).resolves.toBeUndefined();
  });

  it('teardownEmulator SIGTERMs the child even when adb is missing', async () => {
    delete process.env.ANDROID_HOME;
    process.env.PATH = '/nonexistent';
    const kill = vi.fn(() => true);
    const handle: BootedEmulator = {
      deviceId: 'emulator-9999',
      port: 9999,
      child: { kill } as unknown as ChildProcess,
    };
    await expect(teardownEmulator(handle)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('teardownEmulator swallows a child.kill that throws (already exited)', async () => {
    delete process.env.ANDROID_HOME;
    process.env.PATH = '/nonexistent';
    const kill = vi.fn(() => {
      throw new Error('already dead');
    });
    const handle: BootedEmulator = {
      deviceId: 'emulator-1',
      port: 1,
      child: { kill } as unknown as ChildProcess,
    };
    await expect(teardownEmulator(handle)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalled();
  });
});
