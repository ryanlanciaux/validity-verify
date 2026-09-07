// Run after `pnpm build`. Inventory only: does not publish or run lifecycle scripts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
let checked = 0;
for (const name of readdirSync(resolve(root, 'packages'))) {
  const dir = resolve(root, 'packages', name);
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir, encoding: 'utf8',
  }));
  const paths = new Set(pack.files.map((file) => file.path));
  assert(paths.has('LICENSE'), `${pkg.name}: missing packaged LICENSE`);
  assert.equal(readFileSync(resolve(dir, 'LICENSE'), 'utf8'), license, `${pkg.name}: stale LICENSE`);
  for (const path of paths) {
    assert(!/(^|\/)(node_modules|\.validity|\.env(?:\..*)?)(\/|$)|\.(?:tsbuildinfo|pem|key|p12|pfx)$|\.test\.[cm]?js$/.test(path), `${pkg.name}: unexpected package file ${path}`);
  }
  const entrypoints = [pkg.main, pkg.types, ...Object.values(pkg.bin ?? {})];
  for (const path of entrypoints.filter(Boolean)) {
    assert(paths.has(path.replace(/^\.\//, '')), `${pkg.name}: missing entrypoint ${path}`);
  }
  if (pkg.name === '@validity.ai/verify-report') {
    assert(paths.has('THIRD_PARTY_NOTICES.txt'), 'Missing font license notices');
    assert(readFileSync(resolve(dir, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'));
  }
  console.log(`${pkg.name}: ${paths.size} files; license and entrypoints present; no private/build-state files`);
  checked++;
}
assert(checked > 0, 'No public packages checked');
