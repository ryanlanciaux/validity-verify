import { describe, expect, it } from 'vitest';
import type { CommandRunner } from './agent-device-driver.js';
import {
  DEFAULT_PLUGIN_DETECT_TIMEOUT_MS,
  detectNativePlugin,
  parseExpoConfigJson,
  readRegisteredSchemes,
  schemeParityNote,
  VALIDITY_EXPO_PLUGIN,
} from './native-plugin-detect.js';
import { defaultCompanionScheme } from './prepare-native-app.js';

/** A resolved Expo config as `npx expo config --json` prints it. */
function expoConfigJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'My App',
    slug: 'my-app',
    scheme: 'my-app',
    plugins: [VALIDITY_EXPO_PLUGIN],
    extra: { validity: { pluginVersion: '0.0.1', scheme: 'my-app' } },
    ...over,
  });
}

function runnerReturning(stdout: string, code = 0): CommandRunner {
  return async () => ({ code, stdout, stderr: '' });
}

describe('readRegisteredSchemes', () => {
  it('reads expo.scheme as a string or an array', () => {
    expect(readRegisteredSchemes({ scheme: 'one' })).toEqual(['one']);
    expect(readRegisteredSchemes({ scheme: ['one', 'two'] })).toEqual(['one', 'two']);
  });

  it('reads hand-rolled iOS URL types and Android intent filters', () => {
    expect(
      readRegisteredSchemes({
        ios: { infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['ios-scheme'] }] } },
        android: { intentFilters: [{ action: 'VIEW', data: { scheme: 'android-scheme' } }] },
      }),
    ).toEqual(['ios-scheme', 'android-scheme']);
  });

  it('de-duplicates and keeps expo.scheme first', () => {
    expect(
      readRegisteredSchemes({
        scheme: 'shared',
        ios: { infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['shared', 'extra'] }] } },
      }),
    ).toEqual(['shared', 'extra']);
  });

  it('never throws on a malformed config', () => {
    expect(
      readRegisteredSchemes({
        scheme: 7,
        ios: 'nope',
        android: { intentFilters: [null, { data: 'nope' }] },
      }),
    ).toEqual([]);
  });
});

describe('parseExpoConfigJson', () => {
  it('reports a stamped config as installed, with its scheme and version', () => {
    const detection = parseExpoConfigJson(expoConfigJson());
    expect(detection).not.toBe('unknown');
    if (detection === 'unknown') return;
    expect(detection.installed).toBe(true);
    expect(detection.listed).toBe(true);
    expect(detection.scheme).toBe('my-app');
    expect(detection.pluginVersion).toBe('0.0.1');
    expect(detection.registeredSchemes).toEqual(['my-app']);
  });

  it('separates ATTESTED (listed) from PROVEN (installed)', () => {
    // Listed but no stamp = Expo did not apply it, almost always because the
    // package is not installed. Saying "installed" here would be a false claim.
    const detection = parseExpoConfigJson(expoConfigJson({ extra: {} }));
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.listed).toBe(true);
    expect(detection.installed).toBe(false);
    expect(detection.scheme).toBeUndefined();
  });

  it('reports a stamped-but-unlisted config as installed', () => {
    // `app.config.ts` can call `withValidity(config)` directly, without ever
    // naming the plugin in `expo.plugins`. The stamp is what counts.
    const detection = parseExpoConfigJson(expoConfigJson({ plugins: ['expo-router'] }));
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(true);
    expect(detection.listed).toBe(false);
  });

  it('matches a plugin listed with options', () => {
    const detection = parseExpoConfigJson(
      expoConfigJson({ plugins: [[VALIDITY_EXPO_PLUGIN, { scheme: 'x' }]] }),
    );
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.listed).toBe(true);
  });

  it('accepts the { expo: … } wrapper shape', () => {
    const wrapped = JSON.stringify({ expo: JSON.parse(expoConfigJson()) });
    const detection = parseExpoConfigJson(wrapped);
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(true);
  });

  it('finds the JSON object inside chatty stdout', () => {
    const noisy = `env: load .env\nsome npx notice\n${expoConfigJson()}\n`;
    const detection = parseExpoConfigJson(noisy);
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(true);
  });

  it('ignores a stamp with no pluginVersion', () => {
    // Not a stamp this plugin wrote. Half-known is reported as absent, never
    // as a partial install.
    const detection = parseExpoConfigJson(expoConfigJson({ extra: { validity: { scheme: 'x' } } }));
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(false);
  });

  it('is unknown for output with no JSON object at all', () => {
    expect(parseExpoConfigJson('')).toBe('unknown');
    expect(parseExpoConfigJson('CommandError: expo is not installed')).toBe('unknown');
    expect(parseExpoConfigJson('[1, 2, 3]')).toBe('unknown');
  });

  it('is unknown for truncated JSON', () => {
    expect(parseExpoConfigJson('{"name": "My App", "extra"')).toBe('unknown');
  });
});

