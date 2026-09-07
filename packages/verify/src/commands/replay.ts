/**
 * `validity replay <run-dir | report.html>` — the command a skeptical reviewer runs.
 *
 * `attest verify` answers "are these bytes unmodified?". Replay answers the
 * harder question underneath it: "does the claim still HOLD?" It re-executes the
 * DETERMINISTIC lane — hard + property checks compiled from the frozen spec the
 * run cited, loaded by its `specHash` — against the CURRENT working tree, and
 * diffs the fresh verdicts against the attested ones per criterion.
 *
 * This is the demo answer to "my agent already does this": a screenshot loop has
 * nothing replayable — no frozen contract, no signed verdicts, no receipt.
 *
 * THE THREE RULES THIS COMMAND EXISTS TO HONOR:
 *
 *   1. ATTESTATION FIRST, SHORT-CIRCUIT ON FAILURE. If the run's own evidence
 *      was edited, comparing against it is meaningless — we would be diffing
 *      fresh truth against a forgery and calling the forgery "attested". So a
 *      broken chain stops the command dead, before any check is compiled, and
 *      reports the named mismatches EXACTLY as `attest verify` does (same
 *      `verifyRunAttestation` + same `checkSpecHash`, imported, never copied).
 *
 *   2. SOFT CRITERIA ARE NEVER RE-SCORED. Replay spends zero tokens by
 *      construction, so it has no way to re-judge a model-scored criterion — and
 *      pretending otherwise would be the exact false green the product exists to
 *      prevent. Soft criteria print as "judged lane, not replayed" carrying the
 *      recorded provenance (who scored it, in which session, with what taints).
 *
 *   3. NEVER FALSE GREEN. `reproduced` requires every deterministic criterion to
 *      have re-produced its attested verdict (or improved on it). Anything the
 *      replay could not execute — a native spec with no booted device, a check
 *      that came back unverifiable, a criterion that isn't in the attested run —
 *      makes the verdict `incomplete`, never `reproduced`, and exits non-zero.
 *
 * Exit codes:
 *   0  reproduced   — every deterministic criterion reproduced or improved
 *   1  regressed    — a hard/property criterion that passed now fails, OR the
 *                     attestation chain is broken (same code `attest verify` uses)
 *   2  usage        — no such run, unloadable config
 *   3  incomplete   — nothing regressed, but the deterministic lane could not be
 *                     fully re-executed (matches verify --all's EXIT_UNFINISHED)
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  CommandCheckRunner,
  evidenceTaintsOf,
  readSpec,
  readSpecVersion,
  recordReplayDivergence,
  REPLAY_RECORDING_FILENAME,
  sha256File,
  shortId,
  verifyRecordingSignature,
  verifyRunAttestation,
  type AttestationMismatch,
  type AttestationPayload,
  type AttestationRecord,
  type AttestedCriterion,
  type CriterionTier,
  type EvidenceTaint,
  type ScorerProvenance,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  checkNativeReadiness,
  AgentDeviceDriver,
  collectNetworkEvidence,
  collectPerfEvidence,
  companionBuildIdentity,
  configuredSecrets,
  defaultRunner,
  divergenceEvidenceLines,
  evidenceSummaryLine,
  keepSessionRefusal,
  networkSummaryLine,
  recordingVariableNames,
  redactSecrets,
  repairTransactionLines,
  replayEnvArgs,
  resolveRemoteConfigPath,
  resolveSecrets,
  writeDeviceEvidence,
} from '@validity.ai/verify-native';
import type {
  AgentDeviceReplayOutcome,
  AgentDeviceReplayResult,
  CommandRunner,
  DeviceEvidence,
  ReplayDivergenceReport,
  ResolvedSecret,
} from '@validity.ai/verify-native';
import { checkSpecHash, readRunMetaAt, resolveRunDir } from './attest.js';
import { discoverNativeRun, resolveNativePlatform } from './verify-all.js';
import { verifyOneSpec } from '../verify-engine.js';
import { verifyOneSpecNative } from '../native-verify-engine.js';
import { recentRunIds } from './recent-runs.js';

/* ------------------------------------------------------------------ *
 * Exit codes + result shapes.                                         *
 * ------------------------------------------------------------------ */

export const REPLAY_EXIT_OK = 0;
export const REPLAY_EXIT_REGRESSED = 1;
export const REPLAY_EXIT_USAGE = 2;
/** Deliberately the same number as `verify --all`'s EXIT_UNFINISHED. */
export const REPLAY_EXIT_INCOMPLETE = 3;

/** The receipt line. One string so the CLI, the JSON, and the tests agree. */
export const REPLAY_RECEIPT = 're-verified deterministically — 0 LLM tokens';

type Status = 'pass' | 'fail' | 'unverifiable';

/** Per-criterion comparison of the re-executed verdict against the attested one. */
export type ReplayOutcome = 'reproduced' | 'regressed' | 'improved' | 'unverifiable-now';

export type ReplayVerdict = 'reproduced' | 'regressed' | 'incomplete' | 'attestation-failed';

/** One deterministic (hard/property) criterion, attested vs. re-executed. */
export interface ReplayCriterion {
  id: string;
  tier: Exclude<CriterionTier, 'soft'>;
  /** Status recorded in the SIGNED payload. Null when the run never carried it. */
  attested: Status | null;
  /** Status produced by this replay. Null when the check could not be executed. */
  replayed: Status | null;
  outcome: ReplayOutcome;
  /** Why the comparison is not a clean two-verdict diff (missing on either side). */
  note?: string;
  /** The re-executed check's own detail line, verbatim from the engine. */
  detail?: string;
}

/**
 * One soft criterion. It is REPORTED, never re-executed — replay has no model.
 * Everything here comes from the signed payload, so the provenance a reader sees
 * is the provenance that was attested.
 */
export interface ReplaySoftCriterion {
  id: string;
  attested: Status;
  scoredBy?: ScorerProvenance;
  taints: EvidenceTaint[];
  /** Constant, printed verbatim — the lane, not a verdict. */
  lane: 'judged lane, not replayed';
}

/**
 * The on-device half of a native replay: what happened when the run's signed
 * `.ad` recording was handed back to agent-device.
 *
 * Reported as its own block rather than folded into the criteria table because
 * it answers a different question. The criteria table asks "do the compiled
 * checks still hold against the working tree?"; this asks "does the recorded
 * JOURNEY still reach its landmark on a real device?" — a claim no compiled
 * check makes, and the only part of a native run a reviewer can re-run with
 * their own eyes on the screen.
 */
export interface ReplayRecording {
  /** Run-dir-relative path of the `.ad` that was (or would have been) replayed. */
  file?: string;
  outcome: AgentDeviceReplayOutcome;
  /** One line in the product's register, printed verbatim. */
  notice: string;
  /** agent-device's own error code, when it failed. */
  errorCode?: string;
  /**
   * The 0.20.5 bounded divergence report, when the journey diverged and
   * upstream built one. Persisted next to the run's evidence as well — see
   * {@link REPLAY_DIVERGENCE_FILENAME}.
   */
  divergence?: ReplayDivergenceReport;
  /** Run-dir-relative path of the persisted divergence report, when one was written. */
  divergenceFile?: string;
  /** True when `--keep-session` was forwarded (the session survives the replay). */
  keptSession?: boolean;
  /**
   * Post-journey device evidence (perf metrics, frame health, network dump).
   * ADVISORY ONLY — captured, labelled, never scored. Only collected when the
   * session was kept alive; a completed replay tears its session down and
   * there would be nothing to attach to.
   */
  evidence?: DeviceEvidence[];
  /** Run-dir-relative path of the persisted evidence bundle, when one was written. */
  evidenceFile?: string;
}

