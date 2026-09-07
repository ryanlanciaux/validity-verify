#!/usr/bin/env node

// MCP stdio transport reserves process.stdout for JSON-RPC. Any incidental
// write to stdout from Vite, Playwright, an imported package, or a stray
// `console.log` corrupts the wire format and Claude Code closes the
// connection (-32000). Reroute the noisy console methods to stderr BEFORE
// any other module loads, so nothing has a chance to write to stdout.
console.log = (...args) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n');
console.info = console.log;
console.debug = console.log;
console.warn = (...args) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n');
// console.error already goes to stderr, leave it alone.

const { startMcpServer } = await import('./server.js');

// Surface crashes to stderr instead of letting Node silently kill the process
// — Claude Code captures MCP server stderr per-server in
// ~/.cache/claude-cli-nodejs/.../mcp-logs-validity/, so this turns "Connection
// closed" into a readable error trail.
// unhandledRejection: log but DO NOT exit. A rejected promise without a
// handler does not corrupt the process (unlike uncaughtException), and for a
// long-lived stdio server, exiting here is the worse failure: it tears down the
// JSON-RPC transport mid-request and the client only sees "Connection closed"
// (-32000) with no actionable detail. The most common source is Vite's
// background deps-optimizer rebuild rejecting (e.g. an esbuild pre-bundle error
// on an Expo-Web target) — that should fail the one verify (its own awaited
// page-load surfaces a render error, or it times out), not kill every session.
// Genuinely fatal states still come through uncaughtException below.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[validity-mcp] unhandledRejection (kept alive): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[validity-mcp] uncaughtException: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

startMcpServer().catch((err) => {
  process.stderr.write(
    `[validity-mcp] failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
