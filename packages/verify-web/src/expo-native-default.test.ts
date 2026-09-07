/**
 * The React Native rule, at the layer that can't be talked out of it.
 *
 * `resolveTarget` is the single funnel every web render passes through
 * (verify isolation, browse, the fidelity harness). If it silently maps a
 * detected Expo project onto `react-native-web`, then no amount of prompt
 * wording upstream stops a mobile app from being "verified" in a browser —
 * the screenshots come back green and nothing in the report says which
 * runtime produced them. So the refusal lives here, and an Expo Web render
 * requires the user to have said so.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExpoWebNotRequestedError, resolveTarget } from './render.js';

const dirs: string[] = [];
function project(pkg: object, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-expo-default-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const expoProject = () =>
  project({ dependencies: { expo: '51', 'react-native': '0.74', 'react-native-web': '0.19' } });

describe('resolveTarget — React Native / Expo', () => {
  it('refuses to auto-map a detected Expo project onto react-native-web', () => {
    expect(() => resolveTarget('auto', expoProject())).toThrow(ExpoWebNotRequestedError);
  });

  it('names both ways forward in the refusal', () => {
    let message = '';
    try {
      resolveTarget('auto', expoProject());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('native');
    expect(message).toContain("framework: 'expo-web'");
  });

  it("refuses a web render when the project pins 'expo-native'", () => {
    expect(() => resolveTarget('expo-native', expoProject())).toThrow(ExpoWebNotRequestedError);
  });

  it("honours an explicit 'expo-web' pin — the refusal is about silence, not about the target", () => {
    expect(resolveTarget('expo-web', expoProject())).toBe('expo-web');
  });

  it('leaves web toolchains alone', () => {
    expect(resolveTarget('auto', project({ dependencies: { vite: '6' } }))).toBe('web');
    expect(resolveTarget('auto', project({ dependencies: { next: '15' } }))).toBe('next-web');
    expect(resolveTarget('vite', expoProject())).toBe('web');
  });
});
