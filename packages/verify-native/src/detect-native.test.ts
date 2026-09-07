import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectNative } from './detect-native.js';

const dirs: string[] = [];
function project(pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-native-detect-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('detectNative', () => {
  it('detects an Expo project with expo-router', () => {
    const d = detectNative(project({ dependencies: { expo: '51', 'expo-router': '3' } }));
    expect(d.isNative).toBe(true);
    expect(d.usesExpo).toBe(true);
    expect(d.bareReactNative).toBe(false);
    expect(d.router).toBe('expo-router');
  });

  it('detects a bare react-native project with react-navigation', () => {
    const d = detectNative(
      project({ dependencies: { 'react-native': '0.74', '@react-navigation/native': '6' } }),
    );
    expect(d.isNative).toBe(true);
    expect(d.usesExpo).toBe(false);
    expect(d.bareReactNative).toBe(true);
    expect(d.router).toBe('react-navigation');
  });

  it('flags non-native projects with a reason', () => {
    const d = detectNative(project({ dependencies: { react: '18', vite: '6' } }));
    expect(d.isNative).toBe(false);
    expect(d.reason).toMatch(/react-native|expo/i);
  });

  it('reports capability flags (gesture-handler/reanimated/mmkv) for conditional auto-mocks', () => {
    const d = detectNative(
      project({
        dependencies: {
          expo: '51',
          'react-native-gesture-handler': '2',
          'react-native-reanimated': '3',
          'react-native-mmkv': '3',
        },
      }),
    );
    expect(d.hasGestureHandler).toBe(true);
    expect(d.hasReanimated).toBe(true);
    expect(d.hasMMKV).toBe(true);
    // Absent → false (drives the passthrough generation).
    const none = detectNative(project({ dependencies: { expo: '51' } }));
    expect(none.hasGestureHandler).toBe(false);
    expect(none.hasReanimated).toBe(false);
    expect(none.hasMMKV).toBe(false);
  });

  it('WEB-SAFETY: the new capability flags never flip isNative for a pure react+vite web project', () => {
    // The native guards/generation key off isNative; a web project must stay false
    // even though we now read more deps. (Guards against accidental web impact.)
    const d = detectNative(
      project({ dependencies: { react: '18', 'react-dom': '18', vite: '6' } }),
    );
    expect(d.isNative).toBe(false);
    expect(d.hasGestureHandler).toBe(false);
    expect(d.hasReanimated).toBe(false);
    expect(d.hasMMKV).toBe(false);
  });

  it('reports AsyncStorage availability', () => {
    const d = detectNative(
      project({
        dependencies: { expo: '51', '@react-native-async-storage/async-storage': '1' },
      }),
    );
    expect(d.hasAsyncStorage).toBe(true);
  });

  it('reports expo-splash-screen availability (drives splash dismissal)', () => {
    expect(detectNative(project({ dependencies: { expo: '51' } })).hasSplashScreen).toBe(false);
    const d = detectNative(
      project({ dependencies: { expo: '51', 'expo-splash-screen': '~0.27' } }),
    );
    expect(d.hasSplashScreen).toBe(true);
  });

  it('reports expo-application availability (drives the bridge-hello device identity)', () => {
    expect(detectNative(project({ dependencies: { expo: '51' } })).hasExpoApplication).toBe(false);
    const d = detectNative(project({ dependencies: { expo: '51', 'expo-application': '~6.0' } }));
    expect(d.hasExpoApplication).toBe(true);
  });
});
