/**
 * In-band recovery for a DECAYED companion Metro — the auto-heal for the one
 * decay layer that has been isolated.
 *
 * PROVENANCE (2026-07-29 decay-isolation experiment, 18 consecutive sweeps of
 * 13 specs against one continuously-running emulator): the sweep collapses from
 * 37 pass to 4 after roughly 40-50 device opens past a Metro restart, and stays
 * collapsed. Killing the agent-device daemon and wiping its sessions/claims
 * mid-collapse recovered NOTHING across two further sweeps; the emulator was
 * never reset at all and spanned both states. Restarting Metro — and only
 * restarting Metro — recovered the sweep immediately and completely, twice.
 * See {@link detectMetroDecay} in environment-diagnosis.ts for the signature and
 * `metroManagedRestartCommand` for the restart this automates.
 *
 * Until now that restart was a sentence printed to a human. This module is the
 * decision layer that lets the verify loop perform it itself, and — just as
 * importantly — the bookkeeping that stops it from performing it over and over.
 * Everything here is PURE (decisions) or a bounded filesystem read/write
 * (journal); the actual kill+respawn stays in `ensureCompanionMetro`, which
 * already does it verified, because a second way to restart Metro is a second
 * way to get it wrong.
 *
 * TWO TRIGGERS, ONE BUDGET:
 *
 *   - REACTIVE ({@link decideMetroHeal}) — a capture came back with a
 *     `metro-decayed` diagnosis. Restart, then retry that capture ONCE.
 *   - PREVENTIVE ({@link decidePreventiveRecycle}) — this bundler has served
 *     more captures than the measured cliff allows. Recycle before the cliff,
 *     so an unattended sweep never reaches it.
 *
 * Both draw on the same per-process budget ({@link noteMetroAutoRestart}), so a
 * collapsed sweep restarts Metro at most once and then reports honestly instead
 * of thrashing a bundler that is not the problem.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* -------------------------------------------------------------------------- */
/* the heal journal                                                            */
/* -------------------------------------------------------------------------- */

/** What Validity did to this bundler last, and whether it worked. */
export interface MetroHealRecord {
  /** ISO timestamp of the restart. */
  ts: string;
  /** Which trigger fired it. */
  trigger: MetroRestartTrigger;
  /**
   * Whether the restart actually recovered the run. Written PESSIMISTICALLY as
   * `failed` at restart time and upgraded to `recovered` only once a capture
   * confirms — so a host process killed mid-heal leaves behind the bounding
   * state, never an optimistic one that would let the next run restart again.
   */
  outcome: 'recovered' | 'failed';
  /** The spec whose capture triggered/followed the restart, when known. */
  specId?: string;
  /**
   * Captures this bundler had served when it was recycled (preventive trigger).
   * Recorded so a threshold that turns out to be wrong can be re-derived from
   * real runs rather than re-argued.
   */
  capturesOnBundler?: number;
  /**
   * Start of the CURRENT bundler epoch — the clock the preventive trigger
   * counts captures against. Reset on every Validity-managed restart, and
   * initialized on first sighting when Metro was brought up by something else
   * (the `expo run` build leaves a bundler running with no owner marker).
   */
  bundlerEpochStartedAt?: string;
}

export const METRO_HEAL_JOURNAL_NAME = '.validity-metro-heal.json';

/** Where the journal lives — beside the content/owner markers in the companion app dir. */
export function metroHealJournalPath(appDir: string): string {
  return resolve(appDir, METRO_HEAL_JOURNAL_NAME);
}

/** Injectable filesystem, so every decision path is testable without a disk. */
export interface HealJournalFs {
  readFile: (path: string) => string;
  writeFile: (path: string, body: string) => void;
  remove: (path: string) => void;
}

export const realHealJournalFs: HealJournalFs = {
  readFile: (p) => readFileSync(p, 'utf-8'),
  writeFile: (p, body) => writeFileSync(p, body),
  remove: (p) => rmSync(p, { force: true }),
};