/**
 * The divergence report a replay leaves in the run dir.
 *
 * UNSIGNED BY CONSTRUCTION, and named so: it is written AFTER the run was
 * attested, by a command the run's key never authorized. It is a note about a
 * later observation that happens to live beside the evidence it refers to —
 * not part of the attested set (nothing in `verifyRunAttestation` reads it, and
 * an extra file in a run dir is not a chain finding).
 */
export const REPLAY_DIVERGENCE_FILENAME = 'replay-divergence.json';

/** Post-journey device evidence bundle written by a `--keep-session` replay. */
export const REPLAY_DEVICE_EVIDENCE_FILENAME = 'replay-device-evidence.json';

/**
 * The durable drift ledger for the on-device journey lane: one append-only row
 * per observed divergence, project-wide.
 *
 * Deliberately NOT `.validity/history/signals.jsonl`. That feed is the
 * scorecard's transition ledger — every row there is an open/resolve pair whose
 * id the signal engine owns, and an id nothing can ever resolve would inflate
 * the dashboard's open-signal count forever. A journey divergence has no
 * resolver today (replay is a manual command, not a watch tick), so it gets its
 * own append-only feed alongside `native-session-metrics.jsonl` and stays
 * honest about what it is. Folding it into the signal system is a scorecard
 * change, proposed rather than smuggled in here.
 */
export const REPLAY_DIVERGENCE_LEDGER_PATH = '.validity/runs/replay-divergence.jsonl';

/** One ledger row. Bounded — selectors only, never a screen dump. */
export interface ReplayDivergenceLedgerRow {
  v: 1;
  ts: string;
  runId?: string;
  specId?: string;
  /** The `.ad` that diverged, run-dir relative. */
  file: string;
  /** Run dir the divergence belongs to, project-root relative when possible. */
  dir: string;
  step?: number;
  kind?: string;
  action?: string;
  causeCode?: string;
  cause?: string;
  repairHint?: string;
  resume?: { allowed: boolean; from: number; planDigest: string };
  /** Ranked selector suggestions, selector text only. */
  suggestions: string[];
}

export interface ReplayCounts {
  reproduced: number;
  regressed: number;
  improved: number;
  unverifiableNow: number;
  judgedLane: number;
}

export interface ReplaySpecInfo {
  id: string;
  version: number;
  /** The hash of the spec we actually replayed. */
  hash?: string;
  /** The hash the attested run cited. */
  attestedHash?: string;
  /** True when the store moved past the attested hash (a warning, not tampering). */
  refrozen: boolean;
  /** `history` = the exact frozen version the run cited; `current` = the store's head. */
  source: 'history' | 'current';
  runtime: 'web' | 'native';
}

export interface ReplayResult {
  runId?: string;
  dir: string;
  verdict: ReplayVerdict;
  exitCode: number;
  /** One line stating the verdict in the product's own register. */
  headline: string;
  attestation: {
    ok: boolean;
    mismatches: AttestationMismatch[];
    warnings: AttestationMismatch[];
    digest?: string;
    publicKey?: string;
  };
  spec?: ReplaySpecInfo;
  /**
   * Native runs that carry a signed `.ad`: the outcome of re-executing it.
   * Absent for web runs, for native runs recorded before this existed, and for
   * native runs whose project turned recording off — none of which is a finding.
   */
  recording?: ReplayRecording;
  /** Present when the deterministic lane could not run at all (with the reason). */
  blocked?: string;
  criteria: ReplayCriterion[];
  soft: ReplaySoftCriterion[];
  counts: ReplayCounts;
  /** Always 0 — replay is deterministic by construction, not by policy. */
  llmTokens: 0;
  receipt: string;
}

/* ------------------------------------------------------------------ *
 * Pure: the per-criterion comparison.                                 *
 * ------------------------------------------------------------------ */

/**
 * Classify one criterion. Ordering is load-bearing and deliberately pessimistic:
 *
 *   - "could not execute" is checked FIRST, so an attested `unverifiable` that is
 *     still unverifiable reads as `unverifiable-now` rather than a comfortable
 *     "reproduced" — reproducing a non-result is not evidence of anything;
 *   - a criterion with nothing attested to compare against is `unverifiable-now`
 *     too, even when it passes now, because "reproduced" is a claim ABOUT THE
 *     ATTESTED RUN and there is no such claim to make;
 *   - only then do the two real verdicts get diffed.
 *
 * `regressed` covers attested-pass→fail AND attested-unverifiable→fail: the
 * second was never proven, but a hard check that fails against the working tree
 * is red however it got there, and never-false-green resolves ties toward red.
 */
export function classifyReplay(attested: Status | null, replayed: Status | null): ReplayOutcome {
  if (replayed === null || replayed === 'unverifiable') return 'unverifiable-now';
  if (attested === null) return 'unverifiable-now';
  if (attested === replayed) return 'reproduced';
  return replayed === 'fail' ? 'regressed' : 'improved';
}

/** Sum the outcomes. Pure — the gate and the summary line both read this. */
export function tallyReplay(
  criteria: ReplayCriterion[],
  soft: ReplaySoftCriterion[],
): ReplayCounts {
  return {
    reproduced: criteria.filter((c) => c.outcome === 'reproduced').length,
    regressed: criteria.filter((c) => c.outcome === 'regressed').length,
    improved: criteria.filter((c) => c.outcome === 'improved').length,
    unverifiableNow: criteria.filter((c) => c.outcome === 'unverifiable-now').length,
    judgedLane: soft.length,
  };
}

/**
 * The gate. `reproduced` demands a COMPLETE deterministic lane: every criterion
 * re-executed and landed on its attested verdict or better. An empty
 * deterministic lane is `incomplete`, not a vacuous pass — a spec of nothing but
 * soft criteria has nothing replayable, and saying "reproduced" about it would
 * be the purest false green this command could emit.
 */
export function replayVerdict(
  counts: ReplayCounts,
  recording?: ReplayRecording,
): { verdict: ReplayVerdict; exitCode: number } {
  // The `.ad` outcome is a FIRST-CLASS input to the gate, not a footnote. A
  // recorded journey that no longer reaches its landmark is a regression even
  // when every compiled check still passes — that is precisely the class of
  // break (a route moved, a screen stopped mounting) the deterministic lane
  // cannot see. And one that could not be re-executed cannot be counted as
  // reproduction, so it lands on `incomplete`.
  //
  // Absence is silent: a run without a recording gates exactly as it did
  // before recordings existed.
  if (counts.regressed > 0 || recording?.outcome === 'regressed') {
    return { verdict: 'regressed', exitCode: REPLAY_EXIT_REGRESSED };
  }
  if (
    counts.unverifiableNow > 0 ||
    counts.reproduced + counts.improved === 0 ||
    recording?.outcome === 'unverifiable-now'
  ) {
    return { verdict: 'incomplete', exitCode: REPLAY_EXIT_INCOMPLETE };
  }
  return { verdict: 'reproduced', exitCode: REPLAY_EXIT_OK };
}

