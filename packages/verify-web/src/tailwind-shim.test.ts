/**
 * Tailwind v4 shim generation — the custom-theme regression (smoke test
 * finding): the app's `@theme` tokens (bg-accent, text-accent, …) must
 * compile against the shim's project-wide @source scan, or accent styling
 * silently vanishes from every screenshot. The shim therefore imports the
 * PROJECT'S OWN Tailwind entry when one exists, falling back to the bare
 * "tailwindcss" default otherwise.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeSharedSandboxAssets } from './prepare.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpProject(opts: { tailwind?: boolean } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-shim-'));
  roots.push(root);
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'p',
      devDependencies: opts.tailwind === false ? {} : { '@tailwindcss/vite': '^4.0.0' },
    }),
  );
  mkdirSync(resolve(root, 'node_modules', '.validity'), { recursive: true });
  return root;
}

function shimOf(root: string): string {
  return readFileSync(
    resolve(root, 'node_modules', '.validity', 'validity-tailwind-shim.css'),
    'utf-8',
  );
}

describe('Tailwind v4 shim — custom @theme tokens ride into the project-scanning build', () => {
  it('imports the project Tailwind entry (well-known location) instead of the bare default', () => {
    const root = tmpProject();
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'globals.css'),
      '@import "tailwindcss";\n@theme {\n  --color-accent: #ff00aa;\n}\n',
    );
    const { hasTailwindV4 } = writeSharedSandboxAssets(root);
    expect(hasTailwindV4).toBe(true);
    const shim = shimOf(root);
    expect(shim).toContain('@import "../../src/globals.css";');
    expect(shim).not.toContain('@import "tailwindcss";');
    expect(shim).toContain('@source "../../**/*');
  });

  it('finds a non-standard entry via the bounded walk', () => {
    const root = tmpProject();
    mkdirSync(resolve(root, 'src', 'styles'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'styles', 'theme.css'),
      "@import 'tailwindcss';\n@theme { --color-brand: #123456; }\n",
    );
    writeSharedSandboxAssets(root);
    expect(shimOf(root)).toContain('@import "../../src/styles/theme.css";');
  });

  it('falls back to the bare tailwindcss import when no entry stylesheet exists', () => {
    const root = tmpProject();
    writeSharedSandboxAssets(root);
    const shim = shimOf(root);
    expect(shim).toContain('@import "tailwindcss";');
    expect(shim).toContain('@source "../../**/*');
  });

  it('a CSS file without the tailwindcss import is not treated as the entry', () => {
    const root = tmpProject();
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(resolve(root, 'src', 'globals.css'), 'body { margin: 0; }\n');
    writeSharedSandboxAssets(root);
    expect(shimOf(root)).toContain('@import "tailwindcss";');
  });

  it('writes no shim at all without the @tailwindcss/vite dependency', () => {
    const root = tmpProject({ tailwind: false });
    const { hasTailwindV4 } = writeSharedSandboxAssets(root);
    expect(hasTailwindV4).toBe(false);
    expect(() => shimOf(root)).toThrow();
  });
});
