/**
 * cliVersionString formats the CLI's package version with the core build stamp.
 * Under vitest there is no esbuild define, so the stamp is absent → +dev.
 */
import { describe, expect, it } from 'vitest';
import { cliVersionString } from './version.js';

describe('cliVersionString', () => {
  it('is <pkgVersion>+dev in an unstamped (local) build', () => {
    expect(cliVersionString()).toBe('0.0.1+dev');
  });
});
