/**
 * The hardening engine (maturity ladder, Phase C) — soft → hard distillation.
 *
 * Climbing team → certified means eliminating soft criteria from the gate.
 * The system already holds the evidence to PROPOSE that mechanically: every
 * soft verdict carries screenshot citations, and lean-verify's carry-forward
 * proved the byte-identity discipline works. When a soft criterion has passed
 * N consecutive runs (default {@link HARDENING_STABLE_RUNS}) on IDENTICAL
 * evidence — same cited renders, byte-identical screenshot hashes — a
 * `hardening-candidate` signal is emitted carrying a concrete, ready-to-paste
 * replacement criterion:
 *
 *   - when the deterministic NL→checks compiler (compile-checks.ts — the same
 *     heuristics family the plan→spec bridge uses) can compile the criterion
 *     text into executable checks, those checks ARE the proposal
 *     (`expect.element` presence, console invariants, …);
 *   - else the proposal is an `expect.screenshot` baseline check pinned to the
 *     evidence that has provably not moved in N runs (certifiable once the
 *     Playwright baseline is committed).
 *
 *   (The plan's a11y-node extraction is deferred: web run-meta persists no
 *   structured a11y node set — `a11ySnapshot` is native-only free text — so
 *   element proposals derive from the criterion text via the compiler until
 *   web runs persist structured snapshots.)
 *
 * NEVER auto-applied. The proposal lands as a signal + payload; a human (or an
 * agent instructed by one) accepts it via `spec_update`, which bumps the spec
 * version → re-freeze → re-export. Machine-suggested, human-ratified — the
 * probation-guardrail philosophy.
 *
 * Dismissal: resolving the signal stores its `evidenceHash`; the detector
 * never re-proposes while the evidence fingerprint is unchanged. New evidence
 * (a changed screenshot, different citations) re-opens with a new hash.
 *
 * Flap detector: ANY of — a non-pass verdict, a demoting evidence taint,
 * missing/changed citations, or pixel-changed screenshots — breaks the streak;
 * a criterion with flapping evidence never produces a candidate.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { compileCriterion } from './compile-checks.js';
import { readRunMeta, readSpecRunHistory } from './run.js';
import { loadSignals, mergeSignals, saveSignals, type Signal } from './scorecard.js';
import {
  criterionIsBlocking,
  demotingTaintsOf,
  isExpectCheck,
  type EvidenceTaint,
  type Spec,
  type SpecCriterion,
} from './spec-schema.js';
import { stableStringify } from './specs.js';

/** Default N: consecutive stable passing runs before a candidate fires (§C2). */
export const HARDENING_STABLE_RUNS = 5;

/** runs.jsonl rows to read: 2x slack over the window (scored re-append twins). */
export const HARDENING_HISTORY_READ_LIMIT = 24;

/** One run's evidence slice, pre-hashed so the detector stays pure. */
export interface HardeningRunEvidence {
  runId: string;
  createdAt: string;
  specHash?: string;
  /** Post-scoring criterion verdicts (the submit_report re-appended meta). */
  verdicts: Array<{
    id: string;
    tier: string;
    status: 'pass' | 'fail' | 'unverifiable';
    screenshotCitations?: string[];
    evidenceTaints?: EvidenceTaint[];
    networkTainted?: boolean;
  }>;
  /** renderKey (screenshot basename sans .png) → sha256 of the PNG bytes. */
  shots: ReadonlyMap<string, string>;
  /** citation/render id → renderKeys captured under that id. */
  idsToKeys: ReadonlyMap<string, string[]>;
}

export interface HardeningCandidate {
  specId: string;
  criterionId: string;
  criterionText: string;
  /** Consecutive stable passing runs observed (≥ the configured N). */
  runs: number;
  /** Fingerprint of the evidence — the dismissal key (see module header). */
  evidenceHash: string;
  /** 'element' = compiler-derived checks; 'screenshot' = baseline check. */
  kind: 'element' | 'screenshot';
  /** Ready-to-paste replacement criterion for a spec_update patch. */
  proposal: SpecCriterion;
  /** One human sentence for the signal/dashboard. */
  detail: string;
}

