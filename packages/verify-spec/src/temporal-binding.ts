/**
 * Temporal binding (B2): did the frozen spec demonstrably PRECEDE the work?
 *
 * Honest, not cryptographic — `git stash` defeats any scheme, so the goal is
 * to make good behavior legible and drift visible (the report footnotes the
 * limit). The classification is INFORMATIONAL ONLY: it is never written into
 * a criterion verdict and never feeds `signedOff`, verdict counts, or exit
 * codes. It is derived on demand from already-persisted inputs (`spec.git` +
 * `RunMeta.git.sha` + `RunMeta.diff`), never stored as a verdict field.
 *
 * `classifyTemporalBinding` is pure (takes git FACTS, testable as a table);
 * `resolveTemporalBinding` shells git best-effort to gather those facts.
 */
import { gitDiffNames, gitIsAncestor, gitMergeBase, isValidityInternalPath } from './git.js';
import type { RunMeta } from './run.js';
import type { SpecGitBinding } from './spec-schema.js';

export type TemporalClassification = 'frozen-before-work' | 'frozen-mid-work' | 'unknown';

export interface TemporalInputs {
  /** Binding stamped at freeze (`spec.git`). Absent ⇒ `unknown`. */
  freeze?: SpecGitBinding;
  /** HEAD sha at verify time (`RunMeta.git?.sha`). Absent ⇒ `unknown`. */
  verifySha?: string;
  /** Files the run's uncommitted diff touched (`RunMeta.diff` paths). */
  runDiffFiles: string[];
  /** Whether `freeze.sha` is an ancestor-or-equal of `verifySha`. */
  freezeIsAncestorOfVerify?: boolean;
  /** Files changed between `freeze.sha..verifySha` (committed work). */
  committedFiles?: string[];
  /**
   * True when `freeze.sha` and `verifySha` share a git merge-base — i.e. the
   * two commits belong to the SAME history lineage even though `freeze.sha` is
   * no longer a literal ancestor (a squash-merge or rebase rewrote the commit).
   * Distinguishes "this run's own work, replayed under new shas" from an
   * unrelated sibling branch, so a `before-work` binding survives the rewrite
   * (B2 #22) instead of decaying to `unknown` forever. Undefined ⇒ not checked
   * (only consulted when strict ancestry is not `true`).
   */
  sharedLineageWithVerify?: boolean;
}

export interface TemporalResult {
  classification: TemporalClassification;
  /** Footnote-ready sentence explaining the classification. */
  reason: string;
  /** `freeze.changedFiles ∩ workFiles` — the evidence a mid-work verdict rests on. */
  overlap: string[];
  /** Short (7-char) display shas for the badge. */
  freezeSha?: string;
  verifySha?: string;
}

function normalizePath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Ordered, conservative decision rules — a mid-work freeze can NEVER be
 * laundered into before-work, and before-work requires AFFIRMATIVE ancestry
 * proof plus a complete (untruncated) no-overlap check. Any doubt ⇒ `unknown`.
 */
