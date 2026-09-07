/**
 * Build-time version stamp for the shipped bundles.
 *
 * `__VALIDITY_BUILD_STAMP__` is a free identifier replaced by a bundler's
 * `define` at build time with a `<gitShortSha>.<yyyymmddHHmm>` string. A
 * plain `tsc -b` / `node` dev run has no define, so the identifier is
 * undefined and every reader falls back to `dev`. The `typeof` guard keeps
 * un-defined dev runs from throwing a ReferenceError.
 */
declare const __VALIDITY_BUILD_STAMP__: string | undefined;

/** The esbuild-injected build stamp, or undefined in an unstamped dev build. */
export function getBuildStamp(): string | undefined {
  return typeof __VALIDITY_BUILD_STAMP__ === 'undefined' ? undefined : __VALIDITY_BUILD_STAMP__;
}

/**
 * Human-facing version string: `<pkgVersion>+<stamp>` for a shipped build,
 * `<pkgVersion>+dev` when unstamped. Callers pass their own package.json
 * version so the CLI and MCP server each stamp their own identity.
 */
export function formatBuildVersion(pkgVersion: string): string {
  const stamp = getBuildStamp();
  return `${pkgVersion}+${stamp ?? 'dev'}`;
}
