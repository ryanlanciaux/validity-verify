/**
 * Generates the versioned, public JSON Schema for the durable spec format —
 * `.validity/specs/<id>/spec.yaml`, the file users freeze and commit — from
 * `spec-schema.ts`. The zod schemas in that module ARE the source of truth;
 * this derives JSON Schema from them MECHANICALLY (via `zod-to-json-schema`)
 * so the published schema can never hand-drift from the runtime validator.
 *
 * Versioned by `SCORING_CONTRACT_VERSION` — the same axis `computeSpecHash`
 * folds into the frozen content hash (see specs.ts). Bumping the contract
 * changes both the hash of every newly-frozen spec AND this schema's `$id`/
 * `version`, so a consuming tool can tell at a glance which contract a spec
 * (or this schema file) was produced under.
 *
 * Run via `pnpm -F @validity.ai/verify-spec generate:schema`. `schema-drift.test.ts`
 * regenerates in-memory and byte-compares against the committed file in
 * `schema/`, so CI fails loudly if `spec-schema.ts` changes without a
 * matching regeneration.
 *
 * JSON Schema CAVEAT: structural validators can't express every zod
 * `.refine()` cross-field invariant in the source (e.g. "a selector needs at
 * least one of role/name/text/label/placeholder/testId", "an expect has
 * exactly one assertion family", "hard-tier criteria require a non-empty
 * checks block"). Those rules are enforced at runtime by `parseSpec()` and
 * documented next to `parseSpec()` — this schema is necessary but not
 * sufficient for full spec validity.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { specSchema } from './spec-schema.js';
import { SCORING_CONTRACT_VERSION } from './specs.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Committed output path for the generated, versioned schema file. */
export const SCHEMA_OUTPUT_PATH = resolve(here, '../schema/validity-spec.schema.json');

/**
 * Build the JSON Schema document, pure (no I/O) so both the CLI entry point
 * and the drift test can call it directly. `zodToJsonSchema` derives the
 * shape from `specSchema`; the wrapping metadata ($id/title/description/
 * version) is the only hand-authored part, and it is small and stable on
 * purpose — it should change only when `SCORING_CONTRACT_VERSION` bumps.
 */
export function buildSpecJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(specSchema, {
    name: 'ValiditySpec',
    target: 'jsonSchema7',
    errorMessages: true,
  }) as Record<string, unknown>;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://validity.ai/schema/spec/${SCORING_CONTRACT_VERSION}.json`,
    title: 'Validity spec',
    description:
      'A Validity spec: the durable, versioned acceptance-criteria record frozen to ' +
      '.validity/specs/<id>/spec.yaml. Mechanically generated from ' +
      'packages/verify-spec/src/spec-schema.ts — do not hand-edit. Cross-field rules ' +
      'this schema cannot express (JSON Schema has no zod-refine equivalent) are enforced ' +
      'at runtime by parseSpec(), along with the freeze/content-hash contract.',
    version: SCORING_CONTRACT_VERSION,
    ...generated,
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(import.meta.url) === resolve(entry as string);
}

if (isMain()) {
  const path = SCHEMA_OUTPUT_PATH;
  writeFileSync(path, serialize(buildSpecJsonSchema()));
  process.stdout.write(`wrote ${path}\n`);
}
