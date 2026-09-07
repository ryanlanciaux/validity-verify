import { describe, expect, it, vi } from 'vitest';
import {
  ensureAndroidReverse,
  androidReverseCommand,
  COMPANION_REVERSE_PORT,
} from './android-reverse.js';
import type { ExecResult } from './agent-device-driver.js';

const ok: ExecResult = { code: 0, stdout: '', stderr: '' };
const fail: ExecResult = { code: 1, stdout: '', stderr: 'no devices' };

describe('androidReverseCommand', () => {
  it('builds `adb reverse tcp:8082 tcp:8082` by default', () => {
    expect(androidReverseCommand()).toEqual({
      bin: 'adb',
      args: ['reverse', 'tcp:8082', 'tcp:8082'],
    });
  });

  it('pins to a device serial with -s', () => {
    expect(androidReverseCommand(COMPANION_REVERSE_PORT, 'emulator-5554').args).toEqual([
      '-s',
      'emulator-5554',
      'reverse',
      'tcp:8082',
      'tcp:8082',
    ]);
  });
});

describe('ensureAndroidReverse', () => {
  it('is a no-op on iOS (returns true without running adb)', async () => {
    const run = vi.fn(async () => ok);
    expect(await ensureAndroidReverse('ios', undefined, run)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs adb reverse on Android and returns true on success', async () => {
    const run = vi.fn(async () => ok);
    expect(await ensureAndroidReverse('android', undefined, run)).toBe(true);
    expect(run).toHaveBeenCalledWith('adb', ['reverse', 'tcp:8082', 'tcp:8082']);
  });

  it('passes the device serial through', async () => {
    const run = vi.fn(async () => ok);
    await ensureAndroidReverse('android', 'emulator-5554', run);
    expect(run).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'reverse',
      'tcp:8082',
      'tcp:8082',
    ]);
  });

  it('returns false (does not throw) when adb fails', async () => {
    const run = vi.fn(async () => fail);
    expect(await ensureAndroidReverse('android', undefined, run)).toBe(false);
  });

  it('returns false when the runner throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('adb not found');
    });
    expect(await ensureAndroidReverse('android', undefined, run)).toBe(false);
  });

  // agent-device 0.20.5 auto-configures host reachability for its own URL
  // opens, so Validity's forward is scoped to the case upstream does NOT cover:
  // the app/dev-client launch, after which the app itself dials the host.
  it('skips adb entirely for a `url-open` — 0.20.5 configures that path itself', async () => {
    const run = vi.fn(async () => ok);
    expect(
      await ensureAndroidReverse('android', undefined, run, COMPANION_REVERSE_PORT, 'url-open'),
    ).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('still forwards for an `app-launch`, which is also the default purpose', async () => {
    const run = vi.fn(async () => ok);
    await ensureAndroidReverse('android', undefined, run, COMPANION_REVERSE_PORT, 'app-launch');
    expect(run).toHaveBeenCalledWith('adb', ['reverse', 'tcp:8082', 'tcp:8082']);
    run.mockClear();
    await ensureAndroidReverse('android', undefined, run);
    expect(run).toHaveBeenCalledWith('adb', ['reverse', 'tcp:8082', 'tcp:8082']);
  });
});
