/**
 * MCP `validity__signals` — list / suppress / resolve the local signal queue.
 * Same three actions as `validity signals` on the CLI.
 */
import { resolve } from 'node:path';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import {
  gitHeadSha,
  loadSignals,
  persistSignalTransitions,
  resolveSignalManual,
  saveSignals,
  suppressSignal,
  type Signal,
} from '@validity.ai/verify-spec';

function errorText(body: string): ServerResult {
  return { isError: true, content: [{ type: 'text', text: body }] };
}

function resolveProjectRoot(input?: string): string {
  return input ? resolve(input) : process.cwd();
}

export type SignalsAction = 'list' | 'suppress' | 'resolve';

export interface SignalsToolArgs {
  action: SignalsAction;
  id?: string;
  note?: string;
  all?: boolean;
  projectRoot?: string;
}

function summarize(s: Signal): Record<string, unknown> {
  return {
    id: s.id,
    kind: s.kind,
    severity: s.severity,
    status: s.status,
    specId: s.specId,
    criterionId: s.criterionId ?? null,
    detail: s.detail,
    at: s.at,
    resolvedBy: s.resolvedBy ?? null,
    suppressedUntil: s.suppressedUntil ?? null,
  };
}

export async function handleSignals(args: SignalsToolArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const action = args.action;
  if (action !== 'list' && action !== 'suppress' && action !== 'resolve') {
    return errorText(`Validity signals error: unknown action "${String(action)}"`);
  }

  const existing = loadSignals(projectRoot);

  if (action === 'list') {
    const rows = args.all === true ? existing : existing.filter((s) => s.status === 'open');
    const lines =
      rows.length === 0
        ? [args.all ? 'no signals on disk.' : 'no open signals.']
        : rows.map(
            (s) =>
              `${s.status} ${s.kind} ${s.id} — ${s.detail}` +
              (s.resolvedBy ? ` (resolvedBy=${s.resolvedBy})` : ''),
          );
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { action: 'list', signals: rows.map(summarize) },
    };
  }

  const id = args.id;
  if (!id) return errorText(`Validity signals error: action "${action}" requires id`);
  const current = existing.find((s) => s.id === id);
  if (!current) return errorText(`Validity signals error: no signal with id ${id}`);

  const now = new Date().toISOString();
  const sha = gitHeadSha(projectRoot);
  let next: Signal;
  if (action === 'suppress') {
    if (current.status !== 'open') {
      return errorText(`Validity signals error: signal ${id} is ${current.status}, not open`);
    }
    if (!sha) {
      return errorText(
        'Validity signals error: cannot suppress without a git HEAD sha (needed to reopen on later changes)',
      );
    }
    next = suppressSignal(current, { now, sha, note: args.note });
  } else {
    if (current.status !== 'open' && current.status !== 'suppressed') {
      return errorText(`Validity signals error: signal ${id} is already ${current.status}`);
    }
    next = resolveSignalManual(current, { now, sha, note: args.note });
  }
  const after = existing.map((s) => (s.id === id ? next : s));
  saveSignals(projectRoot, after);
  persistSignalTransitions(projectRoot, existing, after, now, sha);
  return {
    content: [
      {
        type: 'text',
        text: `${action === 'suppress' ? 'suppressed' : 'resolved'} ${id}`,
      },
    ],
    structuredContent: { action, signal: summarize(next) },
  };
}

export const SIGNAL_TOOL_DEFINITIONS = [
  {
    name: 'validity__signals',
    description:
      'Inspect or close Validity’s local signal queue (.validity/signals.json). ' +
      'action=list returns open signals (pass all:true for resolved + suppressed). ' +
      'action=suppress parks an open signal until the spec’s files change past HEAD. ' +
      'action=resolve manually closes a signal (resolvedBy: manual). Does not change verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'suppress', 'resolve'],
          description: 'list | suppress | resolve',
        },
        id: {
          type: 'string',
          description: 'Signal id (kind:specId:criterionId|*). Required for suppress and resolve.',
        },
        note: {
          type: 'string',
          description: 'Optional note stored on suppress / resolve.',
        },
        all: {
          type: 'boolean',
          description: 'list only: include resolved and suppressed rows.',
        },
        projectRoot: { type: 'string', description: 'Absolute project root. Defaults to cwd.' },
      },
      required: ['action'],
    },
  },
] as const;
