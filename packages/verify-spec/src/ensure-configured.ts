/**
 * Auto-configuration orchestrator. Runs at the top of every verify and
 * makes sure the project's `.validity/` is in a state that produces a
 * faithful render — bootstraps on first run, regenerates on drift,
 * preserves user edits via the marker scheme.
 *
 * Surfaces a structured `EnsureResult` so the MCP server can attach
 * setup-health to the verify response: bootstrap notice on first run,
 * drift notice on auto-regen, manual-required error when the user has
 * locally modified `wrapper.gen.tsx` AND the project shape changed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planAutoMock, renderAutoMockConfigSource, type AutoMockPlan } from './auto-mock.js';

import { ensureValidityGitignore, readHistoryCommittedFromConfig, validityDir } from './runs.js';
import {
  cheapTierMatches,
  compareShapeSignatures,
  computeShapeSignature,
  readShapeSignature,
  readWrapperBodyHash,
  writeShapeSignature,
  type DriftReason,
  type ShapeSignature,
} from './shape-signature.js';
import {
  findEntryFile,
  generateWrapperSource,
  isManagedAndUntouched,
  type GenerateWrapperResult,
} from './wrapper-generator.js';
import { describeAppManifestRecord } from './app-manifest.js';
import {
  analyzeWrapperProviders,
  foldWrapperFidelity,
  type WrapperFidelityInfo,
} from './wrapper-fidelity.js';

export type EnsureStatus =
  | 'fresh' // First run — wrote everything from scratch.
  | 'unchanged' // Steady state — nothing to do.
  | 'drift-resolved' // Detected drift, regenerated.
  | 'drift-warned' // Detected drift, surfaced a warning but regenerated.
  | 'manual-required'; // Drift + user edits — preserved files, surfaced a fork.

export interface GeneratedFile {
  path: string;
  action: 'wrote' | 'skipped' | 'preserved' | 'forked';
}

export interface EnsureResult {
  status: EnsureStatus;
  bootstrapped: boolean;
  shapeSignature: ShapeSignature;
  driftReasons: DriftReason[];
  generatedFiles: GeneratedFile[];
  /** Human-readable warnings surfaced to the agent / verify report. */
  warnings: string[];
  /** Steps the user (or agent) needs to take when status === 'manual-required'. */
  manualSteps?: string[];
  /**
   * Auto-mock plan computed on the run that (re)seeded config.ts. Lets the
   * verify handler surface "what we auto-mocked" + provider-stub notes in
   * the Setup health block. Undefined when config.ts already existed.
   */
  autoMock?: AutoMockPlan;
  /**
   * Fidelity of the wrapper that will actually render vs. the app's real
   * provider tree (A1). `status === 'degraded'` taints soft verdicts
   * (`'wrapper'`). Stamped on every branch; absent only on old EnsureResult
   * JSON (RunMeta.setup), which reads as "no fidelity known, no taint".
   */
  wrapperFidelity?: WrapperFidelityInfo;
  /**
   * One-line description of `.validity/app-manifest.json` when the user has
   * installed `@validity.ai/verify-plugin-vite`. Purely observational — what the file
   * RECORDS, never what the sandbox mirrored (this is computed before any
   * sandbox exists; see `describeAppManifestRecord`). Undefined when there is
   * no usable manifest, which is the normal case.
   */
  appManifest?: string;
  durationMs: number;
}

export interface EnsureValidityConfiguredArgs {
  projectRoot: string;
  /** Force a full regen even when no drift detected. CLI's `--force`. */
  force?: boolean;
  /** Validity version embedded in the marker + signature. Read from package.json by default. */
  validityVersion?: string;
}

const CONFIG_FILENAME = '.validity/config.ts';
const WRAPPER_GEN_FILENAME = '.validity/wrapper.gen.tsx';
const WRAPPER_USER_FILENAME = '.validity/wrapper.user.tsx';
const WRAPPER_SUGGESTED_FILENAME = '.validity/wrapper.gen.tsx.suggested';

