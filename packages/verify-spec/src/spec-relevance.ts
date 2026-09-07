/**
 * Relevance-scoped change detection (W3 #10) — the SINGLE implementation of
 * "which frozen specs did these changed files touch?".
 *
 * `validity watch` has always answered this properly (global-style detection →
 * reverse-import ripple → basename/path mapping); the MCP verify fold answered
 * it not at all, and fell back to the reducer's coarse HEAD-sha comparison, so
 * one unrelated commit staled every spec's soft scores. Both now call
 * {@link specsAffectedByChangedFiles}; the fold additionally calls
 * {@link codeChangedForSpec}, which wraps it with the git range read.
 *
 * Pure-ish: the mapping itself is pure given `changedFiles`; the graph build
 * and the git reads are IO and are confined to the two impure helpers here.
 * Every failure mode degrades to `undefined` ("unknown"), never to `false` —
 * a wrong `false` would silently keep a stale soft score reading as fresh.
 */
import { gitChangedFilesSince, gitWorkingTreeChanges } from './git.js';
import {
  buildReverseImportGraph,
  expandChangedFiles,
  type ImportScanCache,
} from './import-graph.js';
import type { ScorecardSpec } from './scorecard.js';
import type { Spec } from './spec-schema.js';
import { mapChangedFilesToSpecs } from './specs.js';

/**
 * Files whose edit invalidates EVERY screen but maps to no single component —
 * build config and root stylesheets. They carry no import edges to the
 * components they restyle, so the ripple graph can't find them.
 */
const GLOBAL_STYLE_PATTERNS: RegExp[] = [
  /(^|\/)tailwind\.config\.[cm]?[jt]s$/,
  /(^|\/)postcss\.config\.[cm]?[jt]s$/,
  /(^|\/)unocss\.config\.[cm]?[jt]s$/,
  /(^|\/)(index|global|globals|app|main|styles?|theme|tokens|base|reset|tailwind)\.(css|scss|sass|less|styl|pcss)$/,
];

export function changesGlobalStyles(changedFiles: string[]): boolean {
  return changedFiles.some((f) => {
    const norm = f.replace(/\\/g, '/');
    return GLOBAL_STYLE_PATTERNS.some((re) => re.test(norm));
  });
}

export interface AffectedSpecsResult {
  /** Specs whose declared targets intersect the (ripple-expanded) change set. */
  matched: Spec[];
  /** Specs that declare no targets — nothing to intersect, so relevance is UNKNOWN. */
  unmapped: Spec[];
  /** A global style/build-config file changed: every candidate spec matched. */
  globalStyleChange: boolean;
  /** The ripple expansion hit its cap — distant importers may be missing. */
  truncated: boolean;
  /** Number of files the (possibly truncated) expansion produced. */
  expandedFileCount: number;
}

/**
 * Map a changed-file set onto the specs it affects — global-style detection,
 * then upward ripple expansion through the reverse import graph, then the
 * target-path/basename intersection. Callers own the reporting (watch prints
 * the truncation/global-change notices); this returns the facts.
 *
 * Best-effort by construction: an unbuildable import graph degrades to
 * basename-only mapping rather than failing the caller.
 */
export function specsAffectedByChangedFiles(args: {
  projectRoot: string;
  specs: Spec[];
  changedFiles: string[];
  cache?: ImportScanCache;
}): AffectedSpecsResult {
  const { projectRoot, specs, changedFiles } = args;
  if (specs.length === 0 || changedFiles.length === 0) {
    return {
      matched: [],
      unmapped: [],
      globalStyleChange: false,
      truncated: false,
      expandedFileCount: changedFiles.length,
    };
  }
  if (changesGlobalStyles(changedFiles)) {
    return {
      matched: specs,
      unmapped: [],
      globalStyleChange: true,
      truncated: false,
      expandedFileCount: changedFiles.length,
    };
  }
  // Ripple expansion (design pillar 2): grow the changed set upward through
  // "who imports this?" edges before the basename mapping, so editing a shared
  // Button.tsx re-verifies the spec targeting the LoginScreen that uses it.
  let mappable = changedFiles;
  let truncated = false;
  try {
    const graph = buildReverseImportGraph({ projectRoot, cache: args.cache });
    const expanded = expandChangedFiles(graph, changedFiles);
    truncated = expanded.truncated;
    mappable = expanded.files;
  } catch {
    // Graph is an enhancement, never a gate.
  }
  const { matched, unmapped } = mapChangedFilesToSpecs({ specs, changedFiles: mappable });
  return {
    matched,
    unmapped,
    globalStyleChange: false,
    truncated,
    expandedFileCount: mappable.length,
  };
}

/**
 * The sha the scorecard entry's soft scores were last observed at — the anchor
 * the fold's change range starts from. Prefers a SOFT criterion's sha (soft
 * rows are what staleness protects, and `applySoftScores` stamps them at score
 * time); falls back to any criterion's sha for entries with no soft tier.
 * `undefined` when the entry predates sha stamping.
 */
export function lastObservedSha(entry: ScorecardSpec | undefined): string | undefined {
  if (!entry) return undefined;
  const criteria = Object.values(entry.criteria ?? {});
  return criteria.find((c) => c.tier === 'soft' && c.sha)?.sha ?? criteria.find((c) => c.sha)?.sha;
}

/**
 * Did code RELEVANT TO THIS SPEC change since its scorecard entry was last
 * observed? This is `SpecObservation.codeChanged` for the one-off verify fold —
 * the same question `validity watch` answers from its scoped-tick subset.
 *
 * Returns `undefined` — never `false` — whenever the answer is unknown:
 *   - no prior sha on the entry (a first fold has nothing to diff from);
 *   - git can't resolve the range (no git, GC'd sha, shallow clone);
 *   - the spec declares no target components (nothing to intersect).
 * The reducer then falls back to its coarse HEAD-sha comparison, which is the
 * pre-existing (conservative, over-staling) behavior. Never-a-false-green:
 * uncertainty must not manufacture a "still fresh" soft score.
 */
export function codeChangedForSpec(args: {
  projectRoot: string;
  spec: Spec;
  sinceSha?: string;
  cache?: ImportScanCache;
}): boolean | undefined {
  const { projectRoot, spec, sinceSha } = args;
  if (!sinceSha) return undefined;
  const committed = gitChangedFilesSince(projectRoot, sinceSha);
  // `null` = unknown range (unresolvable sha / no git). Working-tree edits
  // alone can't answer "since that commit", so stay silent.
  if (committed === null) return undefined;
  const changed = Array.from(new Set([...committed, ...gitWorkingTreeChanges(projectRoot)]));
  if (changed.length === 0) return false;
  const result = specsAffectedByChangedFiles({
    projectRoot,
    specs: [spec],
    changedFiles: changed,
    cache: args.cache,
  });
  // A spec with no declared targets lands in `unmapped`: we cannot prove the
  // change is irrelevant, so we say nothing rather than `false`.
  if (result.unmapped.length > 0) return undefined;
  return result.matched.length > 0;
}