/**
 * Read the journal. Absent/unreadable/malformed → null, which every caller
 * reads as "no heal on record" — the permissive direction, because refusing to
 * heal over an unparseable bookkeeping file would let one bad write disable the
 * recovery permanently.
 */
export function readMetroHealRecord(
  appDir: string,
  fs: HealJournalFs = realHealJournalFs,
): MetroHealRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFile(metroHealJournalPath(appDir)));
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Partial<MetroHealRecord>;
    if (typeof r.ts !== 'string') return null;
    return {
      ts: r.ts,
      trigger: r.trigger === 'preventive' ? 'preventive' : 'decay-diagnosis',
      outcome: r.outcome === 'recovered' ? 'recovered' : 'failed',
      specId: typeof r.specId === 'string' ? r.specId : undefined,
      capturesOnBundler: typeof r.capturesOnBundler === 'number' ? r.capturesOnBundler : undefined,
      bundlerEpochStartedAt:
        typeof r.bundlerEpochStartedAt === 'string' ? r.bundlerEpochStartedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** Persist the journal. Best-effort: bookkeeping must never fail a verify. */
export function writeMetroHealRecord(
  appDir: string,
  record: MetroHealRecord,
  fs: HealJournalFs = realHealJournalFs,
): void {
  try {
    fs.writeFile(metroHealJournalPath(appDir), JSON.stringify(record));
  } catch {
    /* an unwritable app dir is not a verdict */
  }
}

/* -------------------------------------------------------------------------- */
/* per-process budget                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Auto-restarts one host process may perform. ONE, deliberately: a `verify
 * --all` sweep is a single process, and the failure this guards against is a
 * collapsed sweep whose every spec diagnoses `metro-decayed` in turn. The first
 * one restarts and retries; the rest must report the truth rather than each
 * kick the bundler again. A fresh sweep is a fresh process and gets a fresh
 * budget, which is what makes an unattended loop able to recover twice without
 * ever being able to thrash.
 */
export const MAX_METRO_AUTO_RESTARTS_PER_PROCESS = 1;

let autoRestarts = 0;

/** Record that an auto-restart was performed. Returns the new count. */
export function noteMetroAutoRestart(): number {
  autoRestarts += 1;
  return autoRestarts;
}

/** Auto-restarts performed by this process so far. */
export function metroAutoRestartCount(): number {
  return autoRestarts;
}

/** Reset the budget (tests; a caller that genuinely starts a new run). */
export function resetMetroAutoRestartCount(): void {
  autoRestarts = 0;
}

/* -------------------------------------------------------------------------- */
/* the reactive decision                                                       */
/* -------------------------------------------------------------------------- */

export type MetroRestartTrigger = 'decay-diagnosis' | 'preventive';

export interface MetroHealDecision {
  /** Restart Metro and retry the capture once. */
  heal: boolean;
  /**
   * Why — in the words the run will print. Populated on BOTH answers: a refusal
   * is the honest half of this feature, and "Validity already restarted the
   * bundler once and it did not help" is the sentence that stops a developer
   * from spending an hour on the bundler.
   */
  reason: string;
}

export interface MetroHealInput {
  /** The cause the capture's diagnosis landed on. */
  diagnosisCause?: string;
  /** {@link metroAutoRestartCount} for this process. */
  restartsSoFar: number;
  /** The last recorded heal, or null. */
  lastHeal: MetroHealRecord | null;
  /**
   * Has ANY capture confirmed since {@link MetroHealRecord.ts}? This is what
   * ends a collapse episode: a failed heal blocks further heals until the
   * environment demonstrably recovered (by a later heal, or by a human), so an
   * unattended loop restarts a genuinely-broken Metro exactly once.
   */
  confirmedSinceLastHeal: boolean;
  maxRestarts?: number;
}

/**
 * Should this capture's `metro-decayed` diagnosis trigger the managed restart?
 *
 * PURE. Three refusals, each closing a different way this could turn into a
 * restart loop:
 *
 *   1. the diagnosis is not `metro-decayed` — every other cause has its own
 *      (different) remedy, and restarting the bundler for them would be a
 *      confident wrong action dressed as a fix;
 *   2. this process already spent its budget — the rest of a collapsed sweep
 *      reports the truth;
 *   3. the PREVIOUS heal never recovered anything and nothing has confirmed
 *      since — the bundler is not what is broken here, so kicking it again in
 *      the next sweep would be superstition on a five-minute timer.
 */
export function decideMetroHeal(input: MetroHealInput): MetroHealDecision {
  const max = input.maxRestarts ?? MAX_METRO_AUTO_RESTARTS_PER_PROCESS;
  if (input.diagnosisCause !== 'metro-decayed') {
    return { heal: false, reason: 'the diagnosis is not `metro-decayed`' };
  }
  if (input.restartsSoFar >= max) {
    return {
      heal: false,
      reason:
        `Validity already auto-restarted the companion Metro ${input.restartsSoFar}× in this run ` +
        '(the per-run budget) — this failure is being reported rather than retried again',
    };
  }
  const last = input.lastHeal;
  if (last && last.outcome !== 'recovered' && !input.confirmedSinceLastHeal) {
    return {
      heal: false,
      reason:
        `the companion Metro was already auto-restarted at ${last.ts} and nothing has rendered ` +
        'since — a further restart would not be a fix, so the decay is being reported instead',
    };
  }
  return {
    heal: true,
    reason:
      'the capture diagnosed a decayed companion Metro, which is the one layer a restart is ' +
      'proven to recover — restarting it and retrying this spec once',
  };
}

/* -------------------------------------------------------------------------- */
/* the preventive decision                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Captures a bundler may serve before Validity recycles it on its own.
 *
 * MEASURED BASIS: both collapses in the 2026-07-29 isolation run landed roughly
 * 40-50 device opens past a Metro restart (4-5 sweeps of ~10 native captures),
 * and each was preceded by exactly one PARTIAL sweep. 30 sits a full sweep
 * below the earlier of the two onsets, so the recycle lands while the bundler is
 * still healthy. It is deliberately NOT tuned tighter: a recycle costs one
 * `--clear` cold bundle (30-90s) against a ~270s sweep, so buying margin here is
 * cheap and buying it back is not.
 */
export const DEFAULT_METRO_RECYCLE_CAPTURES = 30;

export interface PreventiveRecycleInput {
  /**
   * The platform under test. LOAD-BEARING for the DEFAULT: the cliff was
   * measured on Android only. iOS sweeps in the same period showed no decay, so
   * the default does not tax them with a bundler restart to prevent a failure
   * nobody has observed there — an iOS project that wants it sets the knob.
   */
  platform: 'ios' | 'android';
  /**
   * `native.metroRecycleAfterCaptures` from config. A number overrides the
   * threshold on EITHER platform (this is how iOS opts in); `false` or `0`
   * disables the preventive recycle entirely.
   */
  configured?: number | false;
  /** Captures this bundler has already served (see {@link capturesOnBundler}). */
  capturesOnBundler: number;
  /** {@link metroAutoRestartCount} for this process. */
  restartsSoFar: number;
  maxRestarts?: number;
}

export interface PreventiveRecycleDecision {
  recycle: boolean;
  reason: string;
  /** The threshold that was applied, when one was. */
  threshold?: number;
}

/**
 * Should the bundler be recycled BEFORE it reaches the measured cliff?
 *
 * PURE. Answers `false` whenever the answer is not clearly yes: an unknown
 * epoch (no journal, no owner marker) yields `capturesOnBundler: 0` upstream
 * and therefore no recycle, which is the right way round — a spurious restart
 * costs a cold bundle on a healthy run, and the reactive path still catches a
 * real collapse.
 */
export function decidePreventiveRecycle(input: PreventiveRecycleInput): PreventiveRecycleDecision {
  const configured = input.configured;
  if (configured === false || configured === 0) {
    return { recycle: false, reason: 'preventive Metro recycling is disabled in config' };
  }
  const threshold =
    typeof configured === 'number' && configured > 0
      ? configured
      : input.platform === 'android'
        ? DEFAULT_METRO_RECYCLE_CAPTURES
        : undefined;
  if (threshold === undefined) {
    return {
      recycle: false,
      reason:
        'preventive Metro recycling is off by default on iOS (the decay cliff was measured on ' +
        'Android) — set `native.metroRecycleAfterCaptures` to opt in',
    };
  }
  const max = input.maxRestarts ?? MAX_METRO_AUTO_RESTARTS_PER_PROCESS;
  if (input.restartsSoFar >= max) {
    return {
      recycle: false,
      reason: `the per-run Metro auto-restart budget (${max}) is already spent`,
      threshold,
    };
  }
  if (input.capturesOnBundler < threshold) {
    return {
      recycle: false,
      reason: `this bundler has served ${input.capturesOnBundler} captures (recycles at ${threshold})`,
      threshold,
    };
  }
  return {
    recycle: true,
    reason:
      `this companion Metro has served ${input.capturesOnBundler} captures — recycling it at ` +
      `${threshold}, below the 40-50 opens where the measured decay cliff sits`,
    threshold,
  };
}

/* -------------------------------------------------------------------------- */
/* the bundler epoch                                                           */
/* -------------------------------------------------------------------------- */

export interface BundlerEpochInput {
  /** `startedAt` from the Metro owner marker, when Validity spawned this bundler. */
  ownerStartedAt?: string;
  /** `bundlerEpochStartedAt` from the heal journal. */
  journalEpoch?: string;
}

/**
 * When the CURRENT bundler epoch began, in epoch-ms.
 *
 * Two sources, and the LATER wins. The owner marker is the accurate one but it
 * only exists for a bundler Validity spawned — the `expo run` build leaves one
 * running with no marker at all, which is precisely the bundler a long
 * unattended sweep starts on. The journal covers that case by recording first
 * sighting. Taking the later of the two also absorbs a HUMAN restart (the
 * documented `rm -f .validity-metro-content` fix): the owner marker moves
 * forward, the stale journal epoch is discarded, and the capture count restarts
 * from the restart rather than from before it.
 *
 * `undefined` when neither is known/parseable — the caller then counts nothing
 * and no preventive recycle fires.
 */
export function bundlerEpochStartMs(input: BundlerEpochInput): number | undefined {
  const candidates = [input.ownerStartedAt, input.journalEpoch]
    .map((s) => (s ? Date.parse(s) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

/**
 * How many captures this bundler has served: metrics rows timestamped at or
 * after the epoch. Rows with an unparseable timestamp are DROPPED here (unlike
 * the session-health epoch filter, which keeps them): a row whose clock cannot
 * be read is not evidence that the bundler has been driven, and over-counting
 * would restart a healthy Metro.
 */
export function capturesOnBundler(
  rows: readonly { ts: string }[],
  epochStartMs: number | undefined,
): number {
  if (epochStartMs === undefined) return 0;
  let n = 0;
  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (Number.isFinite(t) && t >= epochStartMs) n += 1;
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* the action                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Force the managed restart, by the SANCTIONED route: delete the content marker
 * so the next `ensureCompanionMetro` reads "already up + content CHANGED" and
 * takes its existing verified kill → `--clear` respawn branch.
 *
 * Nothing here spawns or signals anything. That is the point: `ensureCompanionMetro`
 * polls the old PID until it is genuinely gone, watches the fresh spawn for a
 * crash-on-boot, and refuses to trust `/status` until lsof attributes the port
 * to the process it started. A second restart path would have to re-earn all of
 * that, and the first thing it would do wrong is exactly one of them.
 *
 * Returns whether the marker was removed; a failure is non-fatal (the restart
 * simply does not happen, and the caller reports the decay it already had).
 */
export function invalidateMetroContentMarker(
  markerPath: string,
  fs: HealJournalFs = realHealJournalFs,
): boolean {
  try {
    fs.remove(markerPath);
    return true;
  } catch {
    return false;
  }
}
