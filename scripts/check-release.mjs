// Run after pnpm build. Exercise real prepack hooks and the global-install layout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-release-')));
try {
  for (const name of ['verify', 'verify-spec']) {
    const packDir = resolve(temp, name);
    mkdirSync(packDir);
    execFileSync('pnpm', ['pack', '--pack-destination', packDir], {
      cwd: resolve(root, 'packages', name),
      stdio: 'pipe',
    });
    const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
    assert(tarball, `${name}: missing tarball`);
    const installed = resolve(temp, 'lib/node_modules/@validity.ai', name);
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', [
      '-xzf',
      resolve(packDir, tarball),
      '-C',
      installed,
      '--strip-components=1',
    ]);
    // Reuse dependencies only; the code/assets under test come from the tarball.
    symlinkSync(
      resolve(root, 'packages', name, 'node_modules'),
      resolve(installed, 'node_modules'),
      'dir',
    );
    if (name === 'verify') {
      const { resolvePluginSource, extractPluginPackage } = await import(
        pathToFileURL(resolve(installed, 'dist/plugin-wiring.js'))
      );
      for (const plugin of ['vite', 'next', 'expo']) {
        const source = resolvePluginSource(plugin, { npmRootGlobal: () => null });
        assert.equal(source.kind, 'tgz');
        assert.equal(source.path, resolve(installed, 'plugins', `${plugin}.tgz`));
        const app = resolve(temp, 'app');
        assert.equal(extractPluginPackage(app, plugin, source).action, 'wrote');
        assert(existsSync(resolve(app, '.validity/plugins', plugin, 'package.json')));
        assert(existsSync(resolve(app, '.validity/plugins', plugin, 'dist/index.js')));
      }
    } else {
      const { getBuildStamp, formatBuildVersion } = await import(
        pathToFileURL(resolve(installed, 'dist/build-stamp.js'))
      );
      assert.match(getBuildStamp(), /^[0-9a-f]+\.\d{14}$/);
      assert(!formatBuildVersion('1.2.3').endsWith('+dev'));
    }
  }
  console.log(
    'Release artifacts: all three staged plugins extract; tsc package has a build identity.',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
