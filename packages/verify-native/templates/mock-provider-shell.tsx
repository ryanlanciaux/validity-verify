// @validity-generated-template — React Native mock provider shell.
//
// Shipped RAW (never compiled by @validity.ai/verify-native's tsc — it imports
// react-native, which isn't a dep of this monorepo). prepareNative() copies
// it into node_modules/.validity-native/ where Metro bundles it as part of
// the user's app.
//
// The shell wraps a single isolated component in the providers a screen
// normally needs — but with the *navigation* mocked. We do NOT use the real
// router (expo-router / react-navigation): in isolation there's no route
// tree, so calls like navigate()/router.push() are RECORDED, not executed.
// That keeps a screen that calls useNavigation() from crashing while making
// its navigation intent inspectable.
/* eslint-disable */
// @ts-nocheck
import React, { createContext, useContext, useRef } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// App-specific providers (theme, query client, auth). This is a GENERATED
// passthrough unless the project has `.validity/wrapper.native.tsx`, in which
// case it re-exports that. A component that calls e.g. `useAppTheme()` needs its
// ThemeProvider here, or it render-errors ("must be used within a
// ThemeProvider") in isolation.
import ValidityUserWrapper from './validity-native-wrapper';
// Auto-mocked navigation contexts (GENERATED per-project — see renderNativeNavModule
// in @validity.ai/verify-native). Mounts React Navigation's NavigationContext +
// NavigationRouteContext with a recording mock so screens that call the REAL
// useNavigation()/useRoute()/useScrollToTop()/useIsFocused() (imported from
// '@react-navigation/native' or 'expo-router') render instead of throwing
// "Couldn't find a route/navigation object". For a no-navigation app it's a
// zero-import passthrough, so this import always resolves and never breaks the bundle.
import { NavigationMockProvider } from './validity-native-nav';
// Auto-mounted GestureHandlerRootView (GENERATED — real wrapper when
// react-native-gesture-handler is installed, else passthrough). Gesture
// components crash in isolation without this ancestor.
import { GestureRoot } from './validity-native-gh';

export interface RecordedNavCall {
  method: string;
  args: unknown[];
  at: number;
}

const NavRecorderContext = createContext<{ calls: RecordedNavCall[] }>({ calls: [] });

/**
 * A fake `router` (expo-router shape) whose methods record instead of
 * navigate. Importable by code that calls `router.push(...)` directly.
 */
export const router = {
  _calls: [] as RecordedNavCall[],
  push(...args: unknown[]) {
    this._calls.push({ method: 'push', args, at: Date.now() });
  },
  replace(...args: unknown[]) {
    this._calls.push({ method: 'replace', args, at: Date.now() });
  },
  back(...args: unknown[]) {
    this._calls.push({ method: 'back', args, at: Date.now() });
  },
  navigate(...args: unknown[]) {
    this._calls.push({ method: 'navigate', args, at: Date.now() });
  },
  setParams(...args: unknown[]) {
    this._calls.push({ method: 'setParams', args, at: Date.now() });
  },
};

/** react-navigation shape: a fake navigation object whose actions record. */
export function useNavigation() {
  const ctx = useContext(NavRecorderContext);
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      ctx.calls.push({ method, args, at: Date.now() });
  return {
    navigate: record('navigate'),
    push: record('push'),
    goBack: record('goBack'),
    replace: record('replace'),
    setParams: record('setParams'),
    addListener: () => () => {},
    isFocused: () => true,
  };
}

export function useRoute() {
  return { key: 'validity', name: 'validity', params: {} };
}

export interface MockProviderShellProps {
  children: React.ReactNode;
  /** Which router the project uses — informational; both are mocked the same way. */
  router?: 'expo-router' | 'react-navigation' | 'none';
  /**
   * Project-relative path of the screen being mounted (e.g. `app/post/[id].tsx`).
   * For expo-router apps the nav mock introspects this into pathname/segments/
   * params so useSegments()/usePathname()/useLocalSearchParams() return realistic
   * values. Ignored by the react-navigation mock.
   */
  routePath?: string;
}

/**
 * Wrap the isolated target in: the recorded-navigation context, SafeArea, and
 * the project's own providers (`ValidityUserWrapper`, sourced from
 * `.validity/wrapper.user.tsx` when present — theme/query/auth go there).
 */
export function MockProviderShell({ children, routePath }: MockProviderShellProps) {
  const calls = useRef<RecordedNavCall[]>([]).current;
  return (
    <NavRecorderContext.Provider value={{ calls }}>
      {/* GestureHandlerRootView must be a top-level ancestor of any gesture
          component; mount it outermost (passthrough when GH isn't installed). */}
      <GestureRoot>
        <SafeAreaProvider>
          <ValidityUserWrapper>
            {/* Navigation contexts go INSIDE the user's providers (closest to the
                screen) so a user theme/auth provider stays outermost. */}
            <NavigationMockProvider routePath={routePath}>{children}</NavigationMockProvider>
          </ValidityUserWrapper>
        </SafeAreaProvider>
      </GestureRoot>
    </NavRecorderContext.Provider>
  );
}