export function classifyTemporalBinding(input: TemporalInputs): TemporalResult {
  const { freeze, verifySha } = input;
  // Rule 1: no freeze binding (legacy/non-git spec) or no verify sha. Name the
  // missing side — "and/or" reads as a tool fault when the real cause is a
  // spec frozen before the repo (or the binding feature) existed, and the only
  // honest remedy is a re-freeze (a backfill would launder ordering).
  if (!freeze || !verifySha) {
    const reason = !freeze
      ? !verifySha
        ? 'no git state recorded at freeze or verify'
        : 'no git state was recorded when this spec version was frozen (repo absent or freeze predates ' +
          'temporal binding) — the next version bump + freeze stamps one; it cannot be backfilled'
      : 'no git sha recorded at verify time (repo absent when the run executed)';
    return {
      classification: 'unknown',
      reason,
      overlap: [],
      freezeSha: freeze ? short(freeze.sha) : undefined,
      verifySha: verifySha ? short(verifySha) : undefined,
    };
  }
  const freezeSha = short(freeze.sha);
  const verify7 = short(verifySha);
  // CONSTRAINT: Validity's own `.validity/` writes are excluded from BOTH
  // sides, symmetric with collectGitBinding (see isValidityInternalPath).
  // The canonical workflow commits the spec store, so its files appear as
  // freeze-dirty AND as committed work — overlap on them is the tool
  // observing itself, not evidence the spec trailed the work. Filtering here
  // (not just at collection) keeps bindings stamped before the exclusion
  // existed from misfiring too.
  // Committed work (`freeze.sha..verifySha`) is only a meaningful "work" range
  // when the freeze commit is actually an ANCESTOR of the verified commit (B2
  // #24). On a different branch or rewritten history the `gitDiffNames` output
  // is cross-branch divergence, not this run's work — path-overlapping it into
  // the mid-work check falsely reports `frozen-mid-work`. The run's OWN
  // uncommitted diff (`runDiffFiles`) is always legitimate overlap evidence.
  const committedWork = input.freezeIsAncestorOfVerify === true ? (input.committedFiles ?? []) : [];
  const workFiles = Array.from(
    new Set([...input.runDiffFiles, ...committedWork].map(normalizePath)),
  ).filter((f) => !isValidityInternalPath(f));
  const workSet = new Set(workFiles);
  const overlap = Array.from(new Set(freeze.changedFiles.map(normalizePath)))
    .filter((f) => !isValidityInternalPath(f))
    .filter((f) => workSet.has(f));
  // Rule 2 (STRONGEST, ancestry-independent): a file this run's work changed
  // was already dirty when the spec was frozen ⇒ the spec did not precede it.
  if (overlap.length > 0) {
    const shown = overlap.slice(0, 5).join(', ');
    const more = overlap.length > 5 ? `, +${overlap.length - 5} more` : '';
    return {
      classification: 'frozen-mid-work',
      reason:
        `${overlap.length} file(s) this run changed were already uncommitted when the spec ` +
        `was frozen: ${shown}${more} (path overlap — the spec may not have preceded the work)`,
      overlap,
      freezeSha,
      verifySha: verify7,
    };
  }
  // Rule 3: the freeze-dirty list was truncated — "no overlap" is uncertifiable.
  if (freeze.changedFilesTruncated) {
    return {
      classification: 'unknown',
      reason:
        "spec was frozen on a large uncommitted tree; the dirty-file list was truncated, so 'before work' can't be certified",
      overlap: [],
      freezeSha,
      verifySha: verify7,
    };
  }
  // Rule 4: affirmative ancestry proof (equal shas count) + zero overlap.
  if (input.freezeIsAncestorOfVerify === true) {
    return {
      classification: 'frozen-before-work',
      reason:
        workFiles.length > 0
          ? `spec frozen at ${freezeSha}, an ancestor of the verified commit ${verify7}, ` +
            `with no overlap with the ${workFiles.length} changed file(s)`
          : `spec frozen at ${freezeSha}, an ancestor of the verified commit ${verify7} ` +
            '(no changed files detected this run)',
      overlap: [],
      freezeSha,
      verifySha: verify7,
    };
  }
  // Rule 4b (B2 #22): the freeze commit is NOT a literal ancestor, but the two
  // commits share a merge-base — the same lineage, replayed under new shas by a
  // squash-merge or rebase. Combined with the checks that already passed to
  // reach here — no freeze-time dirty overlap (Rule 2) and an untruncated
  // dirty-file list (Rule 3) — a shared lineage is enough to keep the honest
  // `before-work` reading across the rewrite, rather than letting one rebase
  // decay the spec (and, via the run aggregate, the whole run) to `unknown`
  // forever. Weaker than raw ancestry BY DESIGN: it rests on lineage +
  // unchanged frozen content (this classifies the EXACT verified spec version)
  // rather than a cryptographic commit chain, and the reason says so.
  if (input.sharedLineageWithVerify === true) {
    return {
      classification: 'frozen-before-work',
      reason:
        `spec frozen at ${freezeSha} is no longer a literal ancestor of the verified commit ${verify7} ` +
        '(history rewritten by squash-merge or rebase), but the two share a common merge-base — ' +
        'same lineage, and no freeze-time overlap with the changed files',
      overlap: [],
      freezeSha,
      verifySha: verify7,
    };
  }
  // Rule 5: not an ancestor, no shared lineage (or git couldn't answer) —
  // cannot honestly order.
  return {
    classification: 'unknown',
    reason:
      `spec frozen at ${freezeSha} is not an ancestor of the verified commit ${verify7} ` +
      'and shares no history with it (unrelated branch or rewritten beyond recognition)',
    overlap: [],
    freezeSha,
    verifySha: verify7,
  };
}

