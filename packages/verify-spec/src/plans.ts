/**
 * Plan persistence — acceptance criteria captured BEFORE the agent does
 * work, so that build-time and verify-time score against the same
 * contract. Written by `validity__plan`, read by `validity__verify` and
 * `validity__submit_report`.
 *
 * Plans live at `.validity/plans/<planId>.json`. Pure JSON — no LLM
 * lives here, just schema validation + on-disk storage. The agent
 * supplies the criteria (extracted from the user prompt); this module
 * locks them in.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcceptanceCriterion, ValidityPlan } from './types.js';
import { validityDir } from './runs.js';
import { hash, writeFileAtomic } from './util.js';
import { stableStringify, SCORING_CONTRACT_VERSION } from './specs.js';

export function plansDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'plans');
}

export function planPathFor(projectRoot: string, planId: string): string {
  return resolve(plansDir(projectRoot), `${planId}.json`);
}

/**
 * Validate the shape of a criterion supplied by the agent. Throws a
 * `PlanValidationError` with a clear message on the first failure so
 * the agent gets actionable feedback in its tool result, not a vague
 * "invalid input" wall.
 */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

const VALID_OBSERVABLES = new Set(['visual', 'behavioral', 'console', 'a11y', 'network']);

export function validateCriterion(c: unknown, index: number): AcceptanceCriterion {
  if (!c || typeof c !== 'object') {
    throw new PlanValidationError(`criteria[${index}] must be an object with { id, description }.`);
  }
  const obj = c as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
    throw new PlanValidationError(`criteria[${index}].id must be a non-empty string.`);
  }
  if (typeof obj.description !== 'string' || obj.description.trim().length === 0) {
    throw new PlanValidationError(`criteria[${index}].description must be a non-empty string.`);
  }
  let observable: AcceptanceCriterion['observable'];
  if (obj.observable !== undefined) {
    if (typeof obj.observable !== 'string' || !VALID_OBSERVABLES.has(obj.observable)) {
      throw new PlanValidationError(
        `criteria[${index}].observable must be one of: ${Array.from(VALID_OBSERVABLES).join(', ')}.`,
      );
    }
    observable = obj.observable as AcceptanceCriterion['observable'];
  }
  return { id: obj.id.trim(), description: obj.description.trim(), observable };
}

export function validateCriteria(input: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(input)) {
    throw new PlanValidationError('criteria must be an array.');
  }
  if (input.length === 0) {
    throw new PlanValidationError(
      'criteria cannot be empty — extract at least one acceptance criterion from the prompt.',
    );
  }
  const seen = new Set<string>();
  const out: AcceptanceCriterion[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = validateCriterion(input[i], i);
    if (seen.has(c.id)) {
      throw new PlanValidationError(
        `criteria[${i}].id "${c.id}" is duplicated — ids must be unique within a plan.`,
      );
    }
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * Canonical content hash for a plan. Omits the volatile `contentHash` field
 * (a hash can't cover itself) and mixes in the scoring-contract version, then
 * runs the SAME deep key-sort serializer specs use (`stableStringify`) so the
 * hash reflects every nested criterion field. This is a TAMPER/DRIFT signal
 * only — plans are not the sign-off contract (a frozen spec is); see the
 * `ValidityPlan` doc note.
 */
export function computePlanHash(plan: ValidityPlan): string {
  const { contentHash: _contentHash, ...content } = plan; // omit the volatile hash field
  return `sha256-${hash(stableStringify({ ...content, scoringContract: SCORING_CONTRACT_VERSION }))}`;
}

/**
 * True when the plan carries a `contentHash` that matches its current content —
 * i.e. it hasn't been edited on disk since `writePlan` stamped it. A plan
 * written before this field existed (no `contentHash`) returns false: we can't
 * assert integrity we never recorded.
 */
export function planHashMatches(plan: ValidityPlan): boolean {
  return plan.contentHash != null && plan.contentHash === computePlanHash(plan);
}

export interface WritePlanArgs {
  projectRoot: string;
  planId: string;
  prompt: string;
  criteria: AcceptanceCriterion[];
  componentPath?: string;
  url?: string;
  createdAt?: string;
}

export function writePlan(args: WritePlanArgs): { planPath: string; plan: ValidityPlan } {
  const dir = plansDir(args.projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const plan: ValidityPlan = {
    planId: args.planId,
    createdAt: args.createdAt ?? new Date().toISOString(),
    prompt: args.prompt,
    componentPath: args.componentPath,
    url: args.url,
    criteria: args.criteria,
  };
  // Stamp the drift-detection hash over the final content BEFORE serializing so
  // a later `planHashMatches` can tell whether the file was edited by hand.
  plan.contentHash = computePlanHash(plan);
  const planPath = planPathFor(args.projectRoot, args.planId);
  writeFileAtomic(planPath, JSON.stringify(plan, null, 2));
  return { planPath, plan };
}

/**
 * Load a plan by id. Returns null when not found — callers branch on
 * the missing case (typically: "the planId you passed doesn't exist;
 * call validity__plan first").
 */
export function readPlan(projectRoot: string, planId: string): ValidityPlan | null {
  const path = planPathFor(projectRoot, planId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ValidityPlan;
  } catch {
    return null;
  }
}
