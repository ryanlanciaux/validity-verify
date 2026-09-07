import { formatBuildVersion } from '@validity.ai/verify-spec';

/**
 * The CLI's package.json version. Mirrored as a literal (not read from
 * package.json at runtime — the shipped bundle is a single esbuild file with no
 * sibling package.json). cli.ts still hardcodes the same literal in
 * `cli.version(...)`; the deferred wiring swaps that for `cliVersionString()`
 * so this becomes the single source of truth.
 */
const CLI_PKG_VERSION = '0.0.1';

/**
 * The CLI's own version string, build-stamped in shipped bundles
 * (`0.0.1+<sha>.<yyyymmddHHmm>`), or `0.0.1+dev` in a local build. Doctor
 * compares this against the running MCP server's recorded version to flag a
 * host still talking to a stale server.
 */
export function cliVersionString(): string {
  return formatBuildVersion(CLI_PKG_VERSION);
}
