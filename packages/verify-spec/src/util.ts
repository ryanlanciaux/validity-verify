import { createHash, randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Atomic write (W4 #11): serialize to a per-process temp sibling, then rename
 * over the target. `rename(2)` is atomic on POSIX, so a concurrent reader
 * always sees either the whole old file or the whole new one — never a torn,
 * half-written file. The `.pid.` infix keeps two writers' temp files from
 * colliding.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* consumed by rename, or the write never created it */
    }
  }
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function newRunId(): string {
  return `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function newTaskId(): string {
  return `task_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function newPlanId(): string {
  return `plan_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
