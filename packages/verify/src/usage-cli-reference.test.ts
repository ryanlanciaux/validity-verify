/**
 * Docs-truth guard for the CLI reference in README.md.
 *
 * Reads `cli.ts` SOURCE TEXT (never imports it — the module calls `main()` at
 * load time) and checks that every real `cli.command(...)` is named in
 * README.md's "## CLI" section as `validity <cmd>`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const cliSourcePath = resolve(here, 'cli.ts');
const usagePath = resolve(repoRoot, 'README.md');

function realCommandNames(cliSource: string): string[] {
  const re = /\.command\(\s*['"]([a-zA-Z][\w-]*)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cliSource))) names.add(m[1]!);
  return [...names];
}

function cliReferenceSection(usage: string): string {
  const start = usage.indexOf('## CLI');
  if (start === -1) throw new Error('README.md has no "## CLI" section');
  const rest = usage.slice(start);
  const nextHeading = rest.indexOf('\n## ', 1);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

const cliSource = readFileSync(cliSourcePath, 'utf-8');
const usage = readFileSync(usagePath, 'utf-8');
const realCommands = realCommandNames(cliSource);
const section = cliReferenceSection(usage);

describe('README.md CLI reference stays in sync with cli.ts', () => {
  it('cli.ts actually has commands to check against (sanity)', () => {
    expect(realCommands.length).toBeGreaterThan(10);
  });

  for (const cmd of realCommands) {
    it(`documents \`validity ${cmd}\``, () => {
      expect(section).toMatch(new RegExp(`validity ${cmd}\\b`));
    });
  }
});
