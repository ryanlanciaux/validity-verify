import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.js';

describe('generator identity', () => {
  it('byte-matches package.json', () => {
    // `generator` is how a Validity report attributes a manifest to a specific
    // plugin build. A literal that drifts from the manifest would make that
    // attribution a lie, so the mirror is tested rather than trusted.
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      version: string;
    };
    expect(PLUGIN_NAME).toBe(manifest.name);
    expect(PLUGIN_VERSION).toBe(manifest.version);
  });
});