/**
 * Join the frozen spec's criteria with the attested statuses and the re-executed
 * ones. Pure; the whole comparison is testable without a sandbox.
 *
 * Criteria are enumerated from the FROZEN SPEC (the contract), not from either
 * verdict list, so a criterion that the replay silently produced no verdict for
 * still appears — as `unverifiable-now`, never as an omission.
 */
export function compareReplay(args: {
  spec: Spec;
  attested: AttestedCriterion[];
  replayed: Array<{ id: string; status: Status; detail?: string }>;
  /** Set when the lane never ran (no device, render error) — the reason to print. */
  blockedReason?: string;
}): { criteria: ReplayCriterion[]; soft: ReplaySoftCriterion[] } {
  const attestedById = new Map(args.attested.map((c) => [c.id, c]));
  const replayedById = new Map(args.replayed.map((v) => [v.id, v]));
  const criteria: ReplayCriterion[] = [];
  const soft: ReplaySoftCriterion[] = [];

  for (const c of args.spec.criteria) {
    const a = attestedById.get(c.id);
    if (c.tier === 'soft') {
      soft.push({
        id: c.id,
        attested: a?.status ?? 'unverifiable',
        ...(a?.scoredBy ? { scoredBy: a.scoredBy } : {}),
        taints: a?.taints ?? [],
        lane: 'judged lane, not replayed',
      });
      continue;
    }
    const fresh = replayedById.get(c.id);
    const attested = a?.status ?? null;
    const replayed = fresh?.status ?? null;
    const notes: string[] = [];
    if (!a) {
      notes.push(
        `criterion "${c.id}" is in the frozen spec but carries no attested verdict — nothing to compare against`,
      );
    }
    if (!fresh) {
      notes.push(
        args.blockedReason ??
          'the replay produced no verdict for this criterion (it never executed)',
      );
    }
    criteria.push({
      id: c.id,
      tier: c.tier === 'property' ? 'property' : 'hard',
      attested,
      replayed,
      outcome: classifyReplay(attested, replayed),
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      ...(fresh?.detail ? { detail: fresh.detail } : {}),
    });
  }
  return { criteria, soft };
}

/* ------------------------------------------------------------------ *
 * Pure: loading the frozen contract by specHash.                      *
 * ------------------------------------------------------------------ */

export interface ReplaySpecLoad {
  spec: Spec | null;
  info?: ReplaySpecInfo;
  warnings: AttestationMismatch[];
  /** Set when `spec` is null — why this run cannot be replayed at all. */
  reason?: string;
}

/**
 * Resolve the contract to re-execute from the SIGNED payload's spec identity.
 *
 * Prefer the exact frozen version the run cited (`history/`), because that is
 * the contract the attested verdicts were produced against. Fall back to the
 * store's current spec only when history has nothing — and when that current
 * spec no longer hashes to the attested hash, say so as a WARNING and keep
 * going, exactly as `attest verify` treats a re-freeze: the run's evidence is
 * untouched, the contract simply moved on. (In-place EDITING of a frozen spec is
 * a different animal and is caught upstream by `checkSpecHash`, which fails the
 * attestation before we ever get here.)
 */
