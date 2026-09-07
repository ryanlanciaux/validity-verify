/**
 * Run origin detection — was a run produced on a developer's machine (`local`)
 * or inside a CI runner (`ci`)? Pure given its env argument so it is trivially
 * unit-testable; the writers call it at run-meta construction time (the only
 * place a `process.env` read belongs — every downstream renderer receives the
 * result as data). ADD-ONLY provenance: display-only, never a gate input.
 */

/** A run's provenance: `local` = developer machine, `ci` = CI runner. */
export type RunOrigin = 'local' | 'ci';

/** CI vendors whose mere presence (non-empty value) marks a CI environment. */
const CI_MARKER_VARS = ['GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD'] as const;

/** Values a truthy `CI` env var takes across runners (case-insensitive). */
const CI_TRUE = new Set(['true', '1']);

/**
 * Classify the run environment. Returns `'ci'` when GitHub Actions is active,
 * when the generic `CI` var reads truthy (`'true'`/`'1'`), or when any known
 * vendor marker is set non-empty; otherwise `'local'`. Injectable env keeps it
 * deterministic in tests.
 */
export function detectRunOrigin(env: NodeJS.ProcessEnv = process.env): RunOrigin {
  if (env.GITHUB_ACTIONS === 'true') return 'ci';
  if (typeof env.CI === 'string' && CI_TRUE.has(env.CI.trim().toLowerCase())) return 'ci';
  for (const name of CI_MARKER_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return 'ci';
  }
  return 'local';
}
