import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function validityDir(projectRoot: string): string {
  return resolve(projectRoot, '.validity');
}

export function runsDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'runs');
}

export function tasksDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'tasks');
}

/**
 * Durable viewer output (`trends.html`, `compare-*.html`) — a SIBLING of
 * `runs/`, not a child (W5 #19). These are regenerable HTML views a human
 * opens; keeping them out of the prunable `runs/` tree means `validity clean`
 * can never sweep a report the user just generated, and their lifetime is
 * decoupled from run-directory retention. Machine-local + regenerable, so it's
 * gitignored alongside `runs/`.
 */
export function reportsDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'reports');
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Drop a `.gitignore` inside `.validity/` that excludes ephemeral subdirs
 * (runs/ + baselines/) so config.ts + wrapper.tsx stay trackable by default.
 * Users who don't want to track Validity at all can add `.validity/` to their
 * project root .gitignore.
 *
 * Baselines are gitignored because PNG bytes are noisy in code review and
 * the deterministic baseline is a developer-machine concern. Users who DO
 * want shared baselines can remove the line from this .gitignore manually
 * (we don't fight them about it).
 */
const SIGNAL_HISTORY_IGNORE = 'history/signals.jsonl';

/**
 * Cheap-read `.validity/config.ts` for `historyCommitted` without loading the
 * TS module (this package must not import `@validity.ai/verify-spec`). `undefined`
 * means the file is absent / unreadable — callers then leave the feed
 * gitignore line untouched.
 */
export function readHistoryCommittedFromConfig(projectRoot: string): boolean | undefined {
  try {
    const p = resolve(validityDir(projectRoot), 'config.ts');
    if (!existsSync(p)) return undefined;
    const src = readFileSync(p, 'utf-8');
    if (/\bhistoryCommitted\s*:\s*true\b/.test(src)) return true;
    if (/\bhistoryCommitted\s*:\s*false\b/.test(src)) return false;
    return false;
  } catch {
    return undefined;
  }
}

function historyCommittedOpts(projectRoot: string): { historyCommitted: boolean } | undefined {
  const v = readHistoryCommittedFromConfig(projectRoot);
  return v === undefined ? undefined : { historyCommitted: v };
}

export function ensureValidityGitignore(
  projectRoot: string,
  opts?: { historyCommitted?: boolean },
): void {
  const dir = validityDir(projectRoot);
  ensureDir(dir);
  const gi = resolve(dir, '.gitignore');
  // The per-spec run index (specs/<id>/runs.jsonl) is the regression TIMELINE —
  // per-machine run history (runIds + timestamps), like a test-run log. The
  // committed source of truth is each spec.yaml + its history/ frozen versions;
  // the timeline is ignored by default to avoid per-machine noise + merge
  // conflicts. Teams who want shared history can remove the line.
  // `/native-app/` is the RN companion build (ios/Pods alone is ~1GB) — it lands
  // inside a directory users are told to commit, so it MUST be ignored (W5 #15).
  // The existing-file branch below retrofits it into already-created projects.
  // `/plans/` is the LEGACY plan store (superseded by specs/); gitignore it so
  // orphaned plan files from an older Validity don't get committed (W2 #8). The
  // doctor/onboard one-shot migration of any existing plans is a follow-up.
  // `scorecard.json` + `signals.json` are DERIVED per-machine state (W6 #21):
  // they're rebuilt from the committed specs (deterministic criteria) and, when
  // `historyCommitted` is on, from `history/`. Committing them caused guaranteed
  // merge conflicts (rewritten wholesale every watch tick) and let a conflict
  // resolution silently discard soft scores. Ignoring them makes the committed
  // source of truth the specs, and keeps soft (screenshot-scored) results a
  // local concern unless the team opts into `historyCommitted`. `doctor`
  // untracks any copy an older Validity already committed.
  // `/reports/` holds the regenerable HTML viewers (trends.html, compare-*.html)
  // — machine-local output, moved out of the prunable runs/ tree (W5 #19).
  // `watch-state.json` is the watcher's per-machine high-water mark (last
  // observed commit) — same derived-state posture as scorecard/signals.
  // `/inflight/` holds the ephemeral in-progress verify markers (one JSON per
  // running verify, removed in a finally on exit) — pure per-machine liveness
  // for local liveness, never source of truth. Same ignore posture as runs/.
  // `/dashboard/` holds a per-machine static snapshot if one is written.
  const ignoreLines = [
    '/runs/',
    '/reports/',
    '/baselines/',
    '/native-app/',
    '/plans/',
    '/inflight/',
    '/dashboard/',
    'specs/*/runs.jsonl',
    'scorecard.json',
    'signals.json',
    'watch-state.json',
  ];
  // The signal-transition feed is ALWAYS written locally so the open-set is
  // rebuildable. historyCommitted only decides whether that file is meant to
  // be committed. Manage the gitignore line ONLY when the caller passed opts
  // (watch / a config-aware ensure). A no-opts call must not re-add a line
  // the last opted-in write stripped — otherwise .gitignore flip-flops every
  // MCP verify ↔ watch tick.
  const manageFeed = opts !== undefined;
  const historyCommitted = opts?.historyCommitted === true;
  if (!manageFeed || !historyCommitted) ignoreLines.push(SIGNAL_HISTORY_IGNORE);
  if (!existsSync(gi)) {
    writeFileSync(
      gi,
      [
        '# Validity ephemeral + derived artifacts — do not commit.',
        '# config.ts, wrapper.tsx, and specs/*/spec.yaml are tracked by default.',
        '# scorecard.json + signals.json are derived per-machine state (rebuilt',
        '# from specs/ and, when historyCommitted is on, history/).',
        '# history/signals.jsonl is local unless historyCommitted is true.',
        '# To opt out entirely, add `.validity/` to your project root .gitignore.',
        ...ignoreLines,
        '',
      ].join('\n'),
    );
  } else {
    // Existing .gitignore — additively ensure each line is present. Read +
    // check rather than re-write to avoid clobbering user edits. The signal
    // feed line is the exception: only touched when opts was passed.
    let current = readFileSync(gi, 'utf-8');
    if (manageFeed && historyCommitted) {
      const stripped = current
        .split('\n')
        .filter((l) => l.trim() !== SIGNAL_HISTORY_IGNORE)
        .join('\n');
      if (stripped !== current) {
        current = stripped.endsWith('\n') || stripped.length === 0 ? stripped : stripped + '\n';
        writeFileSync(gi, current);
      }
    }
    const have = new Set(current.split('\n').map((l) => l.trim()));
    const missing = manageFeed
      ? ignoreLines.filter((l) => !have.has(l))
      : ignoreLines.filter((l) => l !== SIGNAL_HISTORY_IGNORE && !have.has(l));
    if (missing.length > 0) {
      writeFileSync(gi, current + (current.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
    }
  }
}

export function runDir(projectRoot: string, runId: string): string {
  return resolve(runsDir(projectRoot), runId);
}

export function ensureRunDirectories(
  projectRoot: string,
  runId: string,
): {
  runDir: string;
  screenshotsDir: string;
} {
  ensureValidityGitignore(projectRoot, historyCommittedOpts(projectRoot));
  const dir = runDir(projectRoot, runId);
  const screenshotsDir = resolve(dir, 'screenshots');
  ensureDir(dir);
  ensureDir(screenshotsDir);
  ensureDir(dirname(screenshotsDir));
  return { runDir: dir, screenshotsDir };
}

/* ------------------------------------------------------------------ *
 * Run retention (W5 #16) — `validity clean`.                         *
 *                                                                    *
 * `.validity/runs/` grows unbounded (each run stores its PNGs ~3× —  *
 * files + base64 in report.html + report.md). `clean` prunes old run *
 * DIRECTORIES; the durable viewer outputs (trends.html, compare-*    *
 * .html) live in the SIBLING `.validity/reports/` tree (W5 #19), and *
 * baselines in `.validity/baselines/`, so run cleanup can orphan     *
 * neither.                                                           *
 * ------------------------------------------------------------------ */

/** Run-directory ids under `.validity/runs/` (subdirectories only). */
export function listRunIds(projectRoot: string): string[] {
  const dir = runsDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export interface RunCleanupPlan {
  keep: string[];
  remove: string[];
}

/**
 * PURE retention planner (unit-testable without touching disk). Keeps, per spec,
 * the `keep` most-recent runs (newest-last order as stored in the spec timeline)
 * and prunes the rest; an `olderThanMs` cutoff additionally SPARES any candidate
 * newer than the cutoff (so `--older-than` never deletes recent runs even beyond
 * the keep count). The single newest run per spec is ALWAYS kept so a "last run"
 * reference can't dangle. Runs in no spec timeline (orphans) are prunable subject
 * to the same cutoff.
 */
export function selectRunsToPrune(args: {
  allRunIds: string[];
  /** spec id → its run ids OLDEST→NEWEST (the runs.jsonl timeline order). */
  perSpecRunIds: Record<string, string[]>;
  /** run id → createdAt ISO, for the `--older-than` cutoff. Missing ⇒ treated as old. */
  createdAt: Record<string, string | undefined>;
  /** Per-spec runs to keep (default 10). Clamped so the newest is always kept. */
  keep?: number;
  /** When set, only prune candidates OLDER than `now - olderThanMs`. */
  olderThanMs?: number;
  now: string;
}): RunCleanupPlan {
  const keepN = Math.max(1, args.keep ?? 10);
  const keepSet = new Set<string>();
  const referenced = new Set<string>();
  for (const runIds of Object.values(args.perSpecRunIds)) {
    for (const id of runIds) referenced.add(id);
    // Newest-last: the tail is the most recent → keep the last `keepN`.
    for (const id of runIds.slice(-keepN)) keepSet.add(id);
  }
  const cutoff = args.olderThanMs != null ? Date.parse(args.now) - args.olderThanMs : null;
  const isNewerThanCutoff = (id: string): boolean => {
    if (cutoff == null) return false;
    const at = args.createdAt[id];
    // Unknown createdAt ⇒ treated as old (prunable); a parseable-and-newer run is spared.
    return at != null && Number.isFinite(Date.parse(at)) && Date.parse(at) >= cutoff;
  };
  const remove: string[] = [];
  const keep: string[] = [];
  for (const id of args.allRunIds) {
    if (keepSet.has(id) || isNewerThanCutoff(id)) keep.push(id);
    else remove.push(id);
  }
  return { keep, remove };
}

/** Delete a run directory tree. Best-effort — a missing/locked dir is ignored. */
export function deleteRun(projectRoot: string, runId: string): void {
  try {
    rmSync(runDir(projectRoot, runId), { recursive: true, force: true });
  } catch {
    // Non-fatal: leaving a stray run dir is harmless; clean is idempotent.
  }
}
