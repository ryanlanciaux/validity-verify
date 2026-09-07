/**
 * Judge pack (A6): the blind-judging bundle. The load-bearing invariants:
 *
 *   - BLIND: nothing from the run's prompt / component source / diff / spec
 *     source.prompt ever reaches rubric.json or SCORING.md (denylist test).
 *   - FROZEN: the rubric is only emitted when it re-hashes to exactly the
 *     content the run verified against; drift is a hard error, not a fallback.
 *   - SOFT-ONLY: hard/property criteria never appear in the rubric — the pack
 *     must not even invite the judge to opine on mechanical verdicts.
 *   - CONTAINED: a crafted run-meta path outside `.validity/runs/` is never
 *     copied into a bundle designed to be handed to another context.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildJudgePack,
  citableScreenshotIds,
  computeSpecHash,
  createSpec,
  emitJudgePack,
  freezeSpec,
  judgePackDir,
  JudgePackError,
  readSpecVersion,
  resolveJudgeMode,
  runDir,
  screenshotsFromRunMeta,
  updateSpec,
  type RunMeta,
  type Spec,
  type SpecCriterion,
} from './index.js';

function tmpProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-judge-pack-'));
}

const HARD_CRITERION: SpecCriterion = {
  id: 'AC-1',
  text: 'Clicking Send posts the form',
  tier: 'hard',
  checks: [{ expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } }],
};

const SOFT_CRITERION: SpecCriterion = {
  id: 'AC-2',
  text: 'Form looks polished and on-brand',
  tier: 'soft',
  softThreshold: 0.8,
};

function frozenSpec(
  root: string,
  criteria: SpecCriterion[] = [HARD_CRITERION, SOFT_CRITERION],
): Spec {
  const { specId } = createSpec({
    projectRoot: root,
    prompt: 'Build a beautiful contact form',
    criteria,
  });
  return freezeSpec({ projectRoot: root, specId }).spec;
}

function seedRun(root: string, spec: Spec | null, overrides: Partial<RunMeta> = {}): RunMeta {
  const runId = overrides.runId ?? 'run_jp_1';
  const dir = runDir(root, runId);
  mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
  const screenshotPath = resolve(dir, 'screenshots/contact-form__base.png');
  writeFileSync(
    screenshotPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const meta: RunMeta = {
    runId,
    createdAt: '2026-07-01T00:00:00.000Z',
    mode: 'isolation',
    prompt: 'SECRET-PROMPT make the contact form pop',
    scenarios: [],
    components: [
      {
        id: 'contact-form',
        filePath: 'src/ContactForm.tsx',
        screenshotPath,
      },
    ],
    componentSources: { 'contact-form': 'SECRET-SOURCE export const ContactForm = () => null;' },
    diff: {
      files: [
        {
          path: 'src/ContactForm.tsx',
          status: 'modified',
          patch: 'SECRET-DIFF +something',
        } as RunMeta['diff']['files'][number],
      ],
    },
    report: { enabled: true, brand: 'validity' },
    ...(spec ? { specId: spec.id, specVersion: spec.version, specHash: spec.hash } : {}),
    ...overrides,
  };
  writeFileSync(resolve(dir, 'run-meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

describe('resolveJudgeMode', () => {
  it("defaults to 'self' for absent config / absent scoring", () => {
    expect(resolveJudgeMode(undefined)).toBe('self');
    expect(resolveJudgeMode(null)).toBe('self');
    expect(resolveJudgeMode({})).toBe('self');
    expect(resolveJudgeMode({ scoring: {} })).toBe('self');
  });

  it('reads the configured judge', () => {
    expect(resolveJudgeMode({ scoring: { judge: 'fresh-context' } })).toBe('fresh-context');
    expect(resolveJudgeMode({ scoring: { judge: 'human' } })).toBe('human');
  });
});

describe('buildJudgePack', () => {
  it('rubric carries soft criteria ONLY — hard/property ids appear nowhere', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const built = buildJudgePack({ meta, spec })!;
    expect(built.rubric.criteria.map((c) => c.id)).toEqual(['AC-2']);
    expect(built.rubric.criteria[0]!.softThreshold).toBe(0.8);
    expect(JSON.stringify(built.rubric)).not.toContain('AC-1');
    expect(built.scoringMd).not.toContain('AC-1');
    expect(built.scoringMd).toContain('1 hard/property criterion was decided mechanically');
  });

  it('BLIND PACK: prompt / component source / diff / spec source.prompt never reach the output (denylist)', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const built = buildJudgePack({ meta, spec })!;
    const everything =
      JSON.stringify(built.rubric) + built.scoringMd + JSON.stringify(built.scoresSchema);
    expect(everything).not.toContain('SECRET-PROMPT');
    expect(everything).not.toContain('SECRET-SOURCE');
    expect(everything).not.toContain('SECRET-DIFF');
    // The spec's own captured prompt is build context too.
    expect(everything).not.toContain('Build a beautiful contact form');
  });

  it('carries the citable screenshot id + labels; render errors keep the entry but drop the file', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    meta.components!.push({
      id: 'contact-form-error',
      filePath: 'src/ContactForm.tsx',
      screenshotPath: resolve(runDir(root, meta.runId), 'screenshots/nope.png'),
      renderError: 'boom: missing Provider',
    });
    const built = buildJudgePack({ meta, spec })!;
    expect(built.rubric.screenshots).toHaveLength(2);
    const ok = built.rubric.screenshots[0]!;
    expect(ok.screenshotId).toBe('contact-form');
    expect(ok.file).toMatch(/^screenshots\/.*\.png$/);
    const errored = built.rubric.screenshots[1]!;
    expect(errored.renderError).toBe('boom: missing Provider');
    expect(errored.file).toBeUndefined();
    // Rule 5 (missing evidence ⇒ unverifiable) is in the instructions.
    expect(built.scoringMd).toContain('render error or missing evidence');
    expect(built.warnings.join(' ')).toMatch(/no usable screenshot/);
  });

  it('renderError leak regression: error strings are scrubbed (first line, no paths, truncated) — never verbatim', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    meta.components!.push({
      id: 'contact-form-error',
      filePath: 'src/ContactForm.tsx',
      screenshotPath: resolve(runDir(root, meta.runId), 'screenshots/nope.png'),
      renderError:
        "TypeError: Cannot read properties of undefined (reading 'name') " +
        'at /Users/dev/secret-app/src/features/paywall/PaywallModal.tsx:42:7\n' +
        '    at PaywallModal (src/features/paywall/PaywallModal.tsx:42:7)\n' +
        '    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)',
    });
    const built = buildJudgePack({ meta, spec })!;
    const errored = built.rubric.screenshots.find((s) => s.screenshotId === 'contact-form-error')!;
    // The judge still learns the render errored (criteria → unverifiable)…
    expect(errored.renderError).toBeDefined();
    expect(errored.renderError).toContain('TypeError');
    // …but no source path, component stack, or code frame reaches the pack.
    const everything = JSON.stringify(built.rubric) + built.scoringMd;
    expect(everything).not.toContain('PaywallModal');
    expect(everything).not.toContain('secret-app');
    expect(everything).not.toContain('renderWithHooks');
    expect(errored.renderError).not.toContain('\n');
    expect(errored.renderError!.length).toBeLessThanOrEqual(200);
  });

  it('returns null when the spec has zero soft criteria', () => {
    const root = tmpProject();
    const spec = frozenSpec(root, [HARD_CRITERION]);
    const meta = seedRun(root, spec);
    expect(buildJudgePack({ meta, spec })).toBeNull();
  });

  it('scores.schema.json shape-lock: judge output stays field-compatible with record_soft_scores + citations', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const built = buildJudgePack({ meta, spec })!;
    const schema = built.scoresSchema as {
      required: string[];
      properties: { scores: { items: { required: string[] } } };
    };
    expect(schema.required).toEqual(['scores', 'scoredBy']);
    expect(schema.properties.scores.items.required).toEqual([
      'id',
      'status',
      'reasoning',
      'screenshotIds',
    ]);
  });

  it('slugs colliding screenshot labels deterministically (-2, -3)', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const dup = { ...meta.components![0]!, id: 'contact-form' };
    meta.components = [meta.components![0]!, dup];
    const built = buildJudgePack({ meta, spec })!;
    const files = built.rubric.screenshots.map((s) => s.file);
    expect(files).toEqual(['screenshots/contact-form.png', 'screenshots/contact-form-2.png']);
  });
});

describe('emitJudgePack', () => {
  it('writes rubric.json + scores.schema.json + SCORING.md + copied screenshots to the run dir', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const result = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    expect(result.dir).toBe(judgePackDir(root, meta.runId));
    expect(result.specId).toBe(spec.id);
    expect(result.softCriteria).toBe(1);
    expect(result.screenshots).toBe(1);
    const rubric = JSON.parse(readFileSync(resolve(result.dir, 'rubric.json'), 'utf-8'));
    expect(rubric.specHash).toBe(spec.hash);
    expect(rubric.judgeInstructions).toBe('SCORING.md');
    expect(existsSync(resolve(result.dir, 'scores.schema.json'))).toBe(true);
    expect(readFileSync(resolve(result.dir, 'SCORING.md'), 'utf-8')).toContain(
      'fresh-context judge',
    );
    expect(existsSync(resolve(result.dir, 'screenshots/contact-form.png'))).toBe(true);
  });

  it('throws unknown-run for a missing runId', () => {
    const root = tmpProject();
    expect(() => emitJudgePack({ projectRoot: root, runId: 'run_nope' })).toThrowError(
      JudgePackError,
    );
    try {
      emitJudgePack({ projectRoot: root, runId: 'run_nope' });
    } catch (err) {
      expect((err as JudgePackError).code).toBe('unknown-run');
    }
  });

  it('refuses an unplanned (spec-less) run with a plan-first redirect', () => {
    const root = tmpProject();
    const meta = seedRun(root, null);
    try {
      emitJudgePack({ projectRoot: root, runId: meta.runId });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as JudgePackError).code).toBe('unplanned-run');
      expect((err as JudgePackError).message).toMatch(/validity__plan/);
    }
  });

  it('HARD ERROR when the spec drifted since the run (hash matches neither current nor history)', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec, { specHash: 'sha256-not-what-anything-hashes-to' });
    try {
      emitJudgePack({ projectRoot: root, runId: meta.runId });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as JudgePackError).code).toBe('rubric-unreconstructable');
    }
  });

  it('reconstructs a superseded version from history/ when its hash matches the run', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    // Supersede: v1 snapshots into history/, spec.yaml becomes a v2 draft.
    updateSpec({
      projectRoot: root,
      specId: spec.id,
      patch: { criteria: [HARD_CRITERION, { ...SOFT_CRITERION, text: 'Reworded criterion' }] },
    });
    const result = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    const rubric = JSON.parse(readFileSync(resolve(result.dir, 'rubric.json'), 'utf-8'));
    expect(rubric.specVersion).toBe(1);
    expect(rubric.criteria[0].text).toBe('Form looks polished and on-brand');
    // The judge never sees the post-run rewording.
    expect(JSON.stringify(rubric)).not.toContain('Reworded criterion');
  });

  it('old run-meta without a specHash still packs, with a visible provenance caveat', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec, { specHash: undefined });
    const result = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    const scoringMd = readFileSync(resolve(result.dir, 'SCORING.md'), 'utf-8');
    expect(scoringMd).toContain('spec hash was not recorded on this run');
  });

  it('CONTAINMENT: a screenshot path outside .validity/runs/ is never copied (missing + warning)', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const outside = resolve(root, 'outside-secret.txt');
    writeFileSync(outside, 'HOST-SECRET');
    const meta = seedRun(root, spec);
    meta.components![0]!.screenshotPath = '../../../../etc/passwd';
    meta.components!.push({
      id: 'sneaky',
      filePath: 'src/Sneaky.tsx',
      screenshotPath: outside,
    });
    writeFileSync(
      resolve(runDir(root, meta.runId), 'run-meta.json'),
      JSON.stringify(meta, null, 2),
    );
    const result = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    expect(result.screenshots).toBe(0);
    const rubric = JSON.parse(readFileSync(resolve(result.dir, 'rubric.json'), 'utf-8')) as {
      screenshots: Array<{ missing?: boolean; file?: string }>;
    };
    expect(rubric.screenshots.every((s) => s.missing === true && s.file === undefined)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(existsSync(resolve(result.dir, 'screenshots/sneaky.png'))).toBe(false);
  });

  it('rejects screenshot symlinks, parent symlinks and non-PNG sources', () => {
    const root = tmpProject();
    const outside = tmpProject();
    try {
      const spec = frozenSpec(root);
      const meta = seedRun(root, spec);
      const shots = resolve(runDir(root, meta.runId), 'screenshots');
      const secret = resolve(outside, 'secret.txt');
      writeFileSync(
        resolve(outside, 'valid.png'),
        readFileSync(meta.components![0]!.screenshotPath!),
      );
      symlinkSync(resolve(outside, 'valid.png'), resolve(shots, 'linked-valid.png'));
      writeFileSync(secret, 'OUTSIDE_PRIVATE_SENTINEL');
      symlinkSync(secret, resolve(shots, 'linked.png'));
      symlinkSync(outside, resolve(shots, 'parent'));
      writeFileSync(resolve(shots, 'invalid.png'), 'NOT_PNG_PRIVATE_SENTINEL');
      for (const path of [
        'linked.png',
        'linked-valid.png',
        'parent/valid.png',
        'parent/secret.txt',
        'invalid.png',
      ]) {
        meta.components![0]!.screenshotPath = resolve(shots, path);
        writeFileSync(resolve(runDir(root, meta.runId), 'run-meta.json'), JSON.stringify(meta));
        const pack = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
        expect(pack.screenshots).toBe(0);
        const rubric = readFileSync(resolve(pack.dir, 'rubric.json'), 'utf8');
        expect(rubric).not.toContain('PRIVATE_SENTINEL');
        expect(JSON.parse(rubric).screenshots[0]).toMatchObject({ missing: true });
        expect(existsSync(resolve(pack.dir, 'screenshots/contact-form.png'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns null (and writes nothing) when the spec has no soft criteria', () => {
    const root = tmpProject();
    const spec = frozenSpec(root, [HARD_CRITERION]);
    const meta = seedRun(root, spec);
    expect(emitJudgePack({ projectRoot: root, runId: meta.runId })).toBeNull();
    expect(existsSync(judgePackDir(root, meta.runId))).toBe(false);
  });

  it('is idempotent: re-emit overwrites derived files and leaves foreign files alone', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const first = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    const foreign = resolve(first.dir, 'judge-notes.txt');
    writeFileSync(foreign, 'my notes');
    const second = emitJudgePack({ projectRoot: root, runId: meta.runId })!;
    expect(second.dir).toBe(first.dir);
    expect(readFileSync(foreign, 'utf-8')).toBe('my notes');
  });

  it('honors an explicit outDir', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    const meta = seedRun(root, spec);
    const outDir = resolve(root, 'handoff/pack');
    const result = emitJudgePack({ projectRoot: root, runId: meta.runId, outDir })!;
    expect(result.dir).toBe(outDir);
    expect(existsSync(resolve(outDir, 'rubric.json'))).toBe(true);
  });
});

describe('screenshotsFromRunMeta', () => {
  it('covers isolation components AND url pages with citable ids', () => {
    const meta = {
      runId: 'r',
      createdAt: 'now',
      prompt: 'p',
      scenarios: [],
      components: [
        {
          id: 'card',
          filePath: 'src/Card.tsx',
          screenshotPath: '/tmp/card.png',
          scenarioId: 'logged-in',
          viewport: { name: 'mobile', width: 375, height: 667 },
        },
      ],
      pages: [
        {
          id: 'dashboard__base',
          pathId: 'dashboard',
          url: 'http://localhost:3000/dashboard',
          screenshotPath: '/tmp/dash.png',
          errorMessage: 'timeout',
        },
      ],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
    } as unknown as RunMeta;
    const shots = screenshotsFromRunMeta(meta);
    expect(shots).toEqual([
      {
        id: 'card',
        label: 'card · logged-in · mobile',
        path: '/tmp/card.png',
        error: undefined,
        skipped: undefined,
      },
      {
        id: 'dashboard__base',
        label: 'http://localhost:3000/dashboard',
        path: '/tmp/dash.png',
        error: 'timeout',
      },
    ]);
  });

  it('emits the pre-interaction companion as its own citable render, listed first', () => {
    const meta = {
      runId: 'r',
      createdAt: 'now',
      prompt: 'p',
      scenarios: [],
      components: [
        {
          id: 'login',
          filePath: 'src/Login.tsx',
          screenshotPath: '/tmp/login-post.png',
          preInteractionScreenshotPath: '/tmp/login-pre.png',
        },
      ],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
    } as unknown as RunMeta;
    expect(screenshotsFromRunMeta(meta).map((s) => ({ id: s.id, path: s.path }))).toEqual([
      { id: 'login::pre', path: '/tmp/login-pre.png' },
      { id: 'login', path: '/tmp/login-post.png' },
    ]);
  });

  it('suppresses the pre-interaction companion when the render errored or was skipped', () => {
    const base = {
      runId: 'r',
      createdAt: 'now',
      prompt: 'p',
      scenarios: [],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
    };
    const errored = {
      ...base,
      components: [
        {
          id: 'login',
          filePath: 'src/Login.tsx',
          screenshotPath: '/tmp/post.png',
          preInteractionScreenshotPath: '/tmp/pre.png',
          renderError: 'boom',
        },
      ],
    } as unknown as RunMeta;
    expect(screenshotsFromRunMeta(errored).map((s) => s.id)).toEqual(['login']);
  });
});

describe('citableScreenshotIds', () => {
  it('includes ::pre companions, excludes errored and skipped renders (citation-floor parity)', () => {
    const meta = {
      runId: 'r',
      createdAt: 'now',
      prompt: 'p',
      scenarios: [],
      components: [
        {
          id: 'login',
          filePath: 'src/Login.tsx',
          screenshotPath: '/tmp/post.png',
          preInteractionScreenshotPath: '/tmp/pre.png',
        },
        { id: 'broken', filePath: 'src/B.tsx', screenshotPath: '/tmp/b.png', renderError: 'x' },
        {
          id: 'thrifty',
          filePath: 'src/T.tsx',
          screenshotPath: '/tmp/t.png',
          screenshotSkipped: true,
        },
      ],
      pages: [
        { id: 'page-err', pathId: 'p', url: 'u', screenshotPath: '/tmp/p.png', errorMessage: 'x' },
      ],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
    } as unknown as RunMeta;
    expect(citableScreenshotIds(meta)).toEqual(new Set(['login::pre', 'login']));
  });
});

// Sanity that the history round-trip works the way resolveFrozenSpec assumes:
// the snapshot re-hashes to the frozen hash the run recorded (content hash is
// key-order independent — byte layout of the YAML is not the contract).
describe('frozen hash stability through history snapshot', () => {
  it('history v1 re-hashes to the run-recorded specHash after supersede', () => {
    const root = tmpProject();
    const spec = frozenSpec(root);
    updateSpec({
      projectRoot: root,
      specId: spec.id,
      patch: { criteria: [HARD_CRITERION, { ...SOFT_CRITERION, text: 'changed' }] },
    });
    const historical = readSpecVersion(root, spec.id, 1)!;
    expect(computeSpecHash(historical)).toBe(spec.hash);
    expect(computeSpecHash(spec)).toBe(spec.hash);
  });
});
