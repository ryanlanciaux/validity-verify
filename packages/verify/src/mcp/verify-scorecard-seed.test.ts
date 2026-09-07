/**
 * P2 regression gate: MCP verify must SEED the persistent scorecard, so the
 * MCP-only soft-scoring flow (verify → score_soft_criteria → record_soft_scores)
 * works without ever running `validity watch`. Driven through the REAL
 * `handleVerifyIsolation` (renderer stubbed — no Vite/Playwright), then
 * `handleRecordSoftScores` on top — the exact sequence that used to dead-end
 * with `no scorecard entry for "<spec>"`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mocks (same posture as presentation-accounting.test.ts): the real
// sandbox renderer boots Vite + Playwright and the real ensure-configured pass
// scaffolds a wrapper — both out of scope. Everything between (verdict
// collection, run-meta, the scorecard fold) is real. The mocked ensure result
// carries NO degraded wrapper fidelity, so soft evidence is untainted and the
// recorded pass is stored as a real pass (the taint clamp is covered elsewhere).
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
import {
  loadScorecard,
  readRunMeta,
  readSpecRunHistory,
  scorecardPath,
  screenshotsFromRunMeta,
  writeSpec,
  type ComponentRender,
  type RenderFn,
  type Spec,
} from '@validity.ai/verify-spec';
import { renderComponents } from '@validity.ai/verify-web';
import { handleRecordSoftScores } from './scorecard-tools.js';
import { handleVerifyIsolation } from './server.js';

/** The first citable render id from the spec's latest verify run — what a soft
 *  `pass` must cite through record_soft_scores' citation floor. */
function latestCitableId(projectRoot: string, specId: string): string {
  const latest = readSpecRunHistory(projectRoot, specId, 1).at(-1);
  const meta = latest ? readRunMeta(projectRoot, latest.runId) : null;
  const shot = meta ? screenshotsFromRunMeta(meta).find((s) => !s.error && !s.skipped) : undefined;
  if (!shot) throw new Error('test setup: latest run produced no citable screenshot');
  return shot.id;
}

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

const SPEC_ID = 'spec-seed-loop';

describe('MCP verify seeds the scorecard → record_soft_scores works (P2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-seed-'));

    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
};
`,
    );

    mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/Widget.tsx'), COMPONENT_SOURCE);

    // Frozen spec with a hard criterion (decided mechanically) and a soft one
    // (agent-scored) — the shape the deficiency was hit on (spec-7fe0).
    const spec: Spec = {
      id: SPEC_ID,
      version: 1,
      status: 'frozen',
      hash: 'hash-seed-1',
      source: { prompt: 'build the widget', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'renders without console errors',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        },
        { id: 'AC-2', text: 'the widget looks polished', tier: 'soft' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec);

    const stub: RenderFn = async (args) => ({
      renders: args.components.map<ComponentRender>((req) => {
        const screenshotPath = resolve(
          args.screenshotsDir,
          `${req.componentId}__${req.scenarioId ?? 'base'}.png`,
        );
        writeFileSync(screenshotPath, RED_8x8_PNG);
        return {
          id: req.componentId,
          filePath: req.componentAbsolutePath,
          screenshotPath,
          scenarioId: req.scenarioId,
          criterionVerdicts: [
            { id: 'AC-1', tier: 'hard', status: 'pass', detail: '0 console errors' },
          ],
        };
      }),
      environment: { target: 'web', devServer: 'cold', tailwindShim: false },
    });
    vi.mocked(renderComponents).mockImplementation(stub);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('verify writes scorecard.json (hard decided, soft unscored), then record_soft_scores succeeds and flips the entry', async () => {
    expect(existsSync(scorecardPath(projectRoot))).toBe(false);

    const verifyResult = await handleVerifyIsolation({
      prompt: 'build the widget',
      projectRoot,
      planId: SPEC_ID,
      changedFiles: ['src/Widget.tsx'],
    } as Parameters<typeof handleVerifyIsolation>[0]);
    expect(verifyResult.isError).toBeUndefined();

    // The deterministic tick landed on disk — the exact write that was missing.
    expect(existsSync(scorecardPath(projectRoot))).toBe(true);
    const seeded = loadScorecard(projectRoot)!.specs[SPEC_ID]!;
    expect(seeded.specVersion).toBe(1);
    expect(seeded.specHash).toBe('hash-seed-1');
    expect(seeded.criteria['AC-1']).toMatchObject({ tier: 'hard', status: 'pass' });
    expect(seeded.criteria['AC-2']).toMatchObject({ tier: 'soft', status: 'unscored' });
    expect(seeded.signedOff).toBe(false); // soft still unscored — never false-green

    // The previously-broken step: record soft scores WITHOUT a watch tick.
    const record = await handleRecordSoftScores({
      specId: SPEC_ID,
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a clean, polished widget',
          screenshotIds: [latestCitableId(projectRoot, SPEC_ID)],
        },
      ],
    });
    expect(record.isError).toBeUndefined();
    const recordText = (record.content as Array<{ text?: string }>).map((c) => c.text).join('\n');
    expect(recordText).not.toMatch(/no scorecard entry/);
    expect(recordText).toMatch(/Recorded 1 soft score/);

    // The entry flipped and the stop rule recomputed over the merged statuses.
    const after = loadScorecard(projectRoot)!.specs[SPEC_ID]!;
    expect(after.criteria['AC-2']).toMatchObject({ tier: 'soft', status: 'pass' });
    expect(after.criteria['AC-1']).toMatchObject({ tier: 'hard', status: 'pass' }); // untouched
    expect(after.verdict).toBe('pass');
    expect(after.signedOff).toBe(true);
    const sc = record.structuredContent as { signedOff: boolean; verdict: string };
    expect(sc.signedOff).toBe(true);
    expect(sc.verdict).toBe('pass');
  });

  it('a second verify after the agent score carries the soft pass forward (Rule 1 through the real handler)', async () => {
    const verify = () =>
      handleVerifyIsolation({
        prompt: 'build the widget',
        projectRoot,
        planId: SPEC_ID,
        changedFiles: ['src/Widget.tsx'],
      } as Parameters<typeof handleVerifyIsolation>[0]);

    await verify();
    await handleRecordSoftScores({
      specId: SPEC_ID,
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished widget',
          screenshotIds: [latestCitableId(projectRoot, SPEC_ID)],
        },
      ],
    });

    // The re-verify's soft placeholder must NOT stomp the agent's pass.
    await verify();
    const after = loadScorecard(projectRoot)!.specs[SPEC_ID]!;
    expect(after.criteria['AC-2']).toMatchObject({ tier: 'soft', status: 'pass' });
    expect(after.signedOff).toBe(true);
  });
});
