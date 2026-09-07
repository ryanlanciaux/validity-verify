/**
 * Stamps `dist/cjs/package.json` after the CommonJS `tsc` pass.
 *
 * This package is `"type": "module"`, so Node would read the `.js` files
 * `tsconfig.cjs.json` emits into `dist/cjs/` as ESM and reject their
 * `require`/`exports`. A nested `{"type": "commonjs"}` manifest re-scopes that
 * one directory — the standard dual-format layout, and the reason the
 * `require` condition in the package's exports map is safe to point there.
 *
 * Deliberately globals-free (no `process`, no `console`): the repo's eslint
 * config only grants Node globals to root-level `scripts/**\/*.mjs`, and a
 * build step that needs a lint exemption is a build step that will rot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../dist/cjs/package.json');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, '{\n  "type": "commonjs"\n}\n', 'utf-8');