export function loadReplaySpec(projectRoot: string, payload: AttestationPayload): ReplaySpecLoad {
  const warnings: AttestationMismatch[] = [];
  const { specId, specHash, specVersion } = payload;
  if (!specId) {
    return {
      spec: null,
      warnings,
      reason:
        'this run was not bound to a frozen spec (no specId in the signed payload) — there is no contract to re-execute. Freeze a spec and re-verify to make the run replayable.',
    };
  }

  let spec: Spec | null = null;
  let source: 'history' | 'current' = 'history';
  try {
    spec = specVersion != null ? readSpecVersion(projectRoot, specId, specVersion) : null;
    if (!spec) {
      spec = readSpec(projectRoot, specId);
      source = 'current';
    }
  } catch (err) {
    return {
      spec: null,
      warnings,
      reason: `spec ${specId} could not be loaded (${(err as Error).message}) — nothing to re-execute.`,
    };
  }
  if (!spec) {
    return {
      spec: null,
      warnings,
      reason: `spec ${specId} is no longer in the spec store — the contract this run was scored against is gone, so nothing can be re-executed.`,
    };
  }

  const refrozen = Boolean(specHash) && spec.hash !== specHash;
  if (refrozen) {
    warnings.push({
      field: `spec:${specId}`,
      detail:
        `spec ${specId} now hashes to ${spec.hash ?? '(unfrozen)'} but this run was verified against ` +
        `${specHash} — the spec was re-frozen since, and v${specVersion ?? '?'} is not in history/. ` +
        `Replaying against the CURRENT contract (v${spec.version}): criteria that only exist on one ` +
        `side cannot be compared and are reported as unverifiable-now, never as reproduced.`,
    });
  }

  return {
    spec,
    warnings,
    info: {
      id: spec.id,
      version: spec.version,
      ...(spec.hash ? { hash: spec.hash } : {}),
      ...(specHash ? { attestedHash: specHash } : {}),
      refrozen,
      source,
      runtime: spec.runtime === 'native' ? 'native' : 'web',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pure: target resolution.                                            *
 * ------------------------------------------------------------------ */

/**
 * Accept what a reviewer actually has in hand: the run dir, a bare run id, or
 * the `report.html` they were sent (any file INSIDE the run dir works — the
 * report is the artifact people forward, not the directory it lives in).
 */
export function resolveReplayTarget(projectRoot: string, target: string): string | null {
  const asPath = resolve(projectRoot, target);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    const dir = dirname(asPath);
    return existsSync(resolve(dir, 'run-meta.json')) ? dir : null;
  }
  return resolveRunDir(projectRoot, target);
}

/* ------------------------------------------------------------------ *
 * Pure: rendering.                                                    *
 * ------------------------------------------------------------------ */

/**
 * What a native run with no `.ad` gets told. Not a warning: web runs never have
 * one, recording is opt-out, and upstream permits ONE recording per device
 * session — so in a sweep most native runs legitimately have none.
 */
const NO_RECORDING =
  'this native run carries no `.ad` replay recording, so there is no on-device journey to re-execute. ' +
  'Recordings are written by native verifies on agent-device 0.20.5+ unless `native.recordReplay: false`; ' +
  'one is produced per device SESSION, so in a `verify --all` sweep it lands in the run dir of the spec that opened it.';

/* ------------------------------------------------------------------ *
 * Divergence persistence (best-effort — evidence, never a gate input).*
 * ------------------------------------------------------------------ */

/**
 * Build the ledger row for one divergence. PURE, and bounded on purpose: the
 * full screen digest lives in the run-dir report, the ledger carries only what
 * a "what has been drifting" question needs.
 */
export function divergenceLedgerRow(args: {
  report: ReplayDivergenceReport;
  at: string;
  dir: string;
  file: string;
  runId?: string;
  specId?: string;
}): ReplayDivergenceLedgerRow {
  const { report } = args;
  return {
    v: 1,
    ts: args.at,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.specId ? { specId: args.specId } : {}),
    file: args.file,
    dir: args.dir,
    ...(report.step === undefined ? {} : { step: report.step }),
    ...(report.kind ? { kind: report.kind } : {}),
    ...(report.action ? { action: report.action } : {}),
    ...(report.cause?.code ? { causeCode: report.cause.code } : {}),
    ...(report.cause?.message ? { cause: report.cause.message } : {}),
    ...(report.repairHint ? { repairHint: report.repairHint } : {}),
    ...(report.resume
      ? {
          resume: {
            allowed: report.resume.allowed,
            from: report.resume.from,
            planDigest: report.resume.planDigest,
          },
        }
      : {}),
    suggestions: report.suggestions.map((s) => s.selector),
  };
}

/**
 * The one-line `detail` a `replay-divergence` signal carries into the inbox.
 *
 * Deliberately SHORT and non-quoting: the signal is a pointer, and the evidence
 * it points at (the run-dir report, the ledger row) already carries the ranked
 * suggestions, the resume handle, and the screen digest. Device text is not
 * re-quoted here — the report is where redaction was applied, and an inbox row
 * is not the place to re-derive it. Pure, so the copy is testable.
 */
export function replayDivergenceSignalDetail(report: ReplayDivergenceReport, file: string): string {
  const where = report.step === undefined ? '' : ` at step ${report.step}`;
  const what = report.action ? ` (${report.action})` : '';
  const why = report.cause?.code
    ? ` — ${report.cause.code}`
    : report.kind
      ? ` — ${report.kind}`
      : '';
  return (
    `the recorded on-device journey \`${file}\` no longer reaches its landmark${where}${what}${why}. ` +
    `Full report: ${REPLAY_DIVERGENCE_FILENAME} in the run dir (also appended to ${REPLAY_DIVERGENCE_LEDGER_PATH}). ` +
    'Closes when a later replay of this recording reproduces, or when a fresh verify publishes a new signed recording for this spec.'
  );
}

/**
 * Persist the report into the run dir and append the ledger row.
 *
 * BEST-EFFORT on both halves — a read-only run dir must not turn a divergence
 * (already the interesting result) into a crash. Returns the run-dir-relative
 * filename when the report was written, so the result can point at it.
 */
function persistDivergence(args: {
  projectRoot: string;
  dir: string;
  report: ReplayDivergenceReport;
  file: string;
  runId?: string;
  specId?: string;
  at: string;
}): string | undefined {
  const row = divergenceLedgerRow(args);
  let written: string | undefined;
  try {
    const path = resolve(args.dir, REPLAY_DIVERGENCE_FILENAME);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema: 1,
          note:
            'Written by `validity replay` AFTER this run was signed — an observation about a later ' +
            "replay, not part of the run's attested evidence. Suggestions and the resume handle come " +
            'from agent-device; Validity never acts on them (see the repair transaction in the CLI output).',
          observedAt: args.at,
          runId: args.runId,
          specId: args.specId,
          recording: args.file,
          divergence: args.report,
        },
        null,
        2,
      )}\n`,
    );
    written = REPLAY_DIVERGENCE_FILENAME;
  } catch {
    /* evidence is never load-bearing */
  }
  try {
    const ledger = resolve(args.projectRoot, REPLAY_DIVERGENCE_LEDGER_PATH);
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(row)}\n`);
  } catch {
    /* same */
  }
  return written;
}

function outcomeGlyph(outcome: ReplayOutcome): string {
  switch (outcome) {
    case 'reproduced':
      return pc.green('reproduced  ');
    case 'regressed':
      return pc.red('regressed   ');
    case 'improved':
      return pc.cyan('improved    ');
    case 'unverifiable-now':
      return pc.yellow('unverifiable');
  }
}

function statusWord(s: Status | null): string {
  return s ?? '—';
}

/** "criterion" / "criteria" — the count governing the noun is the TOTAL, not the subset. */
function noun(total: number): string {
  return total === 1 ? 'criterion' : 'criteria';
}

/** The verdict-first headline. Never says "reproduced" unless the lane is complete. */
export function replayHeadline(
  verdict: ReplayVerdict,
  counts: ReplayCounts,
  recording?: ReplayRecording,
): string {
  const deterministic =
    counts.reproduced + counts.regressed + counts.improved + counts.unverifiableNow;
  switch (verdict) {
    case 'attestation-failed':
      return 'NOT REPLAYED — the attestation chain is broken, so the attested verdicts cannot be trusted as a baseline.';
    case 'regressed':
      // The `.ad` can be the SOLE reason for red — a route that moved breaks the
      // recorded journey while every compiled check still passes. Saying "0 of N
      // criteria no longer hold" there would be both true and useless, so the
      // headline names the lane that actually went red.
      if (counts.regressed === 0 && recording?.outcome === 'regressed') {
        return (
          'REGRESSED — every deterministic criterion still holds, but the recorded on-device journey ' +
          'no longer reaches its landmark.'
        );
      }
      return (
        `REGRESSED — ${counts.regressed} of ${deterministic} deterministic ` +
        `${noun(deterministic)} no longer ${counts.regressed === 1 ? 'holds' : 'hold'} against the working tree.`
      );
    case 'incomplete':
      if (
        counts.unverifiableNow === 0 &&
        deterministic > 0 &&
        recording?.outcome === 'unverifiable-now'
      ) {
        return (
          `NOT REPRODUCED — all ${deterministic} deterministic ${noun(deterministic)} reproduced, ` +
          'but the recorded on-device journey could not be re-executed.'
        );
      }
      return deterministic === 0
        ? 'NOT REPRODUCED — this spec has no deterministic (hard/property) criteria, so there is nothing to replay.'
        : `NOT REPRODUCED — nothing regressed, but ${counts.unverifiableNow} of ${deterministic} ` +
            `deterministic ${noun(deterministic)} could not be re-executed.`;
    case 'reproduced':
      return (
        `REPRODUCED — all ${deterministic} deterministic ${noun(deterministic)} produced ` +
        `their attested verdict${counts.improved > 0 ? ` or better (${counts.improved} improved)` : ''}` +
        (recording?.outcome === 'reproduced'
          ? ', and the recorded on-device journey reached its landmark again'
          : '') +
        '.'
      );
  }
}

