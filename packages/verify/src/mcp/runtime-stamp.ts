import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * On-disk record of the MCP server process currently running on this machine,
 * written to `~/.validity/mcp-runtime.json` at server startup. `validity
 * doctor` reads it to detect a host (e.g. Claude Code) still talking to a
 * pre-reinstall server — the process keeps the stale build until the host is
 * restarted, and nothing else surfaces which build is live.
 */
export interface McpRuntimeStamp {
  /** The running server's build-stamped version (see @validity.ai/verify-spec formatBuildVersion). */
  version: string;
  pid: number;
  /** ISO-8601 start time. */
  startedAt: string;
}

/**
 * `~/.validity/mcp-runtime.json`. `home` (tests) overrides the base dir;
 * otherwise honors VALIDITY_HOME exactly like install-meta so the reader and
 * writer always agree on the path.
 */
function stampPath(home?: string): string {
  const base =
    home !== undefined
      ? resolve(home, '.validity')
      : (process.env.VALIDITY_HOME ?? resolve(homedir(), '.validity'));
  return resolve(base, 'mcp-runtime.json');
}

/**
 * Record the running server's build + pid. Best-effort: any failure (unwritable
 * home, race on rename, …) is swallowed — a stamp write must NEVER break server
 * startup. Atomic via tmp-file + rename so a concurrent reader never sees a
 * half-written file.
 */
export function writeMcpRuntimeStamp(info: { version: string }, home?: string): void {
  try {
    const path = stampPath(home);
    mkdirSync(resolve(path, '..'), { recursive: true });
    const stamp: McpRuntimeStamp = {
      version: info.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(stamp, null, 2) + '\n');
    renameSync(tmp, path);
  } catch {
    // best-effort — never throw out of a stamp write
  }
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
