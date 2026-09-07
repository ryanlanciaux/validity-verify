/**
 * Drift guard: the committed public JSON Schema (`schema/validity-spec.schema.json`)
 * must match a fresh regeneration from `spec-schema.ts`.
 *
 * The schema is a derived
 * artifact a contributor could forget to regenerate after editing
 * `spec-schema.ts` or bumping `SCORING_CONTRACT_VERSION`. This turns that into
 * a red CI build with an actionable message instead of a published schema
 * that silently disagrees with the runtime validator.
 *
 * Content is compared as PARSED JSON (not raw bytes) so the test doesn't have
 * to reproduce prettier's formatting decisions — `generate:schema` already
 * runs the output through prettier, and `pnpm format:check` guards formatting
 * repo-wide. This test guards CONTENT only: did someone forget to regenerate?
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSpecJsonSchema, SCHEMA_OUTPUT_PATH } from './generate-schema.js';
import { SCORING_CONTRACT_VERSION } from './specs.js';

describe('validity-spec.schema.json is generated from spec-schema.ts', () => {
  it('the committed schema matches a fresh regeneration', () => {
    expect(
      existsSync(SCHEMA_OUTPUT_PATH),
      `${SCHEMA_OUTPUT_PATH} is missing — run \`pnpm -F @validity.ai/verify-spec generate:schema\` and commit the result.`,
    ).toBe(true);
    const committed: unknown = JSON.parse(readFileSync(SCHEMA_OUTPUT_PATH, 'utf8'));
    const fresh = buildSpecJsonSchema();
    expect(
      committed,
      'schema/validity-spec.schema.json is out of date with spec-schema.ts — run ' +
        '`pnpm -F @validity.ai/verify-spec generate:schema` and commit the result.',
    ).toEqual(fresh);
  });

  it('is versioned by SCORING_CONTRACT_VERSION in both $id and version', () => {
    const schema = buildSpecJsonSchema();
    expect(schema.version).toBe(SCORING_CONTRACT_VERSION);
    expect(schema.$id).toBe(`https://validity.ai/schema/spec/${SCORING_CONTRACT_VERSION}.json`);
  });
});
