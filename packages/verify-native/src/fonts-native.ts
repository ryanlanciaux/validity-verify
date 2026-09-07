/**
 * Native font replication — the companion's analog of "the web just works".
 *
 * On the web, custom fonts arrive via `@font-face` / react-native-web's font
 * mapping, so an isolated component renders with the design-system typography
 * for free. Native is different: custom fonts are loaded AT RUNTIME (usually
 * `useFonts({...})` / `Font.loadAsync({...})` from `expo-font`) inside the
 * host app's real root — `App.tsx`, `app/_layout.tsx`, a fonts hook, etc.
 *
 * The companion generates its OWN root (ValidityNativeRoot) and never runs the
 * host's font loading, so every isolated component falls back to the system
 * font and the design system looks wrong. (Fonts embedded via the `expo-font`
 * CONFIG PLUGIN already carry over — the companion inherits the host's plugins
 * and the native binary registers them. It's only the runtime-loaded fonts
 * that go missing.)
 *
 * This module closes that gap: it scans the host source for the font map the
 * app loads at runtime, merges in any explicit `config.native.fonts` overrides,
 * and renders a `validity-native-fonts.ts` module exporting `loadFonts()` that
 * the harness awaits before mounting a target. Pure source emission + a shallow
 * scan — it never imports `react-native`/`expo-font`, so it compiles and
 * unit-tests without an RN install (like {@link network-native}).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** One font the companion must register so isolated components render correctly. */
export interface NativeFontEntry {
  /** Family/key the app references in `fontFamily` — preserved verbatim. */
  family: string;
  kind: 'requireRel' | 'requireVerbatim' | 'binding';
  /**
   * requireRel: absolute path to the asset (rewritten to an outDir-relative
   * `require` at render time). requireVerbatim: the require spec kept as-is (a
   * package or tsconfig-alias path the companion's Metro resolves). binding: a
   * JS expression (e.g. a `@expo-google-fonts` named asset) used as the value.
   */
  value: string;
}

/** An import the rendered module must reproduce so a `binding` entry resolves. */
export interface NativeFontImportRef {
  /** Original import clause, e.g. `{ Inter_400Regular }` or `InterFont`. */
  clause: string;
  /** Package specifier — copied verbatim (`@expo-google-fonts/inter`). */
  pkg?: string;
  /** Relative-import target resolved to an absolute path (rewritten at render). */
  moduleAbs?: string;
}

export interface DetectedFonts {
  entries: NativeFontEntry[];
  imports: NativeFontImportRef[];
}

const EMPTY: DetectedFonts = { entries: [], imports: [] };

const SOURCE_EXT = /\.(tsx|jsx|ts|js|mjs|cjs)$/i;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.validity',
  'ios',
  'android',
  '.expo',
  'dist',
  'build',
  '.next',
  'coverage',
]);
/** Bounds so the scan stays shallow on a big repo (it's best-effort detection). */
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;

/** Collect candidate source files, skipping vendor/build dirs. Bounded. */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Extract the balanced `{...}` object literal that starts at or after `from`.
 * Returns the inner body (without the outer braces) and the index past the
 * closing brace, or null if the next significant char isn't `{`. String-aware
 * so a `}` inside a string/template doesn't end it early.
 */
