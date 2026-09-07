import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectReactNativeSignals } from '@validity.ai/verify-spec';
import type { DetectedFramework } from '@validity.ai/verify-spec';

export function detectFramework(projectRoot: string): DetectedFramework {
  const pkgPath = resolve(projectRoot, 'package.json');
  let deps: Record<string, string> = {};
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    } catch {
      // ignore
    }
  }

  const hasFile = (...names: string[]) => names.some((n) => existsSync(resolve(projectRoot, n)));

  // PRECEDENCE: next → expo → vite, matching `detectAppTarget`. This used to
  // check Vite FIRST, which made the two disagree in the one case that matters:
  // an Expo app carrying a `vite.config.ts` (a common way to get a path alias
  // for tooling) reported `vite`, so `resolveTarget`'s auto path returned 'web'
  // and rendered a React Native app through react-native-web — the exact silent
  // wrong-runtime render that ExpoWebNotRequestedError exists to prevent. An
  // auxiliary bundler config does not change what the app ships as.
  if (deps['next'] || hasFile('next.config.ts', 'next.config.js', 'next.config.mjs')) {
    return 'next';
  }
  // Shared with `detectAppTarget` so the two can't disagree about what "Expo"
  // means. Notably it does NOT accept a bare `app.json` — that's also Heroku's
  // manifest, and a plain React web app carrying one must report `unknown`
  // (an honest "unsupported toolchain") rather than be handed the RN path.
  if (detectReactNativeSignals(projectRoot).isExpo) {
    return 'expo';
  }
  if (deps['vite'] || hasFile('vite.config.ts', 'vite.config.js', 'vite.config.mjs')) {
    return 'vite';
  }
  return 'unknown';
}

/**
 * Asserts that the detected framework is one Validity can render today.
 * Vite, Expo (rendered through `react-native-web` via the
 * `prepare-expo-web.ts` path), and Next.js (client components rendered
 * through the standard web path with `next/*` aliases) are supported.
 * Next.js Server Components / Route Handlers / Middleware are out of scope
 * (they require Next's server runtime).
 */
export function assertSupportedFramework(
  framework: DetectedFramework,
): asserts framework is 'vite' | 'expo' | 'next' {
  if (framework === 'vite' || framework === 'expo' || framework === 'next') return;
  throw new Error(
    'Could not detect a supported framework. Validity v1 supports Vite, Expo, and Next.js projects.',
  );
}
