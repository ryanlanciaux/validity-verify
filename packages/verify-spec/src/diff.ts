import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { containedFile } from './contained-file.js';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export interface DiffHunk {
  /** The `@@ -10,7 +10,8 @@ context` header line, verbatim. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path relative to projectRoot. */
  path: string;
  hunks: DiffHunk[];
  /** True for binaries / files git refused to diff textually. */
  binary?: boolean;
  /** Best-effort byte size for the working-tree version (used by binary fallback). */
  byteSize?: number;
}

export interface CollectDiffArgs {
  projectRoot: string;
  /**
   * If provided, only files appearing here are included. If undefined, the
   * full `git diff HEAD` + untracked-tracked files set is returned.
   */
  changedFiles?: string[];
  /** Cap the size of any single file's text diff. Default: 100KB. */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 100_000;

/**
 * Filenames whose CONTENTS must never be inlined into a report (which is meant
 * to be uploadable as a CI artifact): env files, private keys, credentials.
 * Matched on the path's basename or a well-known suffix. We still SHOW that the
 * file changed (a redaction marker) so a reviewer sees it exists — we just never
 * put its bytes in the diff.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i, // .env, .env.local, .env.production, …
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)credentials?(\.|$)/i,
  /(^|\/)secrets?(\.|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i,
];

function looksLikeSecret(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return SECRET_FILE_PATTERNS.some((re) => re.test(norm));
}

/** A DiffFile that names a changed file but withholds its contents. */
function redactedSecretFile(relPath: string, byteSize?: number): DiffFile {
  return {
    path: relPath,
    byteSize,
    hunks: [
      {
        header: '@@ contents redacted — looks like a secret @@',
        lines: [
          {
            kind: 'context',
            text:
              'Validity does not inline files matching well-known secret patterns ' +
              '(.env*, *.pem, *.key, credentials*, service-account*.json) into the report. ' +
              'If this file should not be committed, add it to .gitignore.',
          },
        ],
      },
    ],
  };
}

function execGit(args: string[], cwd: string): string | null {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  };
  try {
    return execSync(`git ${args.map(quote).join(' ')}`, opts);
  } catch {
    return null;
  }
}

function quote(s: string): string {
  if (/^[a-zA-Z0-9._/=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Decode Git's C-quoted UTF-8 bytes, including octal escapes (not JSON escapes). */
function gitPath(token: string): string {
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"')) throw new Error('unterminated Git path');
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i]!;
    if (ch === '\\') {
      const escape = token[++i]!;
      if (/[0-7]/.test(escape)) {
        const octal = token.slice(i, i + 3);
        if (!/^[0-3][0-7]{2}$/.test(octal)) throw new Error('invalid Git octal');
        bytes.push(parseInt(octal, 8));
        i += 2;
      } else if (Object.hasOwn(escapes, escape)) bytes.push(escapes[escape]!);
      else throw new Error('invalid Git escape');
    } else {
      if (ch === '"') throw new Error('invalid Git quote');
      const point = token.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

function gitHeaderPaths(header: string): [string, string] | null {
  // A path containing a separator-like substring is ambiguous: withhold it.
  const tokens = header.match(/^("(?:[^"\\]|\\.)*"|a\/[^"\n]+) ("(?:[^"\\]|\\.)*"|b\/[^"\n]+)$/);
  if (!tokens) return null;
  try {
    if (!tokens[1]!.startsWith('"') && tokens[1]!.includes(' b/')) return null;
    if (!tokens[2]!.startsWith('"') && tokens[2]!.includes(' b/')) return null;
    const oldPath = gitPath(tokens[1]!);
    const newPath = gitPath(tokens[2]!);
    if (!oldPath.startsWith('a/') || !newPath.startsWith('b/')) return null;
    return [oldPath.slice(2), newPath.slice(2)];
  } catch {
    return null;
  }
}

/**
 * Parse a `git diff` output blob into one or more `DiffFile` records.
 * Handles binary markers and the `--- a/X +++ b/X` headers.
 */
export function parseGitDiff(blob: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let withhold = false;

  const flush = () => {
    if (currentHunk && current) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  const lines = blob.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      flush();
      if (current) files.push(current);
      const paths = gitHeaderPaths(line.slice('diff --git '.length));
      withhold = paths === null || paths.some(looksLikeSecret);
      const path = paths?.[1] ?? '⚠ unparseable Git path (contents withheld)';
      current = withhold ? redactedSecretFile(path) : { path, hunks: [] };
      continue;
    }
    if (!current || withhold) continue;
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      flush();
      currentHunk = { header: line, lines: [] };
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({ kind: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ kind: 'context', text: line.replace(/^ /, '') });
    }
    // Skip `\ No newline at end of file` and metadata lines silently.
  }
  flush();
  if (current) files.push(current);
  return files;
}

