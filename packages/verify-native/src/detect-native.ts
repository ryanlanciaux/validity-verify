/**
 * Detect whether a project can run the React Native playground, and how its
 * navigation is wired (so the harness mocks the right router).
 *
 * Shallow + dependency-only, like `detect-project.ts` — reads package.json
 * and probes a couple of well-known files. No AST work.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectReactNativeSignals } from '@validity.ai/verify-spec';

export type NativeRouter = 'expo-router' | 'react-navigation' | 'none';

export interface NativeDetection {
  /** True when the project is an Expo / React Native app the playground can target. */
  isNative: boolean;
  /** True when Expo (managed or bare) is present. */
  usesExpo: boolean;
  /** True for a bare react-native project without Expo. */
  bareReactNative: boolean;
  /** Which navigation library is in use (drives the mock-provider shell). */
  router: NativeRouter;
  /** True when @react-native-async-storage/async-storage is installed (asyncStorage seeding works). */
  hasAsyncStorage: boolean;
  /**
   * True when `expo-splash-screen` is installed. The companion never runs the
   * host app's startup, so the native launch storyboard is never dismissed and
   * stays painted over the rendered target. When present, the harness owns the
   * splash lifecycle (prevent auto-hide → hide once content is committed).
   */
  hasSplashScreen: boolean;
  /**
   * True when `react-native-gesture-handler` is installed. Gesture components
   * (GestureDetector / Swipeable) hard-crash in isolation without a
   * `GestureHandlerRootView` ancestor, so the harness auto-wraps one when present.
   */
  hasGestureHandler: boolean;
  /** True when `react-native-reanimated` is installed (worklets need the babel plugin — host config carries it). */
  hasReanimated: boolean;
  /** True when `react-native-mmkv` is installed (sync native storage — reads empty in isolation unless seeded). */
  hasMMKV: boolean;
  /**
   * True when `expo-application` is installed. The generated identity module
   * then uses its vendor/android id as the device identity sent in the bridge
   * `hello` (host↔device correlation); otherwise it falls back to a persisted
   * installation id.
   */
  hasExpoApplication: boolean;
  /** Reason isNative is false, for a helpful CLI message. */
  reason?: string;
}

function readDeps(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

export function detectNative(projectRoot: string): NativeDetection {
  const deps = readDeps(projectRoot);
  // Shared with `detectAppTarget` / `detectFramework`: an `app.json` alone is
  // NOT Expo (it's also Heroku's manifest, and `app.config.ts` belongs to
  // TanStack Start / Solid Start). Without this, a web project carrying one
  // reports `isNative: true` and gets offered a simulator build it can't use.
  const { isExpo: usesExpo, isReactNative: hasReactNative } = detectReactNativeSignals(projectRoot);
  const bareReactNative = hasReactNative && !usesExpo;
  const isNative = usesExpo || hasReactNative;

  let router: NativeRouter = 'none';
  if (deps['expo-router']) router = 'expo-router';
  else if (deps['@react-navigation/native']) router = 'react-navigation';

  return {
    isNative,
    usesExpo,
    bareReactNative,
    router,
    hasAsyncStorage: Boolean(deps['@react-native-async-storage/async-storage']),
    hasSplashScreen: Boolean(deps['expo-splash-screen']),
    hasGestureHandler: Boolean(deps['react-native-gesture-handler']),
    hasReanimated: Boolean(deps['react-native-reanimated']),
    hasMMKV: Boolean(deps['react-native-mmkv']),
    hasExpoApplication: Boolean(deps['expo-application']),
    reason: isNative
      ? undefined
      : 'No `react-native` or `expo` dependency found — the native playground needs a React Native or Expo project.',
  };
}
