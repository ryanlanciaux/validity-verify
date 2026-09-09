import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** Use this installation's Playwright so browser and driver revisions match. */
export function runInstallBrowser(opts: { withDeps?: boolean } = {}): void {
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('playwright/package.json')), 'cli.js');
  execFileSync(
    process.execPath,
    [cli, 'install', 'chromium', ...(opts.withDeps ? ['--with-deps'] : [])],
    {
      stdio: 'inherit',
    },
  );
}