/**
 * Gather the git facts for a run (best-effort — failures degrade to `unknown`,
 * never throw) and classify. Keys everything off the STORED verify sha
 * (`meta.git.sha`), not live HEAD, so the answer is stable after HEAD moves.
 */
export function resolveTemporalBinding(args: {
  projectRoot: string;
  /** `spec.git` for the EXACT verified version (see `readSpecVersion`). */
  freeze?: SpecGitBinding;
  meta: Pick<RunMeta, 'git' | 'diff'>;
}): TemporalResult {
  const verifySha = args.meta.git?.sha;
  const runDiffFiles = args.meta.diff.files.map((f) => f.path);
  let freezeIsAncestorOfVerify: boolean | undefined;
  let committedFiles: string[] | undefined;
  let sharedLineageWithVerify: boolean | undefined;
  if (args.freeze && verifySha) {
    freezeIsAncestorOfVerify = gitIsAncestor(args.projectRoot, args.freeze.sha, verifySha);
    committedFiles = gitDiffNames(args.projectRoot, args.freeze.sha, verifySha);
    // Only worth a merge-base probe when strict ancestry did NOT hold — that's
    // the squash/rebase case (B2 #22). A present merge-base ⇒ same lineage.
    if (freezeIsAncestorOfVerify !== true) {
      sharedLineageWithVerify =
        gitMergeBase(args.projectRoot, args.freeze.sha, verifySha) !== undefined;
    }
  }
  return classifyTemporalBinding({
    freeze: args.freeze,
    verifySha,
    runDiffFiles,
    freezeIsAncestorOfVerify,
    committedFiles,
    sharedLineageWithVerify,
  });
}

/**
 * Roll per-spec classifications into one at-a-glance value (`verify --all`
 * header): mid-work if ANY spec is mid-work (a concrete adverse finding);
 * else the known classification when some specs are unknown (`partial: true`);
 * else before-work. Only all-unknown (or empty) collapses to `unknown`.
 */
export interface TemporalAggregate {
  classification: TemporalClassification;
  /** Some specs are unknown while others have a known classification. */
  partial?: true;
  unknownSpecs?: string[];
}

export type TemporalAggregateInput =
  | TemporalClassification
  | { specId?: string; classification: TemporalClassification };

export function aggregateTemporalClassifications(
  classifications: TemporalAggregateInput[],
): TemporalAggregate {
  if (classifications.length === 0) return { classification: 'unknown' };
  const entries = classifications.map((c) => (typeof c === 'string' ? { classification: c } : c));
  const unknown = entries.filter((e) => e.classification === 'unknown');
  const unknownSpecs = unknown
    .map((e) => e.specId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const hasMid = entries.some((e) => e.classification === 'frozen-mid-work');
  const hasBefore = entries.some((e) => e.classification === 'frozen-before-work');
  const hasUnknown = unknown.length > 0;
  const partialFields = hasUnknown
    ? { partial: true as const, ...(unknownSpecs.length > 0 ? { unknownSpecs } : {}) }
    : {};
  if (hasMid) {
    return hasUnknown
      ? { classification: 'frozen-mid-work', ...partialFields }
      : { classification: 'frozen-mid-work' };
  }
  if (hasBefore && hasUnknown) {
    return { classification: 'frozen-before-work', ...partialFields };
  }
  if (hasBefore) return { classification: 'frozen-before-work' };
  return { classification: 'unknown' };
}
