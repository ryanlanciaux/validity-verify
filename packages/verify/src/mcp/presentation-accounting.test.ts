/**
 * C3's presentation-key accounting, pinned end-to-end through the REAL
 * `handleVerifyIsolation` (renderer stubbed — no Vite/Playwright): the
 * `structuredContent.presentation` tally must ADD UP, or a loop driver
 * re-requesting omitted evidence would chase phantom (or miss real)
 * screenshots. Invariants:
 *   - screenshotsShown + omittedRenderIds.length === screenshotsTotal
 *   - screenshotsShown === the number of images actually embedded in content
 *     (the tally may never claim more OR less than the payload delivers)
 *   - errored renders count NOWHERE (no image possible → not total/omitted)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Partial mocks: the real sandbox renderer boots Vite + Playwright; the real
// ensure-configured pass scaffolds wrapper/config against a real project. Both
// are out of scope here — everything BETWEEN them (prepareVerification,
// lean identity hashing, the response loop, presentation assembly) is real.
vi.mock('@validity.ai/verify-web', async () => {
  const actual = await vi.importActual<typeof import('@validity.ai/verify-web')>('@validity.ai/verify-web');
  return { ...actual, renderComponents: vi.fn() };
});
vi.mock('@validity.ai/verify-spec', async () => {
  const actual = await vi.importActual<typeof import('@validity.ai/verify-spec')>('@validity.ai/verify-spec');
  return {
    ...actual,
    ensureValidityConfigured: vi.fn(async () => ({
      status: 'unchanged',
      bootstrapped: false,
      shapeSignature: { hash: 'test' },
      driftReasons: [],
      generatedFiles: [],
      warnings: [],
      durationMs: 0,
    })),
  };
});

import { writeSpec, type ComponentRender, type RenderFn, type Spec } from '@validity.ai/verify-spec';
import { renderComponents } from '@validity.ai/verify-web';
import { handleVerifyIsolation } from './server.js';
import type { VerifyPresentation } from './lean-verify.js';

// Two real verifies / a real `npm pack` on a loaded box sit right at the default budget — give this file room.
vi.setConfig({ testTimeout: 120_000 });

// 8x8 PNG (red square) — real bytes so the handler's base64 embed + the lean
// sha256 identity hash both work off an actual file.
const RED_8x8_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

const COMPONENT_SOURCE = `import React from 'react';
export default function Widget() {
  return <div>hi</div>;
}
`;

const SPEC_ID = 'spec-lean-accounting';

describe('verify presentation accounting (C3 gate)', () => {
  let projectRoot: string;
  let renderCall: number;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-presentation-'));
    renderCall = 0;

    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    // Seeded as config.ts (jiti path) — vitest's module runner cannot
    // dynamic-import a temp .mjs config.
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
};
`,
    );

    // Three real component files so selectComponentsToRender's AST filter
    // accepts them: Good (byte-identical across runs → lean omits), Fresh
    // (bytes change every run → lean must keep), Broken (render error →
    // counted nowhere).
    mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
    for (const name of ['Good', 'Fresh', 'Broken']) {
      writeFileSync(resolve(projectRoot, `src/${name}.tsx`), COMPONENT_SOURCE);
    }

    // All-hard frozen spec: no soft criterion is ever open, so lean's only
    // keep/omit axis left is screenshot identity — exactly what we tally.
    const spec: Spec = {
      id: SPEC_ID,
      version: 1,
      status: 'frozen',
      source: { prompt: 'render the widgets', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'renders without console errors',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec);

    const stub: RenderFn = async (args) => {
      renderCall += 1;
      const renders = args.components.map<ComponentRender>((req) => {
        const file = basename(req.componentAbsolutePath);
        const screenshotPath = resolve(
          args.screenshotsDir,
          `${req.componentId}__${req.scenarioId ?? 'base'}.png`,
        );
        if (file === 'Broken.tsx') {
          return {
            id: req.componentId,
            filePath: req.componentAbsolutePath,
            screenshotPath,
            scenarioId: req.scenarioId,
            renderError: 'stub render error',
          };
        }
        const bytes =
          file === 'Fresh.tsx'
            ? Buffer.concat([RED_8x8_PNG, Buffer.from(`run-${renderCall}`)])
            : RED_8x8_PNG;
        writeFileSync(screenshotPath, bytes);
        return {
          id: req.componentId,
          filePath: req.componentAbsolutePath,
          screenshotPath,
          scenarioId: req.scenarioId,
          criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        };
      });
      return {
        renders,
        environment: { target: 'web', devServer: 'cold', tailwindShim: false },
      };
    };
    vi.mocked(renderComponents).mockImplementation(stub);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function verify() {
    const result = await handleVerifyIsolation({
      prompt: 'render the widgets',
      projectRoot,
      planId: SPEC_ID,
      changedFiles: ['src/Good.tsx', 'src/Fresh.tsx', 'src/Broken.tsx'],
    } as Parameters<typeof handleVerifyIsolation>[0]);
    expect(result.isError).toBeUndefined();
    const presentation = (result.structuredContent as { presentation: VerifyPresentation })
      .presentation;
    const images = (result.content as Array<{ type: string }>).filter((c) => c.type === 'image');
    return { presentation, images };
  }

  it('first verify (auto full): shown === total, nothing omitted, tally matches embedded images', async () => {
    const { presentation, images } = await verify();
    expect(presentation.detail).toBe('full');
    expect(presentation.autoSelected).toBe(true);
    // Broken (renderError) could never show an image — counted nowhere.
    expect(presentation.screenshotsTotal).toBe(2);
    expect(presentation.screenshotsShown).toBe(2);
    expect(presentation.omittedRenderIds).toEqual([]);
    expect(presentation.screenshotsShown + presentation.omittedRenderIds.length).toBe(
      presentation.screenshotsTotal,
    );
    expect(images).toHaveLength(presentation.screenshotsShown);
  });

  it('second verify (auto lean): shown + omitted === total, and shown === embedded images', async () => {
    await verify(); // seed the prior run of the spec

    const { presentation, images } = await verify();
    expect(presentation.detail).toBe('lean');
    expect(presentation.autoSelected).toBe(true);
    expect(presentation.screenshotsTotal).toBe(2);
    // Good: all-pass + byte-identical + no soft open → provably safe to omit.
    expect(presentation.omittedRenderIds).toHaveLength(1);
    expect(presentation.omittedRenderIds[0]).toContain('good');
    // Fresh: pixels changed → MUST be kept (over-keeping is the only safe
    // failure mode; hiding changed evidence would be a false-green channel).
    expect(presentation.screenshotsShown).toBe(1);
    expect(presentation.screenshotsShown + presentation.omittedRenderIds.length).toBe(
      presentation.screenshotsTotal,
    );
    expect(images).toHaveLength(presentation.screenshotsShown);
  });
});
