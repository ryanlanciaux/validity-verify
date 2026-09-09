/**
 * cliVersionString formats the CLI's package version with the core build stamp.
 * Workspace dependencies may already have a tsc build stamp.
 */
import { readFileSync } from 'node:fs';
import { getBuildStamp } from '@validity.ai/verify-spec';
import { describe, expect, it } from 'vitest';
import { cliVersionString } from './version.js';

describe('cliVersionString', () => {
  it('uses the package version and shared build identity', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(cliVersionString()).toBe(`${pkg.version}+${getBuildStamp() ?? 'dev'}`);
  });
});