function readObjectLiteral(src: string, from: number): { body: string; end: number } | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Split an object body into top-level `key: value` pairs (depth + string aware). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += body[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const REQUIRE_RE = /^require\(\s*['"]([^'"]+)['"]\s*\)$/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const MEMBER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** Parse one `key: value` font pair → an entry + any binding root it needs. */
function parsePair(
  pair: string,
  fileDir: string,
): { entry: NativeFontEntry; bindingRoot?: string } | null {
  const colon = topLevelColon(pair);
  if (colon === -1) {
    // Shorthand property: `{ Inter_400Regular }` — the @expo-google-fonts norm.
    // Key and value are the same identifier; treat it as a binding entry.
    const ident = pair.trim();
    if (!IDENT_RE.test(ident)) return null;
    return { entry: { family: ident, kind: 'binding', value: ident }, bindingRoot: ident };
  }
  const rawKey = pair.slice(0, colon).trim();
  const rawVal = pair.slice(colon + 1).trim();
  const family = unquote(rawKey);
  if (!family) return null;

  const req = REQUIRE_RE.exec(rawVal);
  if (req) {
    const spec = req[1]!;
    if (isRelative(spec)) {
      return { entry: { family, kind: 'requireRel', value: resolve(fileDir, spec) } };
    }
    return { entry: { family, kind: 'requireVerbatim', value: spec } };
  }
  if (IDENT_RE.test(rawVal) || MEMBER_RE.test(rawVal)) {
    return { entry: { family, kind: 'binding', value: rawVal }, bindingRoot: rawVal.split('.')[0] };
  }
  // Anything else (inline objects, function calls, conditionals) is too complex
  // to reproduce safely — skip it rather than emit something that won't compile.
  return null;
}

function topLevelColon(pair: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < pair.length; i++) {
    const c = pair[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const IMPORT_RE = /import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Map every imported binding name in a file to the import it came from, so a
 * font `binding` entry can have its import reproduced. Handles default, named
 * (`{ a, b as c }`), and namespace (`* as ns`) clauses.
 */
function indexImports(content: string, fileDir: string): Map<string, NativeFontImportRef> {
  const byBinding = new Map<string, NativeFontImportRef>();
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content))) {
    const clause = m[1]!.trim();
    const spec = m[2]!;
    const ref: NativeFontImportRef = isRelative(spec)
      ? { clause, moduleAbs: resolve(fileDir, spec) }
      : { clause, pkg: spec };
    for (const name of bindingNames(clause)) byBinding.set(name, ref);
  }
  return byBinding;
}

/** Local binding names introduced by an import clause. */
function bindingNames(clause: string): string[] {
  const names: string[] = [];
  // Namespace: `* as ns`
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (ns) names.push(ns[1]!);
  // Named: `{ a, b as c }`
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    for (const part of braced[1]!.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.push(as ? as[1]! : t.split(/\s+/)[0]!);
    }
  }
  // Default: leading `Name` before any `{` or `*`.
  const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
  if (def && !clause.startsWith('{') && !clause.startsWith('*')) names.push(def[1]!);
  return names;
}

