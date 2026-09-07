import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAppTarget, detectExportAppId } from './app-target.js';

const dirs: string[] = [];
function project(pkg: object, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-target-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('detectAppTarget', () => {
  it('routes a Vite app to web (no native)', () => {
    const t = detectAppTarget(project({ dependencies: { vite: '6', react: '18' } }));
    expect(t.kind).toBe('vite');
    expect(t.recommended).toBe('web');
    expect(t.nativeAvailable).toBe(false);
  });

  it('routes a Next.js app to web', () => {
    const t = detectAppTarget(project({ dependencies: { next: '15' } }));
    expect(t.kind).toBe('next');
    expect(t.recommended).toBe('web');
  });

  it('routes an Expo app to NATIVE by default — expo-web is never auto-picked', () => {
    const t = detectAppTarget(project({ dependencies: { expo: '51', 'react-native': '0.74' } }));
    expect(t.kind).toBe('expo');
    expect(t.recommended).toBe('native');
    expect(t.nativeAvailable).toBe(true);
    expect(t.webTargetExplicit).toBe(false);
    expect(t.modes).toEqual(['native', 'expo-web']);
  });

  it('routes an Expo app to expo-web when the config pins it', () => {
    const t = detectAppTarget(project({ dependencies: { expo: '51', 'react-native': '0.74' } }), {
      configFramework: 'expo-web',
    });
    expect(t.recommended).toBe('expo-web');
    expect(t.webTargetExplicit).toBe(true);
    expect(t.modes).toEqual(['expo-web', 'native']);
  });

  it('routes an Expo app to expo-web on an explicit per-call web flag', () => {
    const t = detectAppTarget(project({ dependencies: { expo: '51' } }), { webTargetFlag: true });
    expect(t.recommended).toBe('expo-web');
    expect(t.webTargetExplicit).toBe(true);
  });

  it("keeps native when the config pins 'expo-native'", () => {
    const t = detectAppTarget(project({ dependencies: { expo: '51' } }), {
      configFramework: 'expo-native',
    });
    expect(t.recommended).toBe('native');
    expect(t.webTargetExplicit).toBe(false);
  });

  it('treats a web-only platforms list in app.json as an explicit web target', () => {
    const t = detectAppTarget(
      project(
        { dependencies: { expo: '51' } },
        { 'app.json': JSON.stringify({ expo: { platforms: ['web'] } }) },
      ),
    );
    expect(t.recommended).toBe('expo-web');
    expect(t.webTargetExplicit).toBe(true);
  });

  it('does NOT treat a mobile platforms list that merely includes web as explicit', () => {
    const t = detectAppTarget(
      project(
        { dependencies: { expo: '51' } },
        { 'app.json': JSON.stringify({ expo: { platforms: ['ios', 'android', 'web'] } }) },
      ),
    );
    expect(t.recommended).toBe('native');
    expect(t.webTargetExplicit).toBe(false);
  });

  it('does NOT infer a web target from react-native-web being installed', () => {
    const t = detectAppTarget(
      project({
        dependencies: {
          expo: '51',
          'react-native': '0.74',
          'react-native-web': '0.19',
          'react-dom': '18',
        },
      }),
    );
    expect(t.recommended).toBe('native');
    expect(t.webTargetExplicit).toBe(false);
  });

  it('detects Expo via an app.json that declares expo, without the expo dep', () => {
    const t = detectAppTarget(
      project({ dependencies: {} }, { 'app.json': JSON.stringify({ expo: { name: 'a' } }) }),
    );
    expect(t.kind).toBe('expo');
  });

  it('does NOT read a contentless app.json as Expo', () => {
    // The filename alone used to be enough, which is how web projects carrying
    // a Heroku manifest ended up on the device path.
    const t = detectAppTarget(project({ dependencies: {} }, { 'app.json': '{}' }));
    expect(t.kind).not.toBe('expo');
    expect(t.recommended).toBe('web');
  });

  it('routes a bare React Native app to native only', () => {
    const t = detectAppTarget(project({ dependencies: { 'react-native': '0.74' } }));
    expect(t.kind).toBe('react-native');
    expect(t.recommended).toBe('native');
    expect(t.modes).toEqual(['native']);
  });

  it('falls back to web for an unknown project', () => {
    const t = detectAppTarget(project({ dependencies: { lodash: '4' } }));
    expect(t.kind).toBe('unknown');
    expect(t.recommended).toBe('web');
    expect(t.nativeAvailable).toBe(false);
  });
});

/**
 * The mirror image of the React Native rule: a WEB project must never be
 * routed to a simulator. These are all real filenames that collide with
 * Expo's, and before this guard each of them sent a web user down the
 * device path — a much worse failure than the one the RN rule prevents,
 * because there is no device coming and nothing to fall back to.
 */
describe('detectAppTarget — web projects never route to native', () => {
  const expectWeb = (dir: string) => {
    const t = detectAppTarget(dir);
    expect(t.recommended).toBe('web');
    expect(t.nativeAvailable).toBe(false);
  };

  it('ignores a Heroku app.json in a Vite project', () => {
    // Heroku's app manifest shares Expo's filename and says nothing about RN.
    expectWeb(
      project(
        { dependencies: { vite: '6', react: '18' } },
        { 'app.json': JSON.stringify({ name: 'web-app', env: {}, buildpacks: [] }) },
      ),
    );
  });

  it('ignores app.config.ts in a TanStack Start project', () => {
    // app.config.ts is TanStack Start / Solid Start / Vinxi, not just Expo.
    expectWeb(
      project(
        { dependencies: { vite: '6', '@tanstack/react-start': '1' } },
        { 'app.config.ts': 'export default defineConfig({})' },
      ),
    );
  });

  it('keeps a plain React app with an app.json on the web path', () => {
    const t = detectAppTarget(
      project(
        { dependencies: { react: '18', 'react-scripts': '5' } },
        { 'app.json': '{"name":"w"}' },
      ),
    );
    // Unsupported toolchain is the honest answer here — but it is a WEB answer.
    expect(t.kind).toBe('unknown');
    expect(t.recommended).toBe('web');
  });

  it('treats vite + react-native as the react-native-web pattern (a web app)', () => {
    expectWeb(
      project({
        dependencies: { vite: '6', 'react-native-web': '0.19', 'react-native': '0.74' },
      }),
    );
  });

  // The web side is not just Vite. Every one of these is a web app that could
  // pick up an Expo-shaped filename or a react-native-web dependency, and none
  // of them has a simulator to be sent to.
  const WEB_TOOLCHAINS: Array<[string, Record<string, string>]> = [
    ['Next.js', { next: '15' }],
    ['TanStack Start', { '@tanstack/react-start': '1' }],
    ['Remix', { '@remix-run/dev': '2' }],
    ['Astro', { astro: '5' }],
    ['Gatsby', { gatsby: '5' }],
    ['Create React App', { 'react-scripts': '5' }],
    ['Rsbuild', { '@rsbuild/core': '1' }],
    ['Vite', { vite: '6' }],
  ];

  for (const [name, deps] of WEB_TOOLCHAINS) {
    it(`keeps ${name} on web despite an Expo-shaped app.json`, () => {
      expectWeb(
        project({ dependencies: deps }, { 'app.json': JSON.stringify({ name: 'w', env: {} }) }),
      );
    });

    it(`keeps ${name} on web despite an app.config.ts`, () => {
      expectWeb(project({ dependencies: deps }, { 'app.config.ts': 'export default {}' }));
    });

    it(`keeps ${name} on web despite a react-native dependency (react-native-web)`, () => {
      expectWeb(
        project({
          dependencies: { ...deps, 'react-native': '0.74', 'react-native-web': '0.19' },
        }),
      );
    });
  }

  it('gives an unrenderable web toolchain a WEB answer, pointing at URL mode', () => {
    const t = detectAppTarget(project({ dependencies: { astro: '5' } }));
    expect(t.recommended).toBe('web');
    expect(t.nativeAvailable).toBe(false);
    expect(t.summary).toMatch(/URL mode/);
  });

  it('still routes a real Expo app to the device', () => {
    // The guard tightens the signal without weakening the rule it protects.
    const t = detectAppTarget(project({ dependencies: { expo: '51', 'react-native': '0.74' } }));
    expect(t.recommended).toBe('native');
  });

  it('accepts an app.json that literally declares expo, with no deps to read', () => {
    const t = detectAppTarget(
      project({}, { 'app.json': JSON.stringify({ expo: { name: 'a', slug: 'a' } }) }),
    );
    expect(t.kind).toBe('expo');
    expect(t.recommended).toBe('native');
  });

  it('accepts an app config alongside a react-native dependency', () => {
    const t = detectAppTarget(
      project({ dependencies: { 'react-native': '0.74' } }, { 'app.json': '{"name":"a"}' }),
    );
    expect(t.recommended).toBe('native');
  });
});

describe('detectExportAppId', () => {
  it('reads the Android package from app.json (expo-wrapped)', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      { 'app.json': JSON.stringify({ expo: { android: { package: 'com.acme.app' } } }) },
    );
    expect(detectExportAppId(dir)).toBe('com.acme.app');
  });

  it('falls back to the iOS bundle id when there is no Android package', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      { 'app.json': JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.acme.ios' } } }) },
    );
    expect(detectExportAppId(dir)).toBe('com.acme.ios');
  });

  it('prefers the Android package over the iOS bundle id', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      {
        'app.json': JSON.stringify({
          expo: {
            android: { package: 'com.acme.droid' },
            ios: { bundleIdentifier: 'com.acme.ios' },
          },
        }),
      },
    );
    expect(detectExportAppId(dir)).toBe('com.acme.droid');
  });

  it('reads a bare (non-expo-wrapped) app.json shape', () => {
    const dir = project(
      { dependencies: {} },
      { 'app.json': JSON.stringify({ android: { package: 'com.bare.app' } }) },
    );
    expect(detectExportAppId(dir)).toBe('com.bare.app');
  });

  it('regex-reads the package from a dynamic app.config.ts', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      {
        'app.config.ts':
          'export default { expo: { android: { package: "com.dyn.app" }, ios: { bundleIdentifier: "com.dyn.ios" } } };',
      },
    );
    expect(detectExportAppId(dir)).toBe('com.dyn.app');
  });

  it('falls through from a malformed app.json to app.config.js', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      {
        'app.json': '{ not valid json',
        'app.config.js': 'module.exports = { ios: { bundleIdentifier: "com.fallback.ios" } };',
      },
    );
    expect(detectExportAppId(dir)).toBe('com.fallback.ios');
  });

  it('returns undefined for a pure-web project (no app config)', () => {
    const dir = project({ dependencies: { vite: '6' } });
    expect(detectExportAppId(dir)).toBeUndefined();
  });

  it('returns undefined when the config carries no id', () => {
    const dir = project(
      { dependencies: { expo: '51' } },
      { 'app.json': JSON.stringify({ expo: {} }) },
    );
    expect(detectExportAppId(dir)).toBeUndefined();
  });
});
