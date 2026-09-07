/**
 * `validity signals <sub> [id]` — inspect and close the local signal queue.
 *
 *   list [--all]           open signals (default); `--all` includes resolved + suppressed
 *   suppress <id> [--note] park until the spec's files change past HEAD
 *   resolve <id> [--note]  manual close (`resolvedBy: 'manual'`)
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  gitHeadSha,
  loadSignals,
  persistSignalTransitions,
  resolveSignalManual,
  saveSignals,
  suppressSignal,
  type Signal,
} from '@validity.ai/verify-spec';

export interface SignalsOptions {
  cwd?: string;
  all?: boolean;
  note?: string;
}

const SUBCOMMANDS = ['list', 'suppress', 'resolve'] as const;
type SubCommand = (typeof SUBCOMMANDS)[number];

export async function runSignals(
  sub: string | undefined,
  id: string | undefined,
  opts: SignalsOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();
  if (!sub || !SUBCOMMANDS.includes(sub as SubCommand)) {
    process.stderr.write(
      pc.red(
        `error: \`validity signals\` needs a subcommand: ${SUBCOMMANDS.join(' | ')}.\n` +
          `  e.g. \`validity signals list\`, \`validity signals suppress <id>\`.\n`,
      ),
    );
    process.exitCode = 2;
    return;
  }
  switch (sub as SubCommand) {
    case 'list':
      return listSignals(projectRoot, opts.all === true);
    case 'suppress':
      return mutateSignal(projectRoot, id, 'suppress', opts.note);
    case 'resolve':
      return mutateSignal(projectRoot, id, 'resolve', opts.note);
  }
}

const SEV = { high: 0, medium: 1, low: 2, info: 3 } as const;

function listSignals(projectRoot: string, all: boolean): void {
  const signals = loadSignals(projectRoot);
  const rows = all ? signals : signals.filter((s) => s.status === 'open');
  if (rows.length === 0) {
    process.stdout.write(
      all ? 'no signals on disk.\n' : 'no open signals — everything tracked is steady.\n',
    );
    return;
  }
  const sorted = [...rows].sort(
    (a, b) => SEV[a.severity] - SEV[b.severity] || a.id.localeCompare(b.id),
  );
  process.stdout.write(
    all ? `Signals (${sorted.length}):\n` : `Open signals (${sorted.length}):\n`,
  );
  for (const s of sorted) {
    const where = s.criterionId ? `${s.specId}/${s.criterionId}` : s.specId;
    const close = s.resolvedBy ? ` by=${s.resolvedBy}` : '';
    const park = s.suppressedUntil ? ` until=${s.suppressedUntil.sha.slice(0, 7)}` : '';
    process.stdout.write(
      `  ${s.status}${close}${park}  ${s.kind}  ${where}  ${s.id}\n    ${s.detail}\n`,
    );
  }
}

function mutateSignal(
  projectRoot: string,
  id: string | undefined,
  action: 'suppress' | 'resolve',
  note?: string,
): void {
  if (!id) {
    process.stderr.write(pc.red(`error: \`validity signals ${action}\` needs a signal id.\n`));
    process.exitCode = 2;
    return;
  }
  const existing = loadSignals(projectRoot);
  const current = existing.find((s) => s.id === id);
  if (!current) {
    process.stderr.write(pc.red(`error: no signal with id ${id}.\n`));
    process.exitCode = 1;
    return;
  }
  const now = new Date().toISOString();
  const sha = gitHeadSha(projectRoot);
  let next: Signal;
  if (action === 'suppress') {
    if (current.status !== 'open') {
      process.stderr.write(
        pc.red(`error: signal ${id} is ${current.status}, not open — cannot suppress.\n`),
      );
      process.exitCode = 1;
      return;
    }
    if (!sha) {
      process.stderr.write(
        pc.red(
          'error: cannot suppress without a git HEAD sha (needed to reopen on later changes).\n',
        ),
      );
      process.exitCode = 1;
      return;
    }
    next = suppressSignal(current, { now, sha, note });
  } else {
    if (current.status !== 'open' && current.status !== 'suppressed') {
      process.stderr.write(pc.red(`error: signal ${id} is already ${current.status}.\n`));
      process.exitCode = 1;
      return;
    }
    next = resolveSignalManual(current, { now, sha, note });
  }
  const after = existing.map((s) => (s.id === id ? next : s));
  saveSignals(projectRoot, after);
  persistSignalTransitions(projectRoot, existing, after, now, sha);
  process.stdout.write(`${action === 'suppress' ? 'suppressed' : 'resolved'} ${id}\n`);
}
