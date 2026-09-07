/**
 * MCP-server session fingerprint (A3). Stamped into run-meta at verify time and
 * onto scored soft criteria at submit_report / record_soft_scores, so a reader
 * can tell whether the session that BUILT+VERIFIED the change is the same one
 * that JUDGED it (self-scoring — a weak signal, surfaced as a warning, never a
 * gate).
 *
 * Stable for the lifetime of this MCP server process: two tool calls from the
 * same host conversation share it; a fresh-context judge (separate process /
 * separate MCP connection) gets a different one. No env var required. Both
 * error directions are accepted as advisory noise: a host that restarts the
 * server between verify and submit misses the warning; a fresh subagent sharing
 * the parent's connection is warned anyway.
 */
import { createHash, randomUUID } from 'node:crypto';

export const SESSION_FINGERPRINT =
  'sfp-' +
  createHash('sha256')
    .update(`${process.pid}:${process.hrtime.bigint()}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 12);
