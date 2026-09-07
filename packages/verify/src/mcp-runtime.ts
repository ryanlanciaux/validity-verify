import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VALIDITY_HOME } from './install-meta.js';

/**
 * Reads the MCP runtime stamp that @validity.ai/verify writes at startup and
 * decides whether the host is on the current build, a stale one, or none.
 *
 * The shape mirrors mcp-server's `McpRuntimeStamp` but is re-declared here on
 * purpose: importing from @validity.ai/verify would pull the entire server
 * module into the CLI bundle. This half only needs to read a small JSON file.
 */
export interface McpRuntimeStamp {
  version: string;
  pid: number;
  startedAt: string;
}

/** `~/.validity/mcp-runtime.json` — `home` (tests) overrides the base dir. */
function stampPath(home?: string): string {
  const base = home !== undefined ? resolve(home, '.validity') : VALIDITY_HOME;
  return resolve(base, 'mcp-runtime.json');
}

/** Read + validate the runtime stamp, or null if absent / unparseable / malformed. */
export function readMcpRuntimeStamp(home?: string): McpRuntimeStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(home), 'utf-8')) as Partial<McpRuntimeStamp>;
    if (
      typeof parsed.version === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { version: parsed.version, pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/** True if `pid` is a live process. `process.kill(pid, 0)` sends no signal but
 *  throws ESRCH when the pid is gone; EPERM means it exists but is owned by
 *  another user — still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type McpRuntimeState =
  | { kind: 'absent' }
  | { kind: 'exited'; version: string }
  | { kind: 'current'; version: string }
  | { kind: 'stale'; running: string; installed: string };

/** Pure classifier — no I/O, so it's directly unit-testable. */
export function classifyMcpRuntime(
  stamp: McpRuntimeStamp | null,
  installedVersion: string,
  isAlive: (pid: number) => boolean,
): McpRuntimeState {
  if (!stamp) return { kind: 'absent' };
  if (!isAlive(stamp.pid)) return { kind: 'exited', version: stamp.version };
  if (stamp.version === installedVersion) return { kind: 'current', version: stamp.version };
  return { kind: 'stale', running: stamp.version, installed: installedVersion };
}

export interface McpRuntimeDescription {
  status: 'ok' | 'info' | 'warn';
  detail: string;
}

/** Maps a runtime state to a doctor check status + detail. */
export function describeMcpRuntime(state: McpRuntimeState): McpRuntimeDescription {
  switch (state.kind) {
    case 'absent':
      return {
        status: 'info',
        detail:
          'no runtime stamp — MCP not started since this feature landed, or host not restarted; ' +
          'restart your MCP host after reinstalling',
      };
    case 'exited':
      return { status: 'info', detail: `last recorded MCP (v${state.version}) has exited` };
    case 'current':
      return { status: 'ok', detail: `v${state.version}` };
    case 'stale':
      return {
        status: 'warn',
        detail:
          `running v${state.running}, installed v${state.installed} — ` +
          'restart your MCP host (e.g. Claude Code) to pick up the new build',
      };
  }
}
