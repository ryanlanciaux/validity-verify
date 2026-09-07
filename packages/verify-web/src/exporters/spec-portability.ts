/**
 * Portability badge — export health as a SEPARATE, optional signal, decoupled
 * from the maturity ladder (certification reads only Validity's own evidence;
 * see maturity.ts in @validity.ai/verify-spec).
 *
 * "Portable" answers one question: would this spec's gate-relevant mechanical
 * checks compile warning-free to a conventional test suite (Playwright for
 * web, Maestro for native), and do the committed artifacts match a fresh
 * recompile byte-for-byte? It is the anti-lock-in story — your specs are not
 * hostage to Validity's runtime — not a trust level. It never gates maturity,
 * the Validity Score, or sign-off.
 *
 * The badge is derived ONLY when the project has opted into exports (an
 * `export` stanza in .validity/config.ts). Without the stanza every surface
 * hides it ('unconfigured') — a team that never asked for exports must never
 * see export-derived judgments.
 *
 * Two invariants live here (moved verbatim from the old certification wiring):
 *   - the warning collectors receive the SAME `hasFixtures`/`hasBaseUrl`/
 *     `hasAppId` values the exporter itself would compute (single source of
 *     truth — "the export lies about fidelity" and "the badge lies" are the
 *     same bug);
 *   - the artifact check reads the exports manifest + recompiled bytes, so
 *     the badge's freshness clause is the exact `spec export --check` gate.
 */
import {
  exportGateSpec,
  type MaturityArtifactCheck,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { collectPlaywrightWarnings, type ExportWarning } from './spec-export-warnings.js';
import { computeHasFixtures } from './spec-playwright.js';
import { exportSpecToMaestro } from './spec-maestro.js';
import {
  exportRunStanding,
  loadExportsManifest,
  specArtifactCheck,
  type ExportRunStanding,
} from './spec-export-manifest.js';

export type PortabilityStatus = 'portable' | 'blocked' | 'unconfigured';

export interface PortabilityAssessment {
  /**
   * - `unconfigured` — no `export` stanza; the badge is hidden everywhere;
   * - `blocked`      — warnings fired (a check degrades to a stub/TODO) or the
   *                    committed artifacts are missing/drifted;
   * - `portable`     — zero warnings over the export gate AND byte-fresh
   *                    artifacts on disk.
   */
  status: PortabilityStatus;
  /** Degradation warnings over the gate-relevant hard/property criteria. */
  warnings: ExportWarning[];
  /** Artifact freshness — only consulted once the warnings are clear. */
  artifact: MaturityArtifactCheck | null;
  /**
   * Run-the-export standing: did executing these exact artifact bytes produce a
   * verdict, and which one. Additive and one-directional:
   *
   *   - `failed` / `unsupported` → the badge is BLOCKED (a suite that does not
   *     run is not portable, whatever the warnings say);
   *   - `not-run` / `stale`      → the badge is unchanged (absence of a run is
   *     never evidence — not for and not against);
   *   - `passed`                 → the badge is what it would have been anyway,
   *     now with an executed proof behind it.
   *
   * `null` when the badge is `unconfigured` (nothing was assessed).
   */
  run: ExportRunStanding | null;
}

/**
 * Warnings for a spec (or a pre-filtered gate subset) with the exporter-true
 * input flags derived from config. The one collector call every consumer
 * routes through.
 */
export function collectRuntimeExportWarnings(spec: Spec, config?: ValidityConfig): ExportWarning[] {
  if (spec.runtime === 'native') {
    // Route through the EXPORTER itself rather than re-deriving the warnings
    // from the spec. Two reasons, both about the badge never disagreeing with
    // the file: it guarantees the `hasAppId`/`maestro` inputs are the ones the
    // exporter compiled with (no "MUST be the same value" contract to keep by
    // hand), and it picks up the 0.20.5 subset lint over the EMITTED BYTES —
    // which no spec-shaped predicate could reproduce. Pure string generation;
    // `specArtifactCheck` below already recompiles on every read surface.
    return exportSpecToMaestro({
      spec,
      appId: config?.export?.appId,
      maestro: config?.export?.maestro,
    }).warnings;
  }
  return collectPlaywrightWarnings({
    spec,
    hasFixtures: computeHasFixtures(spec, config),
    hasBaseUrl: Boolean(config?.export?.baseUrl),
    // Same fallback the fixtures' catch-all compiles with — so the 'populate'
    // warning agrees with the export (and blocks the badge identically).
    mockFallback: config?.mockNetwork?.fallback,
  });
}

/**
 * Export-gate warnings: the collectors over the GATE-RELEVANT hard/property
 * criteria only (advisory criteria never gate; soft criteria export as stubs
 * by design). Also the `spec export --all` eligibility test — a spec is
 * export-eligible exactly when nothing here fires.
 */
export function collectExportGateWarnings(spec: Spec, config?: ValidityConfig): ExportWarning[] {
  return collectRuntimeExportWarnings(exportGateSpec(spec), config);
}

/**
 * Derive the portability badge for a spec. Cheap when unconfigured (returns
 * immediately); the artifact check (manifest read + in-memory recompile) only
 * runs once the warnings are clear, mirroring the old "next actionable step"
 * ordering.
 */
export function assessSpecPortability(
  projectRoot: string,
  spec: Spec,
  config?: ValidityConfig,
): PortabilityAssessment {
  if (!config?.export) return { status: 'unconfigured', warnings: [], artifact: null, run: null };
  // Maestro export is parked as a preview (opt-in via export.maestro.enabled):
  // while it's off, native specs must not surface export-derived judgments.
  if (spec.runtime === 'native' && config.export.maestro?.enabled !== true) {
    return { status: 'unconfigured', warnings: [], artifact: null, run: null };
  }
  const warnings = collectExportGateWarnings(spec, config);
  if (warnings.length > 0) return { status: 'blocked', warnings, artifact: null, run: null };
  const artifact = specArtifactCheck(projectRoot, spec, config);
  const run = exportRunStanding(loadExportsManifest(projectRoot).entries[spec.id]);
  // A recorded run only ever SUBTRACTS. `passed` doesn't upgrade a drifted
  // artifact, and `not-run`/`stale` can't downgrade a clean one — the badge
  // predates run-the-export and must keep meaning what it meant for every
  // export nobody has executed.
  const ranBadly = run.status === 'failed' || run.status === 'unsupported';
  return {
    status: artifact.status === 'ok' && !ranBadly ? 'portable' : 'blocked',
    warnings,
    artifact,
    run,
  };
}
