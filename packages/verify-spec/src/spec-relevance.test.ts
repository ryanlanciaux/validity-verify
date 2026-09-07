/**
 * Relevance-scoped staleness (W3 #10) for the ONE-OFF verify fold.
 *
 * The property under test is the product one: after a one-off `validity__verify`
 * with no `validity watch` running, an UNRELATED file edit must not stale a
 * spec's soft scores, while an edit to a file the spec's component imports
 * must. Everything runs against a real temp git repo — the helper's whole job
 * is reading git, so mocking it away would test nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changesGlobalStyles,
  codeChangedForSpec,
  lastObservedSha,
  specsAffectedByChangedFiles,
} from './spec-relevance.js';
import type { Spec } from './spec-schema.js';
import type { ScorecardSpec } from './scorecard.js';

const T0 = '2026-01-01T00:00:00.000Z';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function specFor(targets: string[]): Spec {
  return {
    id: 'spec-rel',
    version: 1,
    status: 'frozen',
    hash: 'h1',
    source: { prompt: 'p', createdBy: 'agent' },
    criteria: [{ id: 'AC-1', text: 'looks right', tier: 'soft' }],
    targets: { components: targets },
    createdAt: T0,
  };
}

describe('specsAffectedByChangedFiles (shared with `validity watch`)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-relevance-'));
    mkdirSync(resolve(root, 'src'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('matches a spec whose target file changed, and leaves an unrelated spec out', () => {
    const login = specFor(['src/Login.tsx']);
    const other: Spec = { ...specFor(['src/Settings.tsx']), id: 'spec-other' };
    const result = specsAffectedByChangedFiles({
      projectRoot: root,
      specs: [login, other],
      changedFiles: ['src/Login.tsx'],
    });
    expect(result.matched.map((s) => s.id)).toEqual(['spec-rel']);
    expect(result.globalStyleChange).toBe(false);
  });

  it('ripples upward: editing an imported Button matches the spec targeting its importer', () => {
    writeFileSync(resolve(root, 'src', 'Button.tsx'), 'export const Button = () => null;\n');
    writeFileSync(
      resolve(root, 'src', 'Login.tsx'),
      "import { Button } from './Button';\nexport const Login = () => Button();\n",
    );
    const result = specsAffectedByChangedFiles({
      projectRoot: root,
      specs: [specFor(['src/Login.tsx'])],
      changedFiles: ['src/Button.tsx'],
    });
    expect(result.matched.map((s) => s.id)).toEqual(['spec-rel']);
  });

  it('a global style/config change matches EVERY candidate spec', () => {
    const result = specsAffectedByChangedFiles({
      projectRoot: root,
      specs: [specFor(['src/Login.tsx'])],
      changedFiles: ['tailwind.config.js'],
    });
    expect(result.globalStyleChange).toBe(true);
    expect(result.matched).toHaveLength(1);
    expect(changesGlobalStyles(['src/components/Button.module.css'])).toBe(false);
  });

  it('reports a target-less spec as UNMAPPED, never as unaffected', () => {
    const result = specsAffectedByChangedFiles({
      projectRoot: root,
      specs: [specFor([])],
      changedFiles: ['src/Login.tsx'],
    });
    expect(result.matched).toHaveLength(0);
    expect(result.unmapped.map((s) => s.id)).toEqual(['spec-rel']);
  });
});

describe('lastObservedSha', () => {
  const entry = (criteria: ScorecardSpec['criteria']): ScorecardSpec => ({
    specVersion: 1,
    verdict: 'pass',
    coveragePercent: 100,
    criteria,
    updatedAt: T0,
  });

  it('prefers a SOFT criterion sha (that is the row staleness protects)', () => {
    expect(
      lastObservedSha(
        entry({
          'AC-1': { tier: 'hard', status: 'pass', at: T0, sha: 'hard-sha' },
          'AC-2': { tier: 'soft', status: 'pass', at: T0, sha: 'soft-sha' },
        }),
      ),
    ).toBe('soft-sha');
  });

  it('falls back to any criterion sha, and is undefined when nothing was stamped', () => {
    expect(
      lastObservedSha(entry({ 'AC-1': { tier: 'hard', status: 'pass', at: T0, sha: 'only' } })),
    ).toBe('only');
    expect(
      lastObservedSha(entry({ 'AC-1': { tier: 'hard', status: 'pass', at: T0 } })),
    ).toBeUndefined();
    expect(lastObservedSha(undefined)).toBeUndefined();
  });
});

describe("codeChangedForSpec (the MCP fold's watch-parity input)", () => {
  let root: string;
  let baseSha: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-codechanged-'));
    mkdirSync(resolve(root, 'src'), { recursive: true });
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@validity.local']);
    git(root, ['config', 'user.name', 'Validity Test']);
    writeFileSync(resolve(root, 'src', 'Button.tsx'), 'export const Button = () => null;\n');
    writeFileSync(
      resolve(root, 'src', 'Login.tsx'),
      "import { Button } from './Button';\nexport const Login = () => Button();\n",
    );
    writeFileSync(resolve(root, 'src', 'Unrelated.tsx'), 'export const Unrelated = () => null;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
    baseSha = git(root, ['rev-parse', 'HEAD']).trim();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('an UNRELATED committed change does not mark the spec changed', () => {
    writeFileSync(resolve(root, 'src', 'Unrelated.tsx'), 'export const Unrelated = () => 1;\n');
    git(root, ['commit', '-qam', 'unrelated']);
    expect(
      codeChangedForSpec({
        projectRoot: root,
        spec: specFor(['src/Login.tsx']),
        sinceSha: baseSha,
      }),
    ).toBe(false);
  });

  it("a change to a file the spec's component IMPORTS marks it changed (ripple)", () => {
    writeFileSync(resolve(root, 'src', 'Button.tsx'), 'export const Button = () => 2;\n');
    git(root, ['commit', '-qam', 'button']);
    expect(
      codeChangedForSpec({
        projectRoot: root,
        spec: specFor(['src/Login.tsx']),
        sinceSha: baseSha,
      }),
    ).toBe(true);
  });

  it('UNCOMMITTED edits count too — a day of dirty work must stale the score', () => {
    writeFileSync(resolve(root, 'src', 'Login.tsx'), 'export const Login = () => 3;\n');
    expect(
      codeChangedForSpec({
        projectRoot: root,
        spec: specFor(['src/Login.tsx']),
        sinceSha: baseSha,
      }),
    ).toBe(true);
  });

  it('nothing moved at all ⇒ false (the honest answer, not "unknown")', () => {
    expect(
      codeChangedForSpec({
        projectRoot: root,
        spec: specFor(['src/Login.tsx']),
        sinceSha: baseSha,
      }),
    ).toBe(false);
  });

  it('NEVER guesses false: unknown sha, missing sha and a target-less spec all read undefined', () => {
    // No prior sha at all — a first fold has nothing to diff from.
    expect(
      codeChangedForSpec({ projectRoot: root, spec: specFor(['src/Login.tsx']) }),
    ).toBeUndefined();
    // A sha git cannot resolve (GC'd / shallow clone / foreign history).
    expect(
      codeChangedForSpec({
        projectRoot: root,
        spec: specFor(['src/Login.tsx']),
        sinceSha: '0000000000000000000000000000000000000000',
      }),
    ).toBeUndefined();
    // A spec that declares no targets: we cannot prove irrelevance.
    writeFileSync(resolve(root, 'src', 'Unrelated.tsx'), 'export const Unrelated = () => 9;\n');
    expect(
      codeChangedForSpec({ projectRoot: root, spec: specFor([]), sinceSha: baseSha }),
    ).toBeUndefined();
  });

  it('a non-git directory reads undefined, never false', () => {
    const nonGit = mkdtempSync(resolve(tmpdir(), 'validity-nogit-'));
    try {
      expect(
        codeChangedForSpec({
          projectRoot: nonGit,
          spec: specFor(['src/Login.tsx']),
          sinceSha: baseSha,
        }),
      ).toBeUndefined();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
