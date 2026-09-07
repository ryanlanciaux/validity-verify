/**
 * Phase A agent-stanza wiring for `validity init`. Exercises the
 * `applyAgentStanza` seam (not `runInit` end-to-end) so we can assert the
 * CLAUDE.md / AGENTS.md contract without running the full
 * ensureValidityConfigured bootstrap. Mirrors export.test.ts's mkdtempSync +
 * colocation convention. Also guards that the `--no-agent-stanza` flag is
 * actually registered on the `init` command in cli.ts — read as SOURCE TEXT
 * (never import cli.ts; it calls main() at load time).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAgentStanza, runInit } from './init.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliSourcePath = resolve(here, '..', 'cli.ts');

function mkdtemp(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-init-stanza-'));
}

const USER_TEXT = `# My project\n\nSome custom notes about how we work here.\n`;

describe('applyAgentStanza', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtemp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opt-out: --no-agent-stanza skips and creates nothing', () => {
    const reports = applyAgentStanza({ cwd: root, enabled: false, allowAdd: true });
    expect(reports).toEqual([]);
    expect(existsSync(resolve(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  });

  it('first-init create: writes CLAUDE.md with markers, never AGENTS.md', () => {
    const reports = applyAgentStanza({ cwd: root, enabled: true, allowAdd: true });
    const actions = reports.map((r) => r.action);
    expect(actions).toContain('created');
    const claudePath = resolve(root, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    const src = readFileSync(claudePath, 'utf-8');
    expect(src).toContain('<!-- validity:begin -->');
    expect(src).toContain('<!-- validity:end -->');
    expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  });

  it('AGENTS.md only-if-exists: appends block, preserves original text', () => {
    const agentsPath = resolve(root, 'AGENTS.md');
    writeFileSync(agentsPath, USER_TEXT, 'utf-8');
    const reports = applyAgentStanza({ cwd: root, enabled: true, allowAdd: true });
    const agentsReport = reports.find((r) => r.path === 'AGENTS.md');
    expect(agentsReport).toBeDefined();
    expect(agentsReport!.action).toMatch(/updated|unchanged/);
    const src = readFileSync(agentsPath, 'utf-8');
    expect(src.startsWith(USER_TEXT)).toBe(true);
    expect(src).toContain('<!-- validity:begin -->');
    expect(src).toContain('<!-- validity:end -->');
  });

  it('update-in-place without allowAdd: keeps block, never clobbers user text', () => {
    const claudePath = resolve(root, 'CLAUDE.md');
    writeFileSync(claudePath, USER_TEXT, 'utf-8');
    // First pass with allowAdd to seed the block.
    applyAgentStanza({ cwd: root, enabled: true, allowAdd: true });
    const seeded = readFileSync(claudePath, 'utf-8');
    expect(seeded).toContain('<!-- validity:begin -->');
    // Re-run WITHOUT allowAdd — block stays, user text preserved.
    const reports = applyAgentStanza({ cwd: root, enabled: true, allowAdd: false });
    const claudeReport = reports.find((r) => r.path === 'CLAUDE.md');
    expect(claudeReport).toBeDefined();
    // Either unchanged (idempotent) or skipped; never created/updated.
    expect(['unchanged', 'skipped']).toContain(claudeReport!.action);
    const after = readFileSync(claudePath, 'utf-8');
    expect(after).toContain('<!-- validity:begin -->');
    expect(after).toContain('<!-- validity:end -->');
    expect(after).toContain(USER_TEXT.trim());
  });

  it('no re-add: CLAUDE.md without markers is byte-identical on allowAdd:false', () => {
    const claudePath = resolve(root, 'CLAUDE.md');
    writeFileSync(claudePath, USER_TEXT, 'utf-8');
    const before = readFileSync(claudePath, 'utf-8');
    const reports = applyAgentStanza({ cwd: root, enabled: true, allowAdd: false });
    const claudeReport = reports.find((r) => r.path === 'CLAUDE.md');
    expect(claudeReport).toBeDefined();
    expect(claudeReport!.action).toBe('skipped');
    const after = readFileSync(claudePath, 'utf-8');
    expect(after).toBe(before);
  });
});

describe('cli.ts init flag registration', () => {
  it('registers --no-agent-stanza on the init command', () => {
    const src = readFileSync(cliSourcePath, 'utf-8');
    expect(src).toContain('--no-agent-stanza');
  });

  it('registers --plugins and --no-plugins on the init command', () => {
    const src = readFileSync(cliSourcePath, 'utf-8');
    expect(src).toContain('--plugins [target]');
    expect(src).toContain('--no-plugins');
  });
});

// Wiring is DEFAULT-ON (decision: Ryan 2026-08-07, superseding the
// 2026-08-06 opt-in — which cac's negatable-flag default had already
// bypassed for the real CLI): a plain `validity init` attempts wiring, and
// `--no-plugins` is the one opt-out. These exercise `runInit` end-to-end
// (not just the resolvePluginSelectionFlag unit, so a regression that
// ignores the resolved mode would also be caught here).
describe('runInit — plugin wiring is the default; --no-plugins opts out', () => {
  let root: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  function project(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'validity-init-plugins-'));
    // A Vite dependency so, IF the opt-in regressed back to auto-detect-by-
    // default, `resolvePluginTargets` would actually select the vite plugin
    // — a project with no matching framework would pass this test even with
    // the bug, which defeats the point of the guard.
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({ name: 'app', version: '0.0.1', dependencies: { vite: '6', react: '18' } }),
    );
    return dir;
  }

  beforeEach(() => {
    root = project();
    stdoutBuf = '';
    stderrBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    }) as never;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    }) as never;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('omitting --plugins DOES attempt wiring — default-on, same as bare --plugins', async () => {
    // Same tolerant assertion as the bare-`--plugins` case below: the point
    // is that the mode reached 'auto', not which extraction outcome this
    // environment produces.
    await runInit({ cwd: root, agentStanza: false });
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toContain('vite');
    expect(combined.toLowerCase()).toMatch(/vite: (wrote|unchanged)|not staged|failed to extract/);
  });

  it('--no-plugins touches nothing — the explicit opt-out', async () => {
    const pkgBefore = readFileSync(resolve(root, 'package.json'), 'utf-8');
    await runInit({ cwd: root, agentStanza: false, plugins: false });
    expect(existsSync(resolve(root, '.validity/plugins'))).toBe(false);
    expect(readFileSync(resolve(root, 'package.json'), 'utf-8')).toBe(pkgBefore);
    expect(stdoutBuf).not.toContain('Plugins');
  });

  it('a bare --plugins DOES attempt wiring (mode reaches auto, unlike the omitted case)', async () => {
    // The point is only that wiring was ATTEMPTED (mode !== 'skip') — which
    // would fail if 'auto' ever silently degraded to 'skip'. The OUTCOME is
    // environment-dependent by design: in a checkout with built plugin dists
    // the dev fallback extracts and wiring succeeds on stdout; without them
    // the attempt surfaces as an extraction error on stderr. Either proves
    // the attempt happened, and pinning one outcome couples this test to
    // whether `pnpm -r build` ran before it.
    await runInit({ cwd: root, agentStanza: false, plugins: true });
    expect(stdoutBuf).not.toContain('Tip: `validity init --plugins`');
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toContain('vite');
    expect(combined.toLowerCase()).toMatch(/vite: (wrote|unchanged)|not staged|failed to extract/);
  });
});

describe('runInit — native aftermath output', () => {
  let root: string;
  let stdoutBuf: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  function expoProject(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'validity-init-native-'));
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { expo: '51', 'react-native': '0.73' } }),
    );
    return dir;
  }
  beforeEach(() => {
    root = expoProject();
    stdoutBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutBuf += String(c);
      return true;
    }) as never;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
  });
  it('prints native wrapper.gen + wrapper.native advice, not web-only user.tsx', async () => {
    await runInit({ cwd: root, agentStanza: false });
    expect(stdoutBuf).toContain('wrapper.gen.tsx');
    expect(stdoutBuf).toContain('wrapper.native.tsx');
    expect(stdoutBuf).not.toContain('Edit .validity/wrapper.user.tsx (create it if you want)');
  });

  it('expo-web config uses web footer (not native advice)', async () => {
    // explicit expo-web config must not trigger native footer
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'config.ts'),
      `export default { renderMode: 'web', framework: 'expo-web' as const, wrapper: './.validity/wrapper.gen.tsx', mocks: { api: 'auto' }, components: {} };`,
    );
    await runInit({ cwd: root, agentStanza: false, plugins: false });
    expect(stdoutBuf).toContain('Edit .validity/wrapper.user.tsx');
    expect(stdoutBuf).not.toContain('wrapper.native.tsx');
    expect(stdoutBuf).not.toContain('Native isolation reuses');
  });
});
