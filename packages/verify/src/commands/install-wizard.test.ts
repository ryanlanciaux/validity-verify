/**
 * Non-interactive install path (finding C4). `detectWiredHosts` is the pure-ish
 * probe for "which hosts already have Validity wired in" (MCP registration OR
 * skill dir present); `syncKnownHosts` is the prompt-free refresh that a headless
 * `install-wizard --non-interactive` runs so stale skills get overwritten instead
 * of skipped. Both take an injected home / exec seam so we can assert against a
 * fake home without touching the real ~/.claude / ~/.cursor / ~/.config. Mirrors
 * the mkdtempSync + colocation convention from doctor.test.ts / init.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWiredHosts, syncKnownHosts } from './install-wizard.js';
import type { InstallMeta } from '../install-meta.js';

function mkFakeHome(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-wizard-home-'));
}

function seedSkill(home: string, rel: string, body = 'stale\n'): void {
  const dir = resolve(home, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'SKILL.md'), body, 'utf-8');
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8');
}

describe('detectWiredHosts', () => {
  let home: string;
  const noClaude = () => null;

  beforeEach(() => {
    home = mkFakeHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('empty home + no claude CLI → nothing wired', () => {
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w).toEqual({ claude: false, cursor: false, opencode: false, codex: false });
  });

  it('claude wired via skill dir alone', () => {
    seedSkill(home, '.claude/skills/validity');
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.claude).toBe(true);
  });

  it('claude wired via `claude mcp list` matching the bin name', () => {
    const list = () => 'validity  stdio  validity-mcp\nother  stdio  x\n';
    const w = detectWiredHosts('validity', { home, claudeMcpList: list });
    expect(w.claude).toBe(true);
  });

  it('claude mcp list for a DIFFERENT server does not count as wired', () => {
    const list = () => 'somethingelse  stdio  x\n';
    const w = detectWiredHosts('validity', { home, claudeMcpList: list });
    expect(w.claude).toBe(false);
  });

  it('renamed binary: mcp list + cursor json keyed by the custom name', () => {
    writeJson(resolve(home, '.cursor/mcp.json'), { mcpServers: { myval: { command: 'x' } } });
    const list = () => 'myval  stdio  myval-mcp\n';
    const w = detectWiredHosts('myval', { home, claudeMcpList: list });
    expect(w.claude).toBe(true);
    expect(w.cursor).toBe(true);
  });

  it('cursor wired via ~/.cursor/mcp.json mcpServers entry', () => {
    writeJson(resolve(home, '.cursor/mcp.json'), { mcpServers: { validity: { command: 'x' } } });
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.cursor).toBe(true);
  });

  it('cursor NOT wired when mcp.json exists but has no matching entry', () => {
    writeJson(resolve(home, '.cursor/mcp.json'), { mcpServers: { other: { command: 'x' } } });
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.cursor).toBe(false);
  });

  it('opencode wired via ~/.config/opencode/opencode.json mcp entry', () => {
    writeJson(resolve(home, '.config/opencode/opencode.json'), {
      mcp: { validity: { type: 'local', command: ['x'], enabled: true } },
    });
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.opencode).toBe(true);
  });

  it('codex wired only via its skill dir (TOML config is not parsed)', () => {
    seedSkill(home, '.codex/skills/validity');
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.codex).toBe(true);
  });

  it('malformed cursor mcp.json is tolerated (treated as not wired)', () => {
    const p = resolve(home, '.cursor/mcp.json');
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, '{ not json', 'utf-8');
    const w = detectWiredHosts('validity', { home, claudeMcpList: noClaude });
    expect(w.cursor).toBe(false);
  });
});

describe('syncKnownHosts (non-interactive)', () => {
  let home: string;
  let skillDir: string;
  const noClaude = () => null;
  const FRESH_SKILL = 'FRESH SKILL v2\n';
  const FRESH_HELP = 'FRESH HELP v2\n';

  beforeEach(() => {
    home = mkFakeHome();
    // A fake SKILL.md source (+ sibling HELP.md), standing in for the shipped
    // tarball's skill/validity/ dir.
    skillDir = mkdtempSync(resolve(tmpdir(), 'validity-wizard-skillsrc-'));
    writeFileSync(resolve(skillDir, 'SKILL.md'), FRESH_SKILL, 'utf-8');
    writeFileSync(resolve(skillDir, 'HELP.md'), FRESH_HELP, 'utf-8');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  function run(overrides: Partial<Parameters<typeof syncKnownHosts>[0]> = {}) {
    const lines: string[] = [];
    const persisted: InstallMeta[] = [];
    const result = syncKnownHosts({
      installedValidity: '/opt/validity/validity',
      installedMcp: '/opt/validity/validity-mcp',
      prevMeta: null,
      home,
      skillSrc: resolve(skillDir, 'SKILL.md'),
      claudeMcpList: noClaude,
      write: (s) => lines.push(s),
      persistMeta: (m) => persisted.push(m),
      ...overrides,
    });
    return { result, output: lines.join(''), persisted };
  }

  it('refreshes a codex-wired host: overwrites stale SKILL.md + copies HELP.md', () => {
    // codex has no auto-wire (no CLI / global config side effects), so it is the
    // safe host to drive the full skill-copy path in a test.
    seedSkill(home, '.codex/skills/validity', 'STALE SKILL v1\n');
    const { result, output } = run();

    expect(result.refreshed).toEqual(['codex']);
    const codexSkill = resolve(home, '.codex/skills/validity');
    expect(readFileSync(resolve(codexSkill, 'SKILL.md'), 'utf-8')).toBe(FRESH_SKILL);
    expect(readFileSync(resolve(codexSkill, 'HELP.md'), 'utf-8')).toBe(FRESH_HELP);
    expect(output).toContain('refreshed skill + MCP registration for: codex');
    expect(output).toContain('validity install-wizard');
  });

  it('nothing wired → clear "nothing to refresh" message, no skill dirs created', () => {
    const { result, output } = run();
    expect(result.refreshed).toEqual([]);
    expect(output).toContain('nothing to refresh');
    expect(existsSync(resolve(home, '.codex/skills/validity/SKILL.md'))).toBe(false);
  });

  it('persists install metadata like the interactive path (preserving prior fields)', () => {
    seedSkill(home, '.codex/skills/validity');
    const prevMeta: InstallMeta = {
      version: '1.2.3',
      installedAt: '2020-01-01T00:00:00.000Z',
      tarballUrl: 'https://example/validity.tgz',
      binaryName: 'validity',
      wrapperPath: '',
      wrapperMcpPath: '',
    };
    const { persisted } = run({ prevMeta });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].version).toBe('1.2.3');
    expect(persisted[0].installedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(persisted[0].tarballUrl).toBe('https://example/validity.tgz');
    expect(persisted[0].binaryName).toBe('validity');
  });

  it('missing SKILL.md source: still reports, warns, but does not throw', () => {
    seedSkill(home, '.codex/skills/validity', 'STALE\n');
    const { result, output } = run({ skillSrc: null });
    expect(result.refreshed).toEqual(['codex']);
    expect(output).toContain('Could not locate SKILL.md');
    // Stale skill left as-is (nothing to copy) rather than deleted.
    expect(readFileSync(resolve(home, '.codex/skills/validity/SKILL.md'), 'utf-8')).toBe('STALE\n');
  });
});
