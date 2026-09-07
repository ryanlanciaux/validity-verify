/**
 * Identity stamped into the manifest's `generator` field.
 *
 * Held as literals rather than read from `package.json` at runtime for two
 * reasons. First, this package compiles with `rootDir: ./src`, so the manifest
 * is not in `dist/` and a relative read would resolve differently in the repo
 * than in a published tarball. Second, the only portable way to locate it from
 * an ES module is `import.meta.url` — which TypeScript refuses to emit into the
 * CommonJS half of this package's dual build (TS1470), and `next.config.js`
 * needs that half.
 *
 * `version.test.ts` byte-matches both constants against package.json, the same
 * "mirror + test the mirror" discipline the skill/help-text twins use.
 */

/** npm package name, recorded as `generator.name`. */
export const PLUGIN_NAME = '@validity.ai/verify-plugin-next';

/** npm package version, recorded as `generator.version`. */
export const PLUGIN_VERSION = '0.0.1';
