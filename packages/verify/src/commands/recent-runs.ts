/**
 * Cheap "did the user mistype the runId" helper shared by run-addressed
 * commands (`export`, `judge-pack`). Lists directories under `.validity/runs/`
 * and returns the most-recent (by ctime) handful — no need to deserialize the
 * run-meta, the directory name IS the runId.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function recentRunIds(projectRoot: string): string[] {
  const dir = resolve(projectRoot, '.validity', 'runs');
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir)
      .map((name) => ({ name, full: resolve(dir, name) }))
      .filter((e) => {
        try {
          return statSync(e.full).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => ({ ...e, ctime: statSync(e.full).ctimeMs }))
      .sort((a, b) => b.ctime - a.ctime)
      .slice(0, 5)
      .map((e) => e.name);
    return entries;
  } catch {
    return [];
  }
}