/**
 * Hot-path entry point for the MCP verify handler. Two-tier check —
 * cheap stat-based bail when no inputs changed, full content-hash
 * comparison only on cache miss. Bootstraps + regen on drift; preserves
 * user edits.
 */
export async function ensureValidityConfigured(
  args: EnsureValidityConfiguredArgs,
): Promise<EnsureResult> {
  const startedAt = performance.now();
  const { projectRoot, force = false } = args;
  const validityVersion = args.validityVersion ?? readValidityVersion(projectRoot) ?? '0.0.2';

  const wrapperGenPath = resolve(projectRoot, WRAPPER_GEN_FILENAME);
  const wrapperUserPath = resolve(projectRoot, WRAPPER_USER_FILENAME);
  const configPath = resolve(projectRoot, CONFIG_FILENAME);
  const suggestedPath = resolve(projectRoot, WRAPPER_SUGGESTED_FILENAME);

  // Read prior signature (cheap-tier).
  const prevSignature = readShapeSignature(projectRoot);
  const wrapperGenExists = existsSync(wrapperGenPath);
  const configExists = existsSync(configPath);

  // Cheap-tier short-circuit: if every tracked input has the same
  // mtime+size as last time, AND the generated files exist, AND we
  // weren't asked to force, bail without regenerating. Wrapper fidelity is
  // echoed from the persisted signature; legacy signatures (pre-fidelity)
  // compute it once here and persist — a one-time ~20 ms migration instead of
  // a schema bump (which would read as drift and force `manual-required` on
  // users with hand-edited wrappers).
  // The cheap tier's stat epochs don't track wrapper.gen.tsx itself — compare
  // its body hash directly (one small file read) so a hand-edit can't keep
  // echoing a stale cached fidelity verdict; the authoritative tier below
  // re-measures the edited wrapper and re-persists.
  const wantCheap =
    !force &&
    prevSignature !== null &&
    wrapperGenExists &&
    configExists &&
    readWrapperBodyHash(wrapperGenPath) === prevSignature.wrapperGenContentHash;
  if (wantCheap && cheapTierMatches(prevSignature, projectRoot)) {
    const cheapWarnings: string[] = [];
    let shapeSignature = prevSignature;
    let cheapFidelity: WrapperFidelityInfo;
    if (prevSignature.wrapperFidelity) {
      cheapFidelity = { ...prevSignature.wrapperFidelity, analyzed: 'signature-cache' };
    } else {
      try {
        const generation = generateWrapperSource({
          projectRoot,
          validityVersion,
          wrapperOutPath: wrapperGenPath,
          composeWithUserWrapper: existsSync(wrapperUserPath),
        });
        cheapFidelity = computeOnDiskWrapperFidelity({
          projectRoot,
          wrapperGenPath,
          wrapperUserPath,
          generation,
        });
        shapeSignature = { ...prevSignature, wrapperFidelity: pickFidelity(cheapFidelity) };
        writeShapeSignature(projectRoot, shapeSignature);
      } catch (err) {
        // Fail-open by design (a fidelity bug must not brick every verify),
        // but never silent — 'unknown' has no taint and no upgrade path.
        cheapFidelity = unknownFidelity('signature-cache', err);
        cheapWarnings.push(`Wrapper fidelity could not be computed: ${(err as Error).message}`);
      }
    }
    return {
      status: 'unchanged',
      bootstrapped: false,
      shapeSignature,
      driftReasons: [],
      generatedFiles: [],
      warnings: cheapWarnings,
      wrapperFidelity: cheapFidelity,
      appManifest: describeAppManifestRecord(projectRoot),
      durationMs: performance.now() - startedAt,
    };
  }

  // Authoritative tier: compute a fresh signature and compare per-field.
  {
    const historyCommitted = readHistoryCommittedFromConfig(projectRoot);
    ensureValidityGitignore(
      projectRoot,
      historyCommitted === undefined ? undefined : { historyCommitted },
    );
  }
  ensureShapeSignatureGitignore(projectRoot);

  const nextSignature = computeShapeSignature({
    projectRoot,
    validityVersion,
    wrapperGenPath,
    wrapperUserPath,
  });
  const driftReasons = compareShapeSignatures(prevSignature, nextSignature);
  const isFirstRun = prevSignature === null;

  // Filter out the wrapper-gen-edited reason for severity decisions —
  // we treat that one specially below (fork-and-warn). Everything else
  // determines whether we regen at all.
  const userEditedGen = driftReasons.some((d) => d.category === 'wrapper-gen-edited');
  const otherDrift = driftReasons.filter((d) => d.category !== 'wrapper-gen-edited');

  const needsRegen = force || isFirstRun || otherDrift.length > 0;

  const generatedFiles: GeneratedFile[] = [];
  const warnings: string[] = [];
  let autoMock: AutoMockPlan | undefined;
  let wrapperFidelity: WrapperFidelityInfo | undefined;

  // Always write config.ts on first run; never overwrite an existing one
  // (alpha policy — we don't ship a TS-aware config merger yet). The
  // seeded config is tailored to the project's detected data/auth stack
  // (Convex, React Query, Apollo, Clerk, …) so components that read those
  // providers render against mocks on the very first verify.
  if (!configExists) {
    autoMock = planAutoMock(projectRoot);
    writeFileSync(configPath, renderAutoMockConfigSource(projectRoot));
    generatedFiles.push({ path: relForReport(configPath, projectRoot), action: 'wrote' });
    // Surface anything network mocking can't satisfy (WebSocket/realtime
    // transports, auth SDKs needing a client key) as a setup warning so
    // the agent knows to add a stub in wrapper.user.tsx.
    for (const note of autoMock.manualNotes) {
      warnings.push(`Auto-mock: ${note}`);
    }
  } else {
    generatedFiles.push({ path: relForReport(configPath, projectRoot), action: 'skipped' });
  }

  // Decide what to do with wrapper.gen.tsx.
  if (!needsRegen) {
    // No drift apart from possibly user-edited gen. The user-edit is
    // benign without other drift, so leave it alone — but measure the
    // on-disk wrapper (it IS what renders): a user who deleted a provider
    // from wrapper.gen.tsx is caught here.
    generatedFiles.push({ path: relForReport(wrapperGenPath, projectRoot), action: 'skipped' });
    try {
      const generation = generateWrapperSource({
        projectRoot,
        validityVersion,
        wrapperOutPath: wrapperGenPath,
        composeWithUserWrapper: existsSync(wrapperUserPath),
      });
      wrapperFidelity = computeOnDiskWrapperFidelity({
        projectRoot,
        wrapperGenPath,
        wrapperUserPath,
        generation,
      });
    } catch (err) {
      wrapperFidelity = unknownFidelity('on-disk', err);
      warnings.push(`Wrapper fidelity could not be computed: ${(err as Error).message}`);
    }
  } else if (needsRegen && userEditedGen && !force) {
    // The dangerous case: real-app inputs changed AND the user has
    // hand-edited wrapper.gen.tsx. Don't clobber. Write our version
    // alongside as `.suggested` and surface a manual-required.
    const result = generateWrapperSource({
      projectRoot,
      validityVersion,
      wrapperOutPath: wrapperGenPath,
      composeWithUserWrapper: existsSync(wrapperUserPath),
    });
    writeFileSync(suggestedPath, result.source);
    generatedFiles.push({ path: relForReport(wrapperGenPath, projectRoot), action: 'preserved' });
    generatedFiles.push({ path: relForReport(suggestedPath, projectRoot), action: 'forked' });
    warnings.push(
      'Detected drift in your project shape, but `.validity/wrapper.gen.tsx` has hand edits ' +
        `(content hash mismatch with marker). Wrote my updated version to \`.validity/wrapper.gen.tsx.suggested\` ` +
        `instead of overwriting yours. Diff and merge manually, or move your customizations into ` +
        `.validity/wrapper.user.tsx and delete the .suggested file.`,
    );
    // Fidelity of the PRESERVED wrapper — the one that would render (the
    // `.suggested` fork never does), measured against the fresh generation
    // above. Verify aborts on manual-required, so this serves the abort
    // message (via the warning below) and the CLI surfaces.
    try {
      wrapperFidelity = computeOnDiskWrapperFidelity({
        projectRoot,
        wrapperGenPath,
        wrapperUserPath,
        generation: result,
      });
    } catch (err) {
      wrapperFidelity = unknownFidelity('on-disk', err);
    }
    if (wrapperFidelity.status === 'degraded') {
      warnings.push(
        `Wrapper fidelity: degraded — preserved wrapper is missing ${
          wrapperFidelity.missingProviders.join(', ') || 'expected providers'
        }.`,
      );
    }
  } else {
    // Clean regen — generate, optionally check vs. last-known-good,
    // write. If the cloner falls back to passthrough, surface that
    // through warnings but still write the file (sandbox needs *some*
    // wrapper).
    const result = generateWrapperSource({
      projectRoot,
      validityVersion,
      wrapperOutPath: wrapperGenPath,
      composeWithUserWrapper: existsSync(wrapperUserPath),
    });
    if (!result.ok && result.fallbackReason) {
      warnings.push(
        `Could not clone provider tree from your entry file (${result.fallbackReason}); ` +
          `using a passthrough wrapper. Edit \`.validity/wrapper.user.tsx\` to add providers manually.`,
      );
      // A passthrough wrapper renders with NO app providers — degraded
      // fidelity, so prepareVerification taints soft verdicts (`'wrapper'`).
      // The fold names the entry's detectable providers (regex fallback) and
      // flips to verified only when wrapper.user.tsx satisfies every detected
      // signal — the warning's own advice, followed.
      try {
        const actual = analyzeWrapperProviders(result.source, {
          userWrapperSource: readOptional(wrapperUserPath),
        });
        wrapperFidelity = foldWrapperFidelity({
          expected: result.expectedProviderChain,
          actual: actual?.presentChain ?? null,
          generation: result,
          routerSubtreeDiscarded: result.routerSubtreeDiscarded,
          entrySourceText: readEntrySourceText(projectRoot, result.entryFile),
          spliceTarget: spliceTargetOf(result),
          analyzed: 'passthrough',
        });
      } catch (err) {
        wrapperFidelity = unknownFidelity('passthrough', err);
      }
    } else {
      // Fresh clone: analyze the just-generated source against the chain the
      // generator itself derived. Normally `verified` — this doubles as the
      // regression net for generator bugs (a dropped provider flips fidelity
      // to `degraded` and the fixtures catch it).
      try {
        const actual = analyzeWrapperProviders(result.source, {
          userWrapperSource: readOptional(wrapperUserPath),
        });
        wrapperFidelity = foldWrapperFidelity({
          expected: result.expectedProviderChain,
          actual: actual?.presentChain ?? null,
          generation: result,
          routerSubtreeDiscarded: result.routerSubtreeDiscarded,
          spliceTarget: spliceTargetOf(result),
          analyzed: 'generated',
        });
      } catch (err) {
        wrapperFidelity = unknownFidelity('generated', err);
        warnings.push(`Wrapper fidelity could not be computed: ${(err as Error).message}`);
      }
    }
    // Suppress an unnecessary write when we'd produce identical bytes
    // — saves an mtime bump that would re-trigger watchers. Skipped
    // when the user passed --force; they're explicitly asking for a
    // fresh write.
    let action: 'wrote' | 'skipped' = 'wrote';
    if (!force) {
      try {
        const onDisk = readFileSync(wrapperGenPath, 'utf-8');
        const a = onDisk.split('\n').slice(3).join('\n');
        const b = result.source.split('\n').slice(3).join('\n');
        if (a === b && isManagedAndUntouched(onDisk)) action = 'skipped';
      } catch {
        // not on disk yet — fall through to write
      }
    }
    if (action === 'wrote') {
      writeFileSync(wrapperGenPath, result.source);
    }
    generatedFiles.push({ path: relForReport(wrapperGenPath, projectRoot), action });

    // Update wrapperGenContentHash to the just-written body so the next
    // run's drift check reflects what we actually persisted.
    const justWrittenBody = result.source.split('\n').slice(3).join('\n');
    nextSignature.wrapperGenContentHash = first16(sha256(justWrittenBody));
  }

  // Persist signature (fidelity rides along so the cheap tier can echo it).
  if (wrapperFidelity) nextSignature.wrapperFidelity = pickFidelity(wrapperFidelity);
  writeShapeSignature(projectRoot, nextSignature);

  // Status determination.
  const wroteSomething = generatedFiles.some((f) => f.action === 'wrote' || f.action === 'forked');
  const status: EnsureStatus = isFirstRun
    ? 'fresh'
    : userEditedGen && otherDrift.length > 0 && !force
      ? 'manual-required'
      : otherDrift.length > 0
        ? 'drift-resolved'
        : warnings.length > 0
          ? 'drift-warned'
          : force && wroteSomething
            ? 'drift-resolved'
            : 'unchanged';

  const manualSteps =
    status === 'manual-required'
      ? [
          'Open .validity/wrapper.gen.tsx and .validity/wrapper.gen.tsx.suggested in a diff viewer.',
          'Move any custom additions into .validity/wrapper.user.tsx (it composes around the generated tree).',
          'Delete .validity/wrapper.gen.tsx.suggested.',
          'Re-run validity__verify.',
        ]
      : undefined;

  return {
    status,
    bootstrapped: isFirstRun,
    shapeSignature: nextSignature,
    driftReasons,
    generatedFiles,
    warnings,
    manualSteps,
    autoMock,
    wrapperFidelity,
    appManifest: describeAppManifestRecord(projectRoot),
    durationMs: performance.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Wrapper fidelity helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Signature-cached wrapper fidelity for read-only paths (watch/scorecard) that
 * must not run the full orchestrator (a CLI read path should not write files).
 * Every MCP verify refreshes the cache; residual staleness is accepted.
 */
export function readWrapperFidelity(projectRoot: string): WrapperFidelityInfo | undefined {
  const cached = readShapeSignature(projectRoot)?.wrapperFidelity;
  return cached ? { ...cached, analyzed: 'signature-cache' } : undefined;
}

/**
 * Read-only `EnsureResult` reconstructed from the persisted signature cache,
 * for CLI verify paths (`verify --all`, `watch`) that must not run the writing
 * orchestrator. Threading it into `prepareVerification` gives CLI run-metas
 * the same honesty as MCP verifies: the wrapper taint on soft criteria and the
 * `meta.setup` provenance (which `submit_report`'s clamp also reads).
 * Undefined when no signature cache exists yet — reads as "no fidelity known,
 * no taint", matching `readWrapperFidelity`'s fail-open posture. Never
 * upgrades anything: an absent cache produces the same run-meta as before.
 */
export function readCachedEnsureResult(projectRoot: string): EnsureResult | undefined {
  const sig = readShapeSignature(projectRoot);
  if (!sig) return undefined;
  return {
    status: 'unchanged',
    bootstrapped: false,
    shapeSignature: sig,
    driftReasons: [],
    generatedFiles: [],
    warnings: [],
    ...(sig.wrapperFidelity
      ? { wrapperFidelity: { ...sig.wrapperFidelity, analyzed: 'signature-cache' as const } }
      : {}),
    appManifest: describeAppManifestRecord(projectRoot),
    durationMs: 0,
  };
}

/** The persisted subset of a fidelity verdict (echoed by the cheap tier). */
function pickFidelity(
  f: WrapperFidelityInfo,
): Pick<WrapperFidelityInfo, 'status' | 'missingProviders' | 'expectedProviders' | 'detail'> {
  return {
    status: f.status,
    missingProviders: f.missingProviders,
    expectedProviders: f.expectedProviders,
    // Keep the reason (e.g. the generator's fallbackReason) so a cached
    // degraded verdict still names WHY instead of the generic
    // 'degraded clone' the taint falls back to.
    ...(f.detail !== undefined ? { detail: f.detail } : {}),
  };
}

/** Fail-open placeholder when the analysis itself threw — visible, never tainting. */
function unknownFidelity(
  analyzed: WrapperFidelityInfo['analyzed'],
  err: unknown,
): WrapperFidelityInfo {
  return {
    status: 'unknown',
    missingProviders: [],
    expectedProviders: [],
    analyzed,
    detail: `fidelity analysis failed: ${(err as Error).message}`,
  };
}

/**
 * Fidelity of the wrapper source that will actually render (the on-disk
 * `wrapper.gen.tsx`, composed with `wrapper.user.tsx` when present), measured
 * against a throwaway generation from the current entry. Used on the branches
 * where the on-disk file is kept: benign user edit, preserved-under-drift,
 * and the cheap tier's legacy-signature compute-on-miss.
 */
function computeOnDiskWrapperFidelity(args: {
  projectRoot: string;
  wrapperGenPath: string;
  wrapperUserPath: string;
  generation: GenerateWrapperResult;
}): WrapperFidelityInfo {
  const onDisk = readFileSync(args.wrapperGenPath, 'utf-8');
  const actual = analyzeWrapperProviders(onDisk, {
    userWrapperSource: readOptional(args.wrapperUserPath),
  });
  return foldWrapperFidelity({
    expected: args.generation.expectedProviderChain,
    actual: actual?.presentChain ?? null,
    generation: args.generation,
    routerSubtreeDiscarded: args.generation.routerSubtreeDiscarded,
    entrySourceText: args.generation.ok
      ? undefined
      : readEntrySourceText(args.projectRoot, args.generation.entryFile),
    spliceTarget: spliceTargetOf(args.generation),
    analyzed: 'on-disk',
  });
}

/** Fidelity's splice-target expectation, when the generation derived one. */
function spliceTargetOf(
  generation: GenerateWrapperResult,
): { module: string; signals: string[] } | undefined {
  if (!generation.spliceTargetModule || !generation.spliceTargetProviderSignals?.length) {
    return undefined;
  }
  return {
    module: generation.spliceTargetModule,
    signals: generation.spliceTargetProviderSignals,
  };
}

/** Entry-file text for the fold's regex fallback. Best-effort. */
function readEntrySourceText(projectRoot: string, entryFile?: string): string | undefined {
  const rel = entryFile ?? findEntryFile(projectRoot);
  if (!rel) return undefined;
  return readOptional(resolve(projectRoot, rel));
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

function ensureShapeSignatureGitignore(projectRoot: string): void {
  // The base .gitignore already excludes `runs/`. Append the signature
  // file + the suggested fork on first write so users don't accidentally
  // commit them.
  const gi = resolve(validityDir(projectRoot), '.gitignore');
  if (!existsSync(gi)) return;
  const want = ['/.shape-signature.json', '/wrapper.gen.tsx.suggested'];
  let content = '';
  try {
    content = readFileSync(gi, 'utf-8');
  } catch {
    return;
  }
  let changed = false;
  for (const line of want) {
    if (!content.split('\n').includes(line)) {
      content += content.endsWith('\n') ? '' : '\n';
      content += line + '\n';
      changed = true;
    }
  }
  if (changed) writeFileSync(gi, content);
}

function readValidityVersion(projectRoot: string): string | undefined {
  // The running Validity version isn't derivable from the target project;
  // punt to the caller's default (the CLI/MCP layer passes the real one).
  void projectRoot;
  return undefined;
}

function relForReport(abs: string, projectRoot: string): string {
  return abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function first16(s: string): string {
  return s.slice(0, 16);
}
