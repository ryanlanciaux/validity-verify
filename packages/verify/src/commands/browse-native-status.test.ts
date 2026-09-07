/**
 * `validity browse --native` must surface the authoritative render status —
 * a device {ok:false} ack or an unconfirmed settle fall-through used to print
 * the same green "Opened …" as a real render. These tests pin the formatted
 * output (and the failed flag that drives a non-zero exit code) at the
 * function boundary, mirroring export.test.ts's approach.
 */
import { describe, expect, it } from 'vitest';
import { formatBridgePortHeld, formatNativeRenderStatus } from './browse.js';
import { BridgePortHeldError } from '@validity.ai/verify-native';

describe('formatNativeRenderStatus', () => {
  it('confirmed → green "Opened …" naming the confirmation mechanism', () => {
    const status = formatNativeRenderStatus(
      { status: 'confirmed', via: 'bridge-ack', token: 'nav-x-1' },
      'src/Button.tsx',
      'Validity',
      'ios',
    );
    expect(status.failed).toBe(false);
    expect(status.text).toContain('Opened src/Button.tsx');
    expect(status.text).toContain('render confirmed (bridge-ack)');
  });

  it('failed → device error verbatim + rebuild hint, flagged for a non-zero exit', () => {
    const status = formatNativeRenderStatus(
      {
        status: 'failed',
        via: 'bridge-ack',
        token: 'nav-x-2',
        error: 'No component registered for "src/Nope.tsx"',
      },
      'src/Nope.tsx',
      'Validity',
      'ios',
    );
    expect(status.failed).toBe(true);
    expect(status.text).toContain('Render FAILED for src/Nope.tsx');
    expect(status.text).toContain('No component registered for "src/Nope.tsx"');
    expect(status.text).toContain('validity browse --native');
    expect(status.text).not.toContain('Opened');
  });

  it('unconfirmed → explicit UNCONFIRMED warning with the reason, not a silent success', () => {
    const status = formatNativeRenderStatus(
      {
        status: 'unconfirmed',
        via: 'settle',
        token: 'nav-x-3',
        error: 'render marker "validity-root:nav-x-3" did not appear within 3500ms',
      },
      'view "Cards"',
      'Validity',
      'android',
    );
    expect(status.failed).toBe(false);
    expect(status.text).toContain('render UNCONFIRMED');
    expect(status.text).toContain('did not appear within 3500ms');
  });
});

describe('formatBridgePortHeld', () => {
  it('keeps the machine-readable BRIDGE_PORT_HELD message verbatim and first, plus the unblock', () => {
    const text = formatBridgePortHeld(
      new BridgePortHeldError('port 8083 is held by a process that is not a Validity bridge'),
    );
    expect(text).toMatch(/BRIDGE_PORT_HELD: port 8083 is held/);
    expect(text).toContain('Nothing was rendered');
    expect(text).toContain('re-run');
  });
});
