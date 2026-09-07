import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENT_STANZA_BEGIN = '<!-- validity:begin -->';
export const AGENT_STANZA_END = '<!-- validity:end -->';

export function renderAgentStanzaBlock(): string {
  return [
    AGENT_STANZA_BEGIN,
    '## UI acceptance specs (Validity)',
    '',
    '- UI acceptance contracts live in `.validity/specs/` — one folder per spec, with a reviewable `spec.yaml`.',
    '- Before changing a screen or component, read the spec that targets it; its criteria are the contract for the change.',
    '- After UI changes, verify against the spec: agents with the Validity MCP server call `validity__verify`; without MCP, run `validity verify --all --changed`.',
    '- Never edit a frozen `spec.yaml` by hand — use `validity__spec_update` (frozen specs are hash-bound; hand edits break verification).',
    '- Specs carry a DERIVED maturity level (probation → dev → team → certified). `validity__spec_get` (or `validity spec show <id>`) lists the exact steps to the next rung; certified specs verify with zero judge tokens via drift-checked exported tests under `.validity/exports/` — regenerate those with `validity spec export`, never hand-edit them.',
    AGENT_STANZA_END,
  ].join('\n');
}

export interface UpsertStanzaResult {
  content: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  warning?: string;
}

export function upsertAgentStanza(
  existing: string | null,
  opts: { allowAdd: boolean },
): UpsertStanzaResult {
  const block = renderAgentStanzaBlock();

  if (existing === null) {
    if (opts.allowAdd) {
      return { content: block + '\n', action: 'created' };
    }
    return { content: '', action: 'skipped' };
  }

  const hasBegin = existing.includes(AGENT_STANZA_BEGIN);
  const hasEnd = existing.includes(AGENT_STANZA_END);

  if (hasBegin && hasEnd) {
    const beginIdx = existing.indexOf(AGENT_STANZA_BEGIN);
    const endIdx = existing.indexOf(AGENT_STANZA_END);
    if (beginIdx > endIdx) {
      return {
        content: existing,
        action: 'skipped',
        warning: `has '${AGENT_STANZA_END}' before '${AGENT_STANZA_BEGIN}' — left untouched; fix the markers and re-run`,
      };
    }
    const prefix = existing.slice(0, beginIdx);
    const suffix = existing.slice(endIdx + AGENT_STANZA_END.length);
    const updated = prefix + block + suffix;
    if (updated === existing) {
      return { content: existing, action: 'unchanged' };
    }
    return { content: updated, action: 'updated' };
  }

  if (hasBegin || hasEnd) {
    const marker = hasBegin ? AGENT_STANZA_BEGIN : AGENT_STANZA_END;
    return {
      content: existing,
      action: 'skipped',
      warning: `has '${marker}' without a matching end marker — left untouched; fix the markers and re-run`,
    };
  }

  // Neither marker present.
  if (!opts.allowAdd) {
    return { content: existing, action: 'skipped' };
  }
  const base = existing.endsWith('\n') ? existing : existing + '\n';
  const updated = base + '\n' + block + '\n';
  return { content: updated, action: 'updated' };
}

export interface AgentStanzaFileReport {
  path: string;
  action: UpsertStanzaResult['action'];
  warning?: string;
}

export function writeAgentStanzas(
  projectRoot: string,
  opts: { allowAdd: boolean },
): AgentStanzaFileReport[] {
  const reports: AgentStanzaFileReport[] = [];

  const claudePath = resolve(projectRoot, 'CLAUDE.md');
  const claudeExisting = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : null;
  const claudeRes = upsertAgentStanza(claudeExisting, opts);
  if (claudeRes.action === 'created' || claudeRes.action === 'updated') {
    writeFileSync(claudePath, claudeRes.content, 'utf8');
  }
  reports.push({ path: 'CLAUDE.md', action: claudeRes.action, warning: claudeRes.warning });

  const agentsPath = resolve(projectRoot, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const agentsExisting = readFileSync(agentsPath, 'utf8');
    const agentsRes = upsertAgentStanza(agentsExisting, opts);
    if (agentsRes.action === 'created' || agentsRes.action === 'updated') {
      writeFileSync(agentsPath, agentsRes.content, 'utf8');
    }
    reports.push({ path: 'AGENTS.md', action: agentsRes.action, warning: agentsRes.warning });
  }

  return reports;
}

export function agentStanzaPresence(projectRoot: string): {
  claudeMd: 'present' | 'absent' | 'missing-file';
  agentsMd: 'present' | 'absent' | 'missing-file';
} {
  function status(filePath: string): 'present' | 'absent' | 'missing-file' {
    const abs = resolve(projectRoot, filePath);
    if (!existsSync(abs)) return 'missing-file';
    const content = readFileSync(abs, 'utf8');
    return content.includes(AGENT_STANZA_BEGIN) && content.includes(AGENT_STANZA_END)
      ? 'present'
      : 'absent';
  }
  return { claudeMd: status('CLAUDE.md'), agentsMd: status('AGENTS.md') };
}