/** The per-criterion evidence fingerprint for one run: citations + shot hashes. */
function evidenceKeyFor(run: HardeningRunEvidence, citations: string[]): string | null {
  const entries: Array<[string, string]> = [];
  for (const id of [...citations].sort()) {
    const keys = run.idsToKeys.get(id);
    if (!keys || keys.length === 0) return null; // cited render absent
    for (const key of [...keys].sort()) {
      const hash = run.shots.get(key);
      if (!hash) return null; // unreadable/non-evidence render
      entries.push([key, hash]);
    }
  }
  return stableStringify(entries);
}

/** Compile-or-screenshot proposal for a criterion (see module header). */
function buildProposal(c: SpecCriterion): {
  kind: 'element' | 'screenshot';
  proposal: SpecCriterion;
} {
  const compiled = compileCriterion(c.text);
  if (compiled.tier === 'hard' && compiled.checks && compiled.checks.length > 0) {
    return {
      kind: 'element',
      proposal: {
        id: c.id,
        text: c.text,
        tier: 'hard',
        checks: compiled.checks,
        ...(compiled.mocking ? { mocking: compiled.mocking } : {}),
        ...((compiled.dataState ?? c.dataState)
          ? { dataState: compiled.dataState ?? c.dataState }
          : {}),
        ...(c.severity ? { severity: c.severity } : {}),
      },
    };
  }
  return {
    kind: 'screenshot',
    proposal: {
      id: c.id,
      text: c.text,
      tier: 'hard',
      checks: [{ expect: { screenshot: { name: c.id } } }],
      ...(c.dataState ? { dataState: c.dataState } : {}),
      ...(c.severity ? { severity: c.severity } : {}),
    },
  };
}

/** Render a one-line summary of the proposed checks for the signal detail. */
function summarizeChecks(proposal: SpecCriterion): string {
  const parts: string[] = [];
  for (const check of proposal.checks ?? []) {
    if (isExpectCheck(check)) {
      const e = check.expect;
      if (e.element) {
        const sel = [
          e.element.role ? `role: '${e.element.role}'` : null,
          e.element.name ? `name: '${e.element.name}'` : null,
          e.element.text ? `text: '${e.element.text}'` : null,
          e.element.testId ? `testId: '${e.element.testId}'` : null,
        ]
          .filter(Boolean)
          .join(', ');
        parts.push(`expect.element {${sel}}`);
      } else if (e.screenshot) parts.push(`expect.screenshot {name: '${e.screenshot.name}'}`);
      else if (e.console) parts.push(`expect.console {errors: ${e.console.errors}}`);
      else if (e.network) parts.push(`expect.network {url: '${e.network.url}'}`);
      else if (e.performance) parts.push(`expect.performance {${e.performance.metric}}`);
      else parts.push('expect');
    } else parts.push(Object.keys(check)[0] ?? 'check');
  }
  return parts.join(' + ');
}

/**
 * PURE detector: the trailing stable-pass streak per blocking soft criterion.
 * `history` is newest-LAST; only runs whose `specHash` matches the FROZEN
 * spec's hash participate (a streak can never span a re-freeze — same
 * criterion id, different contract).
 */
