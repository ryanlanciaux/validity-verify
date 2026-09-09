/**
 * The version stamped into `expo.extra.validity.pluginVersion`.
 *
 * Held as a literal rather than a `require('../package.json')` because this
 * package compiles with `rootDir: ./src` — the manifest is not in `dist/`, so a
 * runtime read would resolve differently in the repo than in a published
 * tarball. `version.test.ts` byte-matches it against package.json, which is the
 * same "mirror + test the mirror" discipline the skill/help-text twins use.
 */
export const PLUGIN_VERSION = '0.0.2';