describe('detectNativePlugin', () => {
  it('runs `npx expo config --json` in the project root, bounded', async () => {
    const calls: { bin: string; args: string[]; opts?: unknown }[] = [];
    const run: CommandRunner = async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { code: 0, stdout: expoConfigJson(), stderr: '' };
    };
    const detection = await detectNativePlugin({ projectRoot: '/app', run });
    expect(calls[0]?.bin).toBe('npx');
    expect(calls[0]?.args).toEqual(['expo', 'config', '--json']);
    expect(calls[0]?.opts).toMatchObject({
      cwd: '/app',
      timeoutMs: DEFAULT_PLUGIN_DETECT_TIMEOUT_MS,
    });
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(true);
  });

  it('still parses a config printed alongside a non-zero exit', async () => {
    // Expo warns loudly (and sometimes exits non-zero) about things unrelated
    // to the config it just printed.
    const detection = await detectNativePlugin({
      projectRoot: '/app',
      run: runnerReturning(expoConfigJson(), 1),
    });
    if (detection === 'unknown') throw new Error('expected a detection');
    expect(detection.installed).toBe(true);
  });

  it('is unknown when the command produces nothing usable', async () => {
    expect(await detectNativePlugin({ projectRoot: '/app', run: runnerReturning('', 127) })).toBe(
      'unknown',
    );
  });

  it('is unknown — never a throw — when the runner rejects', async () => {
    const run: CommandRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    expect(await detectNativePlugin({ projectRoot: '/app', run })).toBe('unknown');
  });
});

describe('schemeParityNote', () => {
  const companionDefault = defaultCompanionScheme('ai.validity.playground');

  it('says nothing when the two apps hold different schemes', () => {
    const detection = parseExpoConfigJson(expoConfigJson());
    expect(schemeParityNote(detection, companionDefault)).toBeUndefined();
  });

  it('flags the collision when the user app registers the companion scheme', () => {
    const detection = parseExpoConfigJson(expoConfigJson({ scheme: companionDefault }));
    const note = schemeParityNote(detection, companionDefault);
    expect(note).toContain(companionDefault);
    expect(note).toContain('nondeterministically');
  });

  it('names native.scheme as the source when the companion scheme was overridden', () => {
    const overridden = 'shared-scheme';
    const detection = parseExpoConfigJson(expoConfigJson({ scheme: overridden }));
    expect(schemeParityNote(detection, overridden)).toContain('native.scheme');
  });

  it('detects a collision declared through the raw platform keys too', () => {
    const detection = parseExpoConfigJson(
      expoConfigJson({
        scheme: 'my-app',
        android: { intentFilters: [{ data: { scheme: companionDefault } }] },
      }),
    );
    expect(schemeParityNote(detection, companionDefault)).toBeDefined();
  });

  it('says nothing when the config could not be resolved', () => {
    // "We could not look" must never be reported as "we looked and it is fine".
    expect(schemeParityNote('unknown', companionDefault)).toBeUndefined();
  });
});
