/**
 * Fixture/scenario precedence must be VISIBLE: when a component has config
 * fixtures, requested scenarios are ignored. The verify result carries a
 * `warnings` array (structuredContent, add-only) AND a ⚠ line in the text so
 * the agent sees it. Silent ignore is a false-green risk — the agent would
 * score screenshots that never applied the scenario they asked for.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { writeSpec, type ComponentRender, type RenderFn } from '@validity.ai/verify-spec';
import { renderComponents } from '@validity.ai/verify-web';
import { handleVerifyIsolation } from './server.js';

const RED_8x8_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

const COMPONENT_SOURCE = `import React from 'react';
export default function Button() {
  return <button>Go</button>;
}
`;

describe('verify fixture/scenario precedence warning', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-fx-prec-'));
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/Button.tsx'), COMPONENT_SOURCE);

    const stub: RenderFn = async (args) => {
      const renders = args.components.map<ComponentRender>((req) => {
        const screenshotPath = resolve(
          args.screenshotsDir,
          `${req.componentId}__${req.fixtureId ?? req.scenarioId ?? 'base'}.png`,
        );
        writeFileSync(screenshotPath, RED_8x8_PNG);
        return {
          id: req.componentId,
          filePath: req.componentAbsolutePath,
          screenshotPath,
          scenarioId: req.scenarioId,
          fixtureId: req.fixtureId,
          stackedFixtureIds: req.stackedFixtureIds,
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

  it('fixture-configured component + scenarios → warning in text AND structuredContent', async () => {
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  scenarios: { 'logged-in': {}, 'logged-out': {} },
  components: {
    'src/Button.tsx': {
      fixtures: {
        primary: { props: { variant: 'primary' } },
        disabled: { props: { disabled: true } },
      },
    },
  },
};
`,
    );
    writeSpec(projectRoot, {
      id: 'spec-fx',
      version: 1,
      status: 'frozen',
      source: { prompt: 'button', createdBy: 'agent' },
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
    });

    const result = await handleVerifyIsolation({
      prompt: 'render the button',
      projectRoot,
      planId: 'spec-fx',
      changedFiles: ['src/Button.tsx'],
      scenarios: ['logged-in', 'logged-out'],
    } as Parameters<typeof handleVerifyIsolation>[0]);

    expect(result.isError).toBeUndefined();
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    expect(texts).toContain('⚠');
    expect(texts).toMatch(/scenarios \[logged-in, logged-out\] ignored/);
    expect(texts).toMatch(/fixtures take precedence/);
    const sc = result.structuredContent as { warnings?: string[] };
    expect(sc.warnings).toEqual([
      'src-button: scenarios [logged-in, logged-out] ignored — component has fixtures in .validity/config.ts (fixtures take precedence). Remove the fixtures or drop the scenarios.',
    ]);
  });

  it('no fixtures → no warning, even when scenarios are requested', async () => {
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  scenarios: { 'logged-in': {}, 'logged-out': {} },
};
`,
    );

    const result = await handleVerifyIsolation({
      prompt: 'render the button',
      projectRoot,
      changedFiles: ['src/Button.tsx'],
      scenarios: ['logged-in'],
    } as Parameters<typeof handleVerifyIsolation>[0]);

    expect(result.isError).toBeUndefined();
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    expect(texts).not.toContain('⚠');
    expect(texts).not.toMatch(/fixtures take precedence/);
    const sc = result.structuredContent as { warnings?: string[] } | undefined;
    expect(sc?.warnings).toBeUndefined();
  });
});