/**
 * Collect the project's current changes for the report. Combines
 * `git diff HEAD` (tracked modifications) with untracked-but-tracked-ish
 * files (rendered as full-add diffs so the report shows them too).
 *
 * Returns `{ files: [] }` (empty) rather than throwing when git isn't
 * available or the project root isn't a git repo. The report just hides
 * the diff section in that case.
 *
 * `args.changedFiles` is intentionally NOT used as a filter here — the
 * diff section is about "what the AI changed across the whole repo,"
 * which often includes non-component files (config, lockfile, env). The
 * agent's `changedFiles` arg only controls which components get
 * screenshotted, not what shows up in the diff.
 */
export function collectDiff(args: CollectDiffArgs): { files: DiffFile[] } {
  const cwd = resolve(args.projectRoot);
  const maxBytes = args.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Verify we're inside a git repo first; saves us a couple of failed execs.
  if (execGit(['rev-parse', '--is-inside-work-tree'], cwd) === null) {
    return { files: [] };
  }

  // Exclude Validity's own footprint (`.validity/`: config, wrapper, runs,
  // gitignore) from the diff — it's housekeeping the user doesn't want to
  // review alongside their app changes. Magic pathspec `:(exclude).validity`
  // keeps the exclusion on the git side so we never parse those hunks.
  const VALIDITY_EXCLUDE = ':(exclude).validity';
  const diffBlob = execGit(['--no-pager', 'diff', 'HEAD', '--', '.', VALIDITY_EXCLUDE], cwd);
  // `execGit` returns null on FAILURE (git error, or the diff exceeding the 32MB
  // maxBuffer) and '' when there are genuinely no tracked changes. Conflating
  // them would render a report with a silently-empty diff section that a
  // reviewer reads as "nothing else changed". Surface the failure as a visible
  // marker file instead. (We already confirmed we're in a git repo above.)
  const files: DiffFile[] = diffBlob ? parseGitDiff(diffBlob) : [];
  if (diffBlob === null) {
    files.push({
      path: '⚠ code diff unavailable',
      hunks: [
        {
          header: '@@ git diff failed @@',
          lines: [
            {
              kind: 'context',
              text:
                '`git diff HEAD` could not be generated (git errored, or the diff exceeds the ' +
                '32MB cap — e.g. a vendored dir or lockfile churn). Code changes are NOT shown ' +
                'below; do not read the absence as "nothing else changed."',
            },
          ],
        },
      ],
    });
  }

  // Untracked files: `git ls-files --others --exclude-standard`. Render each
  // as a full-add file so the report shows new code the same way it shows
  // changes to existing code.
  const untrackedRaw = execGit(
    ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', VALIDITY_EXCLUDE],
    cwd,
  );
  if (untrackedRaw) {
    const paths = untrackedRaw.split('\0').filter(Boolean);
    for (const p of paths) {
      const file = readUntrackedAsAddFile(cwd, p, maxBytes);
      if (file) files.push(file);
    }
  }

  // Redact secret-looking TRACKED files: `git diff HEAD` inlines their content
  // as hunks, which would ship the secret into report.html / run-meta.json.
  // (Untracked secrets are already redacted at read time below.)
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (looksLikeSecret(f.path)) files[i] = redactedSecretFile(f.path, f.byteSize);
  }

  // Apply size caps to text hunks; replace very large hunks with a marker line.
  for (const f of files) {
    if (f.binary) continue;
    let total = 0;
    for (const h of f.hunks) {
      for (const ln of h.lines) total += ln.text.length + 1;
    }
    if (total > maxBytes) {
      f.hunks = [
        {
          header: `@@ truncated @@`,
          lines: [
            {
              kind: 'context',
              text: `diff truncated: ${total.toLocaleString()} bytes exceeds ${maxBytes.toLocaleString()} byte cap.`,
            },
          ],
        },
      ];
    }
  }

  return { files };
}

function readUntrackedAsAddFile(
  projectRoot: string,
  relPath: string,
  maxBytes: number,
): DiffFile | null {
  const abs = containedFile(projectRoot, resolve(projectRoot, relPath));
  if (!abs) return null;
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(abs);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  // Never read a secret-looking file's bytes into memory at all — show that it
  // exists (redaction marker), but keep its contents out of the report.
  if (looksLikeSecret(relPath)) return redactedSecretFile(relPath, stats.size);
  if (stats.size > maxBytes) {
    return {
      path: relPath,
      byteSize: stats.size,
      hunks: [
        {
          header: `@@ new file (${stats.size.toLocaleString()} bytes — truncated) @@`,
          lines: [],
        },
      ],
    };
  }
  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    // Probably binary.
    return { path: relPath, binary: true, byteSize: stats.size, hunks: [] };
  }
  const lines = content.split('\n');
  return {
    path: relPath,
    byteSize: stats.size,
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@ (new file)`,
        lines: lines.map((text) => ({ kind: 'add' as const, text })),
      },
    ],
  };
}
