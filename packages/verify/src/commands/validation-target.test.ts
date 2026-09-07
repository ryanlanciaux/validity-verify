/**
 * `validationTargetCheck` — the upgrade path for projects configured BEFORE
 * React Native defaulted to the device.
 *
 * `validity init` never rewrites an existing `.validity/config.ts`, so such a
 * project keeps `renderMode: 'web'` forever. Interactive verify self-heals
 * (it routes on detection, not on the stale value), which is exactly what
 * makes this worth a check: nothing appears wrong until `verify --all` fails
 * in CI on a spec that was stamped `runtime: 'web'` at creation. This check
 * is where that gets named, while the user is still at their terminal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validationTargetCheck } from './doctor.js';

const dirs: string[] = [];

function project(
  deps: Record<string, string>,
  config: { renderMode: string; framework: string } | null,
  specs: Array<{ id: string; runtime: string }> = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-target-check-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }));
  if (config) {
    mkdirSync(join(dir, '.validity'), { recursive: true });
    writeFileSync(
      join(dir, '.validity/config.ts'),
      `export default {\n` +
        `  renderMode: '${config.renderMode}' as const,\n` +
        `  framework: '${config.framework}' as const,\n` +
        `  wrapper: './.validity/wrapper.gen.tsx',\n` +
        `  components: {},\n` +
        `};\n`,
    );
  }
  for (const s of specs) {
    const d = resolve(dir, '.validity/specs', s.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'spec.yaml'),
      `id: ${s.id}\nversion: 1\nstatus: frozen\nruntime: ${s.runtime}\n`,
    );
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EXPO = { expo: '51', 'react-native': '0.74' };

describe('validationTargetCheck', () => {
  it('warns when a React Native project still carries a web config', async () => {
    const c = await validationTargetCheck(project(EXPO, { renderMode: 'web', framework: 'auto' }));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain("renderMode: 'native'");
    expect(c.detail).toContain("framework: 'expo-native'");
  });

  it('names the failure that is coming, not just the mismatch', async () => {
    // The point of the check: connect a config value nobody looks at to the
    // CI failure it will cause days later.
    const c = await validationTargetCheck(project(EXPO, { renderMode: 'web', framework: 'auto' }));
    expect(c.detail).toContain('verify --all');
    expect(c.detail).toContain("runtime: 'web'");
  });

  it('counts and names the existing specs that need retargeting', async () => {
    const c = await validationTargetCheck(
      project(EXPO, { renderMode: 'web', framework: 'auto' }, [
        { id: 'spec-aaaa', runtime: 'web' },
        { id: 'spec-bbbb', runtime: 'web' },
        { id: 'spec-cccc', runtime: 'native' },
      ]),
    );
    expect(c.detail).toContain('2 existing spec(s)');
    expect(c.detail).toContain('spec-aaaa');
    expect(c.detail).toContain('spec-bbbb');
    expect(c.detail).not.toContain('spec-cccc');
  });

  it('passes a correctly retargeted React Native project', async () => {
    const c = await validationTargetCheck(
      project(EXPO, { renderMode: 'native', framework: 'expo-native' }),
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('simulator/emulator');
  });

  it('passes an explicit Expo Web opt-in without nagging', async () => {
    // The user asked for the proxy; the check states what it is and moves on.
    const c = await validationTargetCheck(
      project(EXPO, { renderMode: 'web', framework: 'expo-web' }),
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('react-native-web');
  });

  it('passes a plain web project', async () => {
    const c = await validationTargetCheck(
      project({ vite: '6', react: '18' }, { renderMode: 'web', framework: 'auto' }),
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('web sandbox');
  });

  it('warns on the mirror mistake — a web project pinned to native', async () => {
    const c = await validationTargetCheck(
      project({ vite: '6' }, { renderMode: 'native', framework: 'expo-native' }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('no device path');
  });

  it('degrades to info when the config cannot be loaded', async () => {
    const c = await validationTargetCheck(project(EXPO, null));
    expect(c.status).toBe('info');
  });
});
