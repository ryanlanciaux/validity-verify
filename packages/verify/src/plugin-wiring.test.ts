/**
 * Covers every pure/injectable seam in plugin-wiring.ts: flag resolution,
 * bundler-aware target selection (Next app → plugin-next, everything else
 * web → plugin-vite), the JSON-safe package.json/app.json edits (added +
 * idempotent + rejected-malformed), the vite.config and next.config text
 * edits (simple shapes accepted, everything else falls back to a paste
 * stanza), source resolution's 3-tier precedence with fixture directories
 * standing in for "staged tarball" / "npm root -g" / "in-repo dev build",
 * and extraction for both a real packed tgz and a plain directory copy.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addExpoConfigPlugin,
  addFileDependency,
  extractPluginPackage,
  PLUGIN_PACKAGE_NAMES,
  PluginSourceNotFoundError,
  resolvePluginSelectionFlag,
  resolvePluginSource,
  resolvePluginTargets,
  wireNextConfigSource,
  wireViteConfigSource,
  wirePlugins,
  type PluginSource,
} from './plugin-wiring.js';

// Two real verifies / a real `npm pack` on a loaded box sit right at the default budget — give this file room.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
function mkdtemp(prefix = 'validity-plugin-wiring-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* resolvePluginSelectionFlag                                          */
/* ------------------------------------------------------------------ */

describe('resolvePluginSelectionFlag', () => {
  // Wiring is DEFAULT-ON (decision: Ryan 2026-08-07): omitted and bare
  // `--plugins` both mean auto-detect; `--no-plugins` is the ONE opt-out.
  // (The 2026-08-06 opt-in only ever held for programmatic runInit calls —
  // cac's negatable-flag default made the real CLI auto-wire regardless.)
  it('omitted (no flag at all) means auto-detect — wiring is the default', () => {
    expect(resolvePluginSelectionFlag(undefined)).toEqual({ ok: true, mode: 'auto' });
  });

  it('bare --plugins (explicit, no target) also means auto-detect', () => {
    expect(resolvePluginSelectionFlag(true)).toEqual({ ok: true, mode: 'auto' });
  });

  it('--no-plugins is the explicit opt-out — the only path to skip', () => {
    expect(resolvePluginSelectionFlag(false)).toEqual({ ok: true, mode: 'skip' });
  });

  it('accepts web | native | all', () => {
    expect(resolvePluginSelectionFlag('web')).toEqual({ ok: true, mode: 'web' });
    expect(resolvePluginSelectionFlag('native')).toEqual({ ok: true, mode: 'native' });
    expect(resolvePluginSelectionFlag('all')).toEqual({ ok: true, mode: 'all' });
  });

  it('rejects an unknown target with the valid list (never a silent fallback)', () => {
    const r = resolvePluginSelectionFlag('mobile');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('mobile');
      expect(r.message).toContain('web, native, all');
    }
  });
});

/* ------------------------------------------------------------------ */
/* resolvePluginTargets                                                */
/* ------------------------------------------------------------------ */

function project(pkg: object, files: Record<string, string> = {}): string {
  const dir = mkdtemp();
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) writeFileSync(resolve(dir, rel), body);
  return dir;
}

