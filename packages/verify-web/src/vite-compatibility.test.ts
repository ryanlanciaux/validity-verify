import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startDevServer } from './server.js';

it('rejects Vite 8 before evaluating incompatible user plugins', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-vite8-'));
  try {
    mkdirSync(resolve(root, 'node_modules/vite'), { recursive: true });
    writeFileSync(
      resolve(root, 'node_modules/vite/package.json'),
      JSON.stringify({ version: '8.2.0' }),
    );
    writeFileSync(resolve(root, 'vite.config.mjs'), 'throw new Error("config must not load")');
    await expect(startDevServer(root)).rejects.toThrow(
      'npm install -D vite@6.4.3 @vitejs/plugin-react@4.7.0',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