/** Render the whole result as the human console view. Pure. */
export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [];
  lines.push(`Run:    ${result.runId ?? '(unknown)'}`);
  lines.push(`Dir:    ${result.dir}`);
  if (result.spec) {
    const s = result.spec;
    lines.push(
      `Spec:   ${s.id}@v${s.version} ${pc.dim(
        `(${s.hash ?? 'unfrozen'}${s.source === 'history' ? ', the frozen version this run cited' : ', current store head'})`,
      )}`,
    );
  }
  if (result.attestation.digest) lines.push(`Digest: ${result.attestation.digest}`);
  if (result.attestation.publicKey) lines.push(`Key:    ${shortId(result.attestation.publicKey)}`);
  lines.push('');

  // Step (a) — the chain. Printed before anything else runs, because a broken
  // chain is where the command stops.
  if (result.attestation.ok) {
    lines.push(
      pc.green('  ✓ attestation valid') + pc.dim(' — every signed artifact is unmodified'),
    );
  } else {
    lines.push(
      pc.red(`  ✗ ATTESTATION FAILED — ${result.attestation.mismatches.length} mismatch(es):`),
    );
    for (const m of result.attestation.mismatches) {
      lines.push(`      ${pc.red('✗')} ${pc.bold(m.field)}: ${m.detail}`);
    }
  }
  for (const w of result.attestation.warnings) {
    lines.push(pc.yellow(`  warn  ${w.field}: ${w.detail}`));
  }
  lines.push('');

  if (result.blocked) {
    lines.push(pc.yellow(`  ${result.blocked}`));
    lines.push('');
  }

  const headline =
    result.verdict === 'reproduced'
      ? pc.green(pc.bold(result.headline))
      : result.verdict === 'regressed' || result.verdict === 'attestation-failed'
        ? pc.red(pc.bold(result.headline))
        : pc.yellow(pc.bold(result.headline));
  lines.push(headline);

  if (result.criteria.length > 0) {
    lines.push('');
    // Pad id + tier so the attested → replayed column lines up: the reader is
    // scanning for the one arrow that changed, and a ragged column hides it.
    const idWidth = Math.max(...result.criteria.map((c) => c.id.length));
    const tierWidth = Math.max(...result.criteria.map((c) => c.tier.length)) + 2;
    for (const c of result.criteria) {
      const arrow = `${statusWord(c.attested)} → ${statusWord(c.replayed)}`;
      lines.push(
        `  ${outcomeGlyph(c.outcome)}  ${c.id.padEnd(idWidth)} ` +
          `${pc.dim(`[${c.tier}]`.padEnd(tierWidth))}  ` +
          (c.detail ? `${pc.dim(arrow.padEnd(22))}  ${pc.dim(c.detail)}` : pc.dim(arrow)),
      );
      if (c.note) lines.push(`      ${pc.dim(c.note)}`);
    }
  }

  // The on-device lane. Printed after the criteria table because it is the
  // stronger claim and should be the last thing read before the receipt: the
  // table says the checks still compile to the same verdicts, this says the
  // journey still lands on the same screen.
  if (result.recording) {
    const r = result.recording;
    const glyph =
      r.outcome === 'reproduced'
        ? pc.green('reproduced  ')
        : r.outcome === 'regressed'
          ? pc.red('regressed   ')
          : pc.yellow('unverifiable');
    lines.push('');
    lines.push(pc.dim('  on-device recording (agent-device `.ad`, landmark-verified):'));
    lines.push(`    ${glyph}  ${r.file ?? REPLAY_RECORDING_FILENAME}`);
    lines.push(`      ${pc.dim(r.notice)}`);

    // The divergence report. Printed in full (bounded upstream at 5
    // suggestions) because this is the one place a reader can see WHAT the
    // device offered instead — and because the alternative, "see the JSON",
    // is how evidence goes unread.
    if (r.divergence) {
      lines.push('');
      for (const line of divergenceEvidenceLines(r.divergence)) {
        lines.push(`      ${pc.dim(line)}`);
      }
      const repair = repairTransactionLines(r.divergence, r.file ?? REPLAY_RECORDING_FILENAME);
      if (repair.length > 0) {
        lines.push('');
        lines.push(
          pc.dim(
            '      repair is a USER action — Validity never heals a recording it will then report on:',
          ),
        );
        for (const line of repair) lines.push(`      ${pc.dim(line)}`);
      }
      if (r.divergenceFile) {
        lines.push(
          `      ${pc.dim(`full report: ${r.divergenceFile} (also appended to ${REPLAY_DIVERGENCE_LEDGER_PATH})`)}`,
        );
      }
    }

    // Post-journey device evidence. Advisory by construction — the line says
    // what exists, never what it means.
    if (r.evidence && r.evidence.length > 0) {
      lines.push('');
      lines.push(
        pc.dim('      device evidence captured after the journey (advisory — nothing scores it):'),
      );
      for (const e of r.evidence) {
        lines.push(`        ${pc.dim(evidenceSummaryLine(e))}`);
        const net = e.kind === 'network-dump' ? networkSummaryLine(e) : undefined;
        if (net) lines.push(`          ${pc.dim(net)}`);
      }
      if (r.evidenceFile) lines.push(`        ${pc.dim(`written to ${r.evidenceFile}`)}`);
    }
  } else if (result.spec?.runtime === 'native') {
    lines.push('');
    lines.push(pc.dim(`  ${NO_RECORDING}`));
  }

  // Rule 2, made visible: the soft lane is listed with its provenance so a
  // reader can see exactly what replay did NOT re-check, and who did.
  if (result.soft.length > 0) {
    lines.push('');
    lines.push(pc.dim('  judged lane, not replayed (replay has no model and spends no tokens):'));
    for (const s of result.soft) {
      const who = s.scoredBy
        ? `scored by ${s.scoredBy.model ?? 'an unnamed model'} (session ${shortId(s.scoredBy.session)})`
        : 'no scorer provenance recorded';
      const taints = s.taints.length > 0 ? `, taints: ${s.taints.join(', ')}` : '';
      lines.push(`    ${s.id} ${pc.dim('[soft]')}  ${s.attested}  ${pc.dim(`${who}${taints}`)}`);
    }
  }

  lines.push('');
  lines.push(pc.dim(`Re-verified deterministically — 0 LLM tokens.`));
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Orchestrator (impure — boots the sandbox / attaches to a device).   *
 * ------------------------------------------------------------------ */

/** Injection seam for tests: the two verify engines and the adb/simctl runner. */
export interface ReplayDeps {
  verifyWeb?: typeof verifyOneSpec;
  verifyNative?: typeof verifyOneSpecNative;
  nativeDeviceRunner?: CommandRunner;
  /**
   * Re-execute a `.ad` recording. Injected so the classification can be tested
   * from fixtures — the mapping from agent-device's outcomes to replay's
   * vocabulary is the part worth testing, and it needs no device.
   */
  replayRecording?: (
    path: string,
    ctx: {
      platform: 'ios' | 'android';
      device: string;
      projectRoot: string;
      /** Forward `--keep-session` (native `.ad` only). */
      keepSession?: boolean;
      /** `-e NAME=value` pairs for the recording's `${NAME}` placeholders. */
      secrets?: ReadonlyArray<ResolvedSecret>;
    },
  ) => Promise<AgentDeviceReplayResult>;
  /**
   * Runner for the POST-JOURNEY evidence commands (`perf metrics|frames`,
   * `network dump`). Separate from `nativeDeviceRunner` (device discovery) so a
   * test can stub the evidence lane alone; defaults to the same runner.
   */
  evidenceRunner?: CommandRunner;
  /** Injected clock, so an evidence bundle is byte-comparable in tests. */
  now?: () => Date;
}