describe('resolvePluginTargets', () => {
  it('auto: a Vite app gets only the web plugin', () => {
    const dir = project({ dependencies: { vite: '6' } });
    expect(resolvePluginTargets(dir, 'auto')).toEqual(['vite']);
  });

  it('auto: an Expo app gets only the native plugin', () => {
    const dir = project({ dependencies: { expo: '51', 'react-native': '0.74' } });
    expect(resolvePluginTargets(dir, 'auto')).toEqual(['expo']);
  });

  it('auto: bare React Native (no expo) gets nothing — no config-plugin surface yet', () => {
    const dir = project({ dependencies: { 'react-native': '0.74' } });
    expect(resolvePluginTargets(dir, 'auto')).toEqual([]);
  });

  // REGRESSION GUARD: a Next app in auto mode used to silently get NOTHING
  // (only the vite/expo kinds were mapped) — the whole point of plugin-next.
  it('auto: a Next.js app gets the Next plugin', () => {
    const dir = project({ dependencies: { next: '15' } });
    expect(resolvePluginTargets(dir, 'auto')).toEqual(['next']);
  });

  it('auto: a toolchain with no manifest producer (Remix) still gets nothing', () => {
    const dir = project({ dependencies: { '@remix-run/dev': '2' } });
    expect(resolvePluginTargets(dir, 'auto')).toEqual([]);
  });

  it('web: a Next app gets plugin-next, NOT plugin-vite (no new flag vocabulary)', () => {
    const dir = project({ dependencies: { next: '15' } });
    expect(resolvePluginTargets(dir, 'web')).toEqual(['next']);
  });

  it('web: a Vite app gets plugin-vite', () => {
    const dir = project({ dependencies: { vite: '6' } });
    expect(resolvePluginTargets(dir, 'web')).toEqual(['vite']);
  });

  it('web: a TanStack Start app is a Vite app and gets plugin-vite', () => {
    const dir = project({
      dependencies: { vite: '7', '@tanstack/react-start': '1', '@tanstack/react-router': '1' },
    });
    expect(resolvePluginTargets(dir, 'web')).toEqual(['vite']);
    expect(resolvePluginTargets(dir, 'auto')).toEqual(['vite']);
  });

  it('web: an unrecognized project falls back to plugin-vite (explicit ask, best guess)', () => {
    const dir = project({ dependencies: {} });
    expect(resolvePluginTargets(dir, 'web')).toEqual(['vite']);
  });

  it('all: web half stays bundler-aware — Next app gets next + expo', () => {
    const dir = project({ dependencies: { next: '15' } });
    expect(resolvePluginTargets(dir, 'all')).toEqual(['next', 'expo']);
  });

  it('all: a Vite app gets vite + expo', () => {
    const dir = project({ dependencies: { vite: '6' } });
    expect(resolvePluginTargets(dir, 'all')).toEqual(['vite', 'expo']);
  });

  it('native never consults detection — always the Expo plugin', () => {
    const dir = project({ dependencies: { next: '15' } });
    expect(resolvePluginTargets(dir, 'native')).toEqual(['expo']);
  });

  it('skip always yields nothing', () => {
    const dir = project({ dependencies: { vite: '6', expo: '51' } });
    expect(resolvePluginTargets(dir, 'skip')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* addFileDependency (package.json)                                    */
/* ------------------------------------------------------------------ */

describe('addFileDependency', () => {
  it('appends to an existing dependencies block, preserving other deps + formatting', () => {
    const src = `{\n  "name": "app",\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n`;
    const r = addFileDependency(src, '@validity.ai/verify-plugin-vite', 'file:.validity/plugins/vite');
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('added');
    const parsed = JSON.parse(r.source);
    expect(parsed.dependencies.react).toBe('^18.0.0');
    expect(parsed.dependencies['@validity.ai/verify-plugin-vite']).toBe('file:.validity/plugins/vite');
    expect(r.source).toContain('    "react": "^18.0.0"');
  });

  it('creates a dependencies block when absent', () => {
    const src = `{\n  "name": "app",\n  "version": "1.0.0"\n}\n`;
    const r = addFileDependency(src, '@validity.ai/verify-plugin-expo', 'file:.validity/plugins/expo');
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.source);
    expect(parsed.dependencies).toEqual({ '@validity.ai/verify-plugin-expo': 'file:.validity/plugins/expo' });
    expect(parsed.name).toBe('app');
    expect(parsed.version).toBe('1.0.0');
  });

  it('is idempotent — the exact same dep+spec already present is a no-op', () => {
    const src = `{\n  "dependencies": {\n    "@validity.ai/verify-plugin-vite": "file:.validity/plugins/vite"\n  }\n}\n`;
    const r = addFileDependency(src, '@validity.ai/verify-plugin-vite', 'file:.validity/plugins/vite');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already');
    expect(r.source).toBe(src);
  });

  it('rejects unparseable JSON without writing anything', () => {
    const src = `{ not valid json`;
    const r = addFileDependency(src, '@validity.ai/verify-plugin-vite', 'file:.validity/plugins/vite');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unparseable');
    expect(r.source).toBe(src);
  });

  it('4-space indent files stay 4-space indented', () => {
    const src = `{\n    "name": "app",\n    "dependencies": {\n        "react": "^18.0.0"\n    }\n}\n`;
    const r = addFileDependency(src, '@validity.ai/verify-plugin-vite', 'file:.validity/plugins/vite');
    expect(r.changed).toBe(true);
    expect(r.source).toContain('        "react": "^18.0.0"');
    expect(r.source).toContain('        "@validity.ai/verify-plugin-vite": "file:.validity/plugins/vite"');
  });
});

/* ------------------------------------------------------------------ */
/* addExpoConfigPlugin (app.json)                                      */
/* ------------------------------------------------------------------ */

describe('addExpoConfigPlugin', () => {
  it('appends to an existing plugins array', () => {
    const src = `{\n  "expo": {\n    "name": "app",\n    "plugins": [\n      "expo-router"\n    ]\n  }\n}\n`;
    const r = addExpoConfigPlugin(src, '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.source);
    expect(parsed.expo.plugins).toEqual(['expo-router', '@validity.ai/verify-plugin-expo']);
  });

  it('creates a plugins array when absent', () => {
    const src = `{\n  "expo": {\n    "name": "app"\n  }\n}\n`;
    const r = addExpoConfigPlugin(src, '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.source);
    expect(parsed.expo.plugins).toEqual(['@validity.ai/verify-plugin-expo']);
    expect(parsed.expo.name).toBe('app');
  });

  it('is idempotent for a bare-string entry', () => {
    const src = `{\n  "expo": {\n    "plugins": [\n      "@validity.ai/verify-plugin-expo"\n    ]\n  }\n}\n`;
    const r = addExpoConfigPlugin(src, '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already');
  });

  it('is idempotent for a [name, options] tuple entry', () => {
    const src = `{\n  "expo": {\n    "plugins": [\n      ["@validity.ai/verify-plugin-expo", { "scheme": "x" }]\n    ]\n  }\n}\n`;
    const r = addExpoConfigPlugin(src, '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already');
  });

  it('reports unsupported-shape when there is no top-level "expo" key', () => {
    const src = `{\n  "name": "app"\n}\n`;
    const r = addExpoConfigPlugin(src, '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unsupported-shape');
  });

  it('rejects unparseable JSON', () => {
    const r = addExpoConfigPlugin('{ nope', '@validity.ai/verify-plugin-expo');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unparseable');
  });
});

/* ------------------------------------------------------------------ */
/* wireViteConfigSource                                                */
/* ------------------------------------------------------------------ */

describe('wireViteConfigSource', () => {
  it('wires into defineConfig({ plugins: [react()] })', () => {
    const src = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain("import validity from '@validity.ai/verify-plugin-vite';");
    expect(r.source).toContain('plugins: [validity(), react()]');
  });

  it('adds a plugins array to defineConfig({}) when absent', () => {
    const src = `import { defineConfig } from 'vite'\n\nexport default defineConfig({})\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('plugins: [validity()]');
    expect(r.source).toContain('@validity.ai/verify-plugin-vite');
  });

  it('wires a bare `export default { ... }` shape (no defineConfig wrapper)', () => {
    const src = `export default {\n  plugins: [],\n}\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('plugins: [validity(), ]');
  });

  it('is idempotent when already wired', () => {
    const src = `import validity from '@validity.ai/verify-plugin-vite';\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [validity()],\n})\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already');
  });

  it('falls back to not-simple-shape for a function-form defineConfig', () => {
    const src = `export default defineConfig(({ mode }) => ({\n  plugins: [],\n}))\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('falls back to not-simple-shape for an exported variable / mergeConfig wrapper', () => {
    const src = `const base = {}\nexport default mergeConfig(base, {})\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('inserts the import after the LAST existing import line', () => {
    const src = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`;
    const r = wireViteConfigSource(src);
    const lines = r.source.split('\n');
    const reactImportIdx = lines.findIndex((l) => l.includes('@vitejs/plugin-react'));
    const validityImportIdx = lines.findIndex((l) => l.includes('@validity.ai/verify-plugin-vite'));
    expect(validityImportIdx).toBeGreaterThan(reactImportIdx);
  });

  // TanStack Start ships as a VITE PLUGIN (`@tanstack/react-start/plugin/vite`)
  // — a Start app is a Vite app, so it needs no special case anywhere in
  // plugin selection or wiring. These two fixtures are the shapes the Start
  // scaffolds actually emit; they pin that the existing edit path covers
  // them, so "TanStack support" stays a documentation fact rather than code.
  it('wires a TanStack Start vite.config.ts (defineConfig + tanstackStart() in plugins)', () => {
    const src = [
      "import { defineConfig } from 'vite'",
      "import viteTsConfigPaths from 'vite-tsconfig-paths'",
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'",
      "import viteReact from '@vitejs/plugin-react'",
      '',
      'export default defineConfig({',
      '  server: {',
      '    port: 3000,',
      '  },',
      '  plugins: [',
      "    viteTsConfigPaths({ projects: ['./tsconfig.json'] }),",
      '    tanstackStart({ customViteReactPlugin: true }),',
      '    viteReact(),',
      '  ],',
      '})',
      '',
    ].join('\n');
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('added');
    expect(r.source).toContain("import validity from '@validity.ai/verify-plugin-vite';");
    // Wired into the TOP-LEVEL plugins array (not the nested `server` object),
    // and every existing Start plugin survives.
    expect(r.source).toContain('plugins: [validity(), ');
    expect(r.source).toContain('tanstackStart({ customViteReactPlugin: true })');
    expect(r.source).toContain('viteTsConfigPaths(');
    expect(r.source).toContain('port: 3000');
    // The import lands after the last existing import, inside the block.
    const lines = r.source.split('\n');
    expect(lines.findIndex((l) => l.includes('@validity.ai/verify-plugin-vite'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('@tanstack/react-start')),
    );
    // Idempotent on a second pass.
    expect(wireViteConfigSource(r.source).reason).toBe('already');
  });

  it('wires a minimal TanStack Start config (tanstackStart() as the only plugin)', () => {
    const src = `import { tanstackStart } from '@tanstack/react-start/plugin/vite'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [tanstackStart()],\n})\n`;
    const r = wireViteConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('plugins: [validity(), tanstackStart()]');
  });
});

/* ------------------------------------------------------------------ */
/* wireNextConfigSource                                                */
/* ------------------------------------------------------------------ */

describe('wireNextConfigSource', () => {
  // The three shapes create-next-app emits, one per file extension.
  it('wires the create-next-app TS shape (const nextConfig: NextConfig = {…} + export default)', () => {
    const src = [
      'import type { NextConfig } from "next";',
      '',
      'const nextConfig: NextConfig = {',
      '  /* config options here */',
      '};',
      '',
      'export default nextConfig;',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('added');
    expect(r.source).toContain("import { withValidity } from '@validity.ai/verify-plugin-next';");
    expect(r.source).toContain('const nextConfig: NextConfig = withValidity({');
    expect(r.source).toContain('});');
    expect(r.source).toContain('export default nextConfig;');
    // Import lands after the existing `import type` line, not above it.
    const lines = r.source.split('\n');
    expect(lines.findIndex((l) => l.includes('@validity.ai/verify-plugin-next'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('from "next"')),
    );
  });

  it('wires the create-next-app mjs shape (JSDoc @type + const + export default)', () => {
    const src = [
      "/** @type {import('next').NextConfig} */",
      'const nextConfig = {',
      '  reactStrictMode: true,',
      '};',
      '',
      'export default nextConfig;',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain("import { withValidity } from '@validity.ai/verify-plugin-next';");
    expect(r.source).toContain('const nextConfig = withValidity({');
    expect(r.source).toContain('reactStrictMode: true,');
    // The JSDoc annotation stays attached to the declaration it describes.
    const lines = r.source.split('\n');
    expect(lines[lines.findIndex((l) => l.includes('const nextConfig')) - 1]).toContain('@type');
  });

  it('wires the CommonJS shape (const + module.exports) with a require, not an import', () => {
    const src = [
      "/** @type {import('next').NextConfig} */",
      'const nextConfig = {};',
      '',
      'module.exports = nextConfig;',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain("const { withValidity } = require('@validity.ai/verify-plugin-next');");
    expect(r.source).not.toContain('import {');
    expect(r.source).toContain('const nextConfig = withValidity({});');
  });

  it('wires a direct `export default { … }`', () => {
    const src = `export default {\n  reactStrictMode: true,\n};\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('export default withValidity({');
    expect(r.source).toContain("import { withValidity } from '@validity.ai/verify-plugin-next';");
  });

  it('wires a direct `module.exports = { … }`', () => {
    const src = `module.exports = {\n  reactStrictMode: true,\n};\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('module.exports = withValidity({');
    expect(r.source).toContain("const { withValidity } = require('@validity.ai/verify-plugin-next');");
  });

  it('inserts the require after the LAST existing require line', () => {
    const src = [
      "const path = require('node:path');",
      '',
      'module.exports = {',
      '  reactStrictMode: true,',
      '};',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    const lines = r.source.split('\n');
    expect(lines.findIndex((l) => l.includes('@validity.ai/verify-plugin-next'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('node:path')),
    );
  });

  it('is idempotent — a wired config reports already and is returned untouched', () => {
    const src = `import { withValidity } from '@validity.ai/verify-plugin-next';\n\nexport default withValidity({\n  reactStrictMode: true,\n});\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already');
    expect(r.source).toBe(src);
  });

  it('re-running the transform on its own output is a no-op', () => {
    const src = `const nextConfig = {};\n\nexport default nextConfig;\n`;
    const once = wireNextConfigSource(src);
    expect(once.changed).toBe(true);
    const twice = wireNextConfigSource(once.source);
    expect(twice.changed).toBe(false);
    expect(twice.reason).toBe('already');
    expect(twice.source).toBe(once.source);
  });

  // The shapes we refuse to touch. Each of these would need real reasoning
  // about arbitrary JS, so each gets a paste stanza instead of a rewrite.
  it('refuses an existing wrapper at the export site (withBundleAnalyzer)', () => {
    const src = [
      "const withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: true });",
      '',
      'const nextConfig = {',
      '  reactStrictMode: true,',
      '};',
      '',
      'module.exports = withBundleAnalyzer(nextConfig);',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
    expect(r.source).toBe(src);
  });

  it('refuses an ESM wrapper chain at the export site', () => {
    const src = `import withMDX from '@next/mdx';\n\nconst nextConfig = {};\n\nexport default withMDX()(nextConfig);\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses a function config (phase form)', () => {
    const src = `module.exports = (phase, { defaultConfig }) => {\n  return { ...defaultConfig };\n};\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses an arrow-function default export', () => {
    const src = `export default (phase) => ({\n  reactStrictMode: true,\n});\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses an async function config', () => {
    const src = `export default async function config() {\n  return {};\n}\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses a declaration whose initializer is a call, not a literal', () => {
    const src = `const nextConfig = buildConfig({ reactStrictMode: true });\n\nexport default nextConfig;\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses a function-typed annotation (the `=` in `=>` must not read as an object)', () => {
    const src = `const nextConfig: (phase: string) => NextConfig = (phase) => ({});\n\nexport default nextConfig;\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('refuses a file with no recognizable export at all', () => {
    const src = `// TODO: write a config\n`;
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('not-simple-shape');
  });

  it('keeps a nested object literal intact (brace matching, not first-close-wins)', () => {
    const src = [
      'const nextConfig = {',
      '  images: { remotePatterns: [{ hostname: "example.com" }] },',
      '  experimental: { typedRoutes: true },',
      '};',
      '',
      'export default nextConfig;',
      '',
    ].join('\n');
    const r = wireNextConfigSource(src);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('const nextConfig = withValidity({');
    expect(r.source).toContain('experimental: { typedRoutes: true },');
    expect(r.source).toContain('});');
    expect(r.source).toContain('export default nextConfig;');
    // Exactly one wrap — the nested literals are untouched.
    expect(r.source.match(/withValidity\(/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* resolvePluginSource — 3-tier precedence                             */
/* ------------------------------------------------------------------ */

describe('resolvePluginSource', () => {
  it('finds a staged tarball sibling to the module dir (esbuild-bundle layout)', () => {
    const installRoot = mkdtemp();
    mkdirSync(resolve(installRoot, 'plugins'), { recursive: true });
    writeFileSync(resolve(installRoot, 'plugins/vite.tgz'), 'fake-tgz-bytes');
    const src = resolvePluginSource('vite', { moduleDir: installRoot });
    expect(src).toEqual({ kind: 'tgz', path: resolve(installRoot, 'plugins/vite.tgz') });
  });

  it('finds a staged tarball one level up (tsc dev-build layout)', () => {
    const installRoot = mkdtemp();
    const distDir = resolve(installRoot, 'dist');
    mkdirSync(resolve(installRoot, 'plugins'), { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(installRoot, 'plugins/expo.tgz'), 'fake-tgz-bytes');
    const src = resolvePluginSource('expo', { moduleDir: distDir });
    expect(src).toEqual({ kind: 'tgz', path: resolve(installRoot, 'plugins/expo.tgz') });
  });

  it('falls back to npm root -g when module-relative candidates miss', () => {
    const npmRoot = mkdtemp();
    mkdirSync(resolve(npmRoot, 'validity/plugins'), { recursive: true });
    writeFileSync(resolve(npmRoot, 'validity/plugins/vite.tgz'), 'fake-tgz-bytes');
    const emptyModuleDir = mkdtemp();
    const src = resolvePluginSource('vite', {
      moduleDir: emptyModuleDir,
      npmRootGlobal: () => npmRoot,
    });
    expect(src).toEqual({ kind: 'tgz', path: resolve(npmRoot, 'validity/plugins/vite.tgz') });
  });

  it('falls back to the in-repo dev package dir when dist/ + package.json exist', () => {
    const monorepoRoot = mkdtemp();
    const verifyDist = resolve(monorepoRoot, 'packages/verify/dist');
    const pluginDir = resolve(monorepoRoot, 'packages/verify-plugin-vite');
    mkdirSync(verifyDist, { recursive: true });
    mkdirSync(resolve(pluginDir, 'dist'), { recursive: true });
    writeFileSync(resolve(pluginDir, 'package.json'), '{"name":"@validity.ai/verify-plugin-vite"}');
    const src = resolvePluginSource('vite', { moduleDir: verifyDist, npmRootGlobal: () => null });
    expect(src).toEqual({ kind: 'dir', path: pluginDir });
  });

  // The resolver is generic over the short name — no per-plugin candidate
  // lists — so a new plugin needs nothing here beyond being packed/built.
  it('resolves the next plugin from the same staged + in-repo layouts', () => {
    const installRoot = mkdtemp();
    mkdirSync(resolve(installRoot, 'plugins'), { recursive: true });
    writeFileSync(resolve(installRoot, 'plugins/next.tgz'), 'fake-tgz-bytes');
    expect(resolvePluginSource('next', { moduleDir: installRoot })).toEqual({
      kind: 'tgz',
      path: resolve(installRoot, 'plugins/next.tgz'),
    });

    const monorepoRoot = mkdtemp();
    const verifyDist = resolve(monorepoRoot, 'packages/verify/dist');
    const pluginDir = resolve(monorepoRoot, 'packages/verify-plugin-next');
    mkdirSync(verifyDist, { recursive: true });
    mkdirSync(resolve(pluginDir, 'dist'), { recursive: true });
    writeFileSync(resolve(pluginDir, 'package.json'), '{"name":"@validity.ai/verify-plugin-next"}');
    expect(resolvePluginSource('next', { moduleDir: verifyDist, npmRootGlobal: () => null })).toEqual({
      kind: 'dir',
      path: pluginDir,
    });
  });

  it('names the right build command for a missing next plugin', () => {
    const emptyModuleDir = mkdtemp();
    try {
      resolvePluginSource('next', { moduleDir: emptyModuleDir, npmRootGlobal: () => null });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('@validity.ai/verify-plugin-next build');
    }
  });

  it('throws PluginSourceNotFoundError, listing every checked path, when nothing exists', () => {
    const emptyModuleDir = mkdtemp();
    expect(() =>
      resolvePluginSource('vite', { moduleDir: emptyModuleDir, npmRootGlobal: () => null }),
    ).toThrow(PluginSourceNotFoundError);
    try {
      resolvePluginSource('vite', { moduleDir: emptyModuleDir, npmRootGlobal: () => null });
    } catch (err) {
      expect(err).toBeInstanceOf(PluginSourceNotFoundError);
      const e = err as PluginSourceNotFoundError;
      expect(e.shortName).toBe('vite');
      expect(e.checked.length).toBeGreaterThan(0);
      expect(e.message).toContain('not staged in this install');
    }
  });
});

/* ------------------------------------------------------------------ */
/* extractPluginPackage                                                */
/* ------------------------------------------------------------------ */

const hasTar = (() => {
  try {
    execFileSync('tar', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTar)('extractPluginPackage', () => {
  function packFixture(): string {
    const pkgDir = mkdtemp('validity-plugin-fixture-');
    writeFileSync(
      resolve(pkgDir, 'package.json'),
      JSON.stringify({ name: '@validity.ai/verify-plugin-vite', version: '0.0.1', main: 'index.js' }),
    );
    writeFileSync(resolve(pkgDir, 'index.js'), 'module.exports = () => ({ name: "validity" });\n');
    const outDir = mkdtemp('validity-plugin-pack-out-');
    execFileSync('npm', ['pack', '--silent', '--pack-destination', outDir], { cwd: pkgDir });
    const files = readdirSync(outDir);
    const tgz = files.find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack did not produce a .tgz');
    return resolve(outDir, tgz);
  }

  it('extracts a tgz into .validity/plugins/<name>/, stripping the package/ wrapper', () => {
    const tgzPath = packFixture();
    const cwd = mkdtemp();
    const source: PluginSource = { kind: 'tgz', path: tgzPath };
    const r = extractPluginPackage(cwd, 'vite', source);
    expect(r.action).toBe('wrote');
    const destPkg = resolve(cwd, '.validity/plugins/vite/package.json');
    expect(existsSync(destPkg)).toBe(true);
    expect(JSON.parse(readFileSync(destPkg, 'utf-8')).name).toBe('@validity.ai/verify-plugin-vite');
  });

  it('is idempotent — a second call without force reports unchanged and does not touch files', () => {
    const tgzPath = packFixture();
    const cwd = mkdtemp();
    const source: PluginSource = { kind: 'tgz', path: tgzPath };
    extractPluginPackage(cwd, 'vite', source);
    const destPkg = resolve(cwd, '.validity/plugins/vite/package.json');
    writeFileSync(resolve(cwd, '.validity/plugins/vite/marker.txt'), 'user was here');
    const r = extractPluginPackage(cwd, 'vite', source);
    expect(r.action).toBe('unchanged');
    expect(existsSync(resolve(cwd, '.validity/plugins/vite/marker.txt'))).toBe(true);
    expect(existsSync(destPkg)).toBe(true);
  });

  it('force re-extracts and clears prior contents', () => {
    const tgzPath = packFixture();
    const cwd = mkdtemp();
    const source: PluginSource = { kind: 'tgz', path: tgzPath };
    extractPluginPackage(cwd, 'vite', source);
    writeFileSync(resolve(cwd, '.validity/plugins/vite/marker.txt'), 'stale');
    const r = extractPluginPackage(cwd, 'vite', source, { force: true });
    expect(r.action).toBe('wrote');
    expect(existsSync(resolve(cwd, '.validity/plugins/vite/marker.txt'))).toBe(false);
  });
});

describe('extractPluginPackage (dir source)', () => {
  it('copies a directory source, excluding node_modules and *.test.ts', () => {
    const pkgDir = mkdtemp();
    writeFileSync(resolve(pkgDir, 'package.json'), '{"name":"@validity.ai/verify-plugin-expo"}');
    mkdirSync(resolve(pkgDir, 'dist'), { recursive: true });
    writeFileSync(resolve(pkgDir, 'dist/index.js'), 'module.exports = {};\n');
    mkdirSync(resolve(pkgDir, 'node_modules/leftpad'), { recursive: true });
    writeFileSync(resolve(pkgDir, 'node_modules/leftpad/index.js'), '');
    writeFileSync(resolve(pkgDir, 'index.test.ts'), '');

    const cwd = mkdtemp();
    const source: PluginSource = { kind: 'dir', path: pkgDir };
    const r = extractPluginPackage(cwd, 'expo', source);
    expect(r.action).toBe('wrote');
    expect(existsSync(resolve(cwd, '.validity/plugins/expo/package.json'))).toBe(true);
    expect(existsSync(resolve(cwd, '.validity/plugins/expo/dist/index.js'))).toBe(true);
    expect(existsSync(resolve(cwd, '.validity/plugins/expo/node_modules'))).toBe(false);
    expect(existsSync(resolve(cwd, '.validity/plugins/expo/index.test.ts'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* wirePlugins — end-to-end orchestration on fixture projects          */
/* ------------------------------------------------------------------ */

describe('wirePlugins', () => {
  function fixtureSource(pkgName: string): { dir: string; source: PluginSource } {
    const dir = mkdtemp();
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '0.0.1' }),
    );
    mkdirSync(resolve(dir, 'dist'), { recursive: true });
    writeFileSync(resolve(dir, 'dist/index.js'), 'module.exports = () => ({});\n');
    return { dir, source: { kind: 'dir', path: dir } };
  }

  it('wires the vite plugin end-to-end: extract, package.json dep, vite.config edit', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { vite: '6' } }),
    );
    writeFileSync(
      resolve(cwd, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`,
    );
    const { source } = fixtureSource('@validity.ai/verify-plugin-vite');

    const result = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    expect(result.targets).toEqual(['vite']);
    expect(result.warnings).toEqual([]);

    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@validity.ai/verify-plugin-vite']).toBe('file:.validity/plugins/vite');
    const viteConfig = readFileSync(resolve(cwd, 'vite.config.ts'), 'utf-8');
    expect(viteConfig).toContain('validity()');
    expect(existsSync(resolve(cwd, '.validity/plugins/vite/package.json'))).toBe(true);
  });

  it('re-running is fully idempotent (every step reports unchanged, nothing rewritten again)', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { vite: '6' } }),
    );
    writeFileSync(
      resolve(cwd, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`,
    );
    const { source } = fixtureSource('@validity.ai/verify-plugin-vite');

    wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    const secondRun = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    for (const step of secondRun.steps) {
      expect(['unchanged', 'skipped']).toContain(step.action);
    }
  });

  it('a missing plugin source surfaces as a warning + error step, never throws', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { expo: '51', 'react-native': '0.74' } }),
    );
    const result = wirePlugins({
      cwd,
      selection: 'auto',
      resolveSource: () => {
        throw new PluginSourceNotFoundError('expo', ['/nowhere']);
      },
    });
    expect(result.targets).toEqual(['expo']);
    expect(result.warnings.length).toBe(1);
    expect(result.steps[0]!.action).toBe('error');
  });

  it('prints a paste stanza for an app.config.ts (dynamic Expo config)', () => {
    const cwd = mkdtemp();
    writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(resolve(cwd, 'app.config.ts'), 'export default ({ config }) => config;\n');
    const { source } = fixtureSource('@validity.ai/verify-plugin-expo');
    const result = wirePlugins({ cwd, selection: 'native', resolveSource: () => source });
    const appConfigStep = result.steps.find((s) => s.step === 'app-config-js');
    expect(appConfigStep?.action).toBe('paste-stanza');
    expect(appConfigStep?.stanza).toContain('withValidity');
  });

  it('wires the next plugin end-to-end: extract, package.json dep, next.config edit', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { next: '15' } }),
    );
    writeFileSync(
      resolve(cwd, 'next.config.ts'),
      `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`,
    );
    const { source } = fixtureSource('@validity.ai/verify-plugin-next');

    const result = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    expect(result.targets).toEqual(['next']);
    expect(result.warnings).toEqual([]);

    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@validity.ai/verify-plugin-next']).toBe('file:.validity/plugins/next');
    const nextConfig = readFileSync(resolve(cwd, 'next.config.ts'), 'utf-8');
    expect(nextConfig).toContain('withValidity({})');
    expect(nextConfig).toContain("import { withValidity } from '@validity.ai/verify-plugin-next';");
    expect(existsSync(resolve(cwd, '.validity/plugins/next/package.json'))).toBe(true);

    // Re-running touches nothing.
    const second = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    for (const step of second.steps) expect(['unchanged', 'skipped']).toContain(step.action);
  });

  it('edits next.config.js first when several config files exist (Next own resolution order)', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { next: '15' } }),
    );
    const original = `const nextConfig = {};\n\nexport default nextConfig;\n`;
    writeFileSync(resolve(cwd, 'next.config.js'), `module.exports = {};\n`);
    writeFileSync(resolve(cwd, 'next.config.mjs'), original);
    const { source } = fixtureSource('@validity.ai/verify-plugin-next');

    const result = wirePlugins({ cwd, selection: 'web', resolveSource: () => source });
    expect(result.targets).toEqual(['next']);
    expect(readFileSync(resolve(cwd, 'next.config.js'), 'utf-8')).toContain('withValidity({})');
    expect(readFileSync(resolve(cwd, 'next.config.mjs'), 'utf-8')).toBe(original);
  });

  it('prints a paste stanza for a Next app whose config is a wrapper chain', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { next: '15' } }),
    );
    writeFileSync(
      resolve(cwd, 'next.config.mjs'),
      `import withMDX from '@next/mdx';\n\nconst nextConfig = {};\n\nexport default withMDX()(nextConfig);\n`,
    );
    const { source } = fixtureSource('@validity.ai/verify-plugin-next');
    const result = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    const step = result.steps.find((s) => s.step === 'next-config');
    expect(step?.action).toBe('paste-stanza');
    expect(step?.stanza).toContain('withValidity');
    // …and the user's config is left exactly as it was.
    expect(readFileSync(resolve(cwd, 'next.config.mjs'), 'utf-8')).toContain(
      'export default withMDX()(nextConfig);',
    );
  });

  it('a Next app with no next.config.* still wires the dep and prints a stanza', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { next: '15' } }),
    );
    const { source } = fixtureSource('@validity.ai/verify-plugin-next');
    const result = wirePlugins({ cwd, selection: 'auto', resolveSource: () => source });
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@validity.ai/verify-plugin-next']).toBe('file:.validity/plugins/next');
    const step = result.steps.find((s) => s.step === 'next-config');
    expect(step?.action).toBe('paste-stanza');
    // Never creates a config file Next didn't have.
    expect(existsSync(resolve(cwd, 'next.config.js'))).toBe(false);
    expect(existsSync(resolve(cwd, 'next.config.ts'))).toBe(false);
  });

  it('skip selection wires nothing', () => {
    const cwd = mkdtemp();
    writeFileSync(
      resolve(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { vite: '6' } }),
    );
    const result = wirePlugins({ cwd, selection: 'skip' });
    expect(result.targets).toEqual([]);
    expect(result.steps).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* PLUGIN_PACKAGE_NAMES sanity                                         */
/* ------------------------------------------------------------------ */

describe('PLUGIN_PACKAGE_NAMES', () => {
  it('maps short names to the contracted package names', () => {
    expect(PLUGIN_PACKAGE_NAMES.vite).toBe('@validity.ai/verify-plugin-vite');
    expect(PLUGIN_PACKAGE_NAMES.next).toBe('@validity.ai/verify-plugin-next');
    expect(PLUGIN_PACKAGE_NAMES.expo).toBe('@validity.ai/verify-plugin-expo');
  });

  // The short name is a wire format: it names the staged tarball
  // (`plugins/<shortName>.tgz`, written by installer/src/plugin-packing.ts),
  // the extraction directory (`.validity/plugins/<shortName>/`), and the
  // `file:` dependency spec. Adding one means adding a pack target too.
  it('covers exactly the three short names the installer packs', () => {
    expect(Object.keys(PLUGIN_PACKAGE_NAMES).sort()).toEqual(['expo', 'next', 'vite']);
  });
});
