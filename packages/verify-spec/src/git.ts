/**
 * Git metadata helper for stamping `run-meta.json`.
 *
 * Best-effort: in a non-git project (or with the `git` binary missing), all
 * functions return `undefined` and the caller omits the field from run-meta.
 * Never throws — a verify must succeed in a tarball / unzipped folder too.
 */
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { SpecGitBinding } from './spec-schema.js';

export interface GitInfo {
  sha: string;
  branch?: string;
  dirty: boolean;
}

function safeExec(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Like {@link safeExec} but UNTRIMMED — porcelain statuses like ` M path`
 *  start with a significant space that `.trim()` would eat off entry #1. */
function safeExecRaw(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/**
 * Read git HEAD info for the project at `projectRoot`. Returns `undefined`
 * when:
 *   - the directory isn't a git repo,
 *   - `git` isn't installed,
 *   - HEAD can't be resolved (fresh repo with zero commits, etc.).
 *
 * `dirty` reflects whether `git status --porcelain` returns any output —
 * untracked + modified + staged all count. This is the same semantics
 * `validity verify` uses when promoting screenshots to baselines.
 */
export function collectGitInfo(projectRoot: string): GitInfo | undefined {
  const sha = safeExec(['rev-parse', 'HEAD'], projectRoot);
  if (!sha) return undefined;

  const branchRaw = safeExec(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
  // Detached HEAD → branchRaw === 'HEAD'. Surface as undefined instead so the
  // report doesn't render a misleading "branch: HEAD" line.
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : undefined;

  const status = safeExec(['status', '--porcelain'], projectRoot);
  // status === undefined when the command failed; treat as clean since we
  // can't tell. status === '' when working tree is clean. Anything else = dirty.
  const dirty = typeof status === 'string' ? status.length > 0 : false;

  return { sha, branch, dirty };
}

/* ------------------------------------------------------------------ *
 * Spec freeze binding + temporal-binding helpers (B2).                *
 * ------------------------------------------------------------------ */

/** Cap on `SpecGitBinding.changedFiles` so a freeze on a huge uncommitted
 *  tree can't bloat the spec YAML. Over the cap ⇒ `changedFilesTruncated`,
 *  which the temporal classifier downgrades to `unknown` (never before-work). */
const CHANGED_FILES_CAP = 500;

/** Strip a leading `./` so freeze-time and verify-time paths compare equal. */
function normalizeRepoPath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

/**
 * True for paths inside Validity's own footprint (`.validity/`).
 *
 * CONSTRAINT: this exclusion must be applied SYMMETRICALLY to every
 * temporal-binding input — the freeze-time dirty set here in
 * {@link collectGitBinding} AND the verify-time work set in
 * `classifyTemporalBinding`. The canonical workflow writes `.validity/`
 * itself (spec_create/spec_update land spec.yaml moments before freezeSpec
 * collects the binding, and specs are committed by default), so without the
 * filter every honest plan→freeze→work→verify run overlaps on the spec
 * store's own files and reads 'frozen-mid-work'. Filtering only one side is
 * equally dishonest: bindings stamped BEFORE this exclusion existed still
 * carry `.validity/` paths, and comparing them against an unfiltered work
 * set (or vice versa) revives the false overlap. Mirrors the
 * `:(exclude).validity` pathspec in diff.ts.
 */
export function isValidityInternalPath(p: string): boolean {
  const n = normalizeRepoPath(p);
  return n === '.validity' || n.startsWith('.validity/');
}

/**
 * Parse `git status --porcelain -z` output into the dirty/untracked path set.
 * `-z` is NUL-delimited (quoting-safe): each entry is `XY <path>`, and a
 * rename/copy (`R`/`C` status) emits the OLD path as the NEXT bare token —
 * both sides are recorded (either could overlap with later work).
 */
function parsePorcelainZ(raw: string): string[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const files: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i]!;
    files.push(entry.slice(3));
    const status = entry.slice(0, 2);
    if ((status[0] === 'R' || status[0] === 'C') && i + 1 < tokens.length) {
      files.push(tokens[i + 1]!);
      i += 1;
    }
    i += 1;
  }
  return files;
}

/**
 * Freeze-time git snapshot for a spec: HEAD sha + the dirty/untracked path set
 * (capped at {@link CHANGED_FILES_CAP}). Returns `undefined` in a non-git dir /
 * fresh repo with zero commits — the caller then omits the `git` field, so the
 * temporal classifier honestly reads `unknown`.
 */
export function collectGitBinding(projectRoot: string): SpecGitBinding | undefined {
  const sha = safeExec(['rev-parse', 'HEAD'], projectRoot);
  if (!sha) return undefined;
  // UNTRIMMED read: the first entry's `XY` status can start with a space
  // (` M path`) that a trim would eat, shifting the path slice by one.
  const raw = safeExecRaw(['status', '--porcelain', '-z'], projectRoot);
  // Validity's own `.validity/` writes are workflow noise, not user work —
  // see {@link isValidityInternalPath} for why the filter must be symmetric.
  const files = (raw === undefined || raw === '' ? [] : parsePorcelainZ(raw)).filter(
    (f) => !isValidityInternalPath(f),
  );
  const truncated = files.length > CHANGED_FILES_CAP;
  return {
    sha,
    dirty: files.length > 0,
    changedFiles: (truncated ? files.slice(0, CHANGED_FILES_CAP) : files).map(normalizeRepoPath),
    ...(truncated ? { changedFilesTruncated: true } : {}),
  };
}

/**
 * True iff `ancestor` is an ancestor-or-equal of `descendant`
 * (`git merge-base --is-ancestor`). Three-valued on purpose: `false` is a
 * clean exit-1 (provably NOT an ancestor — diverged/different branch), while
 * `undefined` means git couldn't answer (non-git dir, GC'd sha) and the
 * classifier must not treat that as evidence either way.
 */
export function gitIsAncestor(
  projectRoot: string,
  ancestor: string,
  descendant: string,
): boolean | undefined {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (err) {
    return (err as { status?: number | null }).status === 1 ? false : undefined;
  }
}

/**
 * True iff `absPath` is tracked in git (`git ls-files --error-unmatch` exits 0).
 * Best-effort — a non-git dir, missing git, or an untracked/ignored path all
 * read `false`. Used to tell whether a frozen spec's `spec.yaml` is part of the
 * committed contract CI will actually see (W6 #23): an untracked frozen spec is
 * invisible to a fresh CI checkout, so its criteria never enter the CI score.
 */
export function gitTracksPath(projectRoot: string, absPath: string): boolean {
  const rel = relative(projectRoot, absPath);
  // A path outside the repo can never be tracked by THIS repo.
  if (rel.startsWith('..') || rel.length === 0) return false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The best common ancestor of two commits (`git merge-base A B`). Returns the
 * merge-base sha, or `undefined` when the two commits share NO history (truly
 * unrelated roots) or git can't answer (non-git dir, GC'd sha). Used by the
 * temporal classifier to recognize a squash-merge/rebase (B2 #22): after
 * history is rewritten the frozen `sha` is no longer a literal ancestor of the
 * verified commit, but a shared merge-base proves the two are the SAME lineage
 * (not an unrelated sibling branch), which — together with an unchanged frozen
 * content hash — lets a `before-work` binding survive the rewrite instead of
 * decaying to `unknown` forever.
 */
export function gitMergeBase(projectRoot: string, a: string, b: string): string | undefined {
  const out = safeExec(['merge-base', a, b], projectRoot);
  return out && out.length > 0 ? out : undefined;
}

/** Repo-relative names changed between two commits
 *  (`git diff --name-only -z A B`). `-z` (NUL-delimited, quoting-disabled)
 *  keeps the output byte-identical to {@link collectGitBinding}'s raw
 *  porcelain paths — without it, `core.quotePath` C-quotes non-ASCII names
 *  (`"caf\303\251.tsx"`) and the overlap check in `classifyTemporalBinding`
 *  silently misses them. Best-effort: `[]` on any git failure. */
export function gitDiffNames(projectRoot: string, a: string, b: string): string[] {
  const raw = safeExecRaw(['diff', '--name-only', '-z', a, b], projectRoot);
  if (!raw) return [];
  return raw.split('\0').filter((l) => l.length > 0);
}

/** Current HEAD sha, or `undefined` (non-git dir, git missing, zero commits). */
export function gitHeadSha(projectRoot: string): string | undefined {
  return safeExec(['rev-parse', 'HEAD'], projectRoot);
}

/**
 * Files changed between a previously observed commit and the current HEAD —
 * the watcher's catch-up diff (signals-system-design.md, pillar 1).
 *
 * Returns `null` — meaning "unknown, do a full tick" — when `fromSha` no
 * longer resolves to a commit (GC'd after a rebase/force-push, clone without
 * that history) or git can't answer at all. `null` is deliberately distinct
 * from `[]` (a resolvable range with no changes): a caller that treated
 * "unknown" as "no changes" would silently skip drift.
 */
export function gitChangedFilesSince(projectRoot: string, fromSha: string): string[] | null {
  const resolved = safeExec(
    ['rev-parse', '--verify', '--quiet', `${fromSha}^{commit}`],
    projectRoot,
  );
  if (!resolved) return null;
  const head = gitHeadSha(projectRoot);
  if (!head) return null;
  if (head === resolved) return [];
  const raw = safeExecRaw(['diff', '--name-only', '-z', resolved, head], projectRoot);
  if (raw === undefined) return null;
  return raw.split('\0').filter((l) => l.length > 0);
}

/**
 * Uncommitted work: tracked modifications (`git diff --name-only HEAD`) plus
 * untracked, non-ignored files. Project-relative paths, deduped. `[]` on any
 * git failure — same best-effort posture as everything else in this module.
 *
 * The CLI has had this for `verify --all` since day one; it lives here so the
 * relevance mapping (`spec-relevance.ts`) can pair it with
 * {@link gitChangedFilesSince}: "committed since sha" plus "not committed yet"
 * is the full set of edits a soft score may have gone stale against.
 */
export function gitWorkingTreeChanges(projectRoot: string): string[] {
  const hasHead = safeExec(['rev-parse', '--verify', 'HEAD'], projectRoot) !== undefined;
  const tracked = safeExecRaw(
    hasHead ? ['diff', '--name-only', '-z', 'HEAD'] : ['ls-files', '--cached', '-z'],
    projectRoot,
  );
  const untracked = safeExecRaw(['ls-files', '--others', '--exclude-standard', '-z'], projectRoot);
  const split = (raw: string | undefined): string[] =>
    raw ? raw.split('\0').filter((l) => l.length > 0) : [];
  return Array.from(new Set([...split(tracked), ...split(untracked)]));
}

/**
 * Count of commits on `HEAD` that landed AFTER `fromSha` (`git rev-list --count
 * <fromSha>..HEAD`). The dashboard's watcher-status view surfaces this as "your
 * tracked commit is N behind HEAD" — distinct from the watcher's catch-up
 * range, which is path-scoped, but the count is the simplest "how stale?" signal.
 *
 * Returns `null` — meaning "unknown", never 0 — on ANY failure (git absent,
 * non-repo, unresolvable/GC'd `fromSha`). Mirrors {@link gitChangedFilesSince}'s
 * exec options and try/catch posture exactly: a missing git answer is NOT 0.
 */
export function gitCommitsBehind(projectRoot: string, fromSha: string): number | null {
  try {
    const count = execFileSync('git', ['rev-list', '--count', `${fromSha}..HEAD`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number(count);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
