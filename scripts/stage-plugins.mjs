import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'packages/verify/plugins');
mkdirSync(destination, { recursive: true });
const temp = mkdtempSync(resolve(tmpdir(), 'validity-plugins-'));
try {
  for (const name of ['vite', 'next', 'expo']) {
    const cwd = resolve(root, `packages/verify-plugin-${name}`);
    execFileSync('pnpm', ['build'], { cwd, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd, stdio: 'inherit' });
    const tarball = readdirSync(temp).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error(`No packed ${name} plugin`);
    copyFileSync(resolve(temp, tarball), resolve(destination, `${name}.tgz`));
    rmSync(resolve(temp, tarball));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
