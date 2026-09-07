/**
 * Per-criterion evidence assembly for the report (C1).
 *
 * Builds the `ReportInput.evidence` map from PERSISTED verify-time facts —
 * run-meta and the frozen spec ONLY. Nothing agent-submitted can reach this
 * module: the caller (`handleSubmitReport`) passes the run-meta it read off
 * disk, never `SubmitReportArgs`. The single agent-influenced field that
 * appears here (`screenshotCitations`) was validated against run-meta render
 * ids by the soft-scoring quality floor BEFORE it was persisted.
 *
 * Every read is optional-chained: run-metas from any prior Validity version
 * (no taints, no provenance, no scoredBy) produce sparser entries, never a
 * throw. Degradation direction is always "less claimed".
 */

import { evidenceTaintsOf, type ComponentRender, type RunMeta, type Spec } from '@validity.ai/verify-spec';
import type { ReportEvidence } from './report.js';

export interface BuildEvidenceMapArgs {
  /** The persisted run-meta (verify-time facts + folded soft scores). */
  meta: Pick<RunMeta, 'mode' | 'components' | 'pages' | 'criterionVerdicts' | 'scoring'>;
  /** The frozen spec the run verified against, when one was in scope. */
  spec: Spec | null;
}

/** Union the render-level provenance stamps across a set of renders, deduped. */
function unionProvenance(renders: ComponentRender[]): ReportEvidence['dataProvenance'] {
  const out: NonNullable<ReportEvidence['dataProvenance']> = [];
  for (const r of renders) {
    for (const p of r.dataProvenance ?? []) {
      if (!out.includes(p)) out.push(p);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Fold render confirmations downward: any `unconfirmed` render wins (the worse
 * claim), else `confirmed` when at least one render positively confirmed.
 * All-absent (web renders) stays absent.
 */
function foldRenderConfirmation(renders: ComponentRender[]): ReportEvidence['renderConfirmation'] {
  if (renders.some((r) => r.renderConfirmation === 'unconfirmed')) return 'unconfirmed';
  if (renders.some((r) => r.renderConfirmation === 'confirmed')) return 'confirmed';
  return undefined;
}

/**
 * Build the per-criterion evidence map from persisted verify-time facts.
 *
 *   - Hard/property criteria: the citation ids are RECOVERED from the renders
 *     whose `ComponentRender.criterionVerdicts` carried the criterion (the
 *     association is lost in the rolled-up `meta.criterionVerdicts`).
 *   - Soft criteria: the citation ids are the `screenshotCitations` the
 *     quality floor validated; scorer identity comes from the A3 stamp.
 *   - Taints go through `evidenceTaintsOf` so legacy `networkTainted`
 *     run-metas group correctly.
 */
export function buildEvidenceMap(args: BuildEvidenceMapArgs): Record<string, ReportEvidence> {
  const { meta } = args;
  const mode = meta.mode ?? 'isolation';
  const out: Record<string, ReportEvidence> = {};

  // criterion id → the renders that executed it (hard/property association).
  const executingRenders = new Map<string, ComponentRender[]>();
  for (const render of meta.components ?? []) {
    for (const v of render.criterionVerdicts ?? []) {
      const list = executingRenders.get(v.id) ?? [];
      list.push(render);
      executingRenders.set(v.id, list);
    }
  }
  const rendersById = new Map<string, ComponentRender[]>();
  for (const render of meta.components ?? []) {
    const list = rendersById.get(render.id) ?? [];
    list.push(render);
    rendersById.set(render.id, list);
  }

  for (const v of meta.criterionVerdicts ?? []) {
    const ev: ReportEvidence = { mode };

    const taints = evidenceTaintsOf(v);
    if (taints.length > 0) ev.taints = taints;

    if (v.tier === 'soft') {
      if (v.screenshotCitations && v.screenshotCitations.length > 0) {
        ev.screenshotIds = [...new Set(v.screenshotCitations)];
      }
      if (v.scoredBy) {
        ev.scoredBy = v.scoredBy.model ?? v.scoredBy.session;
        // Self-scoring is a RUN-level fact (A6/foundation §1.2) — surface it on
        // the criterion chip only when a scorer was actually stamped.
        if (meta.scoring?.selfScored !== undefined) ev.selfScored = meta.scoring.selfScored;
      }
      const cited = (ev.screenshotIds ?? []).flatMap((id) => rendersById.get(id) ?? []);
      ev.dataProvenance = unionProvenance(cited);
      ev.renderConfirmation = foldRenderConfirmation(cited);
    } else {
      const renders = executingRenders.get(v.id) ?? [];
      const ids = [...new Set(renders.map((r) => r.id))];
      if (ids.length > 0) ev.screenshotIds = ids;
      ev.dataProvenance = unionProvenance(renders);
      ev.renderConfirmation = foldRenderConfirmation(renders);
    }

    out[v.id] = ev;
  }

  return out;
}