export function computeHardeningCandidates(args: {
  spec: Spec;
  history: HardeningRunEvidence[];
  stableRuns?: number;
}): HardeningCandidate[] {
  const { spec } = args;
  const need = args.stableRuns ?? HARDENING_STABLE_RUNS;
  if (spec.status !== 'frozen' || !spec.hash) return [];

  // Trailing same-contract window, newest last.
  const bound = args.history.filter((r) => r.specHash === spec.hash);
  if (bound.length < need) return [];

  const candidates: HardeningCandidate[] = [];
  for (const c of spec.criteria) {
    if (c.tier !== 'soft' || !criterionIsBlocking(c)) continue;

    // Latest run anchors the evidence; walk backwards while it holds.
    const latest = bound[bound.length - 1]!;
    const latestVerdict = latest.verdicts.find((v) => v.id === c.id);
    if (
      !latestVerdict ||
      latestVerdict.status !== 'pass' ||
      demotingTaintsOf(latestVerdict).length > 0 ||
      !latestVerdict.screenshotCitations ||
      latestVerdict.screenshotCitations.length === 0
    ) {
      continue;
    }
    const citations = [...latestVerdict.screenshotCitations].sort();
    const anchorEvidence = evidenceKeyFor(latest, citations);
    if (anchorEvidence === null) continue;

    let streak = 0;
    for (let i = bound.length - 1; i >= 0; i--) {
      const run = bound[i]!;
      const v = run.verdicts.find((x) => x.id === c.id);
      if (
        !v ||
        v.status !== 'pass' ||
        demotingTaintsOf(v).length > 0 ||
        !v.screenshotCitations ||
        stableStringify([...v.screenshotCitations].sort()) !== stableStringify(citations) ||
        evidenceKeyFor(run, citations) !== anchorEvidence
      ) {
        break;
      }
      streak += 1;
    }
    if (streak < need) continue;

    const { kind, proposal } = buildProposal(c);
    const evidenceHash = `sha256-${createHash('sha256')
      .update(
        stableStringify({
          specHash: spec.hash,
          criterionId: c.id,
          text: c.text,
          evidence: anchorEvidence,
          proposalKind: kind,
        }),
      )
      .digest('hex')}`;
    candidates.push({
      specId: spec.id,
      criterionId: c.id,
      criterionText: c.text,
      runs: streak,
      evidenceHash,
      kind,
      proposal,
      detail:
        `soft criterion "${c.id}" has passed ${streak} consecutive runs on identical evidence — ` +
        `proposed hard replacement: ${summarizeChecks(proposal)}. Apply via validity__spec_update ` +
        `(bumps the version), then re-freeze + re-export. Never auto-applied.`,
    });
  }
  return candidates;
}

/**
 * Candidates → signals, honoring dismissals and withdrawing flapped proposals.
 *
 *   - a candidate whose `evidenceHash` matches a RESOLVED same-id signal's
 *     stored hash is suppressed (the human said no to exactly this evidence);
 *   - an OPEN hardening-candidate whose criterion no longer has a candidate
 *     (evidence flapped, criterion hardened/demoted/left) resolves in place —
 *     `mergeSignals` drops the marker when nothing is open.
 */
export function computeHardeningSignals(args: {
  spec: Spec;
  history: HardeningRunEvidence[];
  existingSignals: Signal[];
  now: string;
  sha?: string;
  stableRuns?: number;
}): Signal[] {
  const { spec, existingSignals, now, sha } = args;
  const candidates = computeHardeningCandidates(args);
  const byCriterion = new Map(candidates.map((c) => [c.criterionId, c]));
  const signals: Signal[] = [];

  for (const candidate of candidates) {
    const id = `hardening-candidate:${spec.id}:${candidate.criterionId}`;
    const prior = existingSignals.find((s) => s.id === id);
    if (prior?.status === 'resolved' && prior.hardening?.evidenceHash === candidate.evidenceHash) {
      continue; // dismissed on this exact evidence — do not re-propose
    }
    signals.push({
      id,
      kind: 'hardening-candidate',
      severity: 'low',
      specId: spec.id,
      criterionId: candidate.criterionId,
      detail: candidate.detail,
      at: now,
      openedAt: now,
      sha,
      status: 'open',
      hardening: {
        evidenceHash: candidate.evidenceHash,
        runs: candidate.runs,
        proposal: candidate.proposal,
      },
    });
  }

  // Withdraw open proposals the evidence no longer supports. The `hardening`
  // payload is STRIPPED on withdrawal: a system withdrawal must never read as
  // a human dismissal — if the same evidence later re-stabilizes, the
  // proposal re-fires (only a resolved row that KEPT its evidenceHash — a
  // human saying no to exactly that evidence — suppresses).
  for (const s of existingSignals) {
    if (s.kind !== 'hardening-candidate' || s.specId !== spec.id || s.status !== 'open') continue;
    if (s.criterionId && byCriterion.has(s.criterionId)) continue;
    signals.push({
      ...s,
      hardening: undefined,
      detail: 'proposal withdrawn — the evidence changed (or the criterion hardened/left the gate)',
      at: now,
      resolvedAt: now,
      sha,
      status: 'resolved',
      resolvedBy: 'superseded',
    });
  }
  return signals;
}

