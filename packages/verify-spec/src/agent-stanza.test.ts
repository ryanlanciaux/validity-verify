import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_STANZA_BEGIN,
  AGENT_STANZA_END,
  agentStanzaPresence,
  renderAgentStanzaBlock,
  upsertAgentStanza,
  writeAgentStanzas,
} from './agent-stanza.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'validity-stanza-'));
  dirs.push(d);
  return d;
}

describe('renderAgentStanzaBlock', () => {
  it('starts with begin marker and ends with end marker', () => {
    const block = renderAgentStanzaBlock();
    expect(block.startsWith(AGENT_STANZA_BEGIN + '\n')).toBe(true);
    expect(block.endsWith('\n' + AGENT_STANZA_END)).toBe(true);
  });

  it('is byte-stable across calls', () => {
    expect(renderAgentStanzaBlock()).toBe(renderAgentStanzaBlock());
  });
});

describe('upsertAgentStanza — create', () => {
  it('creates when null and allowAdd', () => {
    const res = upsertAgentStanza(null, { allowAdd: true });
    expect(res.action).toBe('created');
    expect(res.content).toBe(renderAgentStanzaBlock() + '\n');
  });

  it('skips when null and !allowAdd', () => {
    const res = upsertAgentStanza(null, { allowAdd: false });
    expect(res.action).toBe('skipped');
  });
});

describe('upsertAgentStanza — idempotency', () => {
  it('returns unchanged on second apply', () => {
    const first = upsertAgentStanza(null, { allowAdd: true });
    const second = upsertAgentStanza(first.content, { allowAdd: true });
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });
});

describe('upsertAgentStanza — marker-block update (no clobber)', () => {
  it('replaces inner block, preserves prefix/suffix byte-for-byte', () => {
    const prefix = '# My notes\n\nSome intro.\n\n';
    const suffix = '\n\nAfter block more notes.\n';
    const staleInner = AGENT_STANZA_BEGIN + '\nOLD STUFF\n' + AGENT_STANZA_END;
    const existing = prefix + staleInner + suffix;
    const res = upsertAgentStanza(existing, { allowAdd: true });
    expect(res.action).toBe('updated');
    expect(res.content.startsWith(prefix)).toBe(true);
    expect(res.content.endsWith(suffix)).toBe(true);
    expect(res.content).toContain(renderAgentStanzaBlock());
    expect(res.content).not.toContain('OLD STUFF');
  });
});

describe('upsertAgentStanza — append', () => {
  it('appends after exactly one blank line, preserving user text', () => {
    const user = '# Project notes\n\nA paragraph.';
    const res = upsertAgentStanza(user, { allowAdd: true });
    expect(res.action).toBe('updated');
    expect(res.content.startsWith(user)).toBe(true);
    expect(res.content).toBe(user + '\n' + '\n' + renderAgentStanzaBlock() + '\n');
  });
});

describe('upsertAgentStanza — no re-add', () => {
  it('skips when no markers and !allowAdd', () => {
    const user = '# Notes\nno markers here';
    const res = upsertAgentStanza(user, { allowAdd: false });
    expect(res.action).toBe('skipped');
    expect(res.content).toBe(user);
  });
});

describe('upsertAgentStanza — malformed markers', () => {
  it('skips with warning when begin without end', () => {
    const existing = '# notes\n' + AGENT_STANZA_BEGIN + '\norphan content\n';
    const res = upsertAgentStanza(existing, { allowAdd: true });
    expect(res.action).toBe('skipped');
    expect(res.warning).toBeTruthy();
    expect(res.content).toBe(existing);
  });

  it('skips with warning when end without begin', () => {
    const existing = '# notes\norphan\n' + AGENT_STANZA_END + '\n';
    const res = upsertAgentStanza(existing, { allowAdd: true });
    expect(res.action).toBe('skipped');
    expect(res.warning).toBeTruthy();
    expect(res.content).toBe(existing);
  });

  it('skips when begin appears after end', () => {
    const existing = AGENT_STANZA_END + '\nmiddle\n' + AGENT_STANZA_BEGIN;
    const res = upsertAgentStanza(existing, { allowAdd: true });
    expect(res.action).toBe('skipped');
    expect(res.warning).toBeTruthy();
  });
});

describe('writeAgentStanzas', () => {
  it('creates CLAUDE.md when absent (allowAdd)', () => {
    const root = tmpDir();
    const reports = writeAgentStanzas(root, { allowAdd: true });
    expect(reports).toHaveLength(1);
    expect(reports[0].path).toBe('CLAUDE.md');
    expect(reports[0].action).toBe('created');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(renderAgentStanzaBlock() + '\n');
  });

  it('never creates AGENTS.md when absent', () => {
    const root = tmpDir();
    writeAgentStanzas(root, { allowAdd: true });
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('upserts an existing AGENTS.md', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'CLAUDE.md'), '# existing claude\n');
    writeFileSync(join(root, 'AGENTS.md'), '# existing agents\n');
    const reports = writeAgentStanzas(root, { allowAdd: true });
    expect(reports).toHaveLength(2);
    const agents = reports.find((r) => r.path === 'AGENTS.md');
    expect(agents?.action).toBe('updated');
    const agentsContent = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agentsContent.startsWith('# existing agents\n')).toBe(true);
    expect(agentsContent).toContain(renderAgentStanzaBlock());
  });

  it('does not re-add block after deletion when !allowAdd', () => {
    const root = tmpDir();
    writeAgentStanzas(root, { allowAdd: true });
    // Delete the block from CLAUDE.md
    writeFileSync(join(root, 'CLAUDE.md'), '# Just user notes\n');
    const reports = writeAgentStanzas(root, { allowAdd: false });
    const claude = reports.find((r) => r.path === 'CLAUDE.md');
    expect(claude?.action).toBe('skipped');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Just user notes\n');
  });
});

describe('agentStanzaPresence', () => {
  it('reports missing-file for both when absent', () => {
    const root = tmpDir();
    const p = agentStanzaPresence(root);
    expect(p.claudeMd).toBe('missing-file');
    expect(p.agentsMd).toBe('missing-file');
  });

  it('reports present when both markers exist', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'CLAUDE.md'), renderAgentStanzaBlock() + '\n');
    writeFileSync(join(root, 'AGENTS.md'), 'x\n' + renderAgentStanzaBlock() + '\n');
    const p = agentStanzaPresence(root);
    expect(p.claudeMd).toBe('present');
    expect(p.agentsMd).toBe('present');
  });

  it('reports absent when file exists without markers', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'CLAUDE.md'), '# notes\n');
    writeFileSync(join(root, 'AGENTS.md'), '# notes\n');
    const p = agentStanzaPresence(root);
    expect(p.claudeMd).toBe('absent');
    expect(p.agentsMd).toBe('absent');
  });

  it('mixed states', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'CLAUDE.md'), renderAgentStanzaBlock() + '\n');
    const p = agentStanzaPresence(root);
    expect(p.claudeMd).toBe('present');
    expect(p.agentsMd).toBe('missing-file');
  });
});
