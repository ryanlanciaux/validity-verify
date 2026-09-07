/**
 * Onboard MCP tool tests (Phase C). Drives the handlers DIRECTLY (no MCP
 * transport) against a throwaway project with a real `.validity/config.ts` +
 * a couple of TSX components, so the deterministic draft generator, the
 * first-write-wins baseline, and the before→after report all exercise the
 * real @validity.ai/verify-spec catalog + spec store.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { createSpec, specCriterionSchema, type Spec } from '@validity.ai/verify-spec';
import {
  handleOnboardEnumerate,
  handleOnboardProgress,
  handleOnboardReport,
} from './onboard-tools.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validity-onboard-tools-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Pull the first text block out of a ServerResult. */
function bodyOf(res: ServerResult): string {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

/** Extract the JSON block (```json … ```) from a handler's text output. */
function jsonBlock(body: string): unknown {
  const m = body.match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no json block in:\n${body}`);
  return JSON.parse(m[1]!);
}

/** Seed a throwaway project: package.json + .validity/config.ts + 2 TSX components. */
function seedProject(projectRoot: string): void {
  writeFileSync(
    resolve(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fix', dependencies: {} }),
  );
  mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  writeFileSync(
    resolve(projectRoot, '.validity', 'config.ts'),
    `export default {\n` +
      `  renderMode: 'web' as const,\n` +
      `  framework: 'auto' as const,\n` +
      `  wrapper: './.validity/wrapper.gen.tsx',\n` +
      `};\n`,
  );
  const buttonDir = resolve(projectRoot, 'src/components');
  mkdirSync(buttonDir, { recursive: true });
  // Button has a literal-union prop — the generator should mint a variant
  // criterion (AC-3) enumerating every value.
  writeFileSync(
    resolve(buttonDir, 'Button.tsx'),
    `export default function Button({ variant }: { variant: "primary" | "outline" | "ghost" }) {\n` +
      `  return <button className={variant}>{variant}</button>;\n` +
      `}\n`,
  );
  // Card is plain — render-clean + a11y + advisory only.
  writeFileSync(
    resolve(buttonDir, 'Card.tsx'),
    `export default function Card({ title }: { title: string }) {\n` +
      `  return <div>{title}</div>;\n` +
      `}\n`,
  );
}

/** Path to the onboard state file (mirrors core's onboardStatePath). */
function statePath(projectRoot: string): string {
  return resolve(projectRoot, '.validity', 'onboard-state.json');
}

describe('handleOnboardEnumerate — deterministic drafts', () => {
  beforeEach(() => seedProject(root));

  it('enumerate succeeds', async () => {
    const res = await handleOnboardEnumerate({ projectRoot: root });
    expect(res.isError).toBeFalsy();
  });

  it('page entries carry draftCriteria that parse against specCriterionSchema', async () => {
    const res = await handleOnboardEnumerate({ projectRoot: root });
    expect(res.isError).toBeFalsy();
    const parsed = jsonBlock(bodyOf(res)) as {
      components: Array<{ path: string; draftCriteria: unknown[]; draftSummary: unknown }>;
    };
    expect(parsed.components.length).toBeGreaterThan(0);
    for (const c of parsed.components) {
      expect(Array.isArray(c.draftCriteria)).toBe(true);
      expect(c.draftCriteria.length).toBeGreaterThan(0);
      for (const crit of c.draftCriteria) {
        // Each deterministic draft must be a valid criterion shape.
        expect(() => specCriterionSchema.parse(crit)).not.toThrow();
      }
      // Tier counts accompany the draft.
      expect(c.draftSummary).toBeDefined();
    }
  });

  it('draftCriteria are identical across two enumerate calls (determinism)', async () => {
    const first = await handleOnboardEnumerate({ projectRoot: root });
    const second = await handleOnboardEnumerate({ projectRoot: root });
    const a = jsonBlock(bodyOf(first)) as {
      components: Array<{ path: string; draftCriteria: unknown[] }>;
    };
    const b = jsonBlock(bodyOf(second)) as {
      components: Array<{ path: string; draftCriteria: unknown[] }>;
    };
    const byPath = (arr: typeof a.components) =>
      Object.fromEntries(arr.map((c) => [c.path, c.draftCriteria]));
    const mapA = byPath(a.components);
    const mapB = byPath(b.components);
    for (const path of Object.keys(mapA)) {
      expect(mapB[path]).toEqual(mapA[path]);
    }
  });
});

describe('handleOnboardEnumerate — baseline is first-write-wins', () => {
  beforeEach(() => seedProject(root));

  it('stamps the baseline once; a second enumerate with changed coverage leaves it untouched', async () => {
    const first = await handleOnboardEnumerate({ projectRoot: root });
    const firstParsed = jsonBlock(bodyOf(first)) as { components: Array<{ path: string }> };
    // Baseline is stamped on the first call.
    const firstBaseline = JSON.parse(readFileSync(statePath(root), 'utf-8')).baseline;
    expect(firstBaseline).toBeDefined();
    const stamped = firstBaseline.totalUncovered;
    // Sanity: the stamped 'before' uncovered matches what enumerate reported.
    const headerLine = bodyOf(first).split('\n')[1]!;
    expect(headerLine).toContain(`${firstParsed.components.length} uncovered`);

    // Change coverage: skip one target so the uncovered count drops by one.
    const aPath = firstParsed.components[0]!.path;
    await handleOnboardProgress({
      projectRoot: root,
      path: aPath,
      status: 'skipped',
      reason: 'not worth a spec',
    });

    const second = await handleOnboardEnumerate({ projectRoot: root });
    const secondParsed = jsonBlock(bodyOf(second)) as { components: Array<{ path: string }> };
    // The second page has one fewer uncovered entry.
    expect(secondParsed.components.length).toBe(firstParsed.components.length - 1);

    // But the baseline is unchanged — first-write-wins.
    const secondBaseline = JSON.parse(readFileSync(statePath(root), 'utf-8')).baseline;
    expect(secondBaseline.totalUncovered).toBe(stamped);
  });
});

describe('handleOnboardReport — before/after, tier counts, full skipped list', () => {
  beforeEach(() => seedProject(root));

  it('renders before→after, per-spec tier counts, and every skipped path + reason', async () => {
    // Stamp the 'before' baseline + get the worklist.
    const enumRes = await handleOnboardEnumerate({ projectRoot: root });
    const list = jsonBlock(bodyOf(enumRes)) as {
      components: Array<{ path: string; name: string; draftCriteria: unknown[] }>;
    };
    const paths = list.components.map((c) => c.path).sort();

    // Mint a real spec for the first target (so the report can read it back
    // and attach per-tier counts).
    const first = list.components[0]!;
    const created = createSpec({
      projectRoot: root,
      prompt: `bulk onboard: ${first.name}`,
      criteria: first.draftCriteria as Spec['criteria'],
      targets: { components: [first.path] },
      probation: { batchId: 'batch-1' },
    });
    await handleOnboardProgress({
      projectRoot: root,
      path: first.path,
      status: 'done',
      specId: created.specId,
    });

    // Skip the remaining targets with distinct reasons — assert the report
    // lists EVERY one, never truncating.
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const c of list.components.slice(1)) {
      const reason = `no spec needed for ${c.name}`;
      skipped.push({ path: c.path, reason });
      await handleOnboardProgress({
        projectRoot: root,
        path: c.path,
        status: 'skipped',
        reason,
      });
    }

    const res = await handleOnboardReport({ projectRoot: root });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);

    // before / after coverage lines are present.
    expect(body).toContain('Coverage:');
    expect(body).toMatch(/before:.*covered/);
    expect(body).toMatch(/after:.*covered/);

    // The created spec's tier counts are surfaced (the deterministic draft
    // always emits at least one hard criterion).
    expect(body).toContain('hard');
    expect(body).toContain(created.specId);

    // EVERY skipped path + reason is listed — no silent caps.
    for (const s of skipped) {
      expect(body).toContain(s.path);
      expect(body).toContain(s.reason);
    }
    // All discovered paths are accounted for somewhere in the report.
    for (const p of paths) expect(body).toContain(p);

    // The verbatim JSON block is the whole report object.
    const report = jsonBlock(body) as {
      before: unknown;
      after: { covered: number; total: number; pct: number };
      created: Array<{ path: string; specId?: string; tierCounts?: unknown }>;
      skipped: Array<{ path: string; reason?: string }>;
      remainingUncovered: number;
    };
    expect(report.after).toBeDefined();
    expect(report.remainingUncovered).toBe(0);
    // Every skipped entry round-trips through the JSON block too.
    const skippedPaths = new Set(report.skipped.map((s) => s.path));
    for (const s of skipped) expect(skippedPaths.has(s.path)).toBe(true);
    // The created entry carries tier counts read from the real spec.
    const createdEntry = report.created.find((c) => c.specId === created.specId);
    expect(createdEntry).toBeDefined();
    expect(createdEntry!.tierCounts).toBeDefined();
  });
});
