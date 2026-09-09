import { readFileSync } from 'node:fs';
import { formatBuildVersion } from '@validity.ai/verify-spec';

/**
 * npm ships tsc output alongside package.json. Keep the literal fallback for
 * standalone bundles, which may not have a sibling package.json.
 */
const CLI_PKG_VERSION = '0.0.2';

/**
 * The CLI's own version string, build-stamped in shipped bundles
 * (`0.0.1+<sha>.<yyyymmddHHmm>`), or `0.0.1+dev` in a local build. Doctor
 * compares this against the running MCP server's recorded version to flag a
 * host still talking to a stale server.
 */
export function cliVersionString(): string {
  let version = CLI_PKG_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (pkg.name === '@validity.ai/verify' && typeof pkg.version === 'string')
      version = pkg.version;
  } catch {
    // Standalone bundle: use the embedded package version.
  }
  return formatBuildVersion(version);
}
