/**
 * esbuild onLoad plugin that strips Flow type annotations from the REAL
 * `react-native` package source so esbuild's dep optimizer can parse it.
 *
 * Why this exists (Expo Web only):
 *   Expo Web renders route through `react-native-web`, but a handful of
 *   ecosystem packages — most notably `react-native-reanimated`'s real
 *   compiled web build — statically reference deep `react-native/**` core
 *   modules (ReactFabric shim, StyleSheet/normalizeColor, processColor,
 *   PlatformColorValueTypes, ReactNativeStyleAttributes, …). Those files
 *   are authored in Flow (`let x: ?string`, `import type {…}`) which
 *   esbuild cannot parse. When the dep optimizer pre-bundles a package
 *   that pulls them in, the build hard-fails.
 *
 *   Rather than stub each file individually (over-mocking, which is what
 *   the old reanimated `/mock` alias did — it dropped real exports like
 *   `Easing`/`interpolate`), we run the genuine RN source through Babel's
 *   Flow-strip transform on load. The output is plain JS+JSX esbuild can
 *   handle, so real exports survive and reanimated's transitive RN core
 *   parses cleanly.
 *
 * Scope guarantees:
 *   - The onLoad filter matches `.../node_modules/react-native/**.js(x)`
 *     ONLY. The `[\\/]` immediately after `react-native` excludes sibling
 *     packages like `react-native-web` and `react-native-reanimated`
 *     (their next char is `-`, not a path separator).
 *   - It never touches user source (must be under a `node_modules/
 *     react-native/` segment).
 *
 * This plugin is wired in for the `expo-web` target only (see server.ts).
 */
import { readFileSync, statSync } from 'node:fs';
import type { Plugin } from 'esbuild';

// Matches real `react-native` package files under node_modules only.
// The `[\\/]` after `react-native` is load-bearing: it forbids the `-`
// that starts sibling packages (react-native-web, react-native-reanimated,
// react-native-gesture-handler, …), so those are NOT transformed here.
const RN_SOURCE_FILTER = /[\\/]node_modules[\\/]react-native[\\/].*\.jsx?$/;

interface CacheEntry {
  mtimeMs: number;
  code: string;
}

/**
 * Build the Flow-strip esbuild plugin. Returns a fresh plugin (with its
 * own cache) per call so concurrent sandboxes don't share mutable state.
 */
export function flowStripPlugin(): Plugin {
  const cache = new Map<string, CacheEntry>();

  return {
    name: 'validity-rn-flow-strip',
    setup(build) {
      build.onLoad({ filter: RN_SOURCE_FILTER }, (args) => {
        const filename = args.path;

        let mtimeMs = 0;
        try {
          mtimeMs = statSync(filename).mtimeMs;
        } catch {
          // If stat fails, fall through and re-read; the readFileSync below
          // will throw with a clear error if the file is truly gone.
        }

        const cached = cache.get(filename);
        if (cached && cached.mtimeMs === mtimeMs) {
          return { contents: cached.code, loader: 'jsx' };
        }

        let source: string;
        try {
          source = readFileSync(filename, 'utf8');
        } catch (err) {
          throw new Error(
            `validity-rn-flow-strip: failed to read react-native source ${filename}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        let code: string;
        try {
          // Lazy require keeps @babel/core (and its Flow/JSX plugins) out of
          // the module graph for non-expo-web targets, where this plugin is
          // never wired. A static `import` would eagerly load Babel and a
          // dynamic `import()` would force this synchronous transform hook to
          // become async — so `require` is deliberate here.
          /* eslint-disable @typescript-eslint/no-require-imports */
          const babel = require('@babel/core') as typeof import('@babel/core');
          const result = babel.transformSync(source, {
            babelrc: false,
            configFile: false,
            // `plugin-syntax-jsx` is required so Babel's parser accepts the JSX
            // that many `react-native/**` files contain (e.g.
            // Libraries/Components/View/View.js). Without it, transformSync
            // throws "Unexpected token" on the first `<Tag>` — even though we
            // only want to strip Flow types and leave the JSX untouched for the
            // `jsx` loader below to handle. `plugin-transform-flow-strip-types`
            // only enables Flow syntax, not JSX.
            plugins: [
              require('@babel/plugin-syntax-jsx'),
              require('@babel/plugin-transform-flow-strip-types'),
            ],
            /* eslint-enable @typescript-eslint/no-require-imports */
            generatorOpts: { retainLines: true },
            filename,
          });
          if (!result || result.code == null) {
            throw new Error('Babel returned no code');
          }
          code = result.code;
        } catch (err) {
          // Rethrow so it surfaces as a fatalError (never a silent hang).
          throw new Error(
            `validity-rn-flow-strip: failed to strip Flow types from ${filename}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        cache.set(filename, { mtimeMs, code });
        return { contents: code, loader: 'jsx' };
      });
    },
  };
}
