/**
 * Structured runtime PERF evidence from a device — captured, labelled, and
 * scored by nobody.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS NOW (and did not before)
 * ---------------------------------------------------------------------------
 * The June Argent spike concluded that on-device profiling was prose-only, so
 * `expect.performance` stayed soft and native runs carried no runtime numbers
 * at all. agent-device 0.20.5 makes that conclusion obsolete at the CAPTURE
 * layer: `perf metrics --json` and `perf frames --json` return bounded,
 * agent-readable JSON (startup, CPU, memory, frame/jank health) instead of a
 * dumpsys/instruments dump.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * NO THRESHOLDS. NO GATE. Nothing in this module produces a verdict, and no
 * caller may derive one from it: a frame-time number from a debug build on a
 * shared emulator, compared against a constant, is exactly the kind of
 * confident-and-wrong red this codebase refuses to ship. Turning these numbers
 * into a gate needs an N-run variance study first; until then every record
 * carries `scoring: 'advisory-evidence-only'` IN THE ARTIFACT, so a future
 * reader cannot mistake captured evidence for a scored criterion.
 *
 * ABSENCE IS NOT A PASS. A device that answers nothing produces a record with
 * `status: 'unavailable'` and the reason upstream gave. "Could not tell" is
 * written down; it never silently disappears, and it never reads as healthy.
 *
 * NO RAW ARTIFACT ESCALATION. `perf memory snapshot`, `perf cpu profile`, and
 * `perf trace` write multi-megabyte files (heaps, simpleperf, perfetto). They
 * are out of scope here on purpose: run evidence is a thing humans open.
 *
 * ---------------------------------------------------------------------------
 * SHAPE TOLERANCE
 * ---------------------------------------------------------------------------
 * Upstream's `data` payload varies by platform and backend (Apple xctrace vs.
 * Android gfxinfo/dumpsys) and is documented as "compact, bounded", not as a
 * fixed schema. So this module stores the payload VERBATIM under a provenance
 * envelope rather than re-modelling it. Pretending to know field names we have
 * not verified would produce a parser that silently drops evidence on the next
 * upstream release — the failure mode being avoided everywhere else in this
 * package.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandRunner } from './agent-device-driver.js';

/** Bumped only when the envelope below changes shape. Add-only within a version. */
export const DEVICE_EVIDENCE_SCHEMA = 1;

/** The evidence families this package captures post-interaction. */
export type DeviceEvidenceKind = 'perf-metrics' | 'perf-frames' | 'network-dump';

/**
 * One captured (or explicitly un-captured) piece of device evidence.
 *
 * Every field except `data` is PROVENANCE. That is the point: a JSON blob in a
 * run dir with no statement of which command produced it, when, on what, and
 * under which scoring posture is an anecdote. This envelope makes it evidence.
 */
export interface DeviceEvidence {
  schema: number;
  kind: DeviceEvidenceKind;
  /** Producer. Constant today; named so a future driver swap is legible. */
  source: 'agent-device';
  /** The exact command line, as run. Reproducible by hand. */
  command: string;
  /** ISO timestamp of the capture attempt. */
  capturedAt: string;
  /**
   * WHERE in the journey this was taken. `post-interaction` is the only value
   * today and it is load-bearing: perf read BEFORE the checks would describe a
   * screen the run never scored.
   */
  phase: 'post-interaction';
  platform: 'ios' | 'android';
  device?: string;
  /**
   * Stated in the artifact so it survives being copied out of context: this is
   * evidence, never a gate input. See the module header.
   */
  scoring: 'advisory-evidence-only';
  status: 'captured' | 'unavailable';
  /** Present iff `status === 'unavailable'` — upstream's own reason, verbatim. */
  unavailableReason?: string;
  /** agent-device's error code, when it named one. */
  errorCode?: string;
  /** Upstream's `data` payload, verbatim (see SHAPE TOLERANCE). */
  data?: unknown;
  /** Set when `data` was withheld for size; `note` says how big it was. */
  truncated?: boolean;
  /** Human note about a truncation or an oddity. Never a verdict. */
  note?: string;
}

/**
 * Payload ceiling. Upstream calls these responses "compact and bounded", so a
 * payload past this is a contract change, not a normal capture — it is
 * withheld rather than pasted into a run dir a human is expected to read.
 */
export const MAX_EVIDENCE_BYTES = 64_000;

/** `agent-device perf metrics --json` — startup/CPU/memory/frame first pass. */
export function perfMetricsArgs(): string[] {
  return ['perf', 'metrics', '--json'];
}

