/**
 * Tests for the deterministic candidate-criteria generator (Phase C bulk
 * onboarding). The load-bearing invariants asserted here:
 *
 *   1. Determinism — identical input → deep-equal output.
 *   2. Normative cap — hard + property criteria never exceed 4, and the total
 *      (normative + advisory) never exceeds 4 either.
 *   3. Advisory-only soft — every soft criterion carries `severity: 'advisory'`.
 *   4. Schema validity — every emitted criterion passes `specCriterionSchema.parse`.
 *   5. Literal-union detection — only 2–8 quoted-string-literal unions qualify.
 *   6. Nav criterion — screens only, and only when an edge resolves.
 *   7. Fixed priority order — render-clean (AC-1) before a11y (AC-2) before
 *      variants (AC-3) before nav (AC-4); ids are AC-1..AC-n in that order.
 */
import { describe, expect, it } from 'vitest';
import {
  generateCandidateCriteria,
  findLiteralUnionProp,
  parseLiteralUnion,
  resolveNavDestinations,
  MAX_NORMATIVE_CRITERIA,
  MAX_TOTAL_CRITERIA,
  type GenerateCandidateCriteriaInput,
} from './onboard-generator.js';
import { specCriterionSchema } from './spec-schema.js';
import type { CatalogEntry, PropTypeInfo } from './catalog.js';
import type { ResolvedNavigationEdge } from './navigation.js';

function componentEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    path: 'src/components/Button.tsx',
    name: 'Button',
    kind: 'component',
    discovered: true,
    fixtures: [],
    ...overrides,
  };
}

function screenEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    path: 'src/screens/Home.tsx',
    name: 'Home',
    kind: 'screen',
    discovered: true,
    fixtures: [],
    ...overrides,
  };
}

function prop(name: string, type: string): PropTypeInfo {
  return { name, type, optional: false };
}

function rawEdge(over: Partial<ResolvedNavigationEdge> = {}): ResolvedNavigationEdge {
  return {
    from: 'src/screens/Home.tsx',
    to: '/about',
    trigger: '<Link to>',
    line: 1,
    column: 0,
    toPath: 'src/screens/About.tsx',
    ...over,
  };
}

function genInput(
  over: Partial<GenerateCandidateCriteriaInput> = {},
): GenerateCandidateCriteriaInput {
  return {
    entry: componentEntry(),
    navigation: [],
    scenarioNames: [],
    ...over,
  };
}