export interface ReplayOptions {
  cwd?: string;
  /** Emit the structured `ReplayResult` instead of the console view. */
  json?: boolean;
  /** Verify the chain against this key rather than the record's own. */
  publicKey?: string;
  /**
   * Leave the device session up after the `.ad` replay (`--keep-session`).
   *
   * Two things follow, and they are the whole reason the flag exists here:
   * the reviewer keeps the screen the journey landed on to look at, and
   * post-journey perf/network evidence has a session to attach to. Native
   * `.ad` only — see {@link keepSessionRefusal}.
   */
  keepSession?: boolean;
  deps?: ReplayDeps;
}

const NATIVE_NO_DEVICE =
  'native replay requires a booted device — the deterministic lane was NOT re-executed';

/**
 * Re-execute the deterministic lane of a NATIVE spec. Replay deliberately
 * ATTACHES ONLY: it never boots an emulator and never installs a companion, both
 * because a reviewer's `replay` should not mutate their device state and because
 * a stale companion would produce a confident red that says nothing about the
 * code. When there is no device — or the companion on it isn't current — the lane
 * is reported as not-run with a named reason, which lands every criterion on
 * `unverifiable-now` and the verdict on `incomplete`. Never a verdict we can't back.
 */
/**
 * Re-execute the run's signed `.ad` recording on the attached device.
 *
 * The signature check is not a formality here. Everything else `replay` does is
 * READ evidence; this hands a file on disk to a tool that will drive a real
 * device with it. So an unsigned or altered `.ad` is not executed at all — it
 * is reported as unverifiable, which is also what the full-chain check upstream
 * of this function would already have said.
 *
 * EXPORTED FOR TESTS: the secret gate, the keep-session refusal, the divergence
 * persistence and the evidence capture all live here, and reaching them through
 * `runReplay` would need a booted device plus a current companion. Everything it
 * touches is injected (`deps`), so it runs from fixtures.
 */
export async function replayRecordingOnDevice(args: {
  dir: string;
  projectRoot: string;
  platform: 'ios' | 'android';
  device: string;
  attestation: AttestationRecord;
  config: ValidityConfig;
  keepSession?: boolean;
  specId?: string;
  deps: ReplayDeps;
}): Promise<ReplayRecording | undefined> {
  const { dir, attestation } = args;
  const attested = attestation.recording;
  if (!attested) {
    // Distinguish "no recording" from "a recording nobody signed" — the second
    // is something to look at, the first is the ordinary case.
    if (!existsSync(resolve(dir, REPLAY_RECORDING_FILENAME))) return undefined;
    return {
      file: REPLAY_RECORDING_FILENAME,
      outcome: 'unverifiable-now',
      notice:
        `${REPLAY_RECORDING_FILENAME} is present but carries no signature — replay will not execute an ` +
        'unattested device script. Re-verify to produce a signed recording.',
    };
  }

  const abs = resolve(dir, attested.file);
  const check = verifyRecordingSignature(attested, sha256File(abs), attestation.publicKey);
  if (!check.ok) {
    return {
      file: attested.file,
      outcome: 'unverifiable-now',
      notice: `the recording was not executed — ${check.mismatches.map((m) => m.detail).join('; ')}`,
    };
  }

  // SECRETS. The `.ad` is the authority on what this replay NEEDS: a
  // secret-safe recording published `${NAME}` placeholders instead of the
  // literals, and those names are in the file. Config supplies the mapping to
  // an environment variable; the environment supplies the value. Nothing is
  // read from disk except the placeholder names.
  const declared = configuredSecrets(args.config.scenarios);
  // Only the secrets this recording REFERENCES matter; a declared-but-unused
  // secret is not a problem to report (and never leaves the environment).
  const { resolved } = resolveSecrets(declared, process.env);
  let referenced: string[] = [];
  try {
    referenced = recordingVariableNames(readFileSync(abs, 'utf-8'));
  } catch {
    // Unreadable here means unreadable for agent-device too; let the replay
    // itself report that rather than inventing a secrets problem.
  }
  const supplied = resolved.filter((s) => referenced.includes(s.name));
  // FAIL CLOSED: a placeholder with no value would be replayed as the literal
  // text `${NAME}` — a login that types "${PASSWORD}" and then reports on the
  // resulting screen. Refuse, name the variables, and stay `unverifiable-now`
  // (never a regression: the app is not what failed).
  const unmet = referenced.filter((name) => !resolved.some((s) => s.name === name));
  if (unmet.length > 0) {
    const how = unmet.map((name) => {
      const d = declared.find((x) => x.name === name);
      return d ? `${name} (env ${d.env})` : `${name} (declare it in scenarios[].secrets)`;
    });
    return {
      file: attested.file,
      outcome: 'unverifiable-now',
      notice:
        `the recording was NOT executed: it needs ${unmet.length === 1 ? 'the secret' : 'the secrets'} ` +
        `${how.join(', ')}, and nothing in the environment supplies ${unmet.length === 1 ? 'it' : 'them'}. ` +
        'Export the variable(s) and replay again — filling a field with the literal `${NAME}` and scoring ' +
        'the result would be a verdict about a placeholder, not about the app.',
    };
  }

  // `--keep-session` is native `.ad` only; refuse loudly rather than letting
  // agent-device reject it after the device has been claimed.
  const refusal = args.keepSession ? keepSessionRefusal(attested.file) : undefined;
  const keepSession = Boolean(args.keepSession) && refusal === undefined;

  // The real driver, not a bare spawn: `exec()` carries the session env, the
  // project-root cwd (half the session's identity — agent-device keys sessions
  // by cwd), the host timeout, and — when the project configured a remote
  // device profile — the `--remote-config` flag every other agent-device
  // command already gets (see NativeConfig.remote).
  const remoteConfigPath = resolveRemoteConfigPath(args.config.native, args.projectRoot);
  const run =
    args.deps.replayRecording ??
    ((path, ctx): Promise<AgentDeviceReplayResult> =>
      new AgentDeviceDriver({
        platform: ctx.platform,
        ...(ctx.device ? { device: ctx.device } : {}),
        projectRoot: ctx.projectRoot,
        cwd: ctx.projectRoot,
        ...(args.deps.nativeDeviceRunner ? { run: args.deps.nativeDeviceRunner } : {}),
        ...(remoteConfigPath ? { remoteConfigPath } : {}),
      }).replayRecording(path, {
        ...(ctx.keepSession ? { keepSession: true } : {}),
        env: replayEnvArgs(ctx.secrets ?? []),
        secrets: ctx.secrets ?? [],
      }));

  let outcome: AgentDeviceReplayResult;
  try {
    outcome = await run(abs, {
      platform: args.platform,
      device: args.device,
      projectRoot: args.projectRoot,
      ...(keepSession ? { keepSession: true } : {}),
      secrets: supplied,
    });
  } catch (err) {
    return {
      file: attested.file,
      outcome: 'unverifiable-now',
      notice: `the recording could not be handed to agent-device: ${redactSecrets((err as Error).message, supplied)}`,
    };
  }

  const at = (args.deps.now?.() ?? new Date()).toISOString();
  const divergenceFile = outcome.divergence
    ? persistDivergence({
        projectRoot: args.projectRoot,
        dir,
        report: outcome.divergence,
        file: attested.file,
        ...(attestation.payload.runId ? { runId: attestation.payload.runId } : {}),
        ...(args.specId ? { specId: args.specId } : {}),
        at,
      })
    : undefined;

  // The actionable STATE on top of the evidence above. The ledger records every
  // observation forever; the signal queue records what is CURRENTLY broken — and
  // the kind ships with both of its close paths (a reproducing replay right
  // here, a freshly published `.ad` inside `attestRecording`), so it drains
  // instead of inflating the dashboard's open count forever. That pair is the
  // whole reason the divergence ledger shipped without a signal.
  //
  // Requires a spec: a signal with nothing to hang on is not actionable by
  // anything. Best-effort by construction — `recordReplayDivergence` never
  // throws, so replay still prints its verdict when the queue cannot be written.
  if (args.specId) {
    if (outcome.divergence) {
      recordReplayDivergence(args.projectRoot, {
        specId: args.specId,
        recording: attested.file,
        outcome: 'diverged',
        detail: replayDivergenceSignalDetail(outcome.divergence, attested.file),
        now: at,
        ...(attestation.payload.runId ? { runId: attestation.payload.runId } : {}),
        ...(args.config.historyCommitted === true ? { historyCommitted: true } : {}),
      });
    } else if (outcome.outcome === 'reproduced') {
      recordReplayDivergence(args.projectRoot, {
        specId: args.specId,
        recording: attested.file,
        outcome: 'reproduced',
        detail: `the recorded on-device journey \`${attested.file}\` reached its landmark again on replay`,
        now: at,
        ...(args.config.historyCommitted === true ? { historyCommitted: true } : {}),
      });
    }
    // `unverifiable-now` deliberately does NOTHING in either direction: a
    // journey that could not be re-executed (no device, unmet secret, unsigned
    // `.ad`) is not evidence that anything broke, and absence of measurement is
    // never recovery. Same no-launder rule perf drift follows.
  }

  // POST-JOURNEY EVIDENCE. Only with a kept session: a replay that ends
  // normally tears its session down, and issuing `perf metrics` at nothing
  // would collect a directory of SESSION_NOT_FOUND records that look like
  // findings. When the session IS kept, capture and label — never score.
  let evidence: DeviceEvidence[] | undefined;
  let evidenceFile: string | undefined;
  if (keepSession) {
    const runner = args.deps.evidenceRunner ?? args.deps.nativeDeviceRunner ?? defaultRunner;
    const ctx = {
      run: runner,
      platform: args.platform,
      device: args.device,
      cwd: args.projectRoot,
      redact: (s: string) => redactSecrets(s, supplied),
      ...(args.deps.now ? { now: args.deps.now } : {}),
    };
    const perf = await collectPerfEvidence(ctx);
    const network = await collectNetworkEvidence(ctx);
    evidence = [perf.metrics, perf.frames, network];
    if (writeDeviceEvidence(resolve(dir, REPLAY_DEVICE_EVIDENCE_FILENAME), evidence)) {
      evidenceFile = REPLAY_DEVICE_EVIDENCE_FILENAME;
    }
  }

  return {
    file: attested.file,
    outcome: outcome.outcome,
    notice: refusal ? `${outcome.notice} (${refusal})` : outcome.notice,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.divergence ? { divergence: outcome.divergence } : {}),
    ...(divergenceFile ? { divergenceFile } : {}),
    ...(keepSession ? { keptSession: true } : {}),
    ...(evidence ? { evidence } : {}),
    ...(evidenceFile ? { evidenceFile } : {}),
  };
}