/** Extract font entries (+ the imports they need) from a single file's source. */
function extractFromFile(filePath: string, content: string): DetectedFonts {
  if (!/useFonts\s*\(|loadAsync\s*\(/.test(content)) return EMPTY;
  const fileDir = dirname(filePath);
  const entries: NativeFontEntry[] = [];
  const neededRoots = new Set<string>();

  const CALL_RE = /(?:useFonts|loadAsync)\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = CALL_RE.exec(content))) {
    const obj = readObjectLiteral(content, call.index + call[0].length);
    if (!obj) continue;
    for (const pair of splitTopLevel(obj.body)) {
      const parsed = parsePair(pair, fileDir);
      if (!parsed) continue;
      entries.push(parsed.entry);
      if (parsed.bindingRoot) neededRoots.add(parsed.bindingRoot);
    }
  }
  if (entries.length === 0) return EMPTY;

  const imports: NativeFontImportRef[] = [];
  if (neededRoots.size > 0) {
    const idx = indexImports(content, fileDir);
    const seen = new Set<string>();
    for (const root of neededRoots) {
      const ref = idx.get(root);
      if (!ref) continue;
      const key = `${ref.clause}::${ref.pkg ?? ref.moduleAbs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push(ref);
    }
  }
  return { entries, imports };
}

/** Merge two detected sets; `b` wins on family conflicts and its imports add. */
function merge(a: DetectedFonts, b: DetectedFonts): DetectedFonts {
  const byFamily = new Map<string, NativeFontEntry>();
  for (const e of a.entries) byFamily.set(e.family, e);
  for (const e of b.entries) byFamily.set(e.family, e);
  const imports = [...a.imports];
  const seen = new Set(imports.map((r) => `${r.clause}::${r.pkg ?? r.moduleAbs}`));
  for (const r of b.imports) {
    const key = `${r.clause}::${r.pkg ?? r.moduleAbs}`;
    if (!seen.has(key)) {
      seen.add(key);
      imports.push(r);
    }
  }
  return { entries: [...byFamily.values()], imports };
}

/**
 * Scan the host project for the fonts it loads at runtime. Best-effort: returns
 * whatever it can parse confidently, skipping entries too dynamic to reproduce.
 */
export function scanHostFonts(projectRoot: string): DetectedFonts {
  let result = EMPTY;
  for (const file of collectSourceFiles(projectRoot)) {
    let content: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes('useFonts') && !content.includes('loadAsync')) continue;
    const found = extractFromFile(file, content);
    if (found.entries.length) result = merge(result, found);
  }
  return result;
}

/**
 * Translate explicit `config.native.fonts` into detected entries. Each value is
 * a path relative to the project root (rewritten to a require) or a package /
 * alias spec kept verbatim. These OVERRIDE scanned entries with the same family.
 */
export function fontsFromConfig(
  fonts: Record<string, string> | undefined,
  projectRoot: string,
): DetectedFonts {
  if (!fonts) return EMPTY;
  const entries: NativeFontEntry[] = [];
  for (const [family, spec] of Object.entries(fonts)) {
    if (!spec) continue;
    if (isRelative(spec) || (!spec.startsWith('@') && spec.includes('/') && /\.\w+$/.test(spec))) {
      entries.push({ family, kind: 'requireRel', value: resolve(projectRoot, spec) });
    } else {
      entries.push({ family, kind: 'requireVerbatim', value: spec });
    }
  }
  return { entries, imports: [] };
}

/** Resolve the full font set for a project: scanned host fonts + config overrides. */
export function resolveNativeFonts(
  projectRoot: string,
  configFonts: Record<string, string> | undefined,
): DetectedFonts {
  return merge(scanHostFonts(projectRoot), fontsFromConfig(configFonts, projectRoot));
}

function relSpec(outDir: string, abs: string): string {
  let r = relative(outDir, abs).replaceAll('\\', '/');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

/** The JS expression a single entry contributes as its `loadAsync` value. */
function valueExpr(outDir: string, entry: NativeFontEntry): string {
  switch (entry.kind) {
    case 'requireRel':
      return `require(${JSON.stringify(relSpec(outDir, entry.value))})`;
    case 'requireVerbatim':
      return `require(${JSON.stringify(entry.value)})`;
    case 'binding':
      return entry.value;
  }
}

function importLine(outDir: string, ref: NativeFontImportRef): string {
  const spec = ref.pkg ?? relSpec(outDir, ref.moduleAbs!);
  return `import ${ref.clause} from ${JSON.stringify(spec)};`;
}

/**
 * Render the `validity-native-fonts.ts` module the harness imports. With no
 * fonts it emits a no-op `loadFonts()` (and no `expo-font` import, so it's safe
 * even when expo-font isn't installed). With fonts it loads each independently —
 * one bad asset path can't take down the rest — and swallows failures so the
 * playground degrades to the system font rather than blocking.
 */
export function renderNativeFontsModule(outDir: string, fonts: DetectedFonts): string {
  if (fonts.entries.length === 0) {
    return `// @validity-generated — no runtime fonts detected. Declare custom fonts in
// .validity/config.ts (native.fonts) if your design system needs them on device.
/* eslint-disable */
// @ts-nocheck
export async function loadFonts(): Promise<void> {}
`;
  }

  const importLines = fonts.imports.map((r) => importLine(outDir, r)).join('\n');
  const mapLines = fonts.entries
    .map((e) => `    ${JSON.stringify(e.family)}: ${valueExpr(outDir, e)},`)
    .join('\n');

  return `// @validity-generated — loads the host app's custom fonts into the companion.
// Native loads fonts at RUNTIME (the host root calls useFonts/Font.loadAsync);
// the companion has its own root, so without this every isolated component falls
// back to the system font. Detected from your source + .validity/config.ts
// (native.fonts). Edit fonts upstream / in config, not here.
/* eslint-disable */
// @ts-nocheck
${importLines ? importLines + '\n' : ''}
const FONTS: Record<string, any> = {
${mapLines}
};

export async function loadFonts(): Promise<void> {
  // expo-font is lazy-required + guarded so a project without it (or a config
  // font added before installing it) degrades to the system font instead of
  // failing the whole Metro bundle.
  let loadAsync;
  try {
    ({ loadAsync } = require('expo-font'));
  } catch {
    return;
  }
  // Load each independently so one bad asset can't block the others; failures
  // degrade to the system font rather than redboxing the playground.
  await Promise.all(
    Object.entries(FONTS).map(([name, src]) =>
      loadAsync({ [name]: src }).catch(() => {}),
    ),
  );
}
`;
}
