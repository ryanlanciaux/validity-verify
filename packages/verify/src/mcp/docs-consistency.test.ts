/**
 * Docs-truth guard. The render cap and the native/URL/"not shipped" claims have
 * drifted across three surfaces before (run.ts said 24, the verify schema said
 * "capped at 6", SKILL.md said "12"; SKILL.md also claimed URL mode writes no
 * report and the native runner "isn't shipped" long after both shipped). These
 * assertions fail the build the moment a doc number or claim stops matching the
 * code, so the agent-facing strings can't silently lie again.
 *
 * Lane: this is the ONLY place the cap is allowed to be a literal — everywhere
 * else (the verify inputSchema, the native description) interpolates the
 * constant, and the SKILL.md copies are checked against the constant's value.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dataStateSchema,
  MAX_NATIVE_RENDER_TARGETS,
  MAX_RENDER_PAIRS,
  performanceMetricSchema,
  RUBRIC_VERSION,
  type Spec,
} from '@validity.ai/verify-spec';
import { TOOL_DEFINITIONS, planSuccessLines } from './server.js';
import { SPEC_TOOL_DEFINITIONS } from './spec-tools.js';
import { SCORECARD_TOOL_DEFINITIONS } from './scorecard-tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const SKILL_COPIES = [
  resolve(repoRoot, 'packages', 'verify', 'skill', 'validity', 'SKILL.md'),
  resolve(repoRoot, 'packages', 'verify-skill', 'SKILL.md'),
];

function tool(name: string): {
  description: string;
  inputSchema: { properties: Record<string, { description?: string }> };
} {
  const t = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} not found in TOOL_DEFINITIONS`);
  return t as never;
}

describe('verify render-cap is single-sourced from MAX_RENDER_PAIRS', () => {
  it('the verify scenarios schema quotes the constant, not a stale literal', () => {
    const desc = tool('validity__verify').inputSchema.properties.scenarios?.description ?? '';
    // Quotes the real ceiling…
    expect(desc).toContain(`capped at ${MAX_RENDER_PAIRS}`);
    // …and none of the historical wrong numbers.
    expect(desc).not.toContain('capped at 6');
    expect(desc).not.toContain('capped at 12');
  });

  it('the native cap quotes MAX_NATIVE_RENDER_TARGETS (a quarter of web)', () => {
    const desc = tool('validity__verify').inputSchema.properties.native?.description ?? '';
    expect(desc).toContain(`Capped at ${MAX_NATIVE_RENDER_TARGETS} `);
  });
});

describe('verify `detail` copy stays truthful (C3 lean verify)', () => {
  it('the schema documents the auto policy and the detail:full escape hatch', () => {
    const desc = tool('validity__verify').inputSchema.properties.detail?.description ?? '';
    // Auto policy: full on the first verify of a spec, lean once history exists.
    expect(desc).toContain('auto');
    expect(desc).toContain('FIRST verify');
    expect(desc).toContain('prior runs');
    // The escape hatch is named verbatim so an agent can copy-paste it.
    expect(desc).toContain("detail:'full'");
    // Presentation-only claim — lean must never read as a gate change.
    expect(desc).toContain('Presentation-only');
  });

  it('the legacy `lean` arg is documented as a deprecated alias, not a second feature', () => {
    const desc = tool('validity__verify').inputSchema.properties.lean?.description ?? '';
    expect(desc).toContain('Deprecated alias');
    expect(desc).toContain("detail:'lean'");
  });

  for (const path of SKILL_COPIES) {
    it(`${path.includes('verify-skill') ? 'verify-skill' : 'cli skill'} SKILL.md documents lean/detail with the escape hatch`, () => {
      const skill = readFileSync(path, 'utf-8');
      expect(skill).toContain("detail: 'lean'");
      expect(skill).toContain("detail: 'full'");
      expect(skill).toContain('carried forward');
    });
  }
});

describe('SKILL.md (both committed copies) stays truthful', () => {
  it('the two copies are byte-identical', () => {
    const [canonical, staged] = SKILL_COPIES.map((p) => readFileSync(p, 'utf-8'));
    expect(staged).toBe(canonical);
  });

  for (const path of SKILL_COPIES) {
    describe(path.includes('verify-skill') ? 'verify-skill copy' : 'cli skill copy', () => {
      const skill = readFileSync(path, 'utf-8');

      it('quotes the real render cap and not a stale number', () => {
        expect(skill).toContain(`capped at ${MAX_RENDER_PAIRS}`);
        expect(skill).not.toContain('capped at 12');
        expect(skill).not.toContain('capped at 6 ');
      });

      it('drops the "URL mode writes no report" lie (handleVerifyUrl writes run-meta)', () => {
        expect(skill).not.toContain('does NOT auto-create a report');
      });

      it('drops the "native runner not yet shipped" / Phase-2 contradictions', () => {
        expect(skill).not.toContain('not yet shipped');
        expect(skill).not.toContain('Phase 2');
      });

      it('documents every real performance metric and no stale ones', () => {
        // Pull the bulleted metric names out of the "Performance criteria"
        // section so a renamed enum value can't silently diverge from the docs.
        const documented = Array.from(skill.matchAll(/\*\*`([a-zA-Z]+)`\*\*/g)).map((m) => m[1]);
        for (const metric of performanceMetricSchema.options) {
          expect(skill).toContain(`\`${metric}\``);
        }
        // Any metric the docs present as a perf bullet must be a real enum value.
        const perfish = documented.filter((d) =>
          ['ready', 'load', 'mount', 'update', 'firstContentfulPaint'].some((k) =>
            d.toLowerCase().includes(k.toLowerCase()),
          ),
        );
        for (const d of perfish) {
          expect(performanceMetricSchema.options as readonly string[]).toContain(d);
        }
      });

      it('documents enforcement mode + the UNPLANNED badge (B1)', () => {
        expect(skill).toContain('UNPLANNED — criteria extracted after the work');
        expect(skill).toContain("enforcement: 'advisory' | 'strict'");
      });
    });
  }
});

