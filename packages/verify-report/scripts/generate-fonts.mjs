/**
 * Regenerates src/fonts.ts from the @fontsource IBM Plex packages.
 *
 * The artifacts are self-contained single files that must render offline from
 * file:// — a remote font would silently fail there — so the latin woff2
 * subsets are inlined as data URIs. Run after bumping the @fontsource
 * devDependencies: `pnpm --filter @validity.ai/verify-report generate:fonts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const FACES = [
  {
    family: 'IBM Plex Sans',
    pkg: '@fontsource/ibm-plex-sans',
    file: 'ibm-plex-sans-latin-400-normal.woff2',
    weight: 400,
  },
  {
    family: 'IBM Plex Sans',
    pkg: '@fontsource/ibm-plex-sans',
    file: 'ibm-plex-sans-latin-500-normal.woff2',
    weight: 500,
  },
  {
    family: 'IBM Plex Sans',
    pkg: '@fontsource/ibm-plex-sans',
    file: 'ibm-plex-sans-latin-600-normal.woff2',
    weight: 600,
  },
  {
    family: 'IBM Plex Sans',
    pkg: '@fontsource/ibm-plex-sans',
    file: 'ibm-plex-sans-latin-700-normal.woff2',
    weight: 700,
  },
  {
    family: 'IBM Plex Mono',
    pkg: '@fontsource/ibm-plex-mono',
    file: 'ibm-plex-mono-latin-400-normal.woff2',
    weight: 400,
  },
  {
    family: 'IBM Plex Mono',
    pkg: '@fontsource/ibm-plex-mono',
    file: 'ibm-plex-mono-latin-500-normal.woff2',
    weight: 500,
  },
  {
    family: 'IBM Plex Mono',
    pkg: '@fontsource/ibm-plex-mono',
    file: 'ibm-plex-mono-latin-600-normal.woff2',
    weight: 600,
  },
];

const faces = FACES.map(({ family, pkg, file, weight }) => {
  const pkgRoot = dirname(require.resolve(join(pkg, 'package.json')));
  const bytes = readFileSync(join(pkgRoot, 'files', file));
  const version = require(join(pkg, 'package.json')).version;
  return { family, weight, version, dataUri: `data:font/woff2;base64,${bytes.toString('base64')}` };
});

const versions = [...new Set(faces.map((f) => `${f.family} ${f.version}`))].join(', ');

const notices = [...new Set(FACES.map((f) => f.pkg))]
  .map((pkg) => `${pkg}\n${readFileSync(join(dirname(require.resolve(join(pkg, 'package.json'))), 'LICENSE'), 'utf8')}`)
  .join('\n\n');

// Keep the font copyright/license readable in every self-contained HTML report,
// not just in the npm package that produced it.
const css = `/*!\n${notices.replaceAll('*/', '* /')}\n*/\n` + faces
  .map(
    (f) => `@font-face{
  font-family:${JSON.stringify(f.family)};
  font-style:normal;
  font-weight:${f.weight};
  font-display:swap;
  src:url(${f.dataUri}) format("woff2");
}`,
  )
  .join('\n');

const out = `// AUTO-GENERATED — do not edit by hand. Regenerate: pnpm --filter @validity.ai/verify-report generate:fonts
// Source: ${versions} (latin woff2 subsets, inlined for offline file:// rendering).

/** @font-face rules for IBM Plex Sans 400/500/600/700 + IBM Plex Mono 400/500/600. */
export const FONT_FACE_CSS = ${JSON.stringify(css)};
`;

writeFileSync(resolve(here, '../src/fonts.ts'), out);
writeFileSync(resolve(here, '../THIRD_PARTY_NOTICES.txt'), notices.trimEnd() + '\n');
console.log(`wrote src/fonts.ts (${(out.length / 1024).toFixed(0)} KiB, ${faces.length} faces)`);