async function replayNative(args: {
  projectRoot: string;
  config: ValidityConfig;
  spec: Spec;
  dir: string;
  attestation: AttestationRecord;
  keepSession?: boolean;
  deps: ReplayDeps;
}): Promise<{
  verdicts: Array<{ id: string; status: Status; detail?: string }>;
  blocked?: string;
  recording?: ReplayRecording;
}> {
  const { projectRoot, config, spec, deps } = args;
  // Every attach-only refusal below reports the recording lane too, so a reader
  // (and `--json`) sees WHY the on-device journey was not re-run rather than
  // silently seeing no recording block at all. Nothing to say when the run
  // never had a recording.
  const notReplayed = (reason: string): { recording?: ReplayRecording } =>
    args.attestation.recording
      ? {
          recording: {
            file: args.attestation.recording.file,
            outcome: 'unverifiable-now',
            notice: `the recorded on-device journey was not re-executed: ${reason}`,
          },
        }
      : {};
  const platform = resolveNativePlatform(config);
  const discovery = await discoverNativeRun(
    projectRoot,
    platform,
    undefined,
    deps.nativeDeviceRunner ?? defaultRunner,
  );
  if (!discovery.ok) {
    const label = platform === 'ios' ? 'iOS Simulator' : 'Android device';
    const blocked =
      `${NATIVE_NO_DEVICE}. Auto-discovery found no booted ${label}` +
      (platform === 'android' && !discovery.apk ? ' and no companion APK on disk' : '') +
      `. Boot one (${platform === 'ios' ? 'open Simulator.app' : 'emulator -avd <name>'}) and run ` +
      `\`validity browse --native\` to install the companion, then replay again.`;
    return { verdicts: [], blocked, ...notReplayed(`no booted ${label} to attach to`) };
  }

  // The companion must already be current on the attached device. Replay does
  // not install: a reviewer's command must not rewrite their device, and an
  // install force-stops the app (see the verify --all note) which is exactly how
  // "every Android verify starts on the dev-launcher home" happened.
  try {
    const identity = companionBuildIdentity({ projectRoot, config, platform });
    const readiness = await checkNativeReadiness({
      projectRoot,
      platform,
      scheme: identity.scheme,
      bundleId: identity.bundleId,
      device: discovery.deviceId,
      buildHash: identity.buildHash,
      buildMarkerPath: identity.buildMarkerPath,
      buildInputs: identity.buildInputs,
    });
    if (readiness.steps.find((s) => s.id === 'companion-app')?.status !== 'ok') {
      return {
        verdicts: [],
        blocked:
          `${NATIVE_NO_DEVICE}. ${discovery.deviceId} is booted but the Validity companion on it is not current ` +
          `(${readiness.nextAction?.label ?? 'unmet prerequisite'}) — replay never installs, so it will not ` +
          `re-execute against a stale build and call the result a verdict. Run \`validity browse --native\`, then replay again.`,
        ...notReplayed(
          `the companion on ${discovery.deviceId} is not current, and replay never installs`,
        ),
      };
    }
  } catch (err) {
    return {
      verdicts: [],
      blocked: `${NATIVE_NO_DEVICE}. Device readiness could not be established: ${(err as Error).message}`,
      ...notReplayed(`device readiness could not be established (${(err as Error).message})`),
    };
  }

  // The `.ad` runs FIRST, while the device is in the state the run left it —
  // before the deterministic lane re-navigates and starts clicking. Replaying
  // the recorded journey after the check executor had already driven the app
  // would be replaying it from a screen the recording never started on.
  const recording = await replayRecordingOnDevice({
    dir: args.dir,
    projectRoot,
    platform,
    device: discovery.deviceId,
    attestation: args.attestation,
    config,
    specId: spec.id,
    ...(args.keepSession ? { keepSession: true } : {}),
    deps,
  });

  const verifyNative = args.deps.verifyNative ?? verifyOneSpecNative;
  const v = await verifyNative(
    projectRoot,
    config,
    spec,
    {
      deviceId: discovery.deviceId,
      port: discovery.port,
      platform,
      ...(discovery.deviceName ? { deviceName: discovery.deviceName } : {}),
      ...(discovery.osVersion ? { osVersion: discovery.osVersion } : {}),
    },
    { commandRunner: new CommandCheckRunner() },
  );
  if (v.error) {
    return {
      verdicts: [],
      blocked: `the deterministic lane did not run on ${discovery.deviceId}: ${v.error}`,
      ...(recording ? { recording } : {}),
    };
  }
  return {
    verdicts: v.mechanical.map((m) => ({ id: m.id, status: m.status, detail: m.detail })),
    ...(recording ? { recording } : {}),
  };
}