describe('plan/spec tool copy stays truthful post-specs-merge (B4)', () => {
  it('the plan description names the spec store, not the dead plans path or "all soft"', () => {
    const desc = tool('validity__plan').description;
    expect(desc).toContain('.validity/specs/');
    expect(desc).not.toContain('plans/<planId>.json');
    expect(desc).not.toContain('all soft');
  });

  it('the spec_get description no longer claims runs are not yet indexed', () => {
    const t = SPEC_TOOL_DEFINITIONS.find((d) => d.name === 'validity__spec_get');
    expect(t).toBeDefined();
    expect(t!.description).not.toContain('not yet indexed');
    expect(t!.description).toContain('runs.jsonl');
  });

  it('the plan success message reports compiler-assigned tiers, never "all soft"', () => {
    const spec: Spec = {
      id: 'spec-b4copy',
      version: 1,
      status: 'frozen',
      source: { prompt: 'add a save button', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        { id: 'AC-1', text: 'a save button is visible', tier: 'hard', checks: [] },
        { id: 'AC-2', text: 'the layout feels balanced', tier: 'soft' },
      ],
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const out = planSuccessLines(spec, '.validity/specs/spec-b4copy/spec.yaml').join('\n');
    expect(out).not.toContain('all soft');
    expect(out).toContain('deterministic compiler');
    // The per-criterion lines show the REAL tier markers.
    expect(out).toContain('AC-1 [hard]');
    expect(out).toContain('AC-2 [soft]');
  });

  it('the verify planId arg documents strict enforcement + spec ids', () => {
    const desc = tool('validity__verify').inputSchema.properties.planId?.description ?? '';
    expect(desc).toContain("enforcement: 'strict'");
    expect(desc).toContain('Plan/spec id');
  });
});

describe('the published rubric version tracks RUBRIC_VERSION (E2.2)', () => {
  /**
   * The marker is the whole mechanism: an agent reads `Rubric version: <n>`
   * out of the skill and submits it back as `rubricVersion`. If the doc copy
   * drifts from the constant, every score is stamped with a version that
   * describes different instructions than the ones the agent actually read —
   * which is precisely the ambiguity the version exists to remove.
   */
  for (const path of SKILL_COPIES) {
    it(`${path.includes('verify-skill') ? 'verify-skill' : 'cli skill'} SKILL.md publishes exactly one marker, equal to the constant`, () => {
      const skill = readFileSync(path, 'utf-8');
      const markers = Array.from(skill.matchAll(/^Rubric version: (\S+)$/gm)).map((m) => m[1]);
      expect(markers).toEqual([RUBRIC_VERSION]);
    });
  }

  it('the submit_report / record_soft_scores schemas quote the constant, not a literal', () => {
    const submit =
      tool('validity__submit_report').inputSchema.properties.rubricVersion?.description;
    expect(submit).toContain(`"${RUBRIC_VERSION}"`);
    const record = SCORECARD_TOOL_DEFINITIONS.find(
      (d) => d.name === 'validity__record_soft_scores',
    ) as unknown as { inputSchema: { properties: Record<string, { description?: string }> } };
    expect(record.inputSchema.properties.rubricVersion?.description).toContain(
      `"${RUBRIC_VERSION}"`,
    );
  });

});

describe('the data-state axis is documented agent-facing (E2.3)', () => {
  for (const path of SKILL_COPIES) {
    it(`${path.includes('verify-skill') ? 'verify-skill' : 'cli skill'} SKILL.md documents dataState + the data-state taint`, () => {
      const skill = readFileSync(path, 'utf-8');
      expect(skill).toContain('### Data states (loading / empty / error / populated)');
      expect(skill).toContain('dataState: loading');
      expect(skill).toContain('droppedDataStates');
      expect(skill).toContain('`data-state` evidence taint');
      // Every state in the enum is named, so a new one can't go undocumented.
      for (const state of dataStateSchema.options) expect(skill).toContain(state);
    });
  }

});

describe('Validity Score is informational (F1)', () => {
  for (const path of SKILL_COPIES) {
    it(`${path.includes('verify-skill') ? 'verify-skill' : 'cli skill'} SKILL.md keeps the score informational`, () => {
      const skill = readFileSync(path, 'utf-8');
      expect(skill).toContain('Validity Score');
      expect(skill).toContain('never gates sign-off or exit codes');
    });
  }
});
