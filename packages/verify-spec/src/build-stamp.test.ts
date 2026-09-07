/**
 * getBuildStamp / formatBuildVersion. In production esbuild's `define` replaces
 * the `__VALIDITY_BUILD_STAMP__` free identifier; there is no define under
 * vitest, so we simulate a stamped build by writing the global that the free
 * identifier resolves to, and an unstamped dev build by deleting it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatBuildVersion, getBuildStamp } from './build-stamp.js';

const G = globalThis as Record<string, unknown>;

afterEach(() => {
  delete G.__VALIDITY_BUILD_STAMP__;
});

describe('getBuildStamp', () => {
  it('returns undefined in an unstamped dev build', () => {
    expect(getBuildStamp()).toBeUndefined();
  });

  it('returns the injected stamp when defined', () => {
    G.__VALIDITY_BUILD_STAMP__ = 'a1b2c3d.202607081030';
    expect(getBuildStamp()).toBe('a1b2c3d.202607081030');
  });
});

describe('formatBuildVersion', () => {
  it('appends +dev when unstamped', () => {
    expect(formatBuildVersion('0.0.1')).toBe('0.0.1+dev');
  });

  it('appends +<stamp> when stamped', () => {
    G.__VALIDITY_BUILD_STAMP__ = 'a1b2c3d.202607081030';
    expect(formatBuildVersion('0.0.1')).toBe('0.0.1+a1b2c3d.202607081030');
  });
});
