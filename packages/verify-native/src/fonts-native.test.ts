import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  scanHostFonts,
  fontsFromConfig,
  resolveNativeFonts,
  renderNativeFontsModule,
} from './fonts-native.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-fonts-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('scanHostFonts', () => {
  it('extracts a require()-based useFonts map and resolves the asset path', () => {
    const root = project({
      'app/_layout.tsx': `import { useFonts } from 'expo-font';
export default function Layout() {
  const [loaded] = useFonts({
    'Inter-Regular': require('../assets/fonts/Inter-Regular.ttf'),
    'Inter-Bold': require('../assets/fonts/Inter-Bold.ttf'),
  });
  return null;
}`,
    });
    const fonts = scanHostFonts(root);
    expect(fonts.entries).toHaveLength(2);
    const reg = fonts.entries.find((e) => e.family === 'Inter-Regular')!;
    expect(reg.kind).toBe('requireRel');
    expect(reg.value).toBe(join(root, 'assets/fonts/Inter-Regular.ttf'));
  });

  it('extracts @expo-google-fonts named bindings and reproduces their import', () => {
    const root = project({
      'App.tsx': `import { useFonts, Inter_400Regular, Inter_700Bold } from '@expo-google-fonts/inter';
export default function App() {
  const [loaded] = useFonts({ Inter_400Regular, Inter_700Bold });
  return null;
}`,
    });
    const fonts = scanHostFonts(root);
    expect(fonts.entries.map((e) => e.family).sort()).toEqual([
      'Inter_400Regular',
      'Inter_700Bold',
    ]);
    expect(fonts.entries.every((e) => e.kind === 'binding')).toBe(true);
    expect(fonts.imports).toHaveLength(1);
    expect(fonts.imports[0]!.pkg).toBe('@expo-google-fonts/inter');
  });

  it('handles Font.loadAsync(...) too', () => {
    const root = project({
      'src/fonts.ts': `import * as Font from 'expo-font';
export const loadFonts = () =>
  Font.loadAsync({ Heading: require('./assets/Heading.otf') });`,
    });
    const fonts = scanHostFonts(root);
    expect(fonts.entries).toHaveLength(1);
    expect(fonts.entries[0]!.family).toBe('Heading');
  });

  it('keeps non-relative require specs verbatim (package / alias paths)', () => {
    const root = project({
      'App.tsx': `import { useFonts } from 'expo-font';
const x = useFonts({ Brand: require('@/assets/Brand.ttf') });`,
    });
    const fonts = scanHostFonts(root);
    expect(fonts.entries[0]!.kind).toBe('requireVerbatim');
    expect(fonts.entries[0]!.value).toBe('@/assets/Brand.ttf');
  });

  it('skips entries too dynamic to reproduce, keeping the parseable ones', () => {
    const root = project({
      'App.tsx': `import { useFonts } from 'expo-font';
const x = useFonts({
  Good: require('./Good.ttf'),
  Bad: someFn('x') ? a : b,
});`,
    });
    const fonts = scanHostFonts(root);
    expect(fonts.entries.map((e) => e.family)).toEqual(['Good']);
  });

  it('ignores node_modules and returns empty when no fonts are loaded', () => {
    const root = project({
      'App.tsx': `export default function App() { return null; }`,
      'node_modules/pkg/index.js': `useFonts({ Nope: require('./x.ttf') })`,
    });
    expect(scanHostFonts(root).entries).toHaveLength(0);
  });
});

describe('fontsFromConfig', () => {
  it('treats file-path values as requireRel and package specs as verbatim', () => {
    const root = '/proj';
    const fonts = fontsFromConfig(
      { Inter: './assets/Inter.ttf', Brand: '@brand/fonts/brand.ttf' },
      root,
    );
    const inter = fonts.entries.find((e) => e.family === 'Inter')!;
    const brand = fonts.entries.find((e) => e.family === 'Brand')!;
    expect(inter.kind).toBe('requireRel');
    expect(inter.value).toBe(join(root, 'assets/Inter.ttf'));
    expect(brand.kind).toBe('requireVerbatim');
    expect(brand.value).toBe('@brand/fonts/brand.ttf');
  });
});

describe('resolveNativeFonts', () => {
  it('config overrides a scanned family of the same name', () => {
    const root = project({
      'App.tsx': `import { useFonts } from 'expo-font';
const x = useFonts({ Inter: require('./scanned/Inter.ttf') });`,
    });
    const fonts = resolveNativeFonts(root, { Inter: './override/Inter.ttf' });
    const inter = fonts.entries.find((e) => e.family === 'Inter')!;
    expect(inter.value).toBe(join(root, 'override/Inter.ttf'));
    expect(fonts.entries).toHaveLength(1);
  });
});

describe('renderNativeFontsModule', () => {
  const outDir = '/proj/.validity/native-app';

  it('emits a no-op loadFonts() and no expo-font import when there are no fonts', () => {
    const mod = renderNativeFontsModule(outDir, { entries: [], imports: [] });
    expect(mod).toContain('export async function loadFonts()');
    expect(mod).not.toContain("from 'expo-font'");
  });

  it('renders requires relative to the out dir and loads each font independently', () => {
    const mod = renderNativeFontsModule(outDir, {
      entries: [
        { family: 'Inter', kind: 'requireRel', value: '/proj/assets/Inter.ttf' },
        { family: 'Brand', kind: 'requireVerbatim', value: '@/assets/Brand.ttf' },
      ],
      imports: [],
    });
    expect(mod).toContain("require('expo-font')");
    expect(mod).toContain('"Inter": require("../../assets/Inter.ttf")');
    expect(mod).toContain('"Brand": require("@/assets/Brand.ttf")');
    // Independent loads so one bad asset can't block the rest.
    expect(mod).toContain('loadAsync({ [name]: src }).catch(() => {})');
  });

  it('reproduces binding imports (package verbatim, relative rewritten to out dir)', () => {
    const mod = renderNativeFontsModule(outDir, {
      entries: [{ family: 'Inter_400Regular', kind: 'binding', value: 'Inter_400Regular' }],
      imports: [{ clause: '{ Inter_400Regular }', pkg: '@expo-google-fonts/inter' }],
    });
    expect(mod).toContain('import { Inter_400Regular } from "@expo-google-fonts/inter";');
    expect(mod).toContain('"Inter_400Regular": Inter_400Regular');
  });
});