/* ------------------------------------------------------------------ *
 * IO shell — mirrors refreshPerfDrift.                                 *
 * ------------------------------------------------------------------ */

/** sha256 of a file's bytes, resolved against the project root; null if unreadable. */
function hashFileOrNull(projectRoot: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(projectRoot, path);
  try {
    if (!existsSync(abs)) return null;
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/** Build one run's evidence slice from its run-meta (hashes every screenshot). */
export function hardeningEvidenceFromMeta(
  projectRoot: string,
  meta: {
    runId: string;
    createdAt: string;
    specHash?: string;
    components?: Array<{
      id: string;
      screenshotPath: string;
      renderError?: string;
      screenshotSkipped?: boolean;
      renderConfirmation?: 'confirmed' | 'unconfirmed';
    }>;
    criterionVerdicts?: HardeningRunEvidence['verdicts'];
  },
): HardeningRunEvidence {
  const shots = new Map<string, string>();
  const idsToKeys = new Map<string, string[]>();
  for (const r of meta.components ?? []) {
    // Same evidence bar as lean-verify's buildPrevRenderIndex: errored,
    // skipped, or unconfirmed renders are never evidence.
    if (r.renderError || r.screenshotSkipped || r.renderConfirmation === 'unconfirmed') continue;
    const key = (r.screenshotPath.split('/').pop() ?? r.screenshotPath).replace(/\.png$/i, '');
    const keys = idsToKeys.get(r.id) ?? [];
    keys.push(key);
    idsToKeys.set(r.id, keys);
    const hash = hashFileOrNull(projectRoot, r.screenshotPath);
    if (hash) shots.set(key, hash);
  }
  return {
    runId: meta.runId,
    createdAt: meta.createdAt,
    specHash: meta.specHash,
    verdicts: meta.criterionVerdicts ?? [],
    shots,
    idsToKeys,
  };
}

/**
 * Read the spec's runs.jsonl tail and build the trailing SAME-HASH evidence
 * window (newest last), hashing each run's screenshots. Rows are deduped by
 * runId keeping the LAST (submit_report's scored re-append supersedes the
 * verify-time row) and ordered by run time — the perf-drift discipline. The
 * walk stops at the first non-matching hash or pruned run dir, so a streak
 * can never bridge a gap it cannot prove. Never throws; failures ⇒ [].
 */
export function buildHardeningWindow(projectRoot: string, spec: Spec): HardeningRunEvidence[] {
  try {
    if (spec.status !== 'frozen' || !spec.hash) return [];
    const rows = readSpecRunHistory(projectRoot, spec.id, HARDENING_HISTORY_READ_LIMIT);
    const byRun = new Map<string, (typeof rows)[number]>();
    for (const row of rows) byRun.set(row.runId, row);
    const ordered = Array.from(byRun.values()).sort(
      (a, b) =>
        (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.runId.localeCompare(b.runId),
    );
    const window: HardeningRunEvidence[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const row = ordered[i]!;
      if (row.specHash !== spec.hash) break;
      const meta = readRunMeta(projectRoot, row.runId);
      if (!meta) break; // pruned run dir — evidence chain broken
      window.unshift(hardeningEvidenceFromMeta(projectRoot, meta));
      if (window.length >= HARDENING_HISTORY_READ_LIMIT) break;
    }
    return window;
  } catch {
    return [];
  }
}

/**
 * Build the window, compute + persist hardening-candidate signals. Advisory by
 * construction (severity 'low' — `watch --fail-on-signal` gates on 'high'
 * only); touches signals.json and nothing else. Never throws; IO failures
 * return [].
 */
export function refreshHardeningCandidates(
  projectRoot: string,
  spec: Spec,
  opts?: { now?: string; sha?: string; stableRuns?: number },
): Signal[] {
  try {
    const window = buildHardeningWindow(projectRoot, spec);
    const existing = loadSignals(projectRoot);
    const fresh = computeHardeningSignals({
      spec,
      history: window,
      existingSignals: existing,
      now: opts?.now ?? new Date().toISOString(),
      sha: opts?.sha,
      stableRuns: opts?.stableRuns,
    });
    if (fresh.length > 0) saveSignals(projectRoot, mergeSignals(existing, fresh));
    return fresh;
  } catch {
    return [];
  }
}
