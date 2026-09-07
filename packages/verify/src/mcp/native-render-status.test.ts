/**
 * The native_browse response must never present an unconfirmed/failed render
 * as evidence — a headless agent scores whatever it's handed, so the status
 * block has to be machine-readable (stable `RENDER_*:` prefixes), carry the
 * device error verbatim, and name a concrete next action. The same policy
 * covers device identity: an ambiguous booted-device set is a machine-readable
 * MULTIPLE_DEVICES error (never an arbitrary pick), and a bridge hello whose
 * identity contradicts the pinned device surfaces as a DEVICE_MISMATCH warning.
 */
import { describe, expect, it } from 'vitest';
import {
  bridgePortHeldBlock,
  deviceMismatchWarning,
  multipleDevicesBlock,
  nativeRenderStatusBlock,
} from './server.js';
import { BridgePortHeldError } from '@validity.ai/verify-native';

describe('nativeRenderStatusBlock', () => {
  it('confirmed → no header, screenshot is evidence', () => {
    const block = nativeRenderStatusBlock({
      status: 'confirmed',
      via: 'bridge-ack',
      token: 'nav-x-1',
    });
    expect(block.header).toBe('');
    expect(block.attachScreenshot).toBe(true);
  });

  it('failed → RENDER_FAILED header with the device error VERBATIM and no screenshot', () => {
    const block = nativeRenderStatusBlock({
      status: 'failed',
      via: 'bridge-ack',
      token: 'nav-x-2',
      error: 'No component registered for "src/Nope.tsx"',
    });
    expect(block.header).toMatch(/^RENDER_FAILED: No component registered for "src\/Nope\.tsx"/);
    expect(block.header).toContain('nav-x-2');
    // Concrete next actions: fresh bundle first, rebuild second.
    expect(block.header).toContain('reload: true');
    expect(block.header).toContain('validity browse --native');
    expect(block.attachScreenshot).toBe(false);
  });

  it('unconfirmed → RENDER_UNCONFIRMED header, screenshot attached for debugging only', () => {
    const block = nativeRenderStatusBlock({
      status: 'unconfirmed',
      via: 'settle',
      token: 'nav-x-3',
      error: 'render marker "validity-root:nav-x-3" did not appear within 3500ms',
    });
    expect(block.header).toMatch(/^RENDER_UNCONFIRMED: render marker/);
    expect(block.header).toMatch(/do not score it/i);
    expect(block.header).toContain('reload: true');
    expect(block.attachScreenshot).toBe(true);
  });

  it('degrades gracefully when no error detail is available', () => {
    const failed = nativeRenderStatusBlock({ status: 'failed', via: 'bridge-ack' });
    expect(failed.header).toMatch(/^RENDER_FAILED: the device reported a failed render/);
    const unconfirmed = nativeRenderStatusBlock({ status: 'unconfirmed', via: 'settle' });
    expect(unconfirmed.header).toMatch(/^RENDER_UNCONFIRMED: the device never confirmed/);
  });
});

describe('bridgePortHeldBlock', () => {
  it('leads with the machine-readable BRIDGE_PORT_HELD error verbatim and names the unblock', () => {
    const block = bridgePortHeldBlock(
      new BridgePortHeldError('port 8083 is held by a process that is not a Validity bridge'),
    );
    expect(block).toMatch(/^BRIDGE_PORT_HELD: port 8083 is held/);
    expect(block).toContain('nothing was captured');
    expect(block).toContain('Next action');
  });
});

describe('multipleDevicesBlock', () => {
  it('leads with the machine-readable MULTIPLE_DEVICES header and lists udids + names', () => {
    const block = multipleDevicesBlock(
      [
        { id: 'UDID-PHONE', name: 'iPhone 15' },
        { id: 'UDID-PAD', name: 'iPad Pro' },
      ],
      'ios',
    );
    expect(block).toMatch(/^MULTIPLE_DEVICES: 2 ios simulators/);
    expect(block).toContain('UDID-PHONE');
    expect(block).toContain('iPhone 15');
    expect(block).toContain('UDID-PAD');
    expect(block).toContain('iPad Pro');
    // The retry is a copy-paste: the `device` arg with the platform's id kind.
    expect(block).toContain('device: "<udid>"');
    expect(block).toContain('Next action');
  });

  it('names the android id kind (serial)', () => {
    const block = multipleDevicesBlock(
      [
        { id: 'emulator-5554', name: 'Pixel 7' },
        { id: 'emulator-5556', name: 'Pixel 8' },
      ],
      'android',
    );
    expect(block).toMatch(/^MULTIPLE_DEVICES: 2 android/);
    expect(block).toContain('device: "<serial>"');
  });
});

describe('deviceMismatchWarning', () => {
  it('warns when the bridge hello platform differs from the pinned device platform', () => {
    const warning = deviceMismatchWarning(
      { platform: 'android', deviceId: 'install-1' },
      'ios',
      'UDID-PHONE',
    );
    expect(warning).toMatch(/^DEVICE_MISMATCH:/);
    expect(warning).toContain('"android"');
    expect(warning).toContain('ios device UDID-PHONE');
    expect(warning).toContain('DIFFERENT devices');
  });

  it('returns null on matching platforms, no hello, or a bare hello (old companion — no signal)', () => {
    expect(deviceMismatchWarning({ platform: 'ios' }, 'ios', 'UDID-PHONE')).toBeNull();
    expect(deviceMismatchWarning(null, 'ios', 'UDID-PHONE')).toBeNull();
    // Old companions send a hello without identity fields — must never warn.
    expect(deviceMismatchWarning({}, 'ios', 'UDID-PHONE')).toBeNull();
  });
});
