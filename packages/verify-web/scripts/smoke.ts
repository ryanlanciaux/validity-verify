/**
 * Phase 1 smoke test:
 * Renders Header.tsx from examples/basic-vite-app and writes a screenshot to disk.
 *
 *   pnpm --filter @validity.ai/verify-web exec tsx scripts/smoke.ts
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from '@validity.ai/verify-spec';
import { renderComponents } from '../src/render.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(here, '../../../examples/basic-vite-app');

async function main() {
  const { config } = await loadConfig(projectRoot);
  const screenshotsDir = resolve(projectRoot, '.validity/runs/smoke/screenshots');
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });

  const header = resolve(projectRoot, 'src/components/Header.tsx');
  const card = resolve(projectRoot, 'src/components/Card.tsx');
  if (!existsSync(header)) throw new Error(`Missing target: ${header}`);

  const { renders, environment } = await renderComponents({
    projectRoot,
    config,
    screenshotsDir,
    components: [
      { componentAbsolutePath: header, componentId: 'header-smoke' },
      {
        componentAbsolutePath: card,
        componentId: 'card-smoke',
        props: {
          title: 'Smoke test card',
          body: 'Phase 1 verifying that JSON-passed props arrive at the component.',
        },
      },
    ],
  });

  console.log(JSON.stringify({ environment }, null, 2));
  for (const r of renders) {
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
