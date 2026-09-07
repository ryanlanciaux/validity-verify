/**
 * Spec ids with ANY run history, shared by the `trends`/`compare` viewers:
 * local `specs/<id>/runs.jsonl` timelines (even when spec.yaml was deleted —
 * the timeline outlives the spec on a machine) plus committed
 * `.validity/history/<id>.jsonl` files (which outlive the whole spec dir).
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { listHistorySpecIds } from '@validity.ai/verify-spec';

export function timelineSpecIds(projectRoot: string): string[] {
  const ids = new Set<string>(listHistorySpecIds(projectRoot));
  const specsDir = resolve(projectRoot, '.validity', 'specs');
  if (existsSync(specsDir)) {
    try {
      for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(resolve(specsDir, entry.name, 'runs.jsonl'))) {
          ids.add(entry.name);
        }
      }
    } catch {
      // Unreadable specs dir — history ids still resolve.
    }
  }
  return [...ids].sort();
}