describe('generateCandidateCriteria', () => {
  it('emits render-clean (AC-1) and a11y (AC-2) for a plain component', () => {
    const out = generateCandidateCriteria(genInput());
    const normative = out.filter((c) => c.tier !== 'soft');
    expect(normative).toHaveLength(2);
    expect(normative[0]).toMatchObject({
      id: 'AC-1',
      tier: 'hard',
      checks: [{ expect: { console: { errors: 0 } } }],
    });
    expect(normative[0]!.text).toContain('renders without console errors');
    expect(normative[1]).toMatchObject({
      id: 'AC-2',
      tier: 'hard',
      checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }],
    });
  });

  it('appends a scenario clause to render-clean text when scenarioNames is non-empty', () => {
    const out = generateCandidateCriteria(genInput({ scenarioNames: ['logged-in', 'logged-out'] }));
    expect(out[0]!.text).toContain(
      'renders without console errors, under each configured scenario: logged-in, logged-out',
    );
  });

  it('omits the scenario clause when scenarioNames is empty', () => {
    const out = generateCandidateCriteria(genInput({ scenarioNames: [] }));
    expect(out[0]!.text).toBe('renders without console errors');
  });

  it('appends exactly ONE advisory soft criterion with severity advisory + softThreshold 0.6', () => {
    const out = generateCandidateCriteria(genInput());
    const soft = out.filter((c) => c.tier === 'soft');
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatchObject({
      tier: 'soft',
      severity: 'advisory',
      softThreshold: 0.6,
    });
    expect(soft[0]!.text).toContain('layout is visually coherent');
  });

  it('ids are AC-1..AC-n in fixed priority order with no gaps', () => {
    const out = generateCandidateCriteria(genInput());
    const ids = out.map((c) => c.id);
    expect(ids).toEqual(ids.map((_, i) => `AC-${i + 1}`));
  });

  it('is deterministic: two calls with identical input are deep-equal', () => {
    const input = genInput({ scenarioNames: ['a', 'b'] });
    const a = generateCandidateCriteria(input);
    const b = generateCandidateCriteria(input);
    expect(a).toEqual(b);
  });

  it('.every emitted criterion passes specCriterionSchema.parse', () => {
    const inputs: GenerateCandidateCriteriaInput[] = [
      genInput(),
      genInput({ entry: screenEntry(), navigation: [rawEdge()] }),
      genInput({ entry: componentEntry({ props: [prop('variant', '"a" | "b" | "c"')] }) }),
      genInput({ scenarioNames: ['x', 'y', 'z'] }),
    ];
    for (const input of inputs) {
      const out = generateCandidateCriteria(input);
      for (const c of out) {
        expect(() => specCriterionSchema.parse(c)).not.toThrow();
      }
    }
  });

  it('hard + property count never exceeds 4', () => {
    const cases: GenerateCandidateCriteriaInput[] = [
      genInput(),
      genInput({
        entry: screenEntry(),
        navigation: [rawEdge({ to: '/a' }), rawEdge({ to: '/b' })],
      }),
      genInput({ entry: componentEntry({ props: [prop('v', '"a" | "b" | "c" | "d" | "e"')] }) }),
      genInput({
        entry: screenEntry({
          props: [prop('v', '"primary" | "outline" | "ghost"')],
        }),
        navigation: [rawEdge({ to: '/a' }), rawEdge({ to: '/b' })],
      }),
    ];
    for (const input of cases) {
      const out = generateCandidateCriteria(input);
      const normative = out.filter((c) => c.tier === 'hard' || c.tier === 'property');
      expect(normative.length).toBeLessThanOrEqual(MAX_NORMATIVE_CRITERIA);
    }
  });

  it('total criteria never exceed 4; the layout advisory is displaced when the cap is full', () => {
    // A screen with BOTH a literal-union prop AND resolved nav edges fills the
    // cap: render + a11y + nav (hard) plus the variant criterion (SOFT). The
    // lowest-priority generic layout advisory is displaced to stay ≤4 total.
    const rich = generateCandidateCriteria(
      genInput({
        entry: screenEntry({ props: [prop('v', '"primary" | "outline" | "ghost"')] }),
        navigation: [rawEdge({ to: '/a' }), rawEdge({ to: '/b' })],
      }),
    );
    expect(rich).toHaveLength(MAX_TOTAL_CRITERIA);
    // 3 mechanical (render, a11y, nav) — the variant criterion is now SOFT.
    expect(rich.filter((c) => c.tier === 'hard' || c.tier === 'property')).toHaveLength(3);
    // Exactly one soft: the per-variant criterion; the layout advisory is displaced.
    expect(rich.filter((c) => c.tier === 'soft')).toHaveLength(1);
    expect(rich.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4']);

    // Shapes with headroom stay under the cap and keep at least one soft criterion.
    const withHeadroom: GenerateCandidateCriteriaInput[] = [
      genInput(), // plain component: 2 mechanical + 1 advisory soft
      genInput({ entry: screenEntry(), navigation: [rawEdge({ to: '/a' })] }), // 3 mechanical + advisory
      genInput({ entry: componentEntry({ props: [prop('v', '"a" | "b" | "c"')] }) }), // 2 mechanical + variant soft + advisory
    ];
    for (const input of withHeadroom) {
      const out = generateCandidateCriteria(input);
      expect(out.length).toBeLessThanOrEqual(MAX_TOTAL_CRITERIA);
      expect(out.filter((c) => c.tier === 'soft').length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('literal-union detection', () => {
  it('qualifies a 2–8 member union of quoted string literals', () => {
    expect(parseLiteralUnion('"a" | "b"')).toEqual(['"a"', '"b"']);
    expect(parseLiteralUnion('"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"')?.length).toBe(8);
    expect(parseLiteralUnion("'x' | 'y'")).toEqual(["'x'", "'y'"]);
  });

  it('rejects unions of 1 or >8 members', () => {
    expect(parseLiteralUnion('"a"')).toBeNull();
    expect(parseLiteralUnion('"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i"')).toBeNull();
  });

  it('rejects unions containing numbers, booleans, or bare identifiers', () => {
    expect(parseLiteralUnion('"a" | number')).toBeNull();
    expect(parseLiteralUnion('"a" | boolean')).toBeNull();
    expect(parseLiteralUnion('"a" | ReactNode')).toBeNull();
    expect(parseLiteralUnion('"a" | string')).toBeNull();
    expect(parseLiteralUnion('boolean')).toBeNull();
    expect(parseLiteralUnion('ReactNode')).toBeNull();
  });

  it('rejects an empty / whitespace-only type string', () => {
    expect(parseLiteralUnion('')).toBeNull();
    expect(parseLiteralUnion('   ')).toBeNull();
  });

  it('emits ONE variant criterion (not one-per-variant), SOFT so it is not a vacuous hard duplicate of AC-1', () => {
    const entry = componentEntry({ props: [prop('variant', '"primary" | "outline" | "ghost"')] });
    const out = generateCandidateCriteria(genInput({ entry }));
    const variant = out.find((c) => c.text.includes('each variant variant'));
    expect(variant).toBeDefined();
    // SOFT + advisory: the mechanical tier only renders DEFAULT props, so it
    // cannot exercise each variant — a hard console check here just duplicated
    // AC-1. Per-variant coverage is agent-scored (soft), never a fake hard pass.
    expect(variant!.tier).toBe('soft');
    expect(variant!.severity).toBe('advisory');
    expect(variant!.checks).toBeUndefined();
    expect(variant!.text).toContain('"primary", "outline", "ghost"');
    expect(variant!.text).toContain('renders correctly');
  });

  it('findLiteralUnionProp returns the first matching prop in order', () => {
    const entry = componentEntry({
      props: [prop('label', 'string'), prop('variant', '"a" | "b"'), prop('size', '"sm" | "md"')],
    });
    expect(findLiteralUnionProp(entry)?.propName).toBe('variant');
  });

  it('produces no variant criterion when props have no qualifying union', () => {
    const entry = componentEntry({ props: [prop('label', 'string'), prop('count', 'number')] });
    const out = generateCandidateCriteria(genInput({ entry }));
    expect(out.find((c) => c.text.includes('variant'))).toBeUndefined();
  });
});

describe('nav-edges criterion', () => {
  it('emits a nav criterion for a screen with a resolved edge', () => {
    const out = generateCandidateCriteria(
      genInput({ entry: screenEntry(), navigation: [rawEdge({ to: '/about' })] }),
    );
    const nav = out.find((c) => c.text.includes('navigation reaches'));
    expect(nav).toBeDefined();
    expect(nav!.checks).toEqual([
      { navigate: { url: '/about' } },
      { expect: { console: { errors: 0 } } },
    ]);
    expect(nav!.text).toContain('/about');
  });

  it('caps at 2 navigate checks + one trailing console expect', () => {
    const out = generateCandidateCriteria(
      genInput({
        entry: screenEntry(),
        navigation: [rawEdge({ to: '/a' }), rawEdge({ to: '/b' }), rawEdge({ to: '/c' })],
      }),
    );
    const nav = out.find((c) => c.text.includes('navigation reaches'));
    expect(nav).toBeDefined();
    const navigates = nav!.checks!.filter((c) => 'navigate' in c);
    expect(navigates).toHaveLength(2);
    const expects = nav!.checks!.filter((c) => 'expect' in c);
    expect(expects).toHaveLength(1);
  });

  it('skips entirely when no edge resolves (no toPath)', () => {
    const out = generateCandidateCriteria(
      genInput({
        entry: screenEntry(),
        navigation: [rawEdge({ toPath: '', to: '/x' })],
      }),
    );
    expect(out.find((c) => c.text.includes('navigation reaches'))).toBeUndefined();
  });

  it('emits no nav criterion for a component (even with edges)', () => {
    const out = generateCandidateCriteria(
      genInput({ entry: componentEntry(), navigation: [rawEdge({ to: '/about' })] }),
    );
    expect(out.find((c) => c.text.includes('navigation reaches'))).toBeUndefined();
  });

  it('only matches edges whose source (from) is this entry', () => {
    const out = generateCandidateCriteria(
      genInput({
        entry: screenEntry({ path: 'src/screens/Home.tsx' }),
        navigation: [rawEdge({ from: 'src/screens/Other.tsx', to: '/about' })],
      }),
    );
    expect(out.find((c) => c.text.includes('navigation reaches'))).toBeUndefined();
  });

  it('dedupes edges to the same destination route', () => {
    const out = generateCandidateCriteria(
      genInput({
        entry: screenEntry(),
        navigation: [rawEdge({ to: '/about' }), rawEdge({ to: '/about', line: 5 })],
      }),
    );
    const nav = out.find((c) => c.text.includes('navigation reaches'));
    const navigates = nav!.checks!.filter((c) => 'navigate' in c);
    expect(navigates).toHaveLength(1);
  });

  it('resolveNavDestinations returns up to MAX_NAV_EDGES routes in source order', () => {
    const routes = resolveNavDestinations('src/screens/Home.tsx', [
      rawEdge({ to: '/first' }),
      rawEdge({ to: '/second' }),
      rawEdge({ to: '/third' }),
    ]);
    expect(routes).toEqual(['/first', '/second']);
  });
});

describe('advisory invariant', () => {
  it('every soft criterion the generator can emit has severity advisory', () => {
    const cases: GenerateCandidateCriteriaInput[] = [
      genInput(),
      genInput({ entry: screenEntry(), navigation: [rawEdge()] }),
      genInput({ entry: componentEntry({ props: [prop('v', '"a" | "b"')] }) }),
    ];
    for (const input of cases) {
      const out = generateCandidateCriteria(input);
      const soft = out.filter((c) => c.tier === 'soft');
      for (const s of soft) {
        expect(s.severity).toBe('advisory');
      }
    }
  });
});
