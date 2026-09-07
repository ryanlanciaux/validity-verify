/**
 * Native `expect.screenshot` baseline diff → verdict upgrade.
 *
 * The native check executor stubs every `expect.screenshot` as `unverifiable`
 * (it can't run the pixel diff). Before Item 6 nothing upgraded that stub, so a
 * native screenshot check could never pass OR fail — a permanent false-NEITHER.
 * `applyNativeScreenshotDiff` wires the verify-run's diff into those stubs
 * (parity with web's capture.ts). These tests pin the seam, especially the
 * required false-green negative: the gate MUST be able to actually FAIL.
 */
import { describe, expect, it } from 'vitest';
import type { CriterionVerdict } from '@validity.ai/verify-spec';
import { applyNativeScreenshotDiff } from './server.js';

/** A criterion verdict carrying a single `expect.screenshot` stub. */
function screenshotVerdict(maxDiffPixels?: number): CriterionVerdict {
  return {
    id: 'AC-1',
    tier: 'hard',
    status: 'unverifiable',
    detail: 'no baseline exists yet for this variant',
    checks: [
      {
        check: {
          expect:
            maxDiffPixels === undefined ? { screenshot: {} } : { screenshot: { maxDiffPixels } },
        },
        status: 'unverifiable',
        detail: 'no baseline exists yet for this variant',
      },
    ],
  };
}

describe('applyNativeScreenshotDiff', () => {
  it('PASS under threshold: a small diff upgrades the stub to pass', () => {
    const v = screenshotVerdict(10);
    applyNativeScreenshotDiff([v], { mismatchedPixels: 5 });
    expect(v.checks?.[0]?.status).toBe('pass');
    expect(v.status).toBe('pass');
  });

  it('FALSE-GREEN NEGATIVE: a diff over threshold makes the screenshot gate FAIL', () => {
    // Default maxDiffPixels (0) with a big mismatch — this is the test that
    // proves the native screenshot check can actually fail. Without the wiring
    // it stayed permanently unverifiable.
    const v = screenshotVerdict(undefined);
    applyNativeScreenshotDiff([v], { mismatchedPixels: 500 });
    expect(v.checks?.[0]?.status).toBe('fail');
    expect(v.status).toBe('fail');
  });

  it('threshold boundary: exact-match semantics at maxDiffPixels 0', () => {
    const exact = screenshotVerdict(0);
    applyNativeScreenshotDiff([exact], { mismatchedPixels: 0 });
    expect(exact.status).toBe('pass');

    const offByOne = screenshotVerdict(0);
    applyNativeScreenshotDiff([offByOne], { mismatchedPixels: 1 });
    expect(offByOne.status).toBe('fail');
  });

  it('STICKY TAINT: a network-tainted verdict is NOT laundered to pass by a passing screenshot', () => {
    const v: CriterionVerdict = {
      id: 'AC-2',
      tier: 'hard',
      status: 'unverifiable',
      networkTainted: true,
      checks: [
        {
          check: { expect: { screenshot: { maxDiffPixels: 100 } } },
          status: 'unverifiable',
          detail: 'no baseline yet',
        },
      ],
    };
    applyNativeScreenshotDiff([v], { mismatchedPixels: 0 });
    // The screenshot check passes, but the criterion stays unverifiable because
    // an earlier expect.network consumed fabricated evidence.
    expect(v.checks?.[0]?.status).toBe('pass');
    expect(v.status).toBe('unverifiable');
  });

  it('no screenshot check: a verdict without expect.screenshot is left untouched', () => {
    const v: CriterionVerdict = {
      id: 'AC-3',
      tier: 'hard',
      status: 'pass',
      checks: [
        {
          check: { expect: { element: { role: 'button' } } },
          status: 'pass',
          detail: 'button present',
        },
      ],
    };
    const before = JSON.stringify(v);
    applyNativeScreenshotDiff([v], { mismatchedPixels: 9999 });
    expect(JSON.stringify(v)).toBe(before);
  });

  it('safe no-op: undefined verdicts and a checkless soft verdict do not throw', () => {
    expect(() => applyNativeScreenshotDiff(undefined, { mismatchedPixels: 1 })).not.toThrow();
    const soft: CriterionVerdict = { id: 'AC-4', tier: 'soft', status: 'unverifiable' };
    expect(() => applyNativeScreenshotDiff([soft], { mismatchedPixels: 1 })).not.toThrow();
    expect(soft.status).toBe('unverifiable');
  });
});