/** `agent-device perf frames --json` — focused frame/jank health. */
export function perfFramesArgs(): string[] {
  return ['perf', 'frames', '--json'];
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseEnvelope(stdout: string): Envelope | undefined {
  if (!stdout || stdout.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as Envelope;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Context every capture is stamped with. */
export interface EvidenceContext {
  platform: 'ios' | 'android';
  device?: string;
  /** Injected clock — the artifact is compared byte-wise in tests. */
  now?: () => Date;
  /** Redactor applied to every string taken from the device. */
  redact?: (s: string) => string;
}

/**
 * Turn one command execution into a {@link DeviceEvidence} record. PURE — the
 * caller supplies the exec result, so every branch is fixture-testable.
 *
 * The three failure modes are kept DISTINCT rather than collapsed into "no
 * data", because they call for different actions: a refusal with a code
 * (`SESSION_NOT_FOUND` — nothing was attached), a non-zero exit with no
 * envelope (the binary or the daemon fell over), and a success whose payload is
 * too large to store (a contract change worth noticing).
 */
export function classifyDeviceEvidence(args: {
  kind: DeviceEvidenceKind;
  argv: string[];
  bin?: string;
  res: { code: number; stdout: string; stderr: string };
  ctx: EvidenceContext;
}): DeviceEvidence {
  const { kind, argv, res, ctx } = args;
  const redact = ctx.redact ?? ((s: string) => s);
  const base = {
    schema: DEVICE_EVIDENCE_SCHEMA,
    kind,
    source: 'agent-device' as const,
    command: [args.bin ?? 'agent-device', ...argv].join(' '),
    capturedAt: (ctx.now?.() ?? new Date()).toISOString(),
    phase: 'post-interaction' as const,
    platform: ctx.platform,
    ...(ctx.device ? { device: ctx.device } : {}),
    scoring: 'advisory-evidence-only' as const,
  };

  const env = parseEnvelope(res.stdout);
  if (env?.success === true) {
    let serialized: string;
    try {
      serialized = JSON.stringify(env.data ?? null);
    } catch {
      return {
        ...base,
        status: 'unavailable',
        unavailableReason: 'the payload could not be serialized (circular or non-JSON value)',
      };
    }
    if (serialized.length > MAX_EVIDENCE_BYTES) {
      return {
        ...base,
        status: 'captured',
        truncated: true,
        note:
          `payload withheld: ${serialized.length} bytes exceeds the ${MAX_EVIDENCE_BYTES}-byte ` +
          'ceiling for run evidence (upstream documents these responses as compact — treat an ' +
          'oversized one as a contract change, not as a device problem)',
      };
    }
    return { ...base, status: 'captured', data: env.data };
  }

  const code = str(env?.error?.code);
  const upstream = str(env?.error?.message);
  // NO ENVELOPE is its own failure, and it is kept distinct from a refusal: a
  // binary that printed something we cannot read is a different problem from a
  // daemon that answered "no session", and collapsing them into the raw stdout
  // ("not json") loses the only sentence that explains what happened.
  const raw = `${res.stderr}\n${res.stdout}`.trim();
  const reason =
    upstream ??
    `agent-device produced no readable JSON envelope (exit ${res.code})` +
      (raw ? `: ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}` : '');
  return {
    ...base,
    status: 'unavailable',
    ...(code ? { errorCode: code } : {}),
    unavailableReason: redact(reason),
  };
}

/** Everything a capture needs. No device in tests — `run` is injected. */
export interface CollectEvidenceArgs extends EvidenceContext {
  run: CommandRunner;
  /** Working directory. agent-device keys sessions by cwd — pass the project root. */
  cwd?: string;
  bin?: string;
  /** Per-command wall-clock bound. Evidence must never hold a run open. */
  timeoutMs?: number;
}

/** Default bound: evidence is a nice-to-have, so it gets a short leash. */
export const DEFAULT_EVIDENCE_TIMEOUT_MS = 20_000;

async function capture(
  kind: DeviceEvidenceKind,
  argv: string[],
  args: CollectEvidenceArgs,
): Promise<DeviceEvidence> {
  const ctx: EvidenceContext = {
    platform: args.platform,
    ...(args.device ? { device: args.device } : {}),
    ...(args.now ? { now: args.now } : {}),
    ...(args.redact ? { redact: args.redact } : {}),
  };
  const env: Record<string, string> = { AGENT_DEVICE_PLATFORM: args.platform };
  if (args.device) env.AGENT_DEVICE_ID = args.device;
  try {
    const res = await args.run(args.bin ?? 'agent-device', argv, {
      env,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      timeoutMs: args.timeoutMs ?? DEFAULT_EVIDENCE_TIMEOUT_MS,
    });
    return classifyDeviceEvidence({
      kind,
      argv,
      ...(args.bin ? { bin: args.bin } : {}),
      res,
      ctx,
    });
  } catch (err) {
    // A THROWN runner (spawn failure) is still evidence about the environment.
    // Swallowing it would leave the record absent, which reads as "we did not
    // try" rather than "we tried and the tool is not there".
    return classifyDeviceEvidence({
      kind,
      argv,
      ...(args.bin ? { bin: args.bin } : {}),
      res: { code: -1, stdout: '', stderr: (err as Error)?.message ?? String(err) },
      ctx,
    });
  }
}

/**
 * Capture both perf families after the interaction phase.
 *
 * Sequential on purpose: two spawns against one device session, and the frame
 * counters are read by both. Racing them would interleave two dumpsys reads on
 * Android for no benefit — evidence collection is not the hot path.
 */
export async function collectPerfEvidence(
  args: CollectEvidenceArgs,
): Promise<{ metrics: DeviceEvidence; frames: DeviceEvidence }> {
  const metrics = await capture('perf-metrics', perfMetricsArgs(), args);
  const frames = await capture('perf-frames', perfFramesArgs(), args);
  return { metrics, frames };
}

/** Internal seam shared with network-evidence.ts. */
export const captureDeviceEvidence = capture;

/**
 * Write a bundle of records as one JSON file. BEST-EFFORT: an unwritable path
 * returns false rather than throwing, because evidence collection must never be
 * able to fail the thing it is documenting.
 */
export function writeDeviceEvidence(path: string, records: DeviceEvidence[]): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ schema: DEVICE_EVIDENCE_SCHEMA, records }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * One line per record for the console — what was captured, or why not.
 *
 * Never a judgement about the numbers. The point of the line is that a reader
 * knows the evidence EXISTS (and where), not that they read a score off it.
 */
export function evidenceSummaryLine(e: DeviceEvidence): string {
  if (e.status === 'captured') {
    return e.truncated
      ? `${e.kind}: captured, payload withheld (${e.note ?? 'oversized'})`
      : `${e.kind}: captured (${e.command})`;
  }
  return `${e.kind}: not captured${e.errorCode ? ` [${e.errorCode}]` : ''} — ${
    e.unavailableReason ?? 'no reason reported'
  }`;
}