export async function runReplay(target: string, opts: ReplayOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const deps = opts.deps ?? {};
  const emit = (result: ReplayResult): void => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatReplay(result));
    }
    if (result.exitCode !== 0) process.exit(result.exitCode);
  };

  if (!target) {
    process.stderr.write(
      pc.red(
        'error: a run dir, run id, or report.html path is required (e.g. `validity replay .validity/runs/<run-id>`).\n',
      ),
    );
    process.exit(REPLAY_EXIT_USAGE);
    return;
  }
  const dir = resolveReplayTarget(projectRoot, target);
  if (!dir) {
    process.stderr.write(
      pc.red(
        `error: no run dir found for "${target}" (a run dir, run id, or a file inside one).\n`,
      ),
    );
    const known = recentRunIds(projectRoot);
    if (known.length > 0) {
      process.stderr.write('  Known run ids (newest first):\n');
      for (const id of known) process.stderr.write(`    ${id}\n`);
    }
    process.exit(REPLAY_EXIT_USAGE);
    return;
  }

  // --- (a) Attestation. Same call, same spec check, same named mismatches as
  // `attest verify` — replay is that command plus re-execution, not a fork of it.
  const attestation = verifyRunAttestation({
    dir,
    runMeta: readRunMetaAt(dir),
    publicKey: opts.publicKey,
    specCheck: (payload) => checkSpecHash(projectRoot, payload),
  });

  const base = {
    runId: attestation.runId,
    dir,
    attestation: {
      ok: attestation.ok,
      mismatches: attestation.mismatches,
      warnings: attestation.warnings,
      ...(attestation.record ? { digest: attestation.record.digest } : {}),
      ...(attestation.record ? { publicKey: attestation.record.publicKey } : {}),
    },
    criteria: [] as ReplayCriterion[],
    soft: [] as ReplaySoftCriterion[],
    llmTokens: 0 as const,
    receipt: REPLAY_RECEIPT,
  };
  const emptyCounts = tallyReplay([], []);

  // SHORT-CIRCUIT. Re-executing now would produce fresh verdicts diffed against
  // an untrustworthy baseline, and printing "reproduced" over a tampered run is
  // the worst output this command could have.
  if (!attestation.ok || !attestation.record) {
    emit({
      ...base,
      verdict: 'attestation-failed',
      exitCode: REPLAY_EXIT_REGRESSED,
      headline: replayHeadline('attestation-failed', emptyCounts),
      counts: emptyCounts,
    });
    return;
  }

  // --- (b) The frozen contract, by specHash.
  const payload = attestation.record.payload;
  const loaded = loadReplaySpec(projectRoot, payload);
  base.attestation.warnings = [...attestation.warnings, ...loaded.warnings];
  if (!loaded.spec || !loaded.info) {
    emit({
      ...base,
      verdict: 'incomplete',
      exitCode: REPLAY_EXIT_INCOMPLETE,
      headline: replayHeadline('incomplete', emptyCounts),
      blocked: loaded.reason,
      counts: emptyCounts,
    });
    return;
  }
  const spec = loaded.spec;

  let config: ValidityConfig;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(REPLAY_EXIT_USAGE);
    return;
  }

  // --- (c) Re-execute the DETERMINISTIC lane only, through the same engines
  // `verify --all` drives. Soft criteria are not passed anywhere near a model —
  // there is no model here.
  if (!opts.json) {
    process.stderr.write(
      pc.dim(
        `Re-executing the deterministic lane of ${spec.id}@v${spec.version} ` +
          `against the working tree at ${projectRoot}…\n`,
      ),
    );
  }
  let verdicts: Array<{ id: string; status: Status; detail?: string }> = [];
  let blocked: string | undefined;
  let recording: ReplayRecording | undefined;
  if (loaded.info.runtime === 'native') {
    const res = await replayNative({
      projectRoot,
      config,
      spec,
      dir,
      attestation: attestation.record,
      ...(opts.keepSession ? { keepSession: true } : {}),
      deps,
    });
    verdicts = res.verdicts;
    blocked = res.blocked;
    recording = res.recording;
  } else {
    // `--keep-session` is a DEVICE-session flag. A web replay has no device
    // session to keep, and quietly accepting the flag would leave a user
    // believing something was held open for them.
    if (opts.keepSession) {
      process.stderr.write(
        pc.yellow(
          'note: --keep-session applies to native `.ad` recordings only — this is a web run, ' +
            'so nothing was forwarded (the replay itself is unaffected).\n',
        ),
      );
    }
    const verifyWeb = deps.verifyWeb ?? verifyOneSpec;
    const v = await verifyWeb(projectRoot, config, spec, {
      commandRunner: new CommandCheckRunner(),
    });
    if (v.error) {
      blocked = `the deterministic lane did not run: ${v.error}`;
    } else {
      verdicts = v.mechanical.map((m) => ({ id: m.id, status: m.status, detail: m.detail }));
    }
  }

  // --- (d) Compare, per criterion.
  const { criteria, soft } = compareReplay({
    spec,
    attested: payload.criteria,
    replayed: verdicts,
    blockedReason: blocked,
  });
  // Soft provenance is taken from the SIGNED payload, but fold the taint
  // normalizer over it anyway so legacy `networkTainted` runs read the same as
  // modern ones (`evidenceTaintsOf` is the single source of that truth).
  for (const s of soft) s.taints = [...evidenceTaintsOf({ evidenceTaints: s.taints })].sort();

  const counts = tallyReplay(criteria, soft);
  const { verdict, exitCode } = replayVerdict(counts, recording);
  emit({
    ...base,
    verdict,
    exitCode,
    headline: replayHeadline(verdict, counts, recording),
    spec: loaded.info,
    ...(recording ? { recording } : {}),
    ...(blocked ? { blocked } : {}),
    criteria,
    soft,
    counts,
  });
}
