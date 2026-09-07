import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLUGIN_VERSION } from './version.js';

describe('PLUGIN_VERSION', () => {
  it('byte-matches package.json', () => {
    // The stamp this plugin writes into `expo.extra.validity.pluginVersion` is
    // how a Validity readiness check reports which plugin build produced a
    // config. A literal that drifts from the manifest would make that report a
    // lie, so the mirror is tested (same discipline as the skill/help-text
    // byte-mirrors elsewhere in this repo).
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version: string };
    expect(PLUGIN_VERSION).toBe(manifest.version);
  });
});
