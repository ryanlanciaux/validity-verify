/**
 * `verify` on a React Native / Expo project must land on the DEVICE.
 *
 * This is the dispatch-level half of the rule enforced in the sandbox by
 * `resolveTarget`: the mode chosen before any render happens. If isolation
 * mode were still the default here, an RN project would take the web path,
 * hit the sandbox refusal, and surface as an error instead of simply running
 * on the simulator — right when the user asked for the ordinary thing.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeIsDefaultTarget } from './server.js';

const dirs: string[] = [];
function project(deps: Record<string, string>, configSource?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-routing-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }));
  if (configSource) {
    mkdirSync(join(dir, '.validity'), { recursive: true });
    writeFileSync(join(dir, '.validity/config.ts'), configSource);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const config = (framework: string) =>
  `export default {\n` +
  `  renderMode: '${framework === 'expo-native' ? 'native' : 'web'}' as const,\n` +
  `  framework: '${framework}' as const,\n` +
  `  wrapper: './.validity/wrapper.gen.tsx',\n` +
  `  components: {},\n` +
  `};\n`;

const EXPO = { expo: '51', 'react-native': '0.74', 'react-native-web': '0.19' };

describe('nativeIsDefaultTarget', () => {
  it('routes an Expo project to the device with no config at all', async () => {
    // The virgin first-run case — the one where a wrong default does the most
    // damage, because nobody has stated an intent yet.
    await expect(nativeIsDefaultTarget(project(EXPO))).resolves.toBe(true);
  });

  it('routes a bare React Native project to the device', async () => {
    await expect(nativeIsDefaultTarget(project({ 'react-native': '0.74' }))).resolves.toBe(true);
  });

  it("respects an explicit 'expo-web' pin", async () => {
    await expect(nativeIsDefaultTarget(project(EXPO, config('expo-web')))).resolves.toBe(false);
  });

  it("stays on the device for an 'expo-native' pin", async () => {
    await expect(nativeIsDefaultTarget(project(EXPO, config('expo-native')))).resolves.toBe(true);
  });

  it('leaves web projects on the sandbox', async () => {
    await expect(nativeIsDefaultTarget(project({ vite: '6', react: '18' }))).resolves.toBe(false);
    await expect(nativeIsDefaultTarget(project({ next: '15' }))).resolves.toBe(false);
  });
});
