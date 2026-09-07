import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  PlanValidationError,
  TooManyRenderPairsError,
  UnknownScenarioError,
  MAX_RENDER_PAIRS,
  MAX_NATIVE_RENDER_TARGETS,
  buildCatalog,
  componentIdFor,
  resolveName,
  selectComponentsToRender,
  summarizeProps,
  discoverDesignTokens,
  discoverComponentFiles,
  discoverScreenFiles,
  ensureRunDirectories,
  clearInflightMarker,
  writeInflightMarker,
  writeStartRunMeta,
  citableScreenshotIds,
  computeCoverageFromVerdicts,
  computeRegressionDeltas,
  computeValidityScore,
  ensureValidityConfigured,
  extractTestIds,
  inferFixtures,
  indexRunForSpec,
  isRunPlanned,
  loadScorecard,
  loadSignals,
  newRunId,
  prepareVerification,
  resolveColorSchemes,
  readPlan,
  readRunMeta,
  readSpecRunHistory,
  resolveReportConfig,
  runDir,
  runMetaPathFor,
  stripProxySentinels,
  validateCriteria,
  writeNativeRunMeta,
  writeUrlRunMeta,
  createSpec,
  detectAppTarget,
  EXPO_WEB_OPT_IN_HINT,
  formatBuildVersion,
  freezeSpec,
  isSpecId,
  planCriteriaToSpecCriteria,
  CHECK_COMPILER_VERSION,
  SCORING_CONTRACT_VERSION,
  readSpec,
  readSpecVersion,
  componentBaseKey,
  weakenedSincePrevVersion,
  resolveJudgeMode,
  resolveTemporalBinding,
  specToPlan,
  computeSignedOff,
  selfScoredSignOffBlockers,
  resolveViewport,
  rollupCriterionVerdicts,
  mergeExecutedVerdicts,
  variantLabel,
  applyEvidenceTaints,
  attestRecording,
  attestReport,
  attestRun,
  stampOf,
  buildRepoA11yCriterion,
  buildHandlerStub,
  buildRepoTypecheckCriterion,
  computePerfHints,
  classifyNextSources,
  criterionUsesCommandChecks,
  demotingTaintsOf,
  evidenceTaintsOf,
  formatDataStateHint,
  formatRscBlock,
  formatPerfHintsBlock,
  executeCommandCriteria,
  fixtureScenarioPrecedenceWarning,
  foldVerifyIntoScorecard,
  codeChangedForSpec,
  lastObservedSha,
  detectRunOrigin,
  URL_MODE_DISCLOSURE,
  urlModeCriterionVerdicts,
  overlayCommandVerdicts,
  acquireVerifyLock,
  VerifyLockHeldError,
  writeFileAtomic,
  refreshHardeningCandidates,
  refreshPerfDrift,
  rubricDriftWarning,
  RUBRIC_VERSION,
  VALIDITY_SCORE_FORMULA,
  withEvidenceTaint,
  type AcceptanceCriterion,
  type ComponentRender,
  type CriterionVerdict,
  type CriterionWeakening,
  type EnsureResult,
  type EvidenceTaint,
  type FoldResult,
  type MockNetworkConfig,
  type PageRender,
  type PerfHint,
  type RegressionDelta,
  type RscClassification,
  type ScorerProvenance,
  type Signal,
  type SignOffCriterion,
  type Spec,
  type SpecCriterion,
  type SpecRunSummary,
  type TemporalResult,
  type RunMeta,
  type UnmatchedRequest,
  type ValidityConfig,
  type ValidityPlan,
  type WrapperFidelityInfo,
} from '@validity.ai/verify-spec';
import {
  buildPrevRenderIndex,
  buildRenderIdentity,
  detailHeaderLine,
  leanScreenshotDecision,
  partitionSoftCriteria,
  prevRunMatchesSpec,
  renderKeyFor,
  renderUnchangedForFold,
  resolveVerifyDetail,
  urlModeDetailNotice,
  type CarryForwardSoft,
  type VerifyDetail,
  type VerifyPresentation,
} from './lean-verify.js';
import { buildVerifyReceipt, receiptLine, RECEIPT_REASON_URL_MODE } from './verify-receipt.js';
import { applySubmittedSoftScores } from './submit-soft-scores.js';
import {
  SPEC_TOOL_DEFINITIONS,
  handleSpecCreate,
  handleSpecReview,
  handleSpecUpdate,
  handleSpecFreeze,
  handleSpecList,
  handleSpecGet,
  resolveComponentTarget,
} from './spec-tools.js';
import {
  SCORECARD_TOOL_DEFINITIONS,
  handleScoreSoftCriteria,
  handleRecordSoftScores,
} from './scorecard-tools.js';
import { SIGNAL_TOOL_DEFINITIONS, handleSignals } from './signal-tools.js';
import {
  ONBOARD_TOOL_DEFINITIONS,
  handleOnboardEnumerate,
  handleOnboardProgress,
  handleOnboardReport,
} from './onboard-tools.js';
import {
  AgentDeviceDriver,
  BridgePortHeldError,
  captureNative,
  checkNativeReadiness,
  closeEstablishedNativeSessions,
  companionBuildIdentity,
  installNativeSessionShutdownHandlers,
  detectNative,
  ensureCompanionMetro,
  listBootedDevices,
  metroLogLength,
  prepareNativeApp,
  resolveNativeViewItems,
  startNativeBridge,
  waitForBundleServed,
  diagnoseNativeEnvironment,
  resolveRemoteConfigPath,
  type BootedDevice,
  type CompanionBuildIdentity,
  type NativeReadiness,
  type ReadinessStep,
  type NativeBridgeDeviceInfo,
  type NativeBridgeHandle,
  type NativeRenderStatus,
  type EnvironmentDiagnosis,
} from '@validity.ai/verify-native';
import {
  buildEvidenceMap,
  captureUrls,
  combineMockNetwork,
  confirmBaseline,
  deleteViewFromConfig,
  detectDevServerBaseUrl,
  detectFramework,
  diffAgainstBaseline,
  evaluateScreenshotExpects,
  formatA11yBlock,
  formatDiagnosticsBlock,
  prepareSandbox,
  readRunEvidence,
  refoldAfterScreenshot,
  renderComponents,
  renderHtmlReport,
  renderMarkdownReport,
  assessSpecMaturity,
  startDevServer,
  writeViewToConfig,
  type BridgeMessage,
  type DevServer,
  type ReportComponent,
  type ReportCriterion,
  type ReportDiff,
  type ReportInput,
  type ReportRegressionDelta,
  type UrlCaptureRequest,
  type WriteViewItem,
} from '@validity.ai/verify-web';
import { NativeSessionCache, computeNativeSourceSignature } from './native-session-cache.js';
import { writeMcpRuntimeStamp } from './runtime-stamp.js';
import { SESSION_FINGERPRINT } from './session-fingerprint.js';

/**
 * Module-level registry of live browse sessions, keyed by absolute project
 * root. `validity__browse_open` populates it; `validity__browse_navigate`
 * reads it to push commands over the bridge. Surviving across MCP tool calls
 * is the whole point — closing the dev server here would defeat browse mode.
 * Cleanup is the MCP server's lifecycle problem (a future PR).
 */
const sessions = new Map<string, { devServer: DevServer }>();

/**
 * The native control bridge — a single host-side WS server the companion
 * connects back to so `validity__native_browse` can re-target the active view
 * IN-PLACE (no deep-link reload, no splash re-present). Started lazily on the
 * first native browse and reused across calls; the device holds the socket
 * between calls and reconnects if needed. Port contention is NOT a silent
 * degrade: if another live Validity bridge (e.g. a concurrent CLI run) holds
 * the port, this handle DELEGATES navigations through its HTTP /navigate
 * endpoint (still per-token acked); a non-Validity holder surfaces as a
 * machine-readable BRIDGE_PORT_HELD error (see bridgePortHeldBlock).
 */
let nativeBridge: NativeBridgeHandle | null = null;
function ensureNativeBridge(): NativeBridgeHandle {
  if (!nativeBridge) nativeBridge = startNativeBridge();
  return nativeBridge;
}

/**
 * Warm-session cache for native_browse, scoped to this long-lived MCP process.
 * Reuses the prepared companion app + catalog (keyed by a source signature) and
 * the device facts (booted devices, readiness — nuked only on a failed capture
 * or an explicit reload), so a back-to-back native_browse for the same
 * component spawns ZERO simctl/agent-device processes before the screenshot.
 * Single-session contract: one pinned device + platform. The device facts are
 * platform-keyed, so a mid-session platform switch re-probes (the readiness
 * gate can return before a capture is attempted, so the invalidate-on-failure
 * net alone wouldn't recover it — see {@link NativeSessionCache}).
 */
const nativeSessionCache = new NativeSessionCache();

interface BrowseOpenArgs {
  /** Optional project-relative component path; if set, the URL appends `?focus=<component>`. */
  component?: string;
  /** Absolute project root. Defaults to cwd. */
  projectRoot?: string;
  /**
   * React Native / Expo only: explicit opt-in to browsing through the Expo Web
   * (`react-native-web`) proxy. Without it, an RN/Expo project is redirected to
   * `validity__native_browse` — a mobile screen belongs on a device.
   */
  webTarget?: boolean;
}

interface BrowseNavigateArgs {
  /** Project-relative component path. Mutually exclusive with `view`. */
  component?: string;
  /** Author-defined view name. Mutually exclusive with `component`. */
  view?: string;
  /** Optional scenario id from `.validity/config.ts`. */
  scenario?: string;
  /**
   * Explicit prop values merged over the auto-mocked defaults. Pass `null`
   * to clear any existing overrides. Ignored when navigating to a view.
   */
  propOverrides?: Record<string, unknown> | null;
  /** Optional viewport override. */
  viewport?: 'desktop' | 'tablet' | 'mobile';
  /** Absolute project root. Defaults to cwd. */
  projectRoot?: string;
}

interface ViewsListArgs {
  projectRoot?: string;
}

interface CatalogArgs {
  projectRoot?: string;
  /** Filter to one kind. */
  kind?: 'component' | 'screen' | 'view';
  /** Free-text filter applied to name/path (substring, case-insensitive). */
  query?: string;
  /** Include prop-type summaries (slower; off by default). */
  includeProps?: boolean;
}

interface ResolveArgs {
  projectRoot?: string;
  /** Casual name to resolve, e.g. "button" or "the login form". */
  query: string;
}

interface TokensArgs {
  projectRoot?: string;
  /** Optional group filter: color | spacing | font | radius | shadow | other. */
  group?: string;
}

interface NativeBrowseArgs {
  projectRoot?: string;
  /**
   * Casual name or path of the component/screen to mount in the simulator.
   * Mutually exclusive with `view` (the native analog of browse_navigate's
   * component/view split — no longer overloaded to also accept view names).
   */
  component?: string;
  /** Author-defined view name to mount as a composition. Mutually exclusive with `component`. */
  view?: string;
  /** Device platform. Defaults to config.native.target, else 'ios'. */
  platform?: 'ios' | 'android';
  /**
   * URL scheme for the deep link. Defaults to config.native.scheme, else a
   * companion-unique derived scheme — only pass this to override deliberately.
   */
  scheme?: string;
  /**
   * Simulator udid / emulator serial to pin every device interaction to (deep
   * link, screenshot, a11y snapshot). With exactly one booted device it is
   * auto-pinned; with several and no explicit value the call returns a
   * machine-readable MULTIPLE_DEVICES error listing the candidates.
   */
  device?: string;
  /** Optional fixture / scenario / explicit prop overrides (same contract as web). */
  fixture?: string;
  scenario?: string;
  propOverrides?: Record<string, unknown> | null;
  /**
   * Force a fresh JS bundle (terminate + cold relaunch) before rendering. Set
   * after editing source files when the device shows stale UI — a running
   * companion whose HMR socket died renders old code on warm re-targets.
   * Validity also forces this automatically whenever it restarts Metro.
   */
  reload?: boolean;
}

interface ViewsCreateArgs {
  name: string;
  title?: string;
  description?: string;
  layout?: 'stack' | 'grid';
  items: WriteViewItem[];
  /** When true, overwrite an existing view of the same name. Never bypasses
   *  collisions with component or screen paths — those are always rejected. */
  force?: boolean;
  projectRoot?: string;
}

interface ViewsDeleteArgs {
  name: string;
  projectRoot?: string;
}

interface ToolArgs {
  prompt?: string;
  /** Isolation mode: explicit changed-files list. Defaults to `git diff HEAD` + untracked. */
  changedFiles?: string[];
  /** Isolation mode: render the same components under each named scenario from .validity/config.ts. */
  scenarios?: string[];
  /** URL mode: capture this single URL. Skips the Vite sandbox entirely. */
  url?: string;
  /** URL mode: capture each path. Joined against `baseUrl` (or auto-detected from package.json). */
  paths?: string[];
  /** URL mode: explicit base URL (e.g. http://localhost:5173). Overrides auto-detection. */
  baseUrl?: string;
  projectRoot?: string;
  /**
   * Plan id from a prior `validity__plan` call. When supplied, the verify
   * response uses the persisted criteria as the scoring rubric instead of
   * asking the agent to re-extract them from the prompt.
   */
  planId?: string;
  /**
   * Native mode: run the verify against a booted iOS Simulator / Android
   * Emulator (the React Native companion) instead of the Vite sandbox. Selects
   * the changed components like isolation mode, then drives each one onto the
   * pinned device — ONE warm session, N navigate+ack+screenshot iterations — and
   * writes the same run-meta so `submit_report` works unchanged.
   */
  native?: boolean;
  /**
   * Explicit opt-in to the Expo Web (`react-native-web`) proxy on a React
   * Native / Expo project. Without it, an RN/Expo project verifies on a
   * simulator/emulator — the runtime it ships on — because a browser render of
   * a mobile app proves something the user did not ask about. Set this ONLY
   * when the user actually said they want the web target.
   */
  webTarget?: boolean;
  /** Native mode: device platform. Defaults to config.native.target, else 'ios'. */
  platform?: 'ios' | 'android';
  /** Native mode: simulator udid / emulator serial to pin the capture to. */
  device?: string;
  /** Native mode: URL-scheme override (defaults to a companion-unique scheme). */
  scheme?: string;
  /** Native mode: force a fresh JS bundle before rendering (stale-UI escape hatch). */
  reload?: boolean;
  /**
   * Response detail level (C3). `'full'` = every screenshot + per-component
   * source. `'lean'` = only the load-bearing screenshots (any render with a
   * fail/unverifiable verdict, every render while a soft criterion still needs
   * scoring, anything pixel-changed vs the previous run) and source only for
   * errored renders; previously scored soft criteria whose cited screenshots
   * are byte-identical are carried forward explicitly. Omitted ⇒ AUTO: full on
   * the first verify of a spec, lean once the spec has run history.
   * Presentation-only — verdicts, run-meta, and the gate are unchanged.
   */
  detail?: VerifyDetail;
  /** Deprecated alias for `detail: 'lean'`. `detail` wins when both are set. */
  lean?: boolean;
}

export interface PlanArgs {
  /** The user prompt this plan was derived from. Stored verbatim for audit. */
  prompt: string;
  /** Structured acceptance criteria the agent extracted from the prompt. */
  criteria: Array<{
    id: string;
    description: string;
    observable?: 'visual' | 'behavioral' | 'console' | 'a11y' | 'network';
  }>;
  /** Optional project-relative component path this plan targets. */
  componentPath?: string;
  /** Optional URL this plan targets (URL-mode verifies). */
  url?: string;
  /** Absolute project root. Defaults to cwd. */
  projectRoot?: string;
}

export interface SubmitReportArgs {
  /** runId returned by validity__verify. */
  runId: string;
  /** Optional explicit project root. Defaults to cwd. Must match what was passed to verify. */
  projectRoot?: string;
  /** Top-level verdict the agent reached after scoring the screenshots. */
  verdict?: 'pass' | 'fail' | 'partial';
  /** Per-criterion scoring. Mirrors what the agent emits in its reply to the user. */
  criteria?: Array<{
    /** Stable criterion id (matches the spec/plan criterion). Optional for back-compat. */
    id?: string;
    description: string;
    status: 'pass' | 'fail' | 'unverifiable';
    reasoning: string;
    suggestion?: string;
    /**
     * Screenshot citations — the Component id(s) of the screenshot(s) the
     * verdict was drawn from. REQUIRED for SOFT criteria (the agent must point
     * at the exact image it scored); optional for hard/property (those are
     * mechanically proven, not scored from a screenshot). The id is the
     * `Component:` id printed above each screenshot in the verify response.
     * Validity rejects a soft submission missing or with unknown citations with
     * a clear error rather than silently accepting an unsourced verdict.
     */
    screenshotIds?: string[];
  }>;
  /** 1–3 sentence note per file describing what changed. Map of project-relative path → note. */
  fileNotes?: Record<string, string>;
  /** Optional 1-paragraph human summary the agent wants surfaced at the top of the report. */
  summary?: string;
  /**
   * Optional plan id. When omitted, falls back to the planId persisted in
   * run-meta by `validity__verify`. Used to pull the upfront criteria for
   * the audit-trail panel.
   */
  planId?: string;
  /**
   * Identifier of the model/agent that scored the soft criteria (e.g.
   * "claude-opus-4"). Stamped (with the MCP session fingerprint) onto each
   * scored soft verdict as `scoredBy` provenance — metadata, never a gate.
   */
  scoredBy?: string;
  /**
   * Soft-scoring rubric version these scores were produced under (E2.2).
   * Omitted ⇒ the server stamps its own current `RUBRIC_VERSION` and marks it
   * `rubricVersionAssumed`, so every judgment records how it was scored.
   */
  rubricVersion?: string;
}

function resolveProjectRoot(input?: string): string {
  return escapeGeneratedNativeApp(input ? resolve(input) : process.cwd());
}

/**
 * If `root` points INSIDE a generated companion app (`…/.validity/native-app`
 * or deeper), return the real project root above it. A shell (or an MCP client)
 * left cd'd inside the companion is the classic footgun: regenerating from there
 * reads the wrong tsconfig (no `@/` aliases → broken imports) AND nests a second
 * `.validity/native-app/.validity/native-app`, whose empty registry then shadows
 * the canonical one — the stale-view bug. The CLI guards this in
 * `runBrowseNative`; this is the MCP-side equivalent, applied to EVERY handler
 * so views_create/native_browse/verify all resolve the same true root.
 */
function escapeGeneratedNativeApp(root: string): string {
  const marker = `${sep}.validity${sep}native-app`;
  const idx = root.indexOf(marker);
  return idx === -1 ? root : root.slice(0, idx);
}

const SCORING_INSTRUCTIONS = [
  'Score the rendered output above against the user prompt.',
  '',
  'Steps:',
  '1. Read the user prompt — extract the acceptance criteria the change should satisfy.',
  '   Treat any explicit "must", "should", or numbered/bulleted requirement as a criterion.',
  '2. For each criterion, decide pass / fail / unverifiable against the screenshots.',
  '   Use any source code returned as supporting evidence when a criterion is about',
  '   behavior/structure (not visual).',
  '3. Be specific in reasoning — quote what you saw in the screenshot.',
  '   Mark "unverifiable" only when the screenshot truly cannot show it (e.g.,',
  '   click handlers, animations).',
  '4. Emit your verdict as a single JSON object in your reply, in this shape:',
  '   {"verdict": "pass" | "fail" | "partial",',
  '    "criteria": [{"description": "...", "status": "pass"|"fail"|"unverifiable",',
  '                  "reasoning": "...", "suggestion"?: "..."}]}',
  '5. Then summarize the verdict for the user in plain prose.',
].join('\n');

/**
 * Variant of SCORING_INSTRUCTIONS used when the verify was associated with
 * a plan via `validity__plan`. The criteria are already committed — the
 * agent's job is to SCORE them, not to re-extract them. Locks the contract
 * between build and verify so misinterpretation can't slip through twice
 * (once at build, again at score).
 */
function planScopedScoringInstructions(plan: ValidityPlan): string {
  const lines: string[] = [
    'Score the rendered output above against the upfront plan.',
    '',
    `Plan: ${plan.planId} (created ${plan.createdAt})`,
    'Criteria — score EACH of these. Do NOT extract additional criteria from the prompt;',
    'this plan is the contract you build and verify against.',
    '',
  ];
  for (const c of plan.criteria) {
    const obs = c.observable ? ` [${c.observable}]` : '';
    lines.push(`  • ${c.id}${obs}: ${c.description}`);
  }
  lines.push(
    '',
    'Steps:',
    '1. For each criterion above, decide pass / fail / unverifiable against the',
    '   screenshots + diagnostics + any source code returned.',
    '2. Be specific in reasoning — quote what you saw. Mark "unverifiable" only',
    '   when the evidence genuinely cannot show it (e.g., click handlers, animations).',
    '3. Emit your verdict as a single JSON object in your reply:',
    '   {"verdict": "pass" | "fail" | "partial",',
    '    "criteria": [{"id": "<criterion-id>", "description": "...",',
    '                  "status": "pass"|"fail"|"unverifiable",',
    '                  "reasoning": "...", "suggestion"?: "..."}]}',
    '4. Then summarize the verdict for the user in plain prose.',
    '5. Call `validity__submit_report` with your verdict + criteria + planId.',
  );
  return lines.join('\n');
}

/**
 * Roll the per-render mechanical verdicts up to one verdict per spec criterion.
 *
 * Every execution of a criterion is folded, NOT just the first: a fixtures- or
 * scenario-driven native target has no base render, so its checks bind to EVERY
 * eligible variant (see renderNativeTargets) and first-wins would let a pass on
 * fixture 1 mask a fail on fixture 3. The fold is core's `mergeExecutedVerdicts`
 * — the same one web's `collectCriterionVerdicts` uses — so fail-wins means the
 * same thing on both runtimes. A single execution is returned verbatim.
 *
 * The placeholders for criteria that never executed stay NATIVE's wording
 * (web's names the web-only dataState axis, which native holds out entirely).
 * Exported for tests.
 */
export function collectVerdictsFromComponents(
  spec: Spec,
  components: ComponentRender[],
): CriterionVerdict[] {
  // criterion id → every render that executed it, in render order.
  const executed = new Map<string, Array<{ verdict: CriterionVerdict; label: string }>>();
  for (const c of components) {
    for (const v of c.criterionVerdicts ?? []) {
      const runs = executed.get(v.id) ?? [];
      runs.push({ verdict: v, label: variantLabel(c) });
      executed.set(v.id, runs);
    }
  }
  return spec.criteria.map((crit) => {
    const runs = executed.get(crit.id);
    if (runs && runs.length > 0) return mergeExecutedVerdicts(runs);
    return {
      id: crit.id,
      tier: crit.tier,
      status: 'unverifiable' as const,
      detail:
        crit.tier === 'soft'
          ? 'soft — score from the screenshot below'
          : 'checks did not execute against the rendered set',
    };
  });
}

/** Placeholder detail for a dataState-conditioned criterion on native (A2). */
export const NATIVE_DATASTATE_UNSUPPORTED_DETAIL =
  'dataState renders are not supported on native yet — unverifiable on this runtime (verify with a web isolation run, or drop the dataState condition)';

/**
 * Hold dataState-conditioned criteria OUT of the checks handed to the device
 * (A2 scopes the forced-data axis to the web sandbox's MSW layer). Their
 * checks must never execute against the natural (populated) native render —
 * a "pass" there would prove the wrong premise. The roll-up placeholder then
 * resolves them `unverifiable` and `annotateNativeDataStateVerdicts` names
 * why. Never a pass. Pure — unit-tested.
 */
export function holdNativeDataStateCriteria(criteria: SpecCriterion[]): SpecCriterion[] {
  return criteria.filter((c) => !c.dataState || c.dataState === 'populated');
}

/**
 * The soft-tier dataState hold (A2 × native): criterion ids whose SOFT verdict
 * must never be scored against a native run — no forced-data render exists
 * there, so the natural (populated) screenshot is the wrong premise. Shared by
 * the verify-time annotation/instructions and the submit-time pass clamp so
 * the two surfaces can never disagree. Pure — unit-tested.
 */
export function nativeHeldDataStateSoftIds(spec: Spec | null | undefined): Set<string> {
  return new Set(
    (spec?.criteria ?? [])
      .filter((c) => c.tier === 'soft' && c.dataState && c.dataState !== 'populated')
      .map((c) => c.id),
  );
}

/**
 * Rewrite the generic placeholder with the honest native-unsupported detail
 * for every dataState criterion — hard/property ("checks did not execute")
 * AND soft ("score from the screenshot"): a soft dataState criterion has no
 * forced-state render on native either, so inviting a score against the
 * populated screenshot would prove the wrong premise. Only a
 * still-unverifiable placeholder (no executed checks) is annotated — belt
 * and braces, since `holdNativeDataStateCriteria` prevents execution.
 *
 * ALSO stamps the demoting `data-state` evidence taint (E2.1) on every held
 * criterion, whatever its current status: the native hold is exactly the
 * "the branch never rendered" condition the taint names, and the taint is what
 * keeps a later `submit_report` pass clamped to `unverifiable` (the detail
 * string alone is prose the clamp can't read).
 *
 * Mutates in place (the verdicts are about to be persisted). Pure logic —
 * unit-tested.
 */
export function annotateNativeDataStateVerdicts(
  verdicts: CriterionVerdict[] | undefined,
  spec: Spec | undefined,
): void {
  if (!verdicts || !spec) return;
  const held = new Map(
    spec.criteria
      .filter((c) => c.dataState && c.dataState !== 'populated')
      .map((c) => [c.id, c.dataState!] as const),
  );
  for (const v of verdicts) {
    const state = held.get(v.id);
    if (!state) continue;
    if (v.status === 'unverifiable' && !(v.checks && v.checks.length > 0)) {
      v.detail = NATIVE_DATASTATE_UNSUPPORTED_DETAIL;
    }
    v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'data-state');
    v.status = applyEvidenceTaints(v.status, evidenceTaintsOf(v));
  }
}

/**
 * Project the persisted mechanical verdicts onto the canonical sign-off shape,
 * joining each verdict with its frozen-spec criterion so the stop rule can see
 * `severity` / `softThreshold`. When the spec (or a matching criterion) isn't in
 * scope, those weights are left undefined ⇒ `computeSignedOff` treats the
 * criterion as blocking — conservative, never false-green.
 */
function toSignOffCriteria(
  criterionVerdicts: CriterionVerdict[] | undefined,
  spec: Spec | undefined,
): SignOffCriterion[] {
  return (criterionVerdicts ?? []).map((v) => {
    const crit = spec?.criteria.find((c) => c.id === v.id);
    return {
      tier: v.tier,
      status: v.status,
      severity: crit?.severity,
      softThreshold: crit?.softThreshold,
      // Normalized taints (legacy networkTainted → 'network') so the sign-off
      // guard can refuse a demoting-tainted "pass" (belt-and-braces; A3).
      evidenceTaints: evidenceTaintsOf(v),
      // Self-scored provenance (A6/requireFreshJudge) — see CriterionVerdict.selfScored.
      selfScored: v.selfScored,
    };
  });
}

/**
 * Whether a sign-off RESTS on an agent-scored soft pass: among the BLOCKING
 * criteria `computeSignedOff` considered, at least one is tier 'soft'. When a
 * run is signed off and this is true, the green leans on a judged opinion — the
 * report flags it "agent-attested — worth a human check". DISPLAY-ONLY: this
 * feeds the report's sign-off note and NEVER gates. Reads the same projected
 * inputs `computeSignedOff` saw, so it can never disagree with the stop rule.
 */
function signOffRestsOnSoft(signOffInputs: SignOffCriterion[]): boolean {
  return signOffInputs.some((c) => c.severity !== 'advisory' && c.tier === 'soft');
}

/**
 * The serialized subset of a wrapper-fidelity verdict (A1) — shared by the
 * verify/submit_report `structuredContent.setup` block and the report's Setup
 * panel so loop drivers can distinguish "fix setup" from "fix component"
 * without parsing text.
 */
function pickWrapperFidelity(
  f: WrapperFidelityInfo | undefined,
): Pick<WrapperFidelityInfo, 'status' | 'missingProviders' | 'expectedProviders'> | undefined {
  if (!f) return undefined;
  return {
    status: f.status,
    missingProviders: f.missingProviders,
    expectedProviders: f.expectedProviders,
  };
}

/**
 * The `verdict.taintedCriteria` convenience block (A3): one row per criterion
 * whose evidence carries a taint (legacy `networkTainted` normalized), so a
 * loop driver can tell "fix the setup, not the component" without scanning
 * every verdict. Empty array when nothing is tainted — callers omit the key.
 */
function taintedCriteriaOf(
  verdicts: CriterionVerdict[],
): Array<{ id: string; taints: EvidenceTaint[] }> {
  const out: Array<{ id: string; taints: EvidenceTaint[] }> = [];
  for (const v of verdicts) {
    const taints = evidenceTaintsOf(v);
    if (taints.length > 0) out.push({ id: v.id, taints });
  }
  return out;
}

/**
 * The `structuredContent.temporal` sibling key (B2, registry §9.1): the
 * spec-preceded-the-work classification. A SIBLING of `verdict` (invariant #3
 * — only B1/A3 touch the verdict block) and display-only provenance: nothing
 * in here feeds status/signedOff/exit codes. Callers omit the key entirely
 * when no spec is in scope.
 */
function buildTemporalContent(
  t: TemporalResult,
  spec: { id: string; version: number },
): {
  classification: TemporalResult['classification'];
  reason: string;
  freezeSha?: string;
  verifySha?: string;
  perSpec: Array<{
    specId: string;
    version: number;
    classification: TemporalResult['classification'];
  }>;
} {
  return {
    classification: t.classification,
    reason: t.reason,
    ...(t.freezeSha ? { freezeSha: t.freezeSha } : {}),
    ...(t.verifySha ? { verifySha: t.verifySha } : {}),
    perSpec: [{ specId: spec.id, version: spec.version, classification: t.classification }],
  };
}

/* -------------------------------------------------------------------------- */
/* environmentBlocked — the agent-loop half of the diagnosis surface           */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable "why did this run produce nothing" (handoff-2026-07-28).
 *
 * The human `content` text already carries a LIKELY CAUSE block, but a headless
 * loop driver reads `structuredContent` and nothing else — so a decayed
 * emulator, a phantom device claim and a genuinely broken component were all
 * one indistinguishable silence to the only consumer that could act on them.
 *
 * INVARIANTS (all three are load-bearing):
 *   - ADDITIVE. Omitted entirely when nothing is blocked, so a healthy run's
 *     payload is byte-identical to the pre-feature one.
 *   - INERT. Structurally unreachable from `verdict`/`signedOff`/exit codes.
 *     Naming a cause never turns an unverifiable into a pass (never false
 *     green) and never turns an honest pass into a failure (never false red).
 *   - `cause` is a plain `string`, not `NativeBlockCause`. The readiness path
 *     emits causes the diagnosis probes have no vocabulary for
 *     (`setup-incomplete`), and a consumer must not break when a future probe
 *     adds one.
 */
export interface EnvironmentBlockedContent {
  cause: string;
  /** What was observed, concretely — the developer should recognize it. */
  symptom: string;
  /** What it means, and why verdicts were withheld. */
  detail: string;
  /** Exact shell command(s), newline-separated. Absent ⇒ no one-command fix. */
  fixCommand?: string;
  confidence: 'confirmed' | 'suspected';
}

/**
 * Project a native `EnvironmentDiagnosis` onto the wire shape. Deliberately a
 * field-by-field pick rather than a spread: the diagnosis type is free to grow
 * probe-internal fields without silently widening a published payload.
 */
export function environmentBlockedFromDiagnosis(
  d: EnvironmentDiagnosis,
): EnvironmentBlockedContent {
  return {
    cause: d.cause,
    symptom: d.symptom,
    detail: d.detail,
    ...(d.fixCommand ? { fixCommand: d.fixCommand } : {}),
    confidence: d.confidence,
  };
}

/**
 * Machine-readable "this run produced evidence, but some of it is missing and
 * here is why" — the PARTIAL-degradation sibling of
 * {@link EnvironmentBlockedContent}.
 *
 * WHY A SEPARATE KEY, not a widened `environmentBlocked`. The multi-target
 * native loop can confirm early targets and then start failing later ones (the
 * documented session-decay shape: "cold emulator: 33 pass… after a few sweeps:
 * 14 pass, then 9 pass"). Before this, the cause was only in the failing
 * render's `renderError` PROSE, and a headless driver — which reads
 * `structuredContent` and nothing else — saw an unexplained partial run.
 * Widening `environmentBlocked` to cover it would be worse than the silence:
 * a driver may quite reasonably treat "blocked" as "abort the sweep, fix the
 * machine", and a run that produced real evidence for most of its targets must
 * not trigger that. So `environmentBlocked` keeps its exact `!anyConfirmed`
 * semantics and this is a strictly weaker, strictly additive signal.
 *
 * Same three invariants as `environmentBlocked`: ADDITIVE (omitted when the run
 * is clean), INERT (structurally unreachable from `verdict`/`signedOff`), and
 * `cause` stays an open `string`.
 */
export interface EnvironmentDegradedContent extends EnvironmentBlockedContent {
  /** How many of this run's renders did not confirm. Always ≥ 1 when present. */
  affectedRenders: number;
  /**
   * Screenshot keys (`<componentId>__<variantSlug>`) of the renders that did
   * not confirm — the same identity the report, the baselines and the
   * screenshot files use, so a driver can line the cause up with the evidence
   * it did NOT get.
   */
  affectedTargets: string[];
}

/**
 * Project a diagnosis + the renders it explains onto the degraded wire shape.
 * Field-by-field, for the same reason {@link environmentBlockedFromDiagnosis}
 * is: a probe-internal field must never silently widen a published payload.
 */
export function environmentDegradedFromDiagnosis(
  d: EnvironmentDiagnosis,
  affected: Array<Pick<ComponentRender, 'screenshotPath'>>,
): EnvironmentDegradedContent {
  return {
    ...environmentBlockedFromDiagnosis(d),
    affectedRenders: affected.length,
    affectedTargets: affected.map((r) => basename(r.screenshotPath).replace(/\.png$/i, '')),
  };
}

/**
 * Which named cause a readiness step failure corresponds to. The environment
 * probes (steps 7-9) are BUILT from diagnoses, so they map onto the same
 * vocabulary; the setup steps (a missing scheme, an uninstalled companion) are
 * honestly `setup-incomplete` — a first-run machine is not a decayed one, and
 * telling a developer their daemon is wedged when they simply have not
 * installed the companion is the false-alarm this whole feature exists to
 * avoid.
 */
export function readinessStepCause(stepId: string): string {
  switch (stepId) {
    case 'agent-device-daemon':
      return 'daemon-unresponsive';
    case 'device-claim':
      return 'phantom-device-claim';
    case 'companion-metro-owner':
      return 'foreign-metro';
    case 'agent-device':
      return 'stale-agent-device';
    case 'device':
      return 'device-not-ready';
    default:
      return 'setup-incomplete';
  }
}

/**
 * Turn a not-ready readiness result into `environmentBlocked`. The FIRST unmet
 * step is the cause (readiness already orders steps cheapest-and-most-certain
 * first, and `nextAction` is that same step), so this reports one thing to do,
 * not a wall.
 *
 * Returns undefined for a READY checklist — a ready environment is never
 * "blocked", and emitting a diagnosis for one would be exactly the working-setup
 * false alarm the probes are written to refuse.
 */
export function readinessEnvironmentBlocked(
  readiness: NativeReadiness,
  targetLabel: string,
): EnvironmentBlockedContent | undefined {
  if (readiness.ready) return undefined;
  const step: ReadinessStep | undefined =
    readiness.nextAction ?? readiness.steps.find((s) => s.status === 'todo');
  if (!step) return undefined;
  return {
    cause: readinessStepCause(step.id),
    symptom: `${step.label}: ${step.detail}`,
    detail:
      `The native playground is not ready, so nothing was rendered and no verdict was produced ` +
      `for ${targetLabel}. This is a setup/environment state, NOT a judgement about the code — ` +
      `re-run this tool once the checklist is clear.`,
    // CONFIRMED, unlike most probe diagnoses: a readiness step is a direct
    // observation of a prerequisite, not an inference from a symptom.
    ...(step.action ? { fixCommand: step.action } : {}),
    confidence: 'confirmed',
  };
}

/**
 * Build the ADDITIVE `structuredContent.verdict` block returned by every
 * `validity__verify` mode. Loop drivers read this (the human-facing `content`
 * array is untouched): `status` is the rollup over the mechanical verdicts and
 * `signedOff` is THE stop signal (every blocking criterion passing).
 *
 * When a `specId` is in scope, ALSO surface a compact `recentRuns` array (last
 * 5 entries of the per-spec timeline, newest-last) so a loop consumer gets
 * cross-iteration history — "verdict / signedOff N iterations ago" — without a
 * file read. The CURRENT run is already indexed by the time verify returns
 * (the run finalizers append before the response is built), so it appears as
 * the last element. Omitted entirely when there is no spec in scope.
 */
export function buildVerifyStructuredContent(
  runId: string,
  criterionVerdicts: CriterionVerdict[] | undefined,
  spec: Spec | undefined,
  projectRoot: string,
  specId: string | undefined,
  renders?: Array<Pick<ComponentRender, 'id' | 'scenarioId' | 'fixtureId' | 'performance'>>,
  planned = false,
  perfDrift?: Array<Pick<Signal, 'perfKey' | 'detail'>>,
  /**
   * Named cause for a run that produced no usable evidence (native path only
   * today). Passed by the caller, never derived here — this builder stays pure.
   */
  environmentBlocked?: EnvironmentBlockedContent,
  /**
   * Named cause for a run that DID produce evidence but lost some targets to
   * the environment (native multi-target path only today). Mutually exclusive
   * with `environmentBlocked` at the call site — a run either produced nothing
   * or produced something — but this builder stays pure and does not enforce it.
   */
  environmentDegraded?: EnvironmentDegradedContent,
): {
  verdict: {
    status: 'pass' | 'fail' | 'partial' | 'unverifiable';
    runId: string;
    signedOff: boolean;
    /**
     * Display-only provenance (B1): false ⇔ criteria were extracted after the
     * work (no plan/spec id at verify time). Never feeds status/signedOff.
     */
    planned: boolean;
    /**
     * Present (true) only when sign-off rests on ZERO blocking criteria — an
     * all-advisory spec. Surface, never a gate: computeSignedOff legitimately
     * returns true, so this just makes the vacuous green visible.
     */
    vacuousSignoff?: boolean;
    /**
     * Present only when this frozen version relaxed a criterion vs its
     * predecessor (tier hard→soft, blocking→advisory, softThreshold lowered).
     * Surface, never a gate.
     */
    weakenedSince?: { fromVersion: number; criteria: CriterionWeakening[] };
    criterionVerdicts: CriterionVerdict[];
    /** Present only when non-empty (A3): criteria with tainted evidence. */
    taintedCriteria?: Array<{ id: string; taints: EvidenceTaint[] }>;
    recentRuns?: Array<{
      runId: string;
      createdAt: string;
      verdict: 'pass' | 'fail' | 'partial' | 'unverifiable';
      signedOff?: boolean;
    }>;
  };
  /**
   * ADVISORY perf namespace (registry §9.1: D2 `hints`, D1 `drift`). Omitted —
   * not empty — when neither fired, so perf-quiet runs return byte-identical
   * payloads. Structurally unreachable from `verdict`/`signedOff`: nothing in
   * here feeds the stop rule.
   */
  perf?: {
    hints?: Array<{ render: string } & PerfHint>;
    drift?: Array<{ perfKey?: string; detail: string }>;
  };
  /**
   * SIBLING key of `verdict` (invariant #3 — only B1/A3 touch the verdict
   * block): why this run produced no mechanical verdict. Present ONLY when the
   * caller established a cause; a healthy run omits the key entirely.
   */
  environmentBlocked?: EnvironmentBlockedContent;
  /**
   * SIBLING key of `verdict`, and a strictly weaker signal than
   * `environmentBlocked`: this run DID produce evidence, but N targets were
   * lost to the named environment cause. Present ONLY when the caller
   * established a cause for a partially-degraded run.
   */
  environmentDegraded?: EnvironmentDegradedContent;
} {
  const verdicts = criterionVerdicts ?? [];
  // Speak ONE verdict vocabulary across this payload: re-roll each timeline
  // entry through `rollupCriterionVerdicts` (the same fn behind `status` above)
  // from its persisted per-criterion snapshot, rather than echoing the stored
  // `SpecRunSummary.verdict` (which uses the distinct pass|fail|partial|unknown
  // rollup). This way the current run — the last `recentRuns` element — reports
  // the SAME verdict string as the top-level `status`, and a loop driver never
  // sees one runId labeled two ways. Pre-feature rows lack `criteria` and roll
  // up to `unverifiable` (honest: their per-criterion snapshot wasn't captured).
  const recentRuns = specId
    ? readSpecRunHistory(projectRoot, specId, 5).map((r) => ({
        runId: r.runId,
        createdAt: r.createdAt,
        verdict: rollupCriterionVerdicts(r.criteria ?? []),
        signedOff: r.signedOff,
      }))
    : undefined;
  const taintedCriteria = taintedCriteriaOf(verdicts);
  // VACUOUS SIGN-OFF + CRITERION WEAKENING (surface, never gate) — mirror the
  // submit_report response's sibling fields so a loop driver sees them at verify
  // time too. Both are omitted when they don't apply, keeping quiet payloads
  // byte-identical.
  const signOffInputs = toSignOffCriteria(verdicts, spec);
  const vacuousSignoff =
    computeSignedOff(signOffInputs) &&
    signOffInputs.filter((c) => c.severity !== 'advisory').length === 0;
  const weakened = spec ? weakenedSincePrevVersion(projectRoot, spec) : null;
  // Advisory perf hints per render (D2) — recomputed from the persisted
  // metrics, never stored. The render label matches the `identicalTo` slug
  // convention so an agent can line hints up with the screenshots.
  const perfHints = (renders ?? []).flatMap((r) =>
    computePerfHints(r.performance).map((hint) => ({
      render: `${r.id}__${r.scenarioId ?? 'base'}${r.fixtureId ? `__${r.fixtureId}` : ''}`,
      ...hint,
    })),
  );
  return {
    verdict: {
      status: rollupCriterionVerdicts(verdicts),
      runId,
      signedOff: computeSignedOff(signOffInputs),
      planned,
      ...(vacuousSignoff ? { vacuousSignoff: true } : {}),
      ...(weakened
        ? { weakenedSince: { fromVersion: weakened.fromVersion, criteria: weakened.weakenings } }
        : {}),
      criterionVerdicts: verdicts,
      ...(taintedCriteria.length > 0 ? { taintedCriteria } : {}),
      ...(recentRuns ? { recentRuns } : {}),
    },
    // Both perf surfaces nest under the ONE merged advisory key (registry
    // §9.1): D2's hints + D1's drift (open perf-drift signals from the spec's
    // timeline, projected to perfKey + detail).
    ...(perfHints.length > 0 || (perfDrift?.length ?? 0) > 0
      ? {
          perf: {
            ...(perfHints.length > 0 ? { hints: perfHints } : {}),
            ...(perfDrift && perfDrift.length > 0
              ? {
                  drift: perfDrift.map((s) => ({
                    ...(s.perfKey ? { perfKey: s.perfKey } : {}),
                    detail: s.detail,
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(environmentBlocked ? { environmentBlocked } : {}),
    ...(environmentDegraded ? { environmentDegraded } : {}),
  };
}

const VERDICT_GLYPH: Record<'pass' | 'fail' | 'unverifiable', string> = {
  pass: '[PASS]',
  fail: '[FAIL]',
  unverifiable: '[UNVERIFIABLE]',
};

/**
 * Render the "proven" block: the hard/property criteria executed
 * deterministically in the sandbox, with their mechanical verdict + per-check
 * detail. Returns null when the spec has no hard/property criteria.
 */
function renderProvenChecksBlock(verdicts: CriterionVerdict[]): string | null {
  const proven = verdicts.filter((v) => v.tier === 'hard' || v.tier === 'property');
  if (proven.length === 0) return null;
  const lines: string[] = [
    'Deterministic checks (PROVEN — executed in the sandbox, no LLM judgement):',
    'These verdicts are mechanical. Do NOT re-judge them from the screenshot; report them as-is.',
    '',
  ];
  for (const v of proven) {
    // Machine-and-eye greppable taint KIND label; the reasons are already in
    // `detail` via the executors' `— tainted: …` convention.
    const taints = evidenceTaintsOf(v);
    const taintLabel = taints.length > 0 ? ` ⚠ tainted: ${taints.join(', ')}` : '';
    lines.push(
      `  ${VERDICT_GLYPH[v.status]}  ${v.id} [${v.tier}] — ${v.detail ?? ''}${taintLabel}`,
    );
    for (const c of v.checks ?? []) {
      lines.push(`      • ${c.status}: ${c.detail ?? JSON.stringify(c.check)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a compact "Regression vs. last run" block for the verify response.
 * Shows only criteria that CHANGED status (regressed ↓ / improved ↑ / new +)
 * plus a count summary — unchanged criteria are silent to keep the response
 * tight. Returns null when there are no deltas (first run, or no spec, or
 * every criterion was unchanged) so the caller doesn't push an empty block.
 *
 * DISPLAY-ONLY: this never participates in the pass/fail gate — a criterion's
 * authoritative status is its CriterionVerdict.status, surfaced above.
 */
function renderRegressionDeltasBlock(deltas: RegressionDelta[] | undefined): string | null {
  if (!deltas || deltas.length === 0) return null;
  const changed = deltas.filter((d) => d.delta !== 'unchanged');
  if (changed.length === 0) return null;
  const regressed = changed.filter((d) => d.delta === 'regressed');
  const improved = changed.filter((d) => d.delta === 'improved');
  const isNew = changed.filter((d) => d.delta === 'new');
  const lines: string[] = [
    'Regression vs. last run of this spec (display-only — not part of the gate):',
    `  ${regressed.length} regressed, ${improved.length} improved, ${isNew.length} new, ${deltas.length - changed.length} unchanged`,
  ];
  for (const d of regressed) {
    lines.push(`  ↓ ${d.criterionId} regressed: ${d.previousStatus ?? '—'} → ${d.currentStatus}`);
  }
  for (const d of improved) {
    lines.push(`  ↑ ${d.criterionId} improved: ${d.previousStatus ?? '—'} → ${d.currentStatus}`);
  }
  for (const d of isNew) {
    lines.push(`  + ${d.criterionId} new (not in the previous run's spec)`);
  }
  return lines.join('\n');
}

/**
 * Render the advisory perf-drift block (D1) from this spec's OPEN perf-drift
 * signals. Returns null when there are none. ADVISORY-ONLY, like the deltas
 * block above: drift never participates in any gate — the only perf that
 * gates is an explicit `expect.performance` budget in the frozen spec.
 */
function renderPerfDriftBlock(open: Signal[]): string | null {
  if (open.length === 0) return null;
  return (
    'Perf drift (advisory — never gates):' +
    open.map((s) => `\n  • ${s.perfKey ? `${s.perfKey}: ` : ''}${s.detail}`).join('')
  );
}

/**
 * Upgrade native `expect.screenshot` verdicts in place using the pixel diff
 * computed during capture (parity with the web verify path — mirrors
 * `capture.ts`). The native check executor stubs `expect.screenshot` as
 * `unverifiable` because it can't run the baseline compare; here, once the
 * verify run HAS a real diff, we resolve those stubs to a pass/fail against
 * `maxDiffPixels`.
 *
 * Sticky network taint is preserved via `refoldAfterScreenshot`: a criterion
 * demoted to `unverifiable` because an expect.network consumed a fabricated
 * catch-all body is NOT laundered back to `pass` by a passing screenshot check.
 *
 * The caller MUST gate on `if (diff)` — when no baseline exists the diff is
 * undefined and the screenshot check stays `unverifiable` (no false-green).
 */
export function applyNativeScreenshotDiff(
  verdicts: CriterionVerdict[] | undefined,
  diff: { mismatchedPixels: number },
): void {
  if (!verdicts) return;
  for (const verdict of verdicts) {
    if (!verdict.checks) continue;
    const hasScreenshotCheck = verdict.checks.some(
      (cv) => 'expect' in cv.check && cv.check.expect.screenshot !== undefined,
    );
    if (!hasScreenshotCheck) continue;
    verdict.checks = evaluateScreenshotExpects(verdict.checks, diff);
    verdict.status = refoldAfterScreenshot({
      networkTainted: verdict.networkTainted,
      evidenceTaints: verdict.evidenceTaints,
      checks: verdict.checks,
    });
  }
}

/** A submitted criterion as `validateSoftCitations` needs to see it. */
export interface SoftCitationSubmission {
  id?: string;
  description: string;
  /**
   * The scored status. Read by the relevance floor: an EMPTY (blank-PNG) render
   * is a legitimate citation for a `fail`/`unverifiable` (the emptiness IS the
   * evidence) but never proves a `pass`. Absent ⇒ treated like a pass (the
   * stricter default), which only matters when `emptyScreenshotIds` is supplied.
   */
  status?: 'pass' | 'fail' | 'unverifiable';
  screenshotIds?: string[];
}

/**
 * SOFT-SCORING QUALITY FLOOR (pure, unit-tested). Every soft criterion
 * submission MUST cite the screenshot(s) it was scored from — an unsourced soft
 * verdict is unfalsifiable (the agent could have scored from memory, the wrong
 * render, or no image at all). Returns one error string per OFFENDING soft
 * criterion; an empty array means "OK to persist".
 *
 * Rules:
 *   • Fires ONLY when a spec is present AND the matched criterion is `soft`.
 *     Hard/property criteria are mechanically proven, not scored from an image,
 *     so they never need citations. Non-spec / legacy plan submits (spec null,
 *     or no matching criterion) are lenient — those flows have no soft contract.
 *   • A soft submission with no `screenshotIds` is rejected (missing citation).
 *   • A soft submission citing ids NOT in `validScreenshotIds` is rejected
 *     (citation theater — the cited render doesn't exist). The valid-id set is
 *     built from run-meta by the caller, never from the submitted ids.
 *   • RELEVANCE (A3 §5.3): a soft `pass` whose ONLY citations are EMPTY
 *     (blank-PNG) renders is rejected — a pass can't be proven from a shot with
 *     no visible content (same "not ground truth" rule `renderIsBaselineWorthy`
 *     applies). The render still EXISTS, so it stays a valid citation for a
 *     `fail`/`unverifiable` (the emptiness is the evidence there). `looksEmpty`
 *     ids are passed in `emptyScreenshotIds`; absent ⇒ the guard is inert
 *     (byte-identical to the pre-relevance behavior).
 */
export function validateSoftCitations(args: {
  submitted: SoftCitationSubmission[];
  spec: Spec | null;
  validScreenshotIds: Set<string>;
  /**
   * Subset of `validScreenshotIds` whose PNG is blank (`ComponentRender.looksEmpty`).
   * A soft `pass` may not be backed SOLELY by these. Omit for the legacy
   * behavior (no empty-render guard).
   */
  emptyScreenshotIds?: Set<string>;
}): string[] {
  const { submitted, spec, validScreenshotIds, emptyScreenshotIds } = args;
  if (!spec) return [];
  const errors: string[] = [];
  const validList = Array.from(validScreenshotIds);
  const idHint =
    validList.length > 0
      ? `Valid ids for this run: ${validList.slice(0, 8).join(', ')}${validList.length > 8 ? ', …' : ''}.`
      : 'This run produced no screenshots to cite.';
  // Ids citable for a PASS: the valid set minus the blank-PNG renders.
  const passCitable = validList.filter((id) => !emptyScreenshotIds?.has(id));
  const passIdHint =
    passCitable.length > 0
      ? `Renders citable for a PASS (non-empty): ${passCitable.slice(0, 8).join(', ')}${passCitable.length > 8 ? ', …' : ''}.`
      : 'This run produced no NON-EMPTY screenshots — a pass cannot be sourced here (re-verify to capture real pixels).';
  for (const c of submitted) {
    // Resolve id-first, then fall back to the description text — the SAME
    // resolution the verdict writeback uses (findSubmitted: byId ?? byText).
    // Matching id-ONLY here while the writeback also matches by text let a
    // submission carrying a wrong `id` but the exact soft-criterion description
    // slip past this floor (specCrit undefined → skipped) yet still land its
    // pass through the text-keyed writeback. Unify the two so the floor sees
    // every submission the writeback will act on.
    const specCrit =
      (c.id ? spec.criteria.find((cc) => cc.id === c.id) : undefined) ??
      spec.criteria.find((cc) => cc.text === c.description);
    if (!specCrit || specCrit.tier !== 'soft') continue;
    if (!c.screenshotIds || c.screenshotIds.length === 0) {
      errors.push(
        `${specCrit.id}: soft criterion submission is missing screenshot citations — ` +
          `pass \`screenshotIds: [<id>]\` with the Component id(s) of the screenshot(s) you scored from. ` +
          idHint,
      );
      continue;
    }
    const invalid = c.screenshotIds.filter((sid) => !validScreenshotIds.has(sid));
    if (invalid.length > 0) {
      errors.push(
        `${specCrit.id}: screenshotIds reference unknown render id(s): ${invalid.join(', ')}. ` +
          idHint,
      );
      continue;
    }
    // RELEVANCE: a `pass` needs at least one NON-EMPTY citation. fail/unverifiable
    // may cite an empty render (the blank shot IS the evidence). Absent
    // emptyScreenshotIds ⇒ no ids qualify as empty ⇒ inert.
    const isPass = c.status !== 'fail' && c.status !== 'unverifiable';
    if (isPass && emptyScreenshotIds && emptyScreenshotIds.size > 0) {
      const nonEmptyCited = c.screenshotIds.filter((sid) => !emptyScreenshotIds.has(sid));
      if (nonEmptyCited.length === 0) {
        errors.push(
          `${specCrit.id}: a soft PASS cannot be sourced only from empty (blank) render(s): ` +
            `${c.screenshotIds.join(', ')} — the screenshot shows no visible content to prove the ` +
            `criterion. Cite a non-empty render, or score fail/unverifiable. ${passIdHint}`,
        );
      }
    }
  }
  return errors;
}

/**
 * CROSS-COMPONENT RELEVANCE (A3 §5.3, advisory). A soft `pass` should cite a
 * render of a component the spec actually TARGETS — a pass sourced only from a
 * render of a DIFFERENT component is suspect (the evidence isn't about the thing
 * under test). The data model binds targets at the SPEC level
 * (`spec.targets.components`), NOT per-criterion, so this is a WARNING surface,
 * never a gate: it fires only when the spec declares component targets AND a
 * pass's cited renders (that resolve to known component paths) match NONE of
 * them. Page (URL-mode) citations carry no component path and are ignored.
 * Returns one line per offending criterion. Pure; the caller supplies the
 * id→component-path map built from run-meta.
 */
export function crossComponentPassWarnings(args: {
  submitted: SoftCitationSubmission[];
  spec: Spec | null;
  renderComponentPathById: Map<string, string>;
}): string[] {
  const { submitted, spec, renderComponentPathById } = args;
  const targets = spec?.targets?.components ?? [];
  if (!spec || targets.length === 0) return [];
  const targetKeys = new Set(targets.map(componentBaseKey));
  const warnings: string[] = [];
  for (const c of submitted) {
    if (c.status === 'fail' || c.status === 'unverifiable') continue;
    const specCrit =
      (c.id ? spec.criteria.find((cc) => cc.id === c.id) : undefined) ??
      spec.criteria.find((cc) => cc.text === c.description);
    if (!specCrit || specCrit.tier !== 'soft') continue;
    const cited = c.screenshotIds ?? [];
    // Only consider citations that resolve to a KNOWN component render (pages
    // and unknown ids are out of scope here).
    const componentCited = cited.filter((id) => renderComponentPathById.has(id));
    if (componentCited.length === 0) continue;
    const onTarget = componentCited.some((id) =>
      targetKeys.has(componentBaseKey(renderComponentPathById.get(id)!)),
    );
    if (!onTarget) {
      warnings.push(
        `${specCrit.id}: soft pass cites render(s) of a component outside this spec's targets ` +
          `(${targets.join(', ')}) — confirm the screenshot is of the component under test.`,
      );
    }
  }
  return warnings;
}

/**
 * Scoring instructions for a SPEC verify. Hard/property tiers are already
 * proven above — the host model only scores the SOFT tiers from the
 * screenshots, then reports both with the proven verdicts kept verbatim.
 *
 * Under lean (C3) the soft section splits: OPEN criteria are scored from the
 * attached screenshots exactly as always; CARRIED-FORWARD criteria (recorded
 * score + byte-identical cited evidence) are reported with their recorded
 * status, never re-judged from memory and never presented as fresh scores.
 * With no carry-forward the output is byte-identical to the pre-C3 text.
 *
 * `heldNativeDataState` (A2 × native, from `nativeHeldDataStateSoftIds`)
 * removes dataState-conditioned soft criteria from the scoreable set on a
 * NATIVE run: no forced-data render exists there, so the screenshots above
 * show the wrong premise. They are named in a HELD block — recorded
 * `unverifiable`, never invited to be scored green. Web passes nothing (the
 * sandbox renders the forced state for real).
 */
export function specScopedScoringInstructions(
  spec: Spec,
  carryForward?: CarryForwardSoft[],
  heldNativeDataState?: ReadonlySet<string>,
): string {
  const soft = spec.criteria.filter((c) => c.tier === 'soft');
  const carried = new Map((carryForward ?? []).map((c) => [c.id, c]));
  const held = soft.filter((c) => heldNativeDataState?.has(c.id));
  const open = soft.filter((c) => !carried.has(c.id) && !heldNativeDataState?.has(c.id));
  const lines: string[] = [
    `Spec: ${spec.id}@v${spec.version}${spec.hash ? ` (${spec.hash})` : ''}`,
    '',
    'Two kinds of criteria, scored differently — keep them SEPARATE in your report:',
    '  • HARD / PROPERTY (proven above) — mechanical. Copy their verdicts verbatim;',
    '    never relabel a proven fail as a pass, or claim proof you did not get.',
    '    (Performance budgets — expect.performance — are proven checks too: their',
    '    measured ms vs maxMs is mechanical. Do NOT also soft-score "feels fast".)',
  ];
  if (soft.length > 0) {
    if (open.length > 0) {
      lines.push(
        '  • SOFT — your job. Score EACH from the screenshots + diagnostics + source:',
        '',
      );
      for (const c of open) lines.push(`      • ${c.id}: ${c.text}`);
      lines.push(
        '',
        '    QUALITY FLOOR: for each soft criterion you MUST cite the screenshot(s) you scored',
        '    from via `screenshotIds: [<id>]`. The id is the `Component:` id printed above each',
        '    screenshot in this response. submit_report REJECTS a soft submission with missing or',
        '    unknown citations — an unsourced verdict is unfalsifiable.',
      );
    } else if (carried.size > 0) {
      lines.push(
        '  • SOFT — every soft criterion carried forward from the previous run (see below);',
        '    none needs fresh scoring this run.',
      );
    } else {
      lines.push(
        '  • SOFT — none scoreable on this runtime (all held, see below); nothing needs',
        '    fresh scoring this run.',
      );
    }
    if (carried.size > 0) {
      const scoredInRunId = carryForward![0]!.scoredInRunId;
      lines.push(
        '',
        `    CARRIED FORWARD (lean): recorded scores from run ${scoredInRunId} whose cited`,
        '    screenshot(s) are byte-identical in this run. Report each with its recorded',
        '    status, reasoning prefixed "carried forward:", citing the same render id(s).',
        '    Do NOT re-judge them from memory; to re-score visually, re-run verify with',
        "    detail:'full'.",
      );
      for (const c of carryForward!) {
        lines.push(`      • ${c.id} — ${c.status} (cite: ${c.screenshotCitations.join(', ')})`);
      }
    }
    if (held.length > 0) {
      lines.push(
        '',
        '    HELD (native): dataState-conditioned soft criteria cannot be scored on this',
        '    runtime — no forced-data render exists, so the screenshots above show the',
        '    WRONG data state. Leave them out of your submission (their verdict is already',
        '    recorded as `unverifiable`; submit_report refuses a pass). Score them with a',
        '    web isolation run, or drop the dataState condition.',
      );
      for (const c of held) {
        lines.push(`      • ${c.id}: ${c.text} (dataState: ${c.dataState})`);
      }
    }
  } else {
    lines.push('  • SOFT — none in this spec; the contract is fully mechanical.');
  }
  lines.push(
    '',
    'Then emit one JSON object combining proven + scored:',
    '   {"verdict": "pass" | "fail" | "partial",',
    '    "criteria": [{"id": "<id>", "description": "<criterion text>",',
    '                  "tier": "hard"|"property"|"soft",',
    '                  "status": "pass"|"fail"|"unverifiable",',
    '                  "reasoning": "...", "suggestion"?: "...",',
    '                  "screenshotIds"?: ["<Component id>", ...]}]}',
    'Always include the criterion `id` so submit_report can match your score to the',
    'upfront criterion (and keep any mechanical hard-tier verdict authoritative).',
    'Then call `validity__submit_report` with verdict + criteria + planId: ' +
      `"${spec.id}". The report renders proven vs scored distinctly.`,
  );
  return lines.join('\n');
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Curated render-error → wrapper-fix hints.
 *
 * The render error returned by the sandbox is the raw exception React
 * caught in `window.onerror`. Without help, models routinely interpret
 * a missing-provider error as "isolation mode is broken — fall back to
 * URL mode" and start the project's dev server, which violates Hard
 * Rule #1 in the skill spec.
 *
 * Each entry maps a stable substring or regex pattern of a known error
 * to a one-line hint pointing at `.validity/wrapper.user.tsx`. Hints
 * can be a literal string OR a function of the regex match groups —
 * use the function form when the provider name is encoded in the error
 * (the generic "must be used within <X>Provider" pattern is the main
 * driver). Keep hints short and actionable: the agent reads them inline
 * with the raw error and decides whether to escape to URL mode.
 */
type RenderErrorHint = {
  match: string | RegExp;
  hint: string | ((m: RegExpMatchArray) => string);
};

const RENDER_ERROR_HINTS: ReadonlyArray<RenderErrorHint> = [
  // Specific cases beat the generic Provider pattern below — list first.
  {
    match: 'useNavigate() may be used only in the context of a <Router>',
    hint:
      'fix: add `<MemoryRouter>` around `{children}` in `.validity/wrapper.user.tsx` ' +
      "(import from 'react-router-dom'). The component you're rendering uses useNavigate. " +
      'Stay in isolation mode — do NOT switch to URL mode.',
  },
  {
    match: 'useLocation() may be used only in the context of a <Router>',
    hint:
      'fix: add `<MemoryRouter>` around `{children}` in `.validity/wrapper.user.tsx` ' +
      "(import from 'react-router-dom'). The component uses useLocation.",
  },
  {
    match: 'useParams',
    hint:
      'fix: add `<MemoryRouter>` around `{children}` in `.validity/wrapper.user.tsx` ' +
      "(import from 'react-router-dom'). The component uses useParams.",
  },
  {
    match: 'could not find react-redux context value',
    hint:
      'fix: wrap `{children}` in `<Provider store={store}>` inside ' +
      '`.validity/wrapper.user.tsx` (import from `react-redux` and your store module).',
  },
  {
    match: 'No QueryClient set',
    hint:
      'fix: wrap `{children}` in `<QueryClientProvider client={new QueryClient()}>` ' +
      'inside `.validity/wrapper.user.tsx` (import from `@tanstack/react-query`).',
  },
  {
    match: 'useApolloClient',
    hint:
      'fix: wrap `{children}` in `<ApolloProvider client={client}>` inside ' +
      '`.validity/wrapper.user.tsx` (import from `@apollo/client`).',
  },
  // Generic "must be used within <X>Provider" — catches user-defined
  // contexts the cloner can't discover (e.g. TrainingGenerationProvider).
  // The agent has to find the provider's import path itself; the hint
  // tells it exactly how. Pattern is stable across React versions because
  // the message comes from the user's own throw call, conventionally
  // produced by `if (!ctx) throw new Error("useFoo must be used within FooProvider")`.
  {
    match:
      /(?:use\w+|the\s+\w+\s+context)\s+must\s+be\s+used\s+(?:with(?:in)?|inside)(?:\s+(?:an?|the))?\s+(?:a\s+)?<?([A-Z]\w*(?:Provider|Context))>?/,
    hint: (m) => {
      const providerName = m[1];
      return (
        `fix (project-specific provider missing): wrap \`{children}\` in ` +
        `\`<${providerName}>\` inside \`.validity/wrapper.user.tsx\`.\n` +
        `  Steps for the agent assisting the user:\n` +
        `    1. STAY IN ISOLATION MODE — do NOT start a dev server or switch to URL mode.\n` +
        `    2. Find where \`${providerName}\` is exported (try \`grep -r "export.*${providerName}" src/\`).\n` +
        `    3. Create \`.validity/wrapper.user.tsx\` if it doesn't exist with shape:\n` +
        `       export default function UserWrapper({ children }) {\n` +
        `         return <${providerName}>{children}</${providerName}>;\n` +
        `       }\n` +
        `       (import \`${providerName}\` from its source file; if the provider needs props,\n` +
        `        construct realistic stubs or seed them from \`.validity/config.ts\` scenarios).\n` +
        `    4. If \`wrapper.user.tsx\` already exists, ADD \`<${providerName}>\` to its tree.\n` +
        `    5. Re-run \`validity__verify\`. Validity auto-detects the wrapper.user toggle and\n` +
        `       regenerates \`wrapper.gen.tsx\` to compose your wrapper around the provider tree.`
      );
    },
  },
  // Plain "Cannot read properties of undefined" inside React often means a
  // hook returned undefined because no provider supplied a value. Less
  // specific than the regex above — only fires when the more-specific
  // patterns don't match.
  {
    match: /Cannot read propert(?:y|ies) of undefined.*\bat use[A-Z]\w+/,
    hint:
      'likely a missing React Context provider. Identify which context the failing hook reads ' +
      'from and add its Provider to `.validity/wrapper.user.tsx`. Stay in isolation mode.',
  },
];

/** Append a curated wrapper-fix hint when the render error matches a known pattern. */
export function annotateRenderError(message: string): string {
  for (const { match, hint } of RENDER_ERROR_HINTS) {
    if (typeof match === 'string') {
      if (message.includes(match)) {
        const text = typeof hint === 'function' ? hint([message] as RegExpMatchArray) : hint;
        return `${message}\n  → ${text}`;
      }
    } else {
      const m = message.match(match);
      if (m) {
        const text = typeof hint === 'function' ? hint(m) : hint;
        return `${message}\n  → ${text}`;
      }
    }
  }
  return message;
}

/**
 * A compact line naming the stable testIDs a target's source declares, shown
 * next to the a11y snapshot (finding A3). The snapshot the agent scores against
 * carries no testID channel, so without this the agent authors a brittle
 * `text:` selector even when the source exposes a `testID`. Setting
 * `selector.testId` instead exports as a durable Maestro `id:` matcher that
 * survives copy/i18n drift. Returns undefined when the source exposes no static
 * testID (nothing to add). Exported for tests.
 */
export function testIdSourceHint(source: string): string | undefined {
  const ids = extractTestIds(source);
  if (ids.length === 0) return undefined;
  return `testIDs in source (prefer selector.testId — exports as Maestro id:): ${ids.join(', ')}`;
}

/**
 * Presentation policy for a native render status (exported for tests).
 *
 * The capture flow now reports HOW (and whether) a render was confirmed
 * instead of unconditional success, and a headless agent must never score a
 * screenshot the device didn't confirm. So:
 *   - 'confirmed'   → no header; the screenshot is evidence (a short
 *                     provenance line is appended by the caller).
 *   - 'unconfirmed' → a machine-readable `RENDER_UNCONFIRMED:` header leads
 *                     the response, the screenshot is attached for HUMAN
 *                     debugging only, and the next action is concrete (retry
 *                     with reload: true).
 *   - 'failed'      → a machine-readable `RENDER_FAILED:` header with the
 *                     device's error VERBATIM; the screenshot (a placeholder /
 *                     error card) is NOT attached — the error is the evidence.
 */
export function nativeRenderStatusBlock(
  render: NativeRenderStatus,
  /**
   * Best-effort environment cause for a non-confirmed render (see
   * @validity.ai/verify-native's diagnoseNativeEnvironment). Appended as an extra line —
   * it never changes `attachScreenshot` or the verdict, it only stops
   * "unconfirmed" from being the entire explanation.
   */
  diagnosis?: EnvironmentDiagnosis,
): {
  /** Machine-readable header to PREFIX the response with ('' when confirmed). */
  header: string;
  /** Whether the screenshot may be attached as evidence. */
  attachScreenshot: boolean;
} {
  const cause = diagnosis
    ? [
        `LIKELY CAUSE (${diagnosis.confidence}, ${diagnosis.cause}): ${diagnosis.symptom}`,
        diagnosis.detail,
        ...(diagnosis.fixCommand ? [`Fix:\n${diagnosis.fixCommand}`] : []),
      ]
    : [];
  if (render.status === 'failed') {
    return {
      attachScreenshot: false,
      header: [
        `RENDER_FAILED: ${render.error ?? 'the device reported a failed render'}`,
        `The device acknowledged this navigation (token ${render.token ?? 'unknown'}) and reported it CANNOT render — there is no screenshot evidence for this call; do not score one.`,
        'Next action: retry with `reload: true` to force a fresh JS bundle (the running bundle may have a stale registry). If it still fails, run `validity browse --native` to rebuild the companion registry, and confirm the component/view exists under that exact path.',
        ...cause,
      ].join('\n'),
    };
  }
  if (render.status === 'unconfirmed') {
    return {
      attachScreenshot: true,
      header: [
        `RENDER_UNCONFIRMED: ${render.error ?? 'the device never confirmed this render'}`,
        'The screenshot below shows whatever is currently on screen — possibly the PREVIOUS target, a placeholder, or the dev launcher. Do NOT score it as evidence of the requested target.',
        'Next action: retry with `reload: true` to force a fresh JS bundle (an in-place reload on a live companion, a cold relaunch otherwise). If that stays unconfirmed, check a simulator/emulator is booted and awake, then run `validity browse --native` to restart the companion.',
        ...cause,
      ].join('\n'),
    };
  }
  return { header: '', attachScreenshot: true };
}

/**
 * Presentation policy for a BRIDGE_PORT_HELD failure (exported for tests).
 * The native bridge port is occupied by a non-Validity process (or a Validity
 * bridge that stopped answering), so the device cannot be driven AND the flow
 * refuses to silently degrade to the splash-prone deep-link ladder. The
 * machine-readable code leads the response so a headless agent can branch on
 * it, followed by the concrete unblock.
 */
export function bridgePortHeldBlock(err: Error): string {
  return [
    err.message, // starts with "BRIDGE_PORT_HELD: …" — keep it verbatim and first
    'The native control bridge could not bind its port and could not delegate to whatever holds it, so no render can be confirmed — nothing was captured.',
    'Next action: free the bridge port (close the other process or validity session holding it), then retry this call.',
  ].join('\n');
}

/**
 * Presentation policy for the ambiguous-device case (exported for tests).
 * Every native capture is pinned to exactly ONE device — `simctl openurl
 * booted` / an unpinned agent-device session each pick ARBITRARILY with >1
 * device booted, so the deep link can land on one device while the screenshot
 * and a11y snapshot run on another (confidently-wrong evidence). With several
 * booted devices and no explicit `device` arg we refuse to guess: the
 * machine-readable header leads so a headless agent can branch, and the udid/
 * serial list makes the retry a copy-paste.
 */
export function multipleDevicesBlock(devices: BootedDevice[], platform: 'ios' | 'android'): string {
  const idKind = platform === 'ios' ? 'udid' : 'serial';
  return [
    `MULTIPLE_DEVICES: ${devices.length} ${platform} ${
      platform === 'ios' ? 'simulators' : 'emulators/devices'
    } are booted and no \`device\` was specified — Validity drives exactly ONE pinned device per call (deep link, screenshot, and a11y snapshot must all hit the same device), and picking one silently risks capturing the wrong screen.`,
    'Booted devices:',
    ...devices.map((d) => `  - ${d.id}  (${d.name})`),
    `Next action: retry with \`device: "<${idKind}>"\` from the list above, or shut down the extra ${
      platform === 'ios' ? 'simulators' : 'emulators'
    } so exactly one is booted.`,
  ].join('\n');
}

/**
 * Cross-check the companion's bridge `hello` identity against the device this
 * call pinned (exported for tests). The bridge accepts whichever companion
 * dialed in last — with several devices running the companion, the socket
 * that acks the render can belong to a DIFFERENT device than the one being
 * screenshotted. The hello's `deviceId` is a vendor/installation id (not a
 * udid/serial), so the comparable field is `platform`: a mismatch there is
 * proof positive the ack and the screenshot came from different devices.
 * Null (no warning) when identities are compatible or the hello carries no
 * platform (old companion binaries — no signal, never a false positive).
 */
export function deviceMismatchWarning(
  info: NativeBridgeDeviceInfo | null,
  platform: 'ios' | 'android',
  pinnedDevice?: string,
): string | null {
  if (!info?.platform || info.platform === platform) return null;
  return (
    `DEVICE_MISMATCH: the companion connected to the control bridge reports platform ` +
    `"${info.platform}", but this call drove the pinned ${platform} device` +
    `${pinnedDevice ? ` ${pinnedDevice}` : ''} — the render ack and the screenshot may come ` +
    `from DIFFERENT devices. Close the Validity companion on other devices (or pass \`device\`) and retry.`
  );
}

function slugifyForId(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'page'
  );
}

/**
 * If the verify call carries a `planId`, load the plan now so we can use
 * its criteria as the scoring rubric and thread the id into run-meta.
 * Throws an actionable error when the id is unknown — agents pass typos
 * sometimes, and "plan not found" is a much better signal than silently
 * falling back to free-form scoring.
 */
function resolvePlan(projectRoot: string, planId: string | undefined): ValidityPlan | null {
  if (!planId) return null;
  // Spec ids (`spec-…`) resolve through the spec store and adapt to the plan
  // shape; legacy plan ids (`plan_…`) read the JSON plan store. This keeps the
  // planId code path working unchanged while letting a frozen spec drive the
  // same scoring rubric.
  if (isSpecId(planId)) {
    const spec = readSpec(projectRoot, planId);
    if (!spec) {
      throw new Error(
        `specId "${planId}" not found in .validity/specs/. ` +
          'Call validity__spec_create (or validity__plan) first, then pass the returned id.',
      );
    }
    return specToPlan(spec);
  }
  const plan = readPlan(projectRoot, planId);
  if (!plan) {
    throw new Error(
      `planId "${planId}" not found in .validity/plans/. ` +
        'Call validity__plan first to create one, then pass the returned id. ' +
        '(validity__plan now returns a spec id — pass that.)',
    );
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Plan-first enforcement (B1). `enforcement: 'strict'` in config makes
 * verify/submit_report REFUSE to run without a resolvable FROZEN spec,
 * returning a redirect the agent follows instead of a verdict. Strict
 * can only refuse, never mint: the gate runs before any render/persist,
 * and a redirect carries NO verdict/signedOff/runId keys — a loop driver
 * keying on `structuredContent.verdict.signedOff` reads undefined.
 * Browse/catalog/spec tools are never gated (no planId, no verdicts).
 * ------------------------------------------------------------------ */

/** 'advisory' when the config is missing/unreadable — strict cannot pre-date init. */
export async function resolveEnforcement(projectRoot: string): Promise<'advisory' | 'strict'> {
  try {
    const { config } = await loadConfig(projectRoot);
    return config.enforcement ?? 'advisory';
  } catch {
    return 'advisory';
  }
}

type StrictRedirectReason = 'no-plan' | 'legacy-plan' | 'unfrozen-spec' | 'unplanned-run';

const STRICT_PLAN_STEPS =
  'Do this now: 1) call `validity__plan` with the user prompt + the structured criteria you ' +
  'extract from it (it mints and freezes a spec); 2) re-run `validity__verify` with ' +
  '`planId: "<returned id>"`.';

function strictRedirectText(reason: StrictRedirectReason, specId?: string): string {
  switch (reason) {
    case 'no-plan':
      return (
        "This project enforces plan-first verification (`enforcement: 'strict'` in " +
        '`.validity/config.ts`). Acceptance criteria must be frozen BEFORE the work is verified ' +
        `so build-time intent and verify-time scoring share one contract. ${STRICT_PLAN_STEPS} ` +
        'Nothing was rendered and no run was recorded.'
      );
    case 'legacy-plan':
      return (
        'The id you passed is a legacy plan id — legacy plans are not a frozen, hash-bound ' +
        `contract, and this project enforces plan-first verification. ${STRICT_PLAN_STEPS} ` +
        'Nothing was rendered and no run was recorded.'
      );
    case 'unfrozen-spec':
      return (
        `Spec \`${specId}\` exists but is not frozen, and this project enforces plan-first ` +
        'verification against a FROZEN spec. Freeze it first ' +
        `(\`validity__spec_freeze { specId: "${specId}" }\`) — or call \`validity__plan\`, which ` +
        'freezes in one step — then re-run verify with the id. Nothing was rendered and no run ' +
        'was recorded.'
      );
    case 'unplanned-run':
      return (
        'This run was captured without a frozen spec, and this project enforces plan-first ' +
        "verification (`enforcement: 'strict'` in `.validity/config.ts`). A report cannot be " +
        'submitted for an unplanned run in strict mode. Do this now: 1) `validity__plan` ' +
        '(freeze the criteria); 2) re-run `validity__verify` with the returned `planId`; ' +
        '3) `validity__submit_report` with the NEW runId. The screenshots from this run remain ' +
        'on disk under `.validity/runs/<runId>/` for your own reference.'
      );
  }
}

/**
 * Render a strict-enforcement redirect (registry §9.1). `isError` is
 * deliberately UNSET: this is a redirect the agent follows, not a failure —
 * and the envelope carries NO verdict so it can never be read as one.
 */
function strictRedirectResult(reason: StrictRedirectReason, specId?: string): ServerResult {
  return {
    content: [{ type: 'text', text: strictRedirectText(reason, specId) }],
    structuredContent: {
      redirect: {
        reason: 'strict-enforcement',
        cause: reason,
        nextTool: reason === 'unfrozen-spec' ? 'validity__spec_freeze' : 'validity__plan',
        ...(specId ? { specId } : {}),
      },
    },
  };
}

/**
 * Decide the strict-mode outcome for a verify call. Returns a REDIRECT
 * ServerResult (isError unset) when the plan-first precondition fails, or
 * null to proceed. Throws (existing resolvePlan wording) on an unknown spec
 * id — a typo'd id is a bug signal, not a redirect.
 */
export function strictVerifyRedirect(
  projectRoot: string,
  planId: string | undefined,
): ServerResult | null {
  if (!planId) return strictRedirectResult('no-plan');
  if (!isSpecId(planId)) return strictRedirectResult('legacy-plan');
  const spec = readSpec(projectRoot, planId);
  if (!spec) {
    throw new Error(
      `specId "${planId}" not found in .validity/specs/. ` +
        'Call validity__spec_create (or validity__plan) first, then pass the returned id.',
    );
  }
  if (spec.status !== 'frozen') return strictRedirectResult('unfrozen-spec', spec.id);
  return null;
}

/**
 * Load the full spec behind an id, when the id is a spec id. Returns null for
 * legacy plan ids (which carry no hard-tier checks). The verify path uses this
 * to run the spec's hard/property checks deterministically; `resolvePlan`
 * above already validated existence, so a missing spec here just means "legacy
 * plan, no checks".
 */
function resolveSpec(projectRoot: string, id: string | undefined): Spec | null {
  if (!id || !isSpecId(id)) return null;
  return readSpec(projectRoot, id);
}

/**
 * Load the PREVIOUS run of this spec (summary + run-meta), so the verify path
 * can compute display-only regression deltas, resolve the lean/full detail
 * default, and hash the previous run's screenshots for identity. Reads the
 * spec's `runs.jsonl` timeline (newest-last) and loads the LAST entry's
 * run-meta — which carries the POST-SCORING verdicts when `submit_report`
 * re-persisted them.
 *
 * CRITICAL: this runs BEFORE `prepareVerification` / `writeNativeRunMeta` index
 * the CURRENT run, so the current run is NOT in the timeline yet — the last
 * entry IS the previous run. Use limit 1 + `history[length - 1]`.
 *
 * Returns undefined on first run and on a missing/corrupt run-meta — the
 * consumers then behave conservatively (no deltas, auto-full, keep-all).
 */
export function loadPreviousRun(
  projectRoot: string,
  specId: string,
): { summary: SpecRunSummary; meta: RunMeta } | undefined {
  const history = readSpecRunHistory(projectRoot, specId, 1);
  if (history.length === 0) return undefined;
  const previous = history[history.length - 1]!;
  if (!previous.runId) return undefined;
  const meta = readRunMeta(projectRoot, previous.runId);
  if (!meta) return undefined;
  return { summary: previous, meta };
}

/**
 * The previous run's per-criterion verdicts (regression-delta input). Thin
 * wrapper over `loadPreviousRun` that keeps the historical contract: undefined
 * when the previous run had no verdicts — the delta computation then flags
 * nothing (honest no-op), never a fabricated regression.
 */
export function loadPreviousVerdicts(
  projectRoot: string,
  specId: string,
): CriterionVerdict[] | undefined {
  return previousVerdictsOf(loadPreviousRun(projectRoot, specId));
}

/** Same emptiness rule as `loadPreviousVerdicts`, over an already-loaded run. */
function previousVerdictsOf(prev: { meta: RunMeta } | undefined): CriterionVerdict[] | undefined {
  const verdicts = prev?.meta.criterionVerdicts;
  return verdicts && verdicts.length > 0 ? verdicts : undefined;
}

/** A prior run's soft score for one criterion, read from its report-meta. */
type PriorSoftScore = { status: 'pass' | 'fail' | 'unverifiable'; reasoning?: string };

/**
 * Locate the PREVIOUS run of this spec AT SUBMIT TIME. Unlike `loadPreviousRun`
 * (verify time, where the current run isn't indexed yet), by the time
 * `submit_report` reaches here the current run is ALREADY in the spec's
 * `runs.jsonl` — and a runId can appear twice (the verify append + the scored
 * twin). So read a slack window, drop the current runId, dedupe by runId (last
 * wins, insertion order preserved), and take the newest remaining run. Returns
 * undefined on first run / when nothing else is in the timeline.
 */
function previousRunIdAtSubmit(
  projectRoot: string,
  specId: string,
  currentRunId: string,
): string | undefined {
  const byRun = new Map<string, SpecRunSummary>();
  for (const r of readSpecRunHistory(projectRoot, specId, 10)) {
    if (!r.runId || r.runId === currentRunId) continue;
    byRun.set(r.runId, r); // last wins; Map keeps first-seen insertion order
  }
  const runs = [...byRun.keys()];
  return runs.length > 0 ? runs[runs.length - 1] : undefined;
}

/**
 * Read a run's `report-meta.json` sidecar and project its SUBMITTED (scored)
 * criteria into id → prior soft score, plus the top-level scorer. Defensive:
 * any missing / malformed / preliminary sidecar (or one without a criteria
 * array) yields no priors and never throws — a broken previous report simply
 * means the current report shows no prior-run diff.
 */
function readPriorSoftScores(
  projectRoot: string,
  runId: string,
): { byId: Map<string, PriorSoftScore>; scoredBy?: string } {
  const empty = { byId: new Map<string, PriorSoftScore>() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
  } catch {
    return empty; // missing or malformed JSON
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rm = parsed as { preliminary?: unknown; criteria?: unknown; scoredBy?: unknown };
  // Preliminary reports carry placeholder criteria, not scored ones — no priors.
  if (rm.preliminary === true) return empty;
  if (!Array.isArray(rm.criteria)) return empty;
  const byId = new Map<string, PriorSoftScore>();
  for (const row of rm.criteria) {
    if (!row || typeof row !== 'object') continue;
    const c = row as { id?: unknown; status?: unknown; reasoning?: unknown };
    if (typeof c.id !== 'string' || !c.id) continue;
    if (c.status !== 'pass' && c.status !== 'fail' && c.status !== 'unverifiable') continue;
    byId.set(c.id, {
      status: c.status,
      reasoning: typeof c.reasoning === 'string' ? c.reasoning : undefined,
    });
  }
  return { byId, scoredBy: typeof rm.scoredBy === 'string' ? rm.scoredBy : undefined };
}

/**
 * PRIOR-RUN SOFT-SCORE DIFFS (display-only). Enrich the verify-time regression
 * list (hard/property rows) with SOFT rows for criteria whose FOLDED status
 * changed vs. the previous run's scored status, attaching the prior receipt
 * (status/reasoning/scorer) so a reader can tell "UI regressed" from "different
 * scorer". Read exclusively from DISK (the previous run's report-meta); nothing
 * from the current submission influences it, nothing here is persisted, and
 * `meta.regressionDeltas` on disk is left untouched. Returns the base list
 * unchanged when there's no spec / no previous run / no changed soft criterion.
 */
function enrichRegressionDeltasWithPriorSoft(args: {
  projectRoot: string;
  meta: RunMeta;
  criterionVerdicts: CriterionVerdict[] | undefined;
}): ReportRegressionDelta[] | undefined {
  const { projectRoot, meta, criterionVerdicts } = args;
  const base = meta.regressionDeltas as ReportRegressionDelta[] | undefined;
  if (!meta.specId) return base;

  const previousRunId = previousRunIdAtSubmit(projectRoot, meta.specId, meta.runId);
  if (!previousRunId) return base;

  const prior = readPriorSoftScores(projectRoot, previousRunId);
  if (prior.byId.size === 0) return base;

  // Current FOLDED soft verdicts that also existed (with a score) last run.
  const currentSoft = (criterionVerdicts ?? []).filter(
    (v) => v.tier === 'soft' && prior.byId.has(v.id),
  );
  if (currentSoft.length === 0) return base;

  // Reuse the verdict lattice: synthesize the previous soft verdicts from the
  // prior scores and diff the current folded verdicts against them, so a soft
  // row's direction obeys the exact same `fail ⊐ unverifiable ⊐ pass` rule as
  // the hard/property rows. Keep only rows that actually changed.
  const previousSoft: CriterionVerdict[] = currentSoft.map((v) => ({
    id: v.id,
    tier: 'soft',
    status: prior.byId.get(v.id)!.status,
  }));
  const softDeltas = computeRegressionDeltas(currentSoft, previousSoft).filter(
    (d) => d.delta !== 'unchanged',
  );
  if (softDeltas.length === 0) return base;

  const merged: ReportRegressionDelta[] = (base ?? []).slice();
  const seen = new Set(merged.map((d) => d.criterionId));
  for (const d of softDeltas) {
    if (seen.has(d.criterionId)) continue; // a hard/property row already owns this id
    const p = prior.byId.get(d.criterionId)!;
    merged.push({
      ...d,
      prior: {
        status: p.status,
        ...(p.reasoning ? { reasoning: p.reasoning } : {}),
        ...(prior.scoredBy ? { scoredBy: prior.scoredBy } : {}),
      },
    });
  }
  return merged;
}

/**
 * Basename without extension, lowercased — used to match a spec `targets`
 * entry (a NAME like `ContactForm` or a PATH like `src/ContactForm.tsx`)
 * against a rendered component, so either form resolves to the same target.
 */
function baseNameNoExtLower(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.(tsx|jsx|ts|js)$/, '').toLowerCase();
}

/**
 * Quick TCP-level liveness check before we hand the URL to Playwright. Any
 * HTTP response (even 4xx/5xx) means a server is up. Network errors / timeouts
 * mean nothing is listening — that's our cue to redirect the agent to
 * isolation mode rather than letting it discover the gap by starting the dev
 * server itself.
 */
async function isReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** URL mode: capture pages of the user's running dev server. */
async function handleVerifyUrl(args: ToolArgs, injectedRunId?: string): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const plan = resolvePlan(projectRoot, args.planId);

  // Load config for mockNetwork + scenarios + report settings. URL mode
  // works without a .validity/config.ts (just point at a URL and screenshot),
  // but if one exists we apply the same mockNetwork + scenarios as isolation
  // mode AND honor the same `report` config so submit_report can render an
  // HTML report from the run-meta we'll write below.
  let baseMockNetwork: MockNetworkConfig | undefined;
  const scenarioConfigs: Record<string, MockNetworkConfig | undefined> = {};
  let reportCfg = resolveReportConfig(undefined);
  let a11ySeverity: 'serious' | 'critical' | 'off' = 'serious';
  let coverageFloorPercent: number | undefined;
  let historyCommitted: boolean | undefined;
  try {
    const { config } = await loadConfig(projectRoot);
    baseMockNetwork = config.mockNetwork;
    for (const [name, scenario] of Object.entries(config.scenarios ?? {})) {
      scenarioConfigs[name] = scenario.mockNetwork;
    }
    reportCfg = resolveReportConfig(config.report);
    a11ySeverity = config.a11y?.severity ?? 'serious';
    coverageFloorPercent = config.coverageFloorPercent;
    historyCommitted = config.historyCommitted;
  } catch {
    // No config — URL mode still works, just without mocks/scenarios. The
    // report config defaults to enabled so submit_report still produces HTML.
  }

  const requestedScenarios = args.scenarios ?? [];
  const availableScenarios = Object.keys(scenarioConfigs);
  for (const name of requestedScenarios) {
    if (!availableScenarios.includes(name)) {
      throw new UnknownScenarioError(name, availableScenarios);
    }
  }
  // [undefined] = render once with just the base mockNetwork.
  // Otherwise multiply: one capture per (url × scenario) pair.
  const scenarioAxis: Array<string | undefined> =
    requestedScenarios.length === 0 ? [undefined] : requestedScenarios;

  // Build the list of (url, scenario) pairs.
  const baseUrls: Array<{ id: string; url: string }> = [];
  if (args.url) {
    baseUrls.push({ id: slugifyForId(new URL(args.url).pathname || 'root'), url: args.url });
  }
  if (args.paths && args.paths.length > 0) {
    const baseUrl = args.baseUrl ?? detectDevServerBaseUrl(projectRoot);
    if (!baseUrl) {
      throw new Error(
        'Cannot resolve baseUrl for `paths`. Pass `baseUrl` explicitly (e.g. http://localhost:5173) ' +
          "or run a dev script that Validity recognizes (vite/next/astro/remix/react-scripts) so package.json's " +
          'scripts.dev gives us a port.',
      );
    }
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    for (const p of args.paths) {
      const path = p.startsWith('/') ? p : `/${p}`;
      baseUrls.push({ id: slugifyForId(path), url: `${trimmedBase}${path}` });
    }
  }

  if (baseUrls.length === 0) {
    throw new Error('URL mode needs at least one of `url` or `paths`.');
  }

  // Liveness check: URL mode requires a dev server the *user* started. If
  // nothing is listening, fail fast with a corrective message instead of
  // letting Playwright time out and inviting the agent to start `npm run
  // dev` itself. Isolation mode is the right answer for most component
  // changes; this nudges the agent back to it.
  const probeUrl = baseUrls[0]!.url;
  if (!(await isReachable(probeUrl))) {
    throw new Error(
      `URL mode requires a dev server already running at ${probeUrl}, but nothing is listening. ` +
        'Do NOT start the dev server yourself (`npm run dev` / `pnpm dev` / `yarn dev`) — ' +
        'Validity has its own sandbox for component verification. ' +
        'Drop `url` / `paths` and call validity__verify in isolation mode (pass only `prompt` and optionally `changedFiles` / `scenarios`). ' +
        'For login-gated UI, seed cookies / localStorage / fetch handlers in `.validity/config.ts` scenarios. ' +
        'Only retry URL mode if the user explicitly asked for page-level verification AND has started their own dev server.',
    );
  }

  const requests: UrlCaptureRequest[] = [];
  for (const { id, url } of baseUrls) {
    for (const scenarioId of scenarioAxis) {
      const merged = combineMockNetwork(baseMockNetwork, scenarioConfigs[scenarioId ?? '']);
      const requestId = scenarioId ? `${id}__${slugifyForId(scenarioId)}` : id;
      // URL mode is passthrough by default — we only install page.route when
      // there's at least one explicit handler. Cookies/storage are seeded
      // unconditionally; they don't affect the dev server's response shape.
      const hasHandlers = !!(merged.handlers && merged.handlers.length > 0);
      requests.push({
        id: requestId,
        url,
        mockNetwork: hasHandlers ? merged : undefined,
        cookies: merged.cookies,
        localStorage: merged.localStorage,
        sessionStorage: merged.sessionStorage,
        a11ySeverity,
      });
    }
  }

  const runId = injectedRunId ?? newRunId();
  const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);

  const captures = await captureUrls({ requests, screenshotsDir });

  // Persist a run-meta.json the same way isolation mode does so
  // submit_report can read it back and render an HTML report. PageRender
  // mirrors ComponentRender's role for url mode.
  const requestPathIds: Record<string, string> = {};
  const requestScenarios: Record<string, string | undefined> = {};
  for (const { id, url } of baseUrls) {
    for (const scenarioId of scenarioAxis) {
      const fullId = scenarioId ? `${id}__${slugifyForId(scenarioId)}` : id;
      requestPathIds[fullId] = id;
      requestScenarios[fullId] = scenarioId;
    }
    void url;
  }
  const pages: PageRender[] = captures.map((cap, i) => {
    const req = requests[i]!;
    return {
      id: req.id,
      pathId: requestPathIds[req.id] ?? req.id,
      url: cap.url,
      scenarioId: requestScenarios[req.id],
      screenshotPath: cap.screenshotPath,
      errorMessage: cap.errorMessage,
      unmatchedUrls: cap.unmatchedUrls,
      consoleErrors: cap.consoleErrors.length > 0 ? cap.consoleErrors : undefined,
      pageErrors: cap.pageErrors.length > 0 ? cap.pageErrors : undefined,
      networkErrors: cap.networkErrors.length > 0 ? cap.networkErrors : undefined,
      a11yViolations: cap.a11yViolations.length > 0 ? cap.a11yViolations : undefined,
    };
  });
  // B6: when a FROZEN spec is in scope, persist an explicit `unverifiable`
  // verdict per criterion instead of leaving the run verdict-less. A blank
  // verdict list gives submit_report nothing to override a submitted hard
  // `pass` with — this makes "not evaluated here" mechanical rather than a
  // matter of the agent's honesty.
  const urlSpec = args.planId ? readSpec(projectRoot, args.planId) : null;
  const urlVerdicts =
    urlSpec && urlSpec.status === 'frozen' ? urlModeCriterionVerdicts(urlSpec) : undefined;
  writeUrlRunMeta({
    projectRoot,
    runId,
    prompt: args.prompt!,
    scenarios: requestedScenarios,
    pages,
    changedFiles: args.changedFiles,
    reportConfig: reportCfg,
    planId: plan?.planId,
    ...(urlVerdicts
      ? {
          specId: urlSpec!.id,
          specVersion: urlSpec!.version,
          specHash: urlSpec!.hash,
          criterionVerdicts: urlVerdicts,
        }
      : {}),
    sessionFingerprint: SESSION_FINGERPRINT,
    // Coverage floor at verify time (C1) — the submit-time report shows the
    // number the gate ran against even if config changes in between.
    coverageFloorPercent,
    // Opt-in committed history (F2) — gates the .validity/history/ twin append.
    historyCommitted,
  });

  const scenarioSummary =
    requestedScenarios.length > 0
      ? `Scenarios: ${requestedScenarios.join(', ')}`
      : 'Scenario: base (no scenario applied)';
  const content: Content[] = [
    {
      type: 'text',
      text: `User prompt:\n${args.prompt}\n\nMode: URL\n${scenarioSummary}\nRun: ${runId}`,
    },
  ];

  // Lean is meaningless here (C3): URL mode has no mechanical verdicts and no
  // spec history, so nothing can be proven unchanged — no screenshot may be
  // dropped. Say so once when it was requested, then behave as full.
  const detailNotice = urlModeDetailNotice({ detail: args.detail, lean: args.lean });
  if (detailNotice) {
    content.push({ type: 'text', text: detailNotice });
  }

  for (const page of pages) {
    const scenarioLabel = page.scenarioId ?? 'base';
    content.push({
      type: 'text',
      text:
        `Page: ${page.url} — scenario: ${scenarioLabel}` +
        (page.errorMessage ? ` — capture error: ${page.errorMessage}` : ''),
    });
    try {
      const data = readFileSync(page.screenshotPath).toString('base64');
      content.push({ type: 'image', data, mimeType: 'image/png' });
    } catch (err) {
      content.push({
        type: 'text',
        text: `Could not read screenshot at ${page.screenshotPath}: ${(err as Error).message}`,
      });
    }
    if (page.unmatchedUrls && page.unmatchedUrls.length > 0) {
      content.push({
        type: 'text',
        text:
          `Unmatched fetch(es) under '${scenarioLabel}' (passed through to dev server): ` +
          page.unmatchedUrls.map((u) => `\n  • ${u}`).join('') +
          "\n  → add a handler in .validity/config.ts mockNetwork.handlers (or the scenario) if the response matters for what you're scoring.",
      });
    }
    const diagBlock = formatDiagnosticsBlock(
      {
        consoleErrors: page.consoleErrors ?? [],
        pageErrors: page.pageErrors ?? [],
        networkErrors: page.networkErrors ?? [],
      },
      scenarioLabel,
    );
    if (diagBlock) {
      content.push({ type: 'text', text: diagBlock });
    }
    const a11yBlock = formatA11yBlock(page.a11yViolations, scenarioLabel);
    if (a11yBlock) {
      content.push({ type: 'text', text: a11yBlock });
    }
  }

  // URL-MODE DISCLOSURE (B6): say plainly, in the tool text and in the report,
  // that no mechanical criterion was evaluated here. Without it an agent can
  // read a clean URL-mode run as "the hard criteria passed" — the exact false
  // green the mode cannot support (there is no sandbox, no check executor).
  content.push({ type: 'text', text: URL_MODE_DISCLOSURE });

  content.push({
    type: 'text',
    text: plan ? planScopedScoringInstructions(plan) : SCORING_INSTRUCTIONS,
  });

  // RECEIPT (B1): URL mode folds NOTHING — it has no mechanical verdicts to
  // reconcile — so the receipt says exactly that rather than staying silent.
  const finalMeta = readRunMeta(projectRoot, runId);
  const receipt = buildVerifyReceipt({
    runId,
    origin: finalMeta?.origin ?? detectRunOrigin(),
    ledgerReason: RECEIPT_REASON_URL_MODE,
  });
  content.push({ type: 'text', text: receiptLine(receipt) });

  // Always-a-report (Feature 1): write the mechanical-only preliminary report
  // from the run-meta writeUrlRunMeta just persisted, and surface its path.
  const reportContent = await attachPreliminaryReport(projectRoot, finalMeta, content);
  return { content, structuredContent: { ...reportContent, receipt } };
}

/**
 * Render the "Setup health" content block for the verify response. Returns
 * undefined when nothing useful to surface (steady-state: no drift, no
 * bootstrap). Otherwise returns a single text payload the agent reads at
 * the top of the response — gives it a clean attribution path for "if
 * the screenshots look wrong, here's why" before it scores anything.
 */
function renderSetupHealthBlock(r: EnsureResult): string | undefined {
  // A non-verified wrapper fidelity always surfaces, even in the otherwise
  // quiet steady state — a degraded wrapper taints every soft verdict, so the
  // agent must see the cause on every verify, not just the run that drifted.
  const fidelityInteresting =
    r.wrapperFidelity !== undefined && r.wrapperFidelity.status !== 'verified';
  if (
    r.status === 'unchanged' &&
    !r.bootstrapped &&
    r.warnings.length === 0 &&
    !fidelityInteresting
  ) {
    return undefined;
  }
  const lines: string[] = ['Setup health:'];
  if (r.bootstrapped) {
    lines.push(
      '  • Validity just configured this project for you — generated .validity/wrapper.gen.tsx ' +
        'and .validity/config.ts by cloning your real entry. Review them after you finish this task.',
    );
  } else if (r.status === 'drift-resolved') {
    lines.push(
      '  • Detected real-app changes since the last run; regenerated .validity/wrapper.gen.tsx.',
    );
  } else if (r.status === 'drift-warned') {
    lines.push('  • Detected drift since the last run.');
  }
  for (const reason of r.driftReasons) {
    if (reason.severity === 'silent') continue;
    lines.push(
      `    - ${reason.category}: ${reason.field} (${reason.before ?? '∅'} → ${reason.after})`,
    );
  }
  for (const w of r.warnings) {
    lines.push(`  • ${w}`);
  }
  if (r.wrapperFidelity?.status === 'degraded') {
    const f = r.wrapperFidelity;
    const cause =
      f.missingProviders.length > 0
        ? `generated wrapper is missing ${f.missingProviders.join(', ')}`
        : `passthrough wrapper — no app providers cloned${f.detail ? ` (${f.detail})` : ''}`;
    lines.push(`  • Wrapper fidelity: DEGRADED — ${cause}.`);
    lines.push(
      '    Soft criteria will be reported unverifiable until this is fixed. Fix the SETUP',
    );
    lines.push('    (add the provider to .validity/wrapper.user.tsx), not the component.');
  } else if (r.wrapperFidelity?.status === 'unknown') {
    lines.push(
      `  • Wrapper fidelity: unknown — could not statically compare the wrapper to your entry` +
        `${r.wrapperFidelity.detail ? ` (${r.wrapperFidelity.detail})` : ''}.`,
    );
  }
  for (const f of r.generatedFiles) {
    if (f.action === 'wrote' || f.action === 'forked') {
      lines.push(`  • ${f.action}: ${f.path}`);
    }
  }
  if (lines.length === 1) return undefined;
  lines.push('');
  lines.push('If the screenshots look wrong, this is the most likely cause.');
  return lines.join('\n');
}

/**
 * The verify-response "Unmatched fetch(es)" block. When the render captured
 * structured requests (each with the fabricated fallback body), every one rides
 * with a paste-ready `mockNetwork.handlers` stub so promoting fallback data to a
 * declared mock is copy-paste-and-edit; older run-metas fall back to the plain
 * URL list. Advisory only — Validity never writes the stub (fabricated data must
 * not silently become declared-mock provenance). Returns '' when nothing was
 * unmatched. Pure.
 */
export function formatUnmatchedFetchBlock(
  scenarioLabel: string,
  unmatchedRequests: UnmatchedRequest[] | undefined,
  unmatchedUrls: string[] | undefined,
): string {
  if (unmatchedRequests && unmatchedRequests.length > 0) {
    return (
      `Unmatched fetch(es) under '${scenarioLabel}' (answered by the fallback — the body is fabricated, not fetched). ` +
      'To promote one to a declared mock, paste the stub into .validity/config.ts ' +
      'mockNetwork.handlers and edit the values to be realistic:' +
      unmatchedRequests
        .map((r) => `\n  • ${r.method} ${r.url}\n      ${buildHandlerStub(r)},`)
        .join('')
    );
  }
  if (unmatchedUrls && unmatchedUrls.length > 0) {
    return (
      `Unmatched fetch(es) under '${scenarioLabel}' (handled by fallback): ` +
      unmatchedUrls.map((u) => `\n  • ${u}`).join('') +
      "\n  → add a handler in .validity/config.ts mockNetwork.handlers (or the scenario) if the response matters for what you're scoring."
    );
  }
  return '';
}

/**
 * Isolation mode: render individual components in the Validity sandbox.
 * Exported for testing (presentation-accounting.test.ts drives it with a
 * stubbed renderer) — production entry stays `handleVerify`.
 */
export async function handleVerifyIsolation(
  args: ToolArgs,
  injectedRunId?: string,
): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const plan = resolvePlan(projectRoot, args.planId);
  const spec = resolveSpec(projectRoot, args.planId);

  // Auto-config: bootstrap or refresh `.validity/wrapper.gen.tsx` +
  // `.validity/config.ts` so isolation-mode renders match the real app's
  // provider tree without an agent-driven setup pass. Runs before
  // loadConfig — on first run the file we're about to load doesn't
  // exist yet.
  const ensureResult = await ensureValidityConfigured({ projectRoot });

  // If the orchestrator surfaced manual-required, abort the verify with
  // an actionable error rather than rendering against a stale wrapper.
  if (ensureResult.status === 'manual-required') {
    const steps = ensureResult.manualSteps ?? [];
    const lines = [
      'Setup needs attention before this verify can run.',
      '',
      ...ensureResult.warnings,
      '',
      'Steps:',
      ...steps.map((s) => `  • ${s}`),
    ];
    return {
      isError: true,
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }

  const loaded = await loadConfig(projectRoot);
  // `webTarget: true` is the caller stating, for this one call, that they want
  // the react-native-web proxy on an RN/Expo project. Pin the target so
  // `resolveTarget` doesn't refuse it — the refusal exists to stop a SILENT
  // web render, not to block one the user asked for.
  const config: ValidityConfig =
    args.webTarget === true &&
    (loaded.config.framework === 'auto' || loaded.config.framework === 'expo-native')
      ? { ...loaded.config, framework: 'expo-web' }
      : loaded.config;

  // The PREVIOUS run of this spec, loaded BEFORE prepareVerification indexes
  // the current one: feeds the display-only regression deltas, the lean/full
  // detail default (C3: full on first verify, lean once history exists), and
  // the previous-run screenshot identity below.
  const prevRun = spec ? loadPreviousRun(projectRoot, spec.id) : undefined;
  const { detail, autoSelected } = resolveVerifyDetail({
    detail: args.detail,
    lean: args.lean,
    hasSpec: Boolean(spec),
    // Only a SAME-HASH prior run counts: the first verify of a re-frozen spec
    // is full, with every soft criterion open — a score recorded against the
    // old criterion text must never carry into the new contract by id alone.
    hasPriorRun: prevRunMatchesSpec(prevRun?.meta, spec ?? undefined),
  });

  const result = await prepareVerification({
    projectRoot,
    config,
    prompt: args.prompt!,
    changedFiles: args.changedFiles,
    scenarios: args.scenarios,
    render: renderComponents,
    setupResult: ensureResult,
    // Pre-generated by the verify dispatcher so the in-flight marker names this
    // exact run; absent on direct (test) calls → prepareVerification mints one.
    runId: injectedRunId,
    // Which MCP session ran this verify (A3) — submit_report compares against
    // its own fingerprint to flag same-session (self) scoring.
    sessionFingerprint: SESSION_FINGERPRINT,
    planId: plan?.planId,
    // When the id is a frozen spec, its hard/property criteria run
    // deterministically in the sandbox and their verdicts + provenance are
    // threaded into run-meta. Soft criteria stay LLM-scored below.
    spec: spec ?? undefined,
    // The previous run's verdicts so prepareVerification can compute
    // display-only per-criterion regression deltas ("AC-3 regressed: pass→fail").
    // The deltas land in run-meta and are surfaced in the verify response below.
    previousVerdicts: previousVerdictsOf(prevRun),
  });

  const content: Content[] = [];
  // Non-blocking notes surfaced as `⚠` text and (add-only) as
  // `structuredContent.warnings` for loop drivers. Seeded from prepare's
  // fixture/scenario precedence notes (A) and appended to below (rubric drift,
  // E2.2). COPIED rather than aliased: pushing onto `result.warnings` would
  // mutate the PrepareVerificationResult the caller still holds.
  const warnings: string[] = [...(result.warnings ?? [])];

  const scenarioSummary =
    args.scenarios && args.scenarios.length > 0
      ? `Scenarios: ${args.scenarios.join(', ')}`
      : 'Scenario: base (no scenario applied)';
  content.push({
    type: 'text',
    text:
      `User prompt:\n${args.prompt}\n\nMode: isolation\n${scenarioSummary}\nRun: ${result.runId}\n` +
      detailHeaderLine(detail, autoSelected),
  });
  if (warnings.length > 0) {
    content.push({ type: 'text', text: warnings.map((w) => `⚠ ${w}`).join('\n') });
  }

  // Setup-health block — suppressed in the steady state, surfaced
  // verbosely on bootstrap / drift / warnings so the agent knows when
  // Validity changed something in the working tree mid-tool-call.
  const setupBlock = renderSetupHealthBlock(ensureResult);
  if (setupBlock) {
    content.push({ type: 'text', text: setupBlock });
  }

  if (result.components.length === 0) {
    const detected = detectDevServerBaseUrl(projectRoot);
    const tip = detected
      ? `Tip: this project's dev server appears to run at ${detected}. ` +
        'For a page-level check, retry with url (e.g. ' +
        `{ url: "${detected}/" }) or paths (e.g. { paths: ["/"] }).`
      : 'For a page-level check instead of component isolation, pass `url` or `paths` + `baseUrl`.';
    content.push({
      type: 'text',
      text:
        'No React components matched the changed files. ' +
        'Pass `changedFiles` explicitly if you know which files to render, ' +
        'or commit the change so `git diff HEAD` picks it up.\n\n' +
        tip,
    });
    return {
      content,
      ...(warnings.length > 0 ? { structuredContent: { warnings } } : {}),
    };
  }

  // Group renders by component id so the source block is emitted once per
  // component (not duplicated per scenario), then list each scenario's
  // screenshot + unmatched-url notes underneath.
  const byComponent = new Map<string, typeof result.components>();
  for (const comp of result.components) {
    const arr = byComponent.get(comp.id) ?? [];
    arr.push(comp);
    byComponent.set(comp.id, arr);
  }

  // LEAN MODE (C3, presentation-only): under `detail: 'lean'`, drop the base64
  // screenshot ONLY from renders where dropping provably hides nothing — all
  // mechanical verdicts pass, no soft criterion is OPEN (unscored/stale), and
  // the pixels are byte-identical to the previous run's same-key screenshot.
  // Soft criteria whose recorded score rests on byte-identical cited evidence
  // are CARRIED FORWARD explicitly in the scoring instructions. Verdicts,
  // run-meta, screenshots on disk, coverage, and the gate are untouched.
  const lean = detail === 'lean';
  const prevIndex = lean ? buildPrevRenderIndex(prevRun?.meta, spec ?? undefined) : undefined;
  const { identity, idsToKeys } = lean
    ? buildRenderIdentity(result.components, prevIndex)
    : {
        identity: new Map<string, boolean | 'unknown'>(),
        idsToKeys: new Map<string, string[]>(),
      };
  const partition =
    lean && spec
      ? partitionSoftCriteria({ spec, prev: prevIndex, identity, currentIdsToKeys: idsToKeys })
      : {
          carryForward: [] as CarryForwardSoft[],
          open: (spec?.criteria ?? []).filter((c) => c.tier === 'soft').map((c) => c.id),
        };
  const anySoftOpen = partition.open.length > 0;
  let leanShown = 0;
  let leanTotal = 0;
  const omittedRenderIds: string[] = [];

  for (const [componentId, renders] of byComponent) {
    const filePath = renders[0]?.filePath ?? componentId;
    content.push({
      type: 'text',
      text: `Component: ${componentId} (${filePath})`,
    });

    for (const comp of renders) {
      const scenarioLabel = comp.scenarioId ?? 'base';
      const annotatedError = comp.renderError ? annotateRenderError(comp.renderError) : null;
      // Forced data-state label (A2): the scorer must know this render's
      // premise is synthetic by declaration (the MSW layer forced the state).
      const dataStateLabel = comp.dataState ? ` — data state: ${comp.dataState} (forced)` : '';
      content.push({
        type: 'text',
        text: `— scenario: ${scenarioLabel}${dataStateLabel}${annotatedError ? ` — render error: ${annotatedError}` : ''}`,
      });
      // Decide whether to attach the screenshot under lean mode. Only count
      // renders that COULD have shown an image (no renderError) toward the
      // "X of Y" summary, or the line would lie.
      const decision = leanScreenshotDecision({
        detail,
        verdicts: comp.criterionVerdicts ?? [],
        identicalToPrev: identity.get(renderKeyFor(comp)) ?? 'unknown',
        anySoftOpen,
        specInScope: Boolean(spec),
      });
      // A skipped screenshot (loop cost control) has no file — like a render
      // error, it can't show an image, so it must not count toward the lean
      // "X of Y shown" tally or the line would lie.
      if (!comp.renderError && !comp.screenshotSkipped) {
        leanTotal += 1;
        if (decision.keep) leanShown += 1;
      }
      if (comp.screenshotSkipped) {
        content.push({
          type: 'text',
          text: '  (screenshot skipped — render was definitively red and the spec has no soft criteria; cost control)',
        });
      } else if (!comp.renderError && decision.keep) {
        // Pre-interaction companion (checks target only): the pristine state
        // BEFORE click/fill checks mutated the page. Shown first, labeled, so
        // initial-state soft criteria aren't scored against post-click
        // residue; the evidence/baseline shot below stays post-interaction.
        // Parity with the native isolation handler.
        if (comp.preInteractionScreenshotPath) {
          try {
            const preData = readFileSync(comp.preInteractionScreenshotPath).toString('base64');
            content.push({
              type: 'text',
              text: '  base state (before interaction checks) — score initial-state soft criteria against this:',
            });
            content.push({ type: 'image', data: preData, mimeType: 'image/png' });
            content.push({
              type: 'text',
              text: '  post-interaction end state (the evidence/baseline shot):',
            });
          } catch {
            // best-effort companion — the evidence shot below still rides
          }
        }
        try {
          const data = readFileSync(comp.screenshotPath).toString('base64');
          content.push({ type: 'image', data, mimeType: 'image/png' });
        } catch (err) {
          content.push({
            type: 'text',
            text: `Could not read screenshot at ${comp.screenshotPath}: ${(err as Error).message}`,
          });
        }
      } else if (!comp.renderError && lean) {
        omittedRenderIds.push(renderKeyFor(comp));
        content.push({
          type: 'text',
          text: `  (lean: screenshot omitted — ${decision.reason}; run detail:'full' to see it)`,
        });
      }
      const unmatchedBlock = formatUnmatchedFetchBlock(
        scenarioLabel,
        comp.unmatchedRequests,
        comp.unmatchedUrls,
      );
      if (unmatchedBlock) {
        content.push({ type: 'text', text: unmatchedBlock });
      }
      const diagBlock = formatDiagnosticsBlock(
        {
          consoleErrors: comp.consoleErrors ?? [],
          pageErrors: comp.pageErrors ?? [],
          networkErrors: comp.networkErrors ?? [],
        },
        scenarioLabel,
      );
      if (diagBlock) {
        content.push({ type: 'text', text: diagBlock });
      }
      const a11yBlock = formatA11yBlock(comp.a11yViolations, scenarioLabel);
      if (a11yBlock) {
        content.push({ type: 'text', text: a11yBlock });
      }
      // Advisory perf hints (D2) — pushed only when a rule fired (metric dumps
      // stay in the report; keeps the lean/loop cost flat). Never a verdict.
      const perfHintsBlock = formatPerfHintsBlock(
        computePerfHints(comp.performance),
        scenarioLabel,
      );
      if (perfHintsBlock) {
        content.push({ type: 'text', text: perfHintsBlock });
      }
      // Baseline diff block — surfaces "regression of N pixels since SHA X"
      // so the agent factors visual drift into its scoring without having
      // to inspect the diff PNG itself (it can if the user asks).
      if (comp.baseline) {
        const px = comp.baseline.mismatchedPixels ?? 0;
        const since = comp.baseline.sha ? ` since SHA ${comp.baseline.sha.slice(0, 7)}` : '';
        if (px > 0) {
          content.push({
            type: 'text',
            text:
              `Visual regression: ${px} pixel${px === 1 ? '' : 's'} changed${since}` +
              (comp.baseline.diffPath ? ` — diff: ${comp.baseline.diffPath}` : '') +
              `\n  → If this drift is intentional, run \`validity accept ${result.runId}\` to promote this run's screenshots as the new baseline.`,
          });
        }
      }
    }

    // Source rides in full detail always; in lean only when a render of this
    // component ERRORED (source is load-bearing for the repair, and it never
    // feeds a verdict — soft scores must cite screenshots, not source).
    const source = result.componentSources[componentId];
    if (source && (!lean || renders.some((r) => r.renderError))) {
      content.push({
        type: 'text',
        text: `Source for ${componentId}:\n\`\`\`tsx\n${source.slice(0, 4000)}\n\`\`\``,
      });
    }
  }

  // Honest "not rendered" note (A2): best-effort dataState clones the render
  // budget dropped. They carry no checks, so dropping only reduces coverage —
  // but the agent must KNOW the state went unvalidated.
  if (result.droppedDataStates && result.droppedDataStates.length > 0) {
    content.push({
      type: 'text',
      text:
        'NOT rendered (render budget):' +
        result.droppedDataStates
          .map((d) => `\n  • ${d.dataState} state for ${d.componentId}`)
          .join('') +
        '\n  → narrow the request (fewer scenarios / a smaller `changedFiles` list), or set `dataStates` explicitly in .validity/config.ts.',
    });
  }

  // RSC honesty (E2.4): on a Next project, name which of this run's targets
  // are Server Components. Their screenshots came from the CLIENT runtime, so
  // the response has to say so rather than let an agent read them as proof.
  const rsc = classifyNextEntries(
    projectRoot,
    Array.from(new Set(result.components.map((c) => c.filePath).filter((p): p is string => !!p))),
  );
  const rscBlock = rsc ? formatRscBlock(rsc, { context: 'verify' }) : undefined;
  if (rscBlock) content.push({ type: 'text', text: rscBlock });

  // Coverage nudges (E2.1, informational): a rendered target has a
  // loading/empty/error branch that no criterion is conditioned on. Never a
  // taint and never a verdict input — the conservative source scan behind it
  // can false-positive, so it reads as a hint and says why.
  const dataStateHints = result.dataStateHints ?? [];
  if (dataStateHints.length > 0) {
    content.push({
      type: 'text',
      text:
        dataStateHints.map(formatDataStateHint).join('\n') +
        '\n  → add a criterion with `dataState: <state>` to cover it (advisory — this is a source scan, not a verdict).',
    });
  }

  // Lean-mode summary line so the agent knows why some screenshots are absent
  // and how to get them back mechanically.
  if (lean && leanTotal > 0) {
    content.push({
      type: 'text',
      text:
        `Lean detail: ${leanShown} of ${leanTotal} screenshots shown` +
        (omittedRenderIds.length > 0 ? ` — omitted: ${omittedRenderIds.join(', ')}` : '') +
        ". Pass detail:'full' for every screenshot + source.",
    });
  }

  // Spec verify: surface the MECHANICAL verdicts (hard/property tiers executed
  // deterministically in the sandbox) as PROVEN, distinct from the soft tiers
  // the host model still scores. The Jepsen-style credibility lives in keeping
  // these two visually separate — never present a soft score as proof.
  let openPerfDrift: Signal[] = [];
  // The fold's receipt (B1) — assembled into `structuredContent.receipt` +
  // one line of text below. Undefined when no frozen spec was in scope.
  let fold: FoldResult | undefined;
  if (spec) {
    // Prefer the run-meta verdicts prepareVerification just persisted: they
    // include the run-level `expect.command` merge (A5), which a recollection
    // from the renders would miss. Fallback recollects (run-meta write is
    // best-effort) — command criteria then read "did not execute", never pass.
    const freshMeta = readRunMeta(projectRoot, result.runId);
    const verdicts =
      freshMeta?.criterionVerdicts ?? collectVerdictsFromComponents(spec, result.components);
    // Seed/update the persistent scorecard from this verify's deterministic
    // verdicts — the same reducer a `validity watch` tick feeds, so an
    // MCP-only flow can record_soft_scores without ever running watch.
    // Best-effort: a scorecard write failure never fails the verify, but it is
    // no longer SILENT — the fold's receipt rides back in the response.
    fold = foldVerifyIntoScorecard(projectRoot, {
      spec,
      verdicts,
      sha: freshMeta?.git?.sha,
      // Byte-identical renders must not stale carried soft scores (Rule 1) —
      // computed for the fold regardless of the lean/full presentation choice.
      renderUnchanged: renderUnchangedForFold(result.components, prevRun?.meta, spec),
      // Relevance-scoped staleness (W3 #10), watch parity: an unrelated file
      // moving must not stale this spec's soft scores. Undefined when unknown
      // — the reducer then falls back to its coarse HEAD-sha comparison.
      codeChanged: codeChangedForSpec({
        projectRoot,
        spec,
        sinceSha: lastObservedSha(loadScorecard(projectRoot)?.specs[spec.id]),
      }),
      historyCommitted: config.historyCommitted === true,
      // Maturity ladder: stamp the derived level + emit maturity-drop through
      // the same fold (invoked post-probation-decision on the spec as it
      // stands, with the freshly-reconciled entry as evidence).
      assessMaturity: (s, entry) => assessSpecMaturity(projectRoot, s, config, entry ?? null),
    });
    const provenBlock = renderProvenChecksBlock(verdicts);
    if (provenBlock) content.push({ type: 'text', text: provenBlock });
    // Display-only regression deltas vs. the previous run — read from the
    // run-meta that prepareVerification just wrote (so the surfaced values
    // match what was persisted, not a re-computation).
    const deltaBlock = renderRegressionDeltasBlock(freshMeta?.regressionDeltas);
    if (deltaBlock) content.push({ type: 'text', text: deltaBlock });
    // Advisory perf drift (D1): the run finalizer just appended this run to
    // the spec's timeline, so the tail is current. Persists perf-drift
    // signals into signals.json and surfaces the open ones here — text +
    // structuredContent.perf.drift only, never the verdict block.
    openPerfDrift = refreshPerfDrift(projectRoot, spec.id).filter((s) => s.status === 'open');
    const driftBlock = renderPerfDriftBlock(openPerfDrift);
    if (driftBlock) content.push({ type: 'text', text: driftBlock });
    // Hardening candidates (maturity Phase C): the run finalizer appended this
    // run, so the evidence window tail is current. Advisory; proposals surface
    // via spec_get / spec show / the dashboard, never the verdict block.
    refreshHardeningCandidates(projectRoot, spec, { sha: freshMeta?.git?.sha });
    // RUBRIC DRIFT (E2.2): this spec's soft criteria were baselined under an
    // older scoring rubric, so its historical soft scores and the ones you are
    // about to produce were written against different instructions. Advisory —
    // it never blocks and never touches a verdict.
    const rubricDrift = rubricDriftWarning(spec);
    if (rubricDrift) {
      warnings.push(rubricDrift);
      content.push({ type: 'text', text: `⚠ ${rubricDrift}` });
    }
    content.push({
      type: 'text',
      text: specScopedScoringInstructions(spec, partition.carryForward),
    });
  } else {
    content.push({
      type: 'text',
      text: plan ? planScopedScoringInstructions(plan) : SCORING_INSTRUCTIONS,
    });
  }

  // Additive loop signal: surface the persisted mechanical verdicts + the
  // single `signedOff` stop rule via structuredContent. The `content` array
  // above (text + screenshots) is unchanged for interactive use. `setup` and
  // `presentation` (C3, registry §9.1) are SIBLING keys of `verdict`: wrapper
  // fidelity routes "fix setup" vs "fix component"; presentation tells a loop
  // driver what was omitted (and how to re-request it) without parsing text.
  const finalMeta = readRunMeta(projectRoot, result.runId);
  const wrapperFidelity = pickWrapperFidelity(ensureResult.wrapperFidelity);
  // Temporal binding (B2, sibling key): did the frozen spec precede this
  // run's work? The spec in hand IS the exact frozen version being verified,
  // so its `git` binding is the right freeze anchor. Display-only.
  const temporal =
    spec && finalMeta
      ? resolveTemporalBinding({ projectRoot, freeze: spec.git, meta: finalMeta })
      : undefined;
  const presentation: VerifyPresentation = {
    detail,
    autoSelected,
    screenshotsShown: leanShown,
    screenshotsTotal: leanTotal,
    omittedRenderIds,
    carriedForwardSoft: partition.carryForward.map((c) => c.id),
  };
  // RECEIPT (B1): what this verify wrote to the project's standing state.
  // Pushed as text AND as a structured sibling so the agent can cite it.
  const receipt = buildVerifyReceipt({
    runId: result.runId,
    origin: finalMeta?.origin ?? detectRunOrigin(),
    fold,
  });
  content.push({ type: 'text', text: receiptLine(receipt, fold?.error) });
  // Always-a-report (Feature 1): write the mechanical-only preliminary report
  // now and surface its path — submit_report later overwrites it with scores.
  const reportContent = await attachPreliminaryReport(projectRoot, finalMeta, content);
  return {
    content,
    structuredContent: {
      ...buildVerifyStructuredContent(
        result.runId,
        finalMeta?.criterionVerdicts,
        spec ?? undefined,
        projectRoot,
        spec?.id,
        finalMeta?.components,
        plan !== null,
        openPerfDrift,
      ),
      receipt,
      presentation,
      // WHAT RAN (parity with the native handler): on an RN/Expo project an
      // isolation render goes through the react-native-web proxy — a DIFFERENT
      // runtime than the app ships on. The response used to carry no runtime
      // field at all, so a scoring agent could not tell the two apart without
      // opening the HTML report.
      runtime: {
        mode: 'isolation' as const,
        target: detectNative(projectRoot).isNative
          ? ('react-native-web' as const)
          : ('web' as const),
        framework: config.framework,
      },
      ...(wrapperFidelity ? { setup: { wrapperFidelity } } : {}),
      ...(temporal && spec ? { temporal: buildTemporalContent(temporal, spec) } : {}),
      // ADVISORY coverage namespace (E2.1) — sibling of `verdict`, structurally
      // unreachable from the stop rule. Omitted when nothing was found so a
      // fully-covered verify returns a byte-identical payload.
      ...(dataStateHints.length > 0 ? { coverage: { dataStateHints } } : {}),
      // Which targets the web sandbox can honestly verify on a Next project
      // (E2.4). Omitted on non-Next projects and when nothing was excluded.
      ...(rsc && rsc.excluded.length > 0 ? { rsc } : {}),
      ...reportContent,
      // Fixture/scenario precedence (A) + rubric drift (E2.2), one array.
      // After `reportContent` so the notes can never be shadowed by it.
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

/**
 * Should "verify this" go to a device rather than the web sandbox?
 *
 * True for React Native / Expo projects that have not explicitly opted into the
 * `react-native-web` proxy. Detection establishes whether a device path exists
 * at all; the config then gets the final say, since a user who pinned
 * `framework: 'expo-web'` has stated their intent. A project with no loadable
 * config yet — the virgin first-run case — is decided by detection alone, which
 * is exactly when the wrong default does the most damage.
 */
export async function nativeIsDefaultTarget(projectRoot: string): Promise<boolean> {
  // Dependency read first (one package.json parse). A toolchain with no native
  // path can never route to a device, so web projects — the common case, and
  // this is the hot path of every verify — skip the config load entirely.
  // `loadConfig` re-transpiles through jiti with `moduleCache: false`, so it is
  // not something to call speculatively.
  if (!detectAppTarget(projectRoot).nativeAvailable) return false;

  let configFramework: string | undefined;
  try {
    configFramework = (await loadConfig(projectRoot)).config.framework;
  } catch {
    // No config yet — detection decides on its own.
  }
  return detectAppTarget(projectRoot, { configFramework }).recommended === 'native';
}

export async function handleVerify(args: ToolArgs): Promise<ServerResult> {
  if (!args.prompt) throw new Error('prompt is required');

  // Plan-first enforcement (B1): one gate here — before mode dispatch — covers
  // isolation, URL, and native identically. On a virgin project loadConfig
  // fails → advisory → verify proceeds and bootstraps (strict cannot pre-date
  // the config file that declares it).
  const projectRoot = resolveProjectRoot(args.projectRoot);
  if ((await resolveEnforcement(projectRoot)) === 'strict') {
    const redirect = strictVerifyRedirect(projectRoot, args.planId);
    if (redirect) return redirect;
  }

  // Mode selection. Native is the most explicit intent (`native: true`), so it
  // wins first; then URL beats isolation when either is explicitly provided. We
  // branch up front so isolation-mode users never pay the dev-server detection
  // cost, and URL-mode users never pay the Vite-sandbox boot cost.
  //
  // The last clause is the React Native rule: on an Expo / bare-RN project with
  // no explicit web opt-in, "verify this" means the device. Falling back to the
  // `react-native-web` sandbox because it's cheaper would score the app against
  // a runtime it never ships on, and the report would not say so.
  const mode: 'isolation' | 'url' | 'native' = await (async () => {
    if (args.native === true) return 'native' as const;
    if (args.url || (args.paths && args.paths.length > 0)) return 'url' as const;
    if (args.webTarget === true) return 'isolation' as const;
    return (await nativeIsDefaultTarget(projectRoot))
      ? ('native' as const)
      : ('isolation' as const);
  })();

  // Serialize overlapping verifies (W4 #12): two MCP verifies, or a watch tick
  // racing this call, must not interleave sandbox files or the scorecard fold.
  // Acquire AFTER the strict redirect (nothing to serialize if we never render)
  // and BEFORE minting a runId / writing the in-flight marker.
  let lock: ReturnType<typeof acquireVerifyLock>;
  try {
    lock = acquireVerifyLock(projectRoot, { owner: 'mcp-verify' });
  } catch (err) {
    if (err instanceof VerifyLockHeldError) {
      return {
        isError: true,
        content: [{ type: 'text', text: err.message }],
      };
    }
    throw err;
  }

  try {
    // In-flight marker (Feature 2). Written HERE — the one choke point past the
    // strict gate, so it covers all three modes with a single try/finally — and
    // removed on EVERY exit path (success, early return, throw).
    // The runId is generated up front and threaded into the mode handler so the
    // marker names the SAME run the render will produce, and the marker predates
    // the expensive render/capture (the window the dashboard most wants visible).
    // specId is best-effort: an unresolvable/malformed planId simply omits it.
    const runId = newRunId();
    let specId: string | undefined;
    try {
      specId = resolveSpec(projectRoot, args.planId)?.id;
    } catch {
      specId = undefined;
    }
    writeInflightMarker(projectRoot, {
      runId,
      mode,
      ...(specId ? { specId } : {}),
      ...(args.planId ? { planId: args.planId } : {}),
      startedAt: new Date().toISOString(),
    });
    // Incomplete-run marker (B5), written at the SAME choke point: a run-meta
    // stamped `status: 'in-progress'` that the mode handler overwrites when it
    // finishes. A verify killed mid-render used to leave a run dir with
    // screenshots and no run-meta — invisible to every reader. Now the crash is
    // a fact on disk, surfaced as an `incomplete` row that is never tallied as a
    // pass or a fail.
    writeStartRunMeta({
      projectRoot,
      runId,
      mode,
      prompt: args.prompt,
      ...(specId ? { specId } : {}),
      ...(args.planId ? { planId: args.planId } : {}),
    });
    try {
      if (mode === 'native') return await handleVerifyNative(args, runId);
      if (mode === 'url') return await handleVerifyUrl(args, runId);
      return await handleVerifyIsolation(args, runId);
    } finally {
      clearInflightMarker(projectRoot, runId);
    }
  } finally {
    lock.release();
  }
}

async function handleGetConfig(args: ToolArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const { config, configPath } = await loadConfig(projectRoot);
  return {
    content: [{ type: 'text', text: JSON.stringify({ configPath, config }, null, 2) }],
  };
}

/**
 * Best-effort "open this URL in the user's default browser." Non-fatal on
 * failure — the URL is always returned in the tool response so the user can
 * paste it manually if the spawn breaks (sandboxed env, missing xdg-open,
 * etc.).
 */
function openInBrowser(url: string): void {
  try {
    let command: string;
    let args: string[];
    if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      // `start` is a cmd builtin, not an executable. The empty quoted
      // string is the window title — required because `start` treats the
      // first quoted arg as a title when there are multiple.
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      /* ENOENT on minimal systems (no xdg-open) — non-fatal. */
    });
    child.unref();
  } catch {
    /* swallow — caller still returns the URL for manual opening. */
  }
}

/**
 * Start (or reuse) a persistent browse-mode dev server for `projectRoot` and
 * open the user's default browser pointed at it. Subsequent
 * `validity__browse_navigate` calls drive whichever page is connected to
 * the bridge.
 */
async function handleBrowseOpen(args: BrowseOpenArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);

  // Redirect to the device — but ONLY for projects the app-target detector
  // actually calls native. A `react-native` dependency alone doesn't decide it
  // (a Vite app aliasing react-native → react-native-web has one and is a web
  // app), so `detectNative` is used to sharpen the MESSAGE, never to make the
  // call. Web projects must never be turned away from the web browser.
  if (args.webTarget !== true && (await nativeIsDefaultTarget(projectRoot))) {
    // A bare RN app has no web target at all; an Expo app has one it didn't
    // ask for. Same redirect, different reason, so say the right one.
    const bare = detectNative(projectRoot).bareReactNative;
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: bare
            ? 'This is a bare React Native app with no web target — validity__browse_open is for ' +
              'Vite / Next / Expo-Web projects. Use validity__native_browse to show components OR ' +
              'views on the simulator.'
            : 'This is a React Native / Expo app, so its UI belongs on a simulator/emulator — ' +
              'use validity__native_browse (it takes a `component` OR a `view`). The first call runs a ' +
              'readiness check and builds the companion app once; later calls are instant.\n\n' +
              `${EXPO_WEB_OPT_IN_HINT}\n` +
              'If the user did ask for the web target, re-call browse_open with `webTarget: true`.',
        },
      ],
    };
  }

  await ensureValidityConfigured({ projectRoot });
  const loadedBrowse = await loadConfig(projectRoot);
  const config: ValidityConfig =
    args.webTarget === true &&
    (loadedBrowse.config.framework === 'auto' || loadedBrowse.config.framework === 'expo-native')
      ? { ...loadedBrowse.config, framework: 'expo-web' }
      : loadedBrowse.config;

  // Reuse the existing session when the server is still listening — starting
  // a second Vite for the same project would burn a port and break the
  // bridge handle the agent already has.
  let entry = sessions.get(projectRoot);
  if (entry) {
    const stillListening = entry.devServer.server.httpServer?.listening === true;
    const stillBridged = entry.devServer.bridge?.isConnected() === true;
    if (!stillListening && !stillBridged) {
      sessions.delete(projectRoot);
      entry = undefined;
    }
  }

  if (!entry) {
    // Materialize the sandbox FIRST — without this, startDevServer brings up
    // Vite over whatever stale entry.tsx / validity-index.tsx happen to be on
    // disk from a previous `validity browse` run. Symptoms: a freshly
    // installed Validity (new MCP tools, new template) serves the OLD browse
    // canvas because the writer step never re-ran. The CLI `validity browse`
    // command does this explicitly; the MCP browse_open path silently relied
    // on the user having prepared it some other way.
    prepareSandbox(projectRoot, config);
    const devServer = await startDevServer(projectRoot, { config, persist: true });
    entry = { devServer };
    sessions.set(projectRoot, entry);
  }

  const baseUrl = entry.devServer.url.replace(/\/+$/, '');
  const url = args.component
    ? `${baseUrl}/?focus=${encodeURIComponent(args.component)}`
    : `${baseUrl}/`;

  openInBrowser(url);

  // Usually only set on the session-reuse path — a fresh server's scan is
  // still running when we return. First-time failures surface later, via
  // the in-page error banner and browse_navigate's check.
  const scanFailure = entry.devServer.depScanFailure();

  return {
    content: [
      {
        type: 'text',
        text:
          `Browse session ready: ${url}\n` +
          'Once the browser tab connects, call `validity__browse_navigate` to switch ' +
          'components, apply scenarios, override props, or change viewport without the ' +
          'user clicking.' +
          (scanFailure ? `\n\n${depScanFailureNote(scanFailure)}` : ''),
      },
    ],
  };
}

/**
 * One paragraph explaining a dead dep pre-scan to the agent driving the
 * browse session — what broke, what the page shows, and the fix. Without
 * this the failure is only four red lines on the CLI server's stderr, which
 * an MCP client never sees; the observable symptom used to be "tool said
 * ready, page blank forever".
 */
function depScanFailureNote(summary: string): string {
  return (
    `WARNING — the sandbox's dependency pre-scan ABORTED: ${summary}\n` +
    'Pre-bundled deps were never written, so the page cannot render components; it shows ' +
    'an error banner instead. Fix or exclude the offending import (e.g. add it to ' +
    "`optimizeDeps.exclude` in the project's vite.config), then reopen with " +
    'validity__browse_open.'
  );
}

/**
 * Push a `navigate` command over the bridge to whichever page is currently
 * connected. Errors are returned as `isError: true` results (not thrown) so
 * the outer try/catch wrapper doesn't reword the actionable message — the
 * agent needs the exact "no session / not connected / reopen" cue.
 */
async function handleBrowseNavigate(args: BrowseNavigateArgs): Promise<ServerResult> {
  if (!args.component && !args.view) {
    return {
      isError: true,
      content: [
        { type: 'text', text: 'validity__browse_navigate requires either `component` or `view`.' },
      ],
    };
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const entry = sessions.get(projectRoot);
  if (!entry) {
    // A React Native / Expo app has no web bridge for browse_navigate to drive —
    // without this redirect the call "succeeds" and the agent then waits forever
    // on a browser tab that never connects (the reported view-loading hang).
    // native_browse renders on the simulator and takes EITHER a `component` or a
    // `view` (its own dedicated args, same split as here), so steer there with
    // the matching arg. Guard on the missing session so a legitimately-open
    // Expo-WEB session still navigates normally.
    const det = detectNative(projectRoot);
    if (det.isNative) {
      const nativeArg = args.view ? 'view' : 'component';
      const name = JSON.stringify(args.view ?? args.component ?? 'MyScreen');
      const nativeHint =
        'For native UI on the simulator, use validity__native_browse — it renders on the device ' +
        `and takes a \`component\` (name/path) OR a \`view\` name (e.g. native_browse({ ${nativeArg}: ${name} })).`;
      // Bare RN has no web target ever; an Expo app's web session may have just
      // closed — so don't tell an Expo user their only option is native_browse.
      const text = det.bareReactNative
        ? 'This is a bare React Native app — validity__browse_navigate is WEB-only and would hang ' +
          `waiting on a browser tab. ${nativeHint}`
        : `No browse session is open for ${projectRoot}. If you meant Expo Web, call ` +
          `validity__browse_open first to (re)start it. Otherwise this is native UI — ${nativeHint}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `No browse session is open for ${projectRoot}. Call validity__browse_open first.`,
        },
      ],
    };
  }
  // A dead dep pre-scan is the one failure where "not connected" is NOT the
  // page being closed — the page is open but can never finish loading, so
  // the bridge never attaches. Name the real cause instead of sending the
  // agent into a reopen loop.
  const scanFailure = entry.devServer.depScanFailure();
  const bridge = entry.devServer.bridge;
  if (!bridge || !bridge.isConnected()) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: scanFailure
            ? `Browse page never connected. ${depScanFailureNote(scanFailure)}`
            : 'Browse session is no longer connected (page closed?). Reopen with validity__browse_open.',
        },
      ],
    };
  }

  // Build the navigate message with only the fields the caller supplied.
  // Sending undefined values would pollute the bridge protocol; sending null
  // for propOverrides is meaningful (it clears any prior override) so we
  // forward it verbatim.
  const msg: BridgeMessage = { type: 'navigate' };
  if (args.view) msg.view = args.view;
  else if (args.component) msg.path = args.component;
  if (args.scenario !== undefined) msg.scenario = args.scenario;
  if (args.propOverrides !== undefined && !args.view) msg.propOverrides = args.propOverrides;
  if (args.viewport !== undefined) msg.viewport = args.viewport;

  const delivered = bridge.send(msg);
  if (!delivered) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Browse session is no longer connected (page closed?). Reopen with validity__browse_open.',
        },
      ],
    };
  }

  const modifiers: string[] = [];
  if (args.scenario) modifiers.push(`scenario "${args.scenario}"`);
  if (args.viewport) modifiers.push(`viewport ${args.viewport}`);
  if (args.propOverrides === null) {
    modifiers.push('cleared prop overrides');
  } else if (args.propOverrides && Object.keys(args.propOverrides).length > 0) {
    const count = Object.keys(args.propOverrides).length;
    modifiers.push(`with ${count} prop override${count === 1 ? '' : 's'}`);
  }
  const suffix = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';
  const target = args.view ? `view "${args.view}"` : (args.component ?? '');
  return {
    content: [
      {
        type: 'text',
        text:
          `Navigated to ${target}${suffix}` +
          (scanFailure ? `\n\n${depScanFailureNote(scanFailure)}` : ''),
      },
    ],
  };
}

/**
 * List every author-defined view in the project's `.validity/config.ts`,
 * with item counts and the components each pulls in. Cheap (just reads the
 * loaded config) so the LLM can call it freely before recommending a view
 * to render.
 */
async function handleViewsList(args: ViewsListArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  await ensureValidityConfigured({ projectRoot });
  const { config } = await loadConfig(projectRoot);
  const views = config.views ?? {};
  const names = Object.keys(views).sort();
  if (names.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No views defined in .validity/config.ts. Create one with validity__views_create.',
        },
      ],
    };
  }
  const lines = [`Views (${names.length}):`];
  for (const name of names) {
    const v = views[name]!;
    const title = v.title ? ` — ${v.title}` : '';
    lines.push(`  • ${name}${title} (${v.items.length} item${v.items.length === 1 ? '' : 's'})`);
    for (const item of v.items) {
      const fx = item.fixtureName ? ` · fixture "${item.fixtureName}"` : '';
      const lbl = item.label ? ` — ${item.label}` : '';
      lines.push(`      - ${item.componentPath}${fx}${lbl}`);
    }
  }
  lines.push('');
  lines.push('Open one with validity__browse_navigate({ view: "<name>" }).');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * List the project's component / screen / view library — the deterministic
 * "what do I have" answer so the agent can explore before driving browse.
 * Pure read (discovery walk + config), cheap by default; `includeProps`
 * opts into per-entry prop-type extraction.
 */
async function handleCatalog(args: CatalogArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  await ensureValidityConfigured({ projectRoot });
  const { config } = await loadConfig(projectRoot);
  const catalog = buildCatalog(projectRoot, config, { includeProps: args.includeProps });

  const q = args.query?.trim().toLowerCase();
  let entries = catalog.entries;
  if (args.kind) entries = entries.filter((e) => e.kind === args.kind);
  if (q) {
    entries = entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    );
  }

  if (entries.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No ${args.kind ?? 'components/screens/views'} found${q ? ` matching "${args.query}"` : ''}. Try validity__catalog with no filter to see everything.`,
        },
      ],
    };
  }

  const { components, screens, views } = catalog.counts;
  const lines = [`Library: ${components} components · ${screens} screens · ${views} views`, ''];
  const render = (kind: string, kindEntries: typeof entries) => {
    if (kindEntries.length === 0) return;
    lines.push(`${kind} (${kindEntries.length}):`);
    for (const e of kindEntries) {
      const bits: string[] = [e.path];
      if (e.routePath) bits.push(`route ${e.routePath}`);
      if (e.fixtures.length)
        bits.push(`${e.fixtures.length} fixture${e.fixtures.length === 1 ? '' : 's'}`);
      if (e.usedByScreens?.length)
        bits.push(
          `used by ${e.usedByScreens.length} screen${e.usedByScreens.length === 1 ? '' : 's'}`,
        );
      if (e.usesComponents?.length && e.kind !== 'component')
        bits.push(`uses ${e.usesComponents.length}`);
      const propsLine = e.props ? summarizeProps(e.props) : '';
      lines.push(`  • ${e.name} — ${bits.join(' · ')}${e.discovered ? ' · discovered' : ''}`);
      if (propsLine) lines.push(`      props: ${propsLine}`);
    }
    lines.push('');
  };
  render(
    'Components',
    entries.filter((e) => e.kind === 'component'),
  );
  render(
    'Screens',
    entries.filter((e) => e.kind === 'screen'),
  );
  render(
    'Views',
    entries.filter((e) => e.kind === 'view'),
  );
  // RSC honesty (E2.4): on a Next project, name which of these files the web
  // sandbox can actually render and which are Server Components it can't —
  // the limit used to live only in a code comment.
  const rsc = classifyNextEntries(
    projectRoot,
    entries.filter((e) => e.kind !== 'view').map((e) => e.path),
  );
  const rscBlock = rsc ? formatRscBlock(rsc) : undefined;
  if (rscBlock) lines.push(rscBlock, '');
  lines.push('Open any of these with validity__browse_open / validity__browse_navigate.');
  return {
    content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
    ...(rsc && rsc.excluded.length > 0 ? { structuredContent: { rsc } } : {}),
  };
}

/**
 * Classify project-relative paths into client-verifiable vs. excluded server
 * components — Next.js only. Returns undefined on every other framework (there
 * is no RSC boundary to report, and an empty `rsc` key on a Vite project would
 * be noise a consumer has to special-case).
 *
 * Reads each file to look for the `'use client'` directive; an unreadable file
 * is treated as having no directive, which only ever moves a path from
 * "verifiable" to "excluded" for App Router files — the conservative direction
 * (we under-claim what we can verify, never over-claim).
 */
export function classifyNextEntries(
  projectRoot: string,
  paths: string[],
): RscClassification | undefined {
  let framework: string;
  try {
    framework = detectFramework(projectRoot);
  } catch {
    return undefined;
  }
  if (framework !== 'next') return undefined;
  return classifyNextSources(
    paths.map((path) => {
      const absolute = resolve(projectRoot, path);
      // `isAppRouterPath` reads project-relative segments; renders carry
      // absolute paths and catalog entries relative ones, so normalize here.
      const rel = relative(projectRoot, absolute).split(sep).join('/');
      let source = '';
      try {
        source = readFileSync(absolute, 'utf-8');
      } catch {
        source = '';
      }
      return { path: rel, source };
    }),
  );
}

/**
 * Resolve a casual name ("button", "the login form") to a concrete library
 * entry. Returns the single match when confident; on a tie it returns the
 * candidate list and asks rather than guessing (CLAUDE.md no-infer rule).
 */
async function handleResolve(args: ResolveArgs): Promise<ServerResult> {
  if (!args.query || typeof args.query !== 'string') {
    throw new Error('validity__resolve requires a `query` string (e.g. "Button").');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);
  await ensureValidityConfigured({ projectRoot });
  const { config } = await loadConfig(projectRoot);
  const catalog = buildCatalog(projectRoot, config);
  const result = resolveName(args.query, catalog);

  if (result.matches.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No component/screen/view matched "${args.query}". Run validity__catalog to see the library.`,
        },
      ],
    };
  }
  if (result.best) {
    const b = result.best;
    const where = b.kind === 'view' ? `view "${b.path}"` : b.path;
    return {
      content: [
        {
          type: 'text',
          text: `Resolved "${args.query}" → ${where} (${b.kind}).\nOpen it with validity__browse_open({ component: "${b.path}" }) or validity__browse_navigate.`,
        },
      ],
    };
  }
  // Ambiguous — surface candidates, do not pick.
  const top = result.matches.slice(0, 5);
  const lines = [
    `"${args.query}" is ambiguous — ${result.matches.length} candidates. Ask the user which one (don't guess):`,
  ];
  for (const m of top) lines.push(`  • ${m.path} (${m.kind})`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Read the project's design tokens (CSS custom properties + Tailwind theme)
 * so you know WHICH token to edit in code when the user asks for a design
 * change. Validity is the eyes here — it reports the tokens and their source
 * files; you make the edit in the source. It never writes tokens itself.
 */
async function handleTokens(args: TokensArgs): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const set = discoverDesignTokens(projectRoot);
  let vars = set.cssVariables;
  if (args.group) vars = vars.filter((t) => t.group === args.group);

  if (vars.length === 0 && !set.tailwindConfigPath) {
    return {
      content: [
        {
          type: 'text',
          text: 'No design tokens found (no :root/@theme CSS custom properties and no tailwind.config). Tokens are usually in your global CSS or tailwind config.',
        },
      ],
    };
  }

  const lines: string[] = [];
  const groups = [...new Set(vars.map((t) => t.group))];
  if (vars.length) {
    lines.push(`CSS custom properties (${vars.length}) — edit these in their source file:`);
    for (const g of groups) {
      const inGroup = vars.filter((t) => t.group === g);
      lines.push(`  ${g}:`);
      for (const t of inGroup) lines.push(`    ${t.name}: ${t.value}   (${t.source})`);
    }
    lines.push('');
  }
  if (set.tailwindConfigPath) {
    lines.push(`Tailwind config: ${set.tailwindConfigPath}`);
    if (set.tailwindColors.length) lines.push(`  color keys: ${set.tailwindColors.join(', ')}`);
    lines.push('  (open this file to edit theme tokens)');
    lines.push('');
  }
  lines.push(
    'Validity is read-only here: edit the token in the source file shown, then re-render to see it.',
  );
  return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
}

/**
 * The warm native session both `native_browse` and a native `verify` drive: the
 * prepared companion app + catalog, the pinned device + driver, the live bridge,
 * and the readiness/metro facts — all the TARGET-INDEPENDENT setup. Extracted so
 * a native verify runs it EXACTLY ONCE and then loops cheap navigate+ack+
 * screenshot iterations against it (the whole point of step 9's caching), rather
 * than re-deriving the session per render the way repeated `native_browse` calls
 * used to. `native_browse` resolves its single target after this returns;
 * `verify` resolves N.
 */
export interface NativeSession {
  projectRoot: string;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  app: ReturnType<typeof prepareNativeApp>;
  catalog: ReturnType<typeof buildCatalog>;
  platform: 'ios' | 'android';
  pinnedDevice?: string;
  /** Name/OS of the pinned device — run-meta provenance (RunMeta.nativeDevice). */
  pinnedDeviceName?: string;
  pinnedOsVersion?: string;
  driver: AgentDeviceDriver;
  bridge: NativeBridgeHandle;
  /** Tail this for the observable cold-bundle readiness wait. */
  metroLogPath: string;
  /** Timing breakdowns, surfaced in the response _meta. */
  prepareMs: number;
  readinessMs: number;
  preparedReused: boolean;
}

/**
 * The cheap, side-effect-free half of a native session: enough to answer "is the
 * playground ready to render?" WITHOUT regenerating the companion app. Returned
 * by {@link probeNativeReadiness} and consumed by {@link setupNativeSession},
 * which only proceeds to the (file-writing) prepare + Metro + bridge once
 * `readiness.ready` is true.
 */
interface NativeReadinessProbe {
  projectRoot: string;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  identity: CompanionBuildIdentity;
  platform: 'ios' | 'android';
  pinnedDevice?: string;
  /** Name/OS of the pinned device — run-meta provenance (RunMeta.nativeDevice). */
  pinnedDeviceName?: string;
  pinnedOsVersion?: string;
  driver: AgentDeviceDriver;
  readiness: NativeReadiness;
  /** Elapsed ms for device-pin + readiness (folded into the session timing). */
  readinessMs: number;
}

/**
 * Side-effect-free readiness preflight: answer "is the native playground ready
 * to render?" WITHOUT regenerating the companion app on disk. The full setup
 * used to run `prepareNativeApp` (which rewrites the registry/mocks/app-shell)
 * BEFORE the readiness gate, so even a "you haven't built the companion yet"
 * answer paid the regeneration cost — and an agent that just wanted to *ask*
 * about readiness couldn't, without that write. This computes only the cheap
 * binary identity ({@link companionBuildIdentity} — a pure read of package.json
 * + node_modules + the resolved expo config), pins the device, and runs
 * {@link checkNativeReadiness} against it. A hard prerequisite that isn't a
 * readiness STEP (not a native project, several booted devices and no pin)
 * comes back as a ready-to-send error result; otherwise the caller gates on
 * `probe.readiness.ready`.
 */
async function probeNativeReadiness(args: {
  projectRoot?: string;
  scheme?: string;
  platform?: 'ios' | 'android';
  device?: string;
}): Promise<{ ok: true; probe: NativeReadinessProbe } | { ok: false; result: ServerResult }> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const { config } = await loadConfig(projectRoot);

  const detection = detectNative(projectRoot);
  if (!detection.isNative) {
    return {
      ok: false,
      result: {
        content: [{ type: 'text', text: `Not a React Native / Expo project: ${detection.reason}` }],
      },
    };
  }

  // CHEAP binary identity — a pure read (package.json + node_modules + expo
  // config), NO file regeneration. Single-sourced with prepareNativeApp so the
  // buildHash the readiness gate keys on is byte-identical to the one the
  // rebuild gate bakes into the install marker.
  const platform = args.platform ?? (config.native?.target === 'android' ? 'android' : 'ios');
  const identity = companionBuildIdentity({ projectRoot, config, scheme: args.scheme, platform });

  // PIN ONE DEVICE for the whole session (CACHED — re-probing it every call is a
  // wasted simctl/adb spawn; a failed capture nukes the cache). With >1 booted
  // device and no explicit pin, refuse to guess: the deep link and the
  // screenshot must hit the same device.
  const readinessStart = Date.now();
  const { value: bootedDevices } = await nativeSessionCache.bootedDevices(
    projectRoot,
    platform,
    () => listBootedDevices(platform),
  );
  if (!args.device && bootedDevices.length > 1) {
    return {
      ok: false,
      result: { content: [{ type: 'text', text: multipleDevicesBlock(bootedDevices, platform) }] },
    };
  }
  const pinnedDevice = args.device ?? bootedDevices[0]?.id;
  const pinned = bootedDevices.find((d) => d.id === pinnedDevice);
  // projectRoot doubles as the spawn cwd: agent-device keys sessions by CWD,
  // and the MCP server's own cwd is whatever the MCP host launched it with —
  // without this pin, a CLI run and an MCP run against the same project
  // address two different agent-device sessions and refuse each other's device.
  // Remote device profile (native.remote) — same --remote-config every other
  // agent-device command gets; unset leaves the local path byte-identical.
  const remoteConfigPath = resolveRemoteConfigPath(config.native, projectRoot);
  const driver = new AgentDeviceDriver({
    platform,
    scheme: identity.scheme,
    device: pinnedDevice,
    projectRoot,
    cwd: projectRoot,
    ...(remoteConfigPath ? { remoteConfigPath } : {}),
  });

  // Walkthrough gate (CACHED, keyed by device + buildHash). If any prerequisite
  // is unmet, the readiness object carries the checklist + the single next
  // action — the caller decides how to present it.
  const readinessKey = `${platform}:${pinnedDevice ?? ''}:${identity.buildHash}`;
  const { value: readiness } = await nativeSessionCache.readiness(projectRoot, readinessKey, () =>
    checkNativeReadiness({
      projectRoot,
      platform,
      scheme: identity.scheme,
      bundleId: identity.bundleId,
      device: pinnedDevice,
      buildHash: identity.buildHash,
      buildMarkerPath: identity.buildMarkerPath,
      buildInputs: identity.buildInputs,
    }),
  );
  const readinessMs = Date.now() - readinessStart;

  return {
    ok: true,
    probe: {
      projectRoot,
      config,
      identity,
      platform,
      pinnedDevice,
      ...(pinned?.name ? { pinnedDeviceName: pinned.name } : {}),
      ...(pinned?.osVersion ? { pinnedOsVersion: pinned.osVersion } : {}),
      driver,
      readiness,
      readinessMs,
    },
  };
}

/**
 * Build (or reuse) the warm native session for `args`, or return a ready-to-send
 * error/checklist ServerResult when a prerequisite is unmet (not a native
 * project, multiple booted devices, readiness gate not satisfied, Metro down /
 * ownership-unconfirmed). Readiness is gated FIRST via {@link probeNativeReadiness}
 * (a pure read), so the expensive `prepareNativeApp` regeneration runs ONLY once
 * the playground is confirmed ready — a not-ready answer no longer rewrites the
 * companion on disk. It does not know the target (the readiness checklist is
 * phrased around `opts.targetLabel`).
 */
async function setupNativeSession(
  args: {
    projectRoot?: string;
    scheme?: string;
    platform?: 'ios' | 'android';
    device?: string;
    reload?: boolean;
  },
  opts: { targetLabel: string },
): Promise<{ ok: true; session: NativeSession } | { ok: false; result: ServerResult }> {
  // An explicit reload means "re-derive everything from scratch" — nuke the warm
  // cache up front (BEFORE the probe reads its cached device + readiness facts)
  // so the prepared bundle AND the device facts are recomputed.
  if (args.reload === true) nativeSessionCache.invalidate(resolveProjectRoot(args.projectRoot));

  // READINESS FIRST, side-effect-free: gate on the cheap probe BEFORE any file
  // regeneration. A not-native project / multiple-devices error short-circuits
  // here without touching disk.
  const probed = await probeNativeReadiness(args);
  if (!probed.ok) return probed;
  const {
    projectRoot,
    config,
    platform,
    pinnedDevice,
    pinnedDeviceName,
    pinnedOsVersion,
    driver,
    readiness,
    readinessMs,
  } = probed.probe;

  if (!readiness.ready) {
    const lines = [
      `The native playground needs setup before it can render ${opts.targetLabel}. Status:`,
      '',
    ];
    for (const s of readiness.steps) {
      lines.push(`  ${s.status === 'ok' ? '✓' : '→'} ${s.label} — ${s.detail}`);
      if (s.status === 'todo' && s.action) lines.push(`      ${s.action}`);
    }
    lines.push('');
    lines.push(
      `Next: ${readiness.nextAction?.label} — ${readiness.nextAction?.action ?? readiness.nextAction?.detail}`,
    );
    lines.push(
      'This is a SEPARATE "Validity" dev app installed beside the real app — the user\'s app is never modified. Once everything is ✓, re-run this tool and it deep-links + screenshots automatically.',
    );
    // The human text above is unchanged. What is ADDED is the machine-readable
    // twin: a polling loop driver used to get a wall of prose and no parseable
    // field at all here, so "the emulator is not booted" and "your component
    // threw" were the same non-answer. `readiness` is the whole checklist
    // (a driver can show progress across polls); `environmentBlocked` is the
    // one thing to do. Neither carries a verdict — this path never produced one.
    const envBlocked = readinessEnvironmentBlocked(readiness, opts.targetLabel);
    return {
      ok: false,
      result: {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ...(envBlocked ? { environmentBlocked: envBlocked } : {}),
          readiness: {
            ready: false,
            steps: readiness.steps.map((s) => ({
              id: s.id,
              label: s.label,
              status: s.status,
              detail: s.detail,
              ...(s.action ? { action: s.action } : {}),
            })),
            ...(readiness.nextAction
              ? {
                  nextAction: {
                    id: readiness.nextAction.id,
                    label: readiness.nextAction.label,
                    detail: readiness.nextAction.detail,
                    ...(readiness.nextAction.action ? { action: readiness.nextAction.action } : {}),
                  },
                }
              : {}),
          },
        },
      },
    };
  }

  // PREPARE (cached) — only now that the playground is confirmed READY: the
  // catalog (for name resolution) + the companion app (registry/mocks/app-shell)
  // are regenerated/written here. Keyed by a cheap source signature (config-file
  // mtimes + the discovered source-file set) so a component-body edit — which
  // rides Fast Refresh and never changes the registry — reuses this without a
  // re-scan; adding/removing a file or touching config recomputes it.
  const prepareStart = Date.now();
  const sourceSignature = `${computeNativeSourceSignature(projectRoot, args.scheme)}:${platform}`;
  const { value: prepared, reused: preparedReused } = nativeSessionCache.prepared(
    projectRoot,
    sourceSignature,
    () => ({
      catalog: buildCatalog(projectRoot, config),
      app: prepareNativeApp({ projectRoot, config, scheme: args.scheme, platform }),
    }),
  );
  const { catalog, app } = prepared;
  const prepareMs = Date.now() - prepareStart;
  // The probe keyed readiness on companionBuildIdentity's buildHash; the
  // regenerated `app` re-derives it through the SAME function, so the gate and
  // the served bundle can't disagree on which binary they assume.

  // The app is installed + fresh, but the deep link only RENDERS if Metro is
  // serving the bundle. Bring it back up (no rebuild) before driving the device.
  const metro = await ensureCompanionMetro(app.appDir, {
    contentHash: app.contentHash,
    contentMarkerPath: app.metroContentMarkerPath,
  });
  if (metro.started && !metro.up) {
    nativeSessionCache.invalidate(projectRoot);
    return {
      ok: false,
      result: {
        content: [
          {
            type: 'text',
            text:
              (metro.earlyExitCode !== undefined
                ? `The Validity companion's Metro bundler crashed on boot (exit ${metro.earlyExitCode}) `
                : `The Validity companion is installed but its Metro bundler didn't come up on its port `) +
              `(log: ${metro.logPath}). Re-run \`validity browse --native\` to (re)start it, then retry.`,
          },
        ],
      },
    };
  }
  if (metro.ownershipUnconfirmed) {
    // A server answered /status but the port couldn't be attributed to the Metro
    // this call spawned — a surviving OLD Metro may be serving STALE content.
    nativeSessionCache.invalidate(projectRoot);
    return {
      ok: false,
      result: {
        content: [
          {
            type: 'text',
            text:
              `A Metro is answering on the companion port but it does not look like the one Validity just ` +
              `started — a leftover server may be serving STALE content (log: ${metro.logPath}). ` +
              `Stop whatever holds the companion port (or close other validity sessions), then retry; ` +
              `the restart will be re-attempted automatically.`,
          },
        ],
      },
    };
  }

  const bridge = ensureNativeBridge();
  // Publish the fresh DATA payload for the device's boot fetch (GET /data) so a
  // views_create / scenario / mock edit shows up with no native rebuild. Cheap +
  // idempotent — safe to set once per session here.
  bridge.setNativeData(app.prepared.dataPayload);

  const metroLogPath = metro.logPath ?? resolve(app.appDir, 'validity-native.log');

  return {
    ok: true,
    session: {
      projectRoot,
      config,
      app,
      catalog,
      platform,
      pinnedDevice,
      ...(pinnedDeviceName ? { pinnedDeviceName } : {}),
      ...(pinnedOsVersion ? { pinnedOsVersion } : {}),
      driver,
      bridge,
      metroLogPath,
      prepareMs,
      readinessMs,
      preparedReused,
    },
  };
}

/**
 * Presentation policy for the device's reported mock-network state (exported for
 * tests). A native verify scores screenshots, so the agent MUST know whether
 * those screens were served by the configured fixtures or by the REAL network —
 * otherwise startMockNetwork's silent degradation (a missing polyfill, an
 * msw/native drift) lets it score live-API data (or unreachable-API error
 * states) against fixture criteria. The companion reports its state in the
 * bridge `hello` (`NativeBridgeDeviceInfo.mock`); this renders it:
 *   - active   → a brief ACTIVE confirmation line.
 *   - disabled → a loud DISABLED(reason) warning with a do-not-score directive.
 *   - unknown  → an older companion sent no mock field; note it so the agent can
 *                rebuild if its criteria depend on mocked data (never a false
 *                "disabled" claim).
 */
export function nativeMockStatusBlock(info: NativeBridgeDeviceInfo | null): string {
  const mock = info?.mock;
  if (!mock) {
    return (
      'MOCK_NETWORK: UNKNOWN — the companion did not report its network-mock state ' +
      '(older build). If any criterion depends on mocked/fixture data, rebuild the ' +
      'companion with `validity browse --native` so this is reported, then re-verify.'
    );
  }
  if (mock.active) {
    return 'MOCK_NETWORK: ACTIVE — screens were served by your .validity mockNetwork handlers / scenario fixtures.';
  }
  return (
    `MOCK_NETWORK: DISABLED (${mock.reason ?? 'reason not reported'}) — network mocking did NOT ` +
    'initialize on the device, so the screens talked to the REAL network. Do NOT score any ' +
    'network-dependent criterion as if fixtures applied: a fixture-backed screen may show real ' +
    'data, empty states, or error states from unreachable APIs. Fix the mock setup (re-check the ' +
    '`msw`/polyfill dev deps and `.validity/config.ts` mockNetwork), then re-verify.'
  );
}

/**
 * One native verify target: a component rendered under EITHER one scenario OR one
 * named fixture (mutually exclusive) — see selectNativeVerifyTargets.
 */
export interface NativeVerifyTarget {
  /** Absolute path of the component file. */
  abs: string;
  /** Project-relative path (the native registry / spec key). */
  rel: string;
  /** Stable component id (shared with the web isolation path via componentIdFor). */
  id: string;
  /** Scenario this target renders under; undefined = base/fixture. */
  scenarioId?: string;
  /** Fixture name this target renders under; undefined = no fixture. Mutually exclusive with scenarioId. */
  fixtureId?: string;
  /**
   * Resolved fixture props (config.components[rel].fixtures[fixtureId].props),
   * shipped INLINE as bridge `overrides` — the native device only applies
   * overrides (it never sees fixture config), exactly like native_browse.
   */
  props?: Record<string, unknown>;
  /** Color scheme (theme) this target renders under; undefined = default. */
  colorScheme?: 'light' | 'dark';
}

/** Minimal shape of `config.components` selectNativeVerifyTargets reads (fixtures' props). */
type VerifyFixturesConfig = Record<
  string,
  { fixtures?: Record<string, { props?: Record<string, unknown> }> }
>;

/**
 * Fan the selected components into a flat, device-serial render list, then CAP it
 * (truncating, never silently dropping). Native drives one device serially, so the
 * budget is MAX_NATIVE_RENDER_TARGETS — a quarter of web's parallel MAX_RENDER_PAIRS.
 *
 * A component that has configured fixtures renders ONCE PER NAMED FIXTURE (with
 * that fixture's props), NOT across scenarios — the "fixtures replace scenario
 * fanout" half of web's prepareVerification rule. This turns a content component
 * that would otherwise mount bare (no props → blank) into its populated states.
 * Config-only (no inferFixtures), to match web verify exactly.
 *
 * Deliberate divergence from web: web STACKS 2+ play-less fixtures into one
 * side-by-side screenshot (stackedFixtureIds); native renders one fixture per
 * device navigation instead (no stacking). The serial device has a tighter budget
 * (MAX_NATIVE_RENDER_TARGETS = ¼ of web's) and one-component-per-nav model, and a
 * per-fixture screenshot scores more cleanly than a cramped stacked frame.
 * Exported for tests.
 */
export function selectNativeVerifyTargets(
  componentPaths: string[],
  scenarios: string[],
  projectRoot: string,
  components?: VerifyFixturesConfig,
): { targets: NativeVerifyTarget[]; truncated: number; warnings: string[] } {
  const scenarioIds: Array<string | undefined> = scenarios.length === 0 ? [undefined] : scenarios;
  const all: NativeVerifyTarget[] = [];
  const warnings: string[] = [];
  for (const abs of componentPaths) {
    const rel = abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
    const id = componentIdFor(abs, projectRoot);
    const fixtures = (components?.[rel] ?? components?.[abs])?.fixtures;
    const fixtureNames = fixtures ? Object.keys(fixtures) : [];
    if (fixtureNames.length > 0) {
      if (scenarios.length > 0) {
        warnings.push(fixtureScenarioPrecedenceWarning(id, scenarios));
      }
      for (const fixtureId of fixtureNames) {
        all.push({ abs, rel, id, fixtureId, props: fixtures![fixtureId]?.props ?? {} });
      }
      continue;
    }
    for (const scenarioId of scenarioIds) all.push({ abs, rel, id, scenarioId });
  }
  const targets = all.slice(0, MAX_NATIVE_RENDER_TARGETS);
  return { targets, truncated: all.length - targets.length, warnings };
}

/**
 * Native playground (goal #6): mount ONE component/screen in isolation on a
 * booted iOS Simulator / Android Emulator via agent-device, and return the
 * screenshot + accessibility snapshot. Same call serves BOTH:
 *   - "show me my Button in the simulator" (look at the screenshot), and
 *   - "build this feature and validate it works" (score the screenshot +
 *     a11y tree against the plan — the native analog of validity__verify).
 *
 * The playground harness applies the SAME mocked network/nav/auth as web.
 * Requires a booted device + the Validity playground dev build installed; on
 * failure we return actionable setup guidance rather than a bare error.
 */
async function handleNativeBrowse(args: NativeBrowseArgs): Promise<ServerResult> {
  // `component` and `view` are mutually exclusive — the same split web's
  // browse_navigate uses. `view` is a DEDICATED arg now (it used to be smuggled
  // through `component`), so a name that matches both a component path and a
  // view is no longer ambiguous: the caller states which they meant.
  const hasComponent = typeof args.component === 'string' && args.component.length > 0;
  const hasView = typeof args.view === 'string' && args.view.length > 0;
  if (hasComponent && hasView) {
    throw new Error(
      'validity__native_browse takes either `component` or `view`, not both — pass one.',
    );
  }
  if (!hasComponent && !hasView) {
    throw new Error('validity__native_browse requires a `component` (name or path) or a `view`.');
  }
  const wantView = hasView;
  const rawName = (wantView ? args.view : args.component) as string;

  // ONE warm session (prepare + device pin + readiness + Metro + bridge), shared
  // VERBATIM with the native verify path. An unmet prerequisite (not native, >1
  // booted device, readiness gate, Metro down / ownership-unconfirmed) returns
  // its own checklist/error ServerResult from here.
  const setup = await setupNativeSession(args, {
    targetLabel: wantView ? `view "${rawName}"` : `"${rawName}"`,
  });
  if (!setup.ok) return setup.result;
  const {
    projectRoot,
    config,
    app,
    catalog,
    platform,
    pinnedDevice,
    driver,
    bridge,
    metroLogPath,
    prepareMs,
    readinessMs,
    preparedReused,
  } = setup.session;

  // Resolve the casual name to a concrete path (no silent guess).
  const resolved = resolveName(rawName, catalog);
  if (resolved.matches.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No ${wantView ? 'view' : 'component'} matched "${rawName}". Run validity__catalog to list the library.`,
        },
      ],
    };
  }
  if (!resolved.best) {
    const lines = [`"${rawName}" is ambiguous — ask the user which one:`];
    for (const m of resolved.matches.slice(0, 5)) lines.push(`  • ${m.path} (${m.kind})`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  const componentPath = resolved.best.path;

  // Enforce the arg the caller chose against what the name actually resolved to,
  // so the dedicated split is honest: `view` must land on a view; `component`
  // must NOT (point them at `view` instead of silently mounting a composition).
  const resolvedIsView = resolved.best.kind === 'view';
  if (wantView && !resolvedIsView) {
    return {
      content: [
        {
          type: 'text',
          text: `"${rawName}" resolved to a ${resolved.best.kind} (${componentPath}), not a view. Pass it as \`component\` instead of \`view\`.`,
        },
      ],
    };
  }
  if (!wantView && resolvedIsView) {
    return {
      content: [
        {
          type: 'text',
          text: `"${rawName}" is a view (${componentPath}), not a component/screen. Pass it as \`view\` instead of \`component\`.`,
        },
      ],
    };
  }

  // A view (composition) mounts via ?view=; a component/screen via ?component=.
  const isView = resolvedIsView;
  // Resolve the view's items HOST-SIDE and ship them inline (bridge + deep-link)
  // so a newly-created/edited view renders without a native rebuild — the view
  // no longer has to be baked into the running bundle.
  let viewItems: ReturnType<typeof resolveNativeViewItems> | undefined;
  if (isView) {
    const registered = new Set(app.prepared.registeredComponents);
    viewItems = resolveNativeViewItems(
      config.views?.[componentPath],
      registered,
      config.components ?? {},
    );
    // Fail LOUD instead of driving the device to a blank splash: a view whose
    // components aren't registered means those components are new (a real
    // rebuild), not that the view itself is broken.
    if (viewItems.length === 0) {
      const refs = (config.views?.[componentPath]?.items ?? []).map((i) => i.componentPath);
      return {
        content: [
          {
            type: 'text',
            text:
              `View "${componentPath}" is in .validity/config.ts but none of its components are ` +
              `in the native registry, so it can't render` +
              (refs.length ? ` (it references: ${refs.join(', ')}).` : '.') +
              `\nThose components were likely added after the companion was last built — run ` +
              `\`validity browse --native\` to rebuild the registry, then retry native_browse.`,
          },
        ],
      };
    }
  }
  // Component targets: resolve fixture props HOST-SIDE (the device never sees
  // fixture config — ComponentScreen only applies `overrides`), and default to
  // a GALLERY when the component has multiple fixtures/variants: every fixture
  // ships as an inline view item, so one scrollable frame shows all variants
  // (goal #5). Screens keep rendering as a single full view; explicit
  // `fixture` or `propOverrides` opt out to a single render.
  let overrides = args.propOverrides ?? undefined;
  let galleryView: string | undefined;
  if (!isView) {
    let fixtureMap: Record<string, { description?: string; props?: Record<string, unknown> }> =
      config.components?.[componentPath]?.fixtures ?? {};
    if (Object.keys(fixtureMap).length === 0) {
      try {
        fixtureMap = inferFixtures(resolve(projectRoot, componentPath))?.fixtures ?? {};
      } catch {
        fixtureMap = {};
      }
    }
    if (args.fixture) {
      const fx = fixtureMap[args.fixture];
      if (fx) overrides = { ...stripProxySentinels(fx.props ?? {}), ...(args.propOverrides ?? {}) };
    } else if (args.propOverrides == null) {
      const names = Object.keys(fixtureMap);
      if (resolved.best.kind === 'component' && names.length >= 2) {
        const base = componentPath
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, '');
        galleryView = `${base} variants`;
        viewItems = names.map((name) => ({
          path: componentPath,
          label: name,
          props: stripProxySentinels(fixtureMap[name]?.props ?? {}),
        }));
      } else if (names.length === 1) {
        overrides = stripProxySentinels(fixtureMap[names[0]!]?.props ?? {});
      }
    }
  }
  // Resolve the scenario seed + mock-network config HOST-SIDE from the prepared
  // data payload and ship them INLINE over the bridge (see TargetSpec) so a
  // scenario or mock-handler edit re-targets a warm device as DATA — no Metro
  // --clear restart, no contentHash flip. The same payload backs the device's
  // boot fetch (setNativeData below) for the cold/deep-link path.
  const spec = {
    component: isView || galleryView ? undefined : componentPath,
    view: isView ? componentPath : galleryView,
    viewItems,
    fixture: args.fixture,
    scenario: args.scenario,
    scenarioSeed: args.scenario ? app.prepared.dataPayload.scenarios[args.scenario] : undefined,
    mockNetwork: app.prepared.dataPayload.mockNetwork,
    overrides: galleryView ? undefined : overrides,
  };

  const shotDir = resolve(app.appDir, 'shots');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(shotDir, { recursive: true });
  } catch {
    /* best effort */
  }
  const screenshotPath = resolve(shotDir, `${componentPath.replace(/[^\w.-]+/g, '_')}.png`);

  // Force a fresh bundle ONLY when the agent explicitly asked (reload: true).
  // Staleness is otherwise caught AUTHORITATIVELY inside captureNative: the
  // device's hello announces the contentHash it bundled with, and a mismatch
  // against `expectedContentHash` upgrades the open to a cheap in-place bridge
  // reload (not a terminate + cold-launch ladder).
  const forceReload = args.reload === true;

  // Cold opens gate on OBSERVED bundle readiness (Metro's "Bundled" log line)
  // instead of a fixed sleep. The offset is captured NOW so only output from
  // THIS open's bundle request can satisfy the wait.
  const metroLogOffset = metroLogLength(metroLogPath);

  try {
    const cap = await captureNative({
      driver,
      spec,
      screenshotPath,
      bridge,
      forceReload,
      bundleId: app.bundleId,
      // `adb reverse` is set up once per pinned-device session (Android only —
      // an iOS no-op); skip re-forwarding the Metro/bridge ports on every call.
      // A failed capture nukes the cache, so a forward that genuinely dropped is
      // re-asserted on the retry.
      // Per-capture session metrics + failure diagnosis (best-effort, additive).
      projectRoot,
      androidReverseAsserted: !nativeSessionCache.needsAdbReverse(projectRoot, pinnedDevice),
      // Stale-bundle guard: the companion's hello announces the contentHash it
      // bundled with; a mismatch against this fresh hash upgrades the open to
      // the forceReload path even when the heuristic above didn't fire. MUST be
      // the PREPARED hash (prepareNative's own — the value baked into
      // validity-content-hash.ts), not app.contentHash, which re-hashes
      // prepared + app-shell bodies and therefore NEVER equals what the device
      // reports: comparing against it would read every fresh bundle as stale
      // and terminate every warm session.
      expectedContentHash: app.prepared.contentHash,
      waitForBundle: () =>
        waitForBundleServed({ logPath: metroLogPath, sinceOffset: metroLogOffset }),
    });

    // Cache hygiene: a clean (confirmed) capture proves the warm session — keep
    // the device facts and mark adb-reverse done. Anything else (failed /
    // unconfirmed) re-derives from scratch next call (the cheap safety net).
    if (cap.render.status === 'confirmed') {
      nativeSessionCache.markAdbReversed(projectRoot, pinnedDevice);
    } else {
      nativeSessionCache.invalidate(projectRoot);
    }

    // Structured timing breakdown (debug): prepare, readiness, navigate-to-ack
    // (cap.timing.openMs), and screenshot — so a future pre-screenshot slowdown
    // is visible instead of folding into one opaque round-trip number. The
    // `reused` flags show whether the warm cache hit (zero device spawns).
    const timingMeta = {
      timing: {
        prepareMs,
        readinessMs,
        navigateToAckMs: cap.timing.openMs,
        screenshotMs: cap.timing.screenshotMs ?? 0,
        snapshotMs: cap.timing.snapshotMs ?? 0,
        preparedReused,
      },
    };

    // Authoritative render status: a device {ok:false} ack or a fall-through
    // settle is no longer presented as a successful open — the agent gets a
    // machine-readable header + the concrete next action instead of confident
    // wrong evidence (stale frame / placeholder / launcher screenshot).
    const statusBlock = nativeRenderStatusBlock(cap.render, cap.diagnosis);
    // Identity cross-check: the bridge socket's hello vs the device this call
    // pinned and screenshotted. A mismatch means the ack and the screenshot
    // may come from DIFFERENT devices — surfaced as a warning, never silent.
    const mismatch = deviceMismatchWarning(bridge.deviceInfo(), platform, pinnedDevice);
    if (cap.render.status === 'failed') {
      return {
        _meta: timingMeta,
        content: [
          {
            type: 'text',
            text:
              `${statusBlock.header}\n\n` +
              (mismatch ? `${mismatch}\n\n` : '') +
              `Target: ${componentPath} (${platform}${pinnedDevice ? `, device ${pinnedDevice}` : ''})\n` +
              `Deep link: ${cap.url}\n` +
              `(A screenshot of the device's current screen was written to ${cap.screenshotPath} for debugging — it is not evidence of the target.)`,
          },
        ],
      };
    }

    // testID hint (A3): the a11y snapshot carries no testID channel, so scan
    // the resolved component/screen source (entry file only — a view has no
    // backing source) and name the stable testIDs so the agent can set
    // `selector.testId`. Best effort: a missing/unreadable file omits the line.
    let testIdHint: string | undefined;
    if (resolved.best.kind !== 'view') {
      try {
        testIdHint = testIdSourceHint(readFileSync(resolve(projectRoot, componentPath), 'utf-8'));
      } catch {
        /* source unavailable — omit the hint */
      }
    }

    const content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    > = [
      {
        type: 'text',
        text:
          (statusBlock.header ? `${statusBlock.header}\n\n` : '') +
          (mismatch ? `${mismatch}\n\n` : '') +
          (galleryView
            ? `Opened ${componentPath} as a variants gallery (${viewItems!.length} fixtures, one scrollable frame) in the ${platform} simulator (isolated, mocked).\n`
            : `Opened ${componentPath} in the ${platform} simulator (isolated, mocked).\n`) +
          `Deep link: ${cap.url}\n` +
          (pinnedDevice ? `Device: ${pinnedDevice}\n` : '') +
          `Render: ${cap.render.status} (${cap.render.via}${cap.render.token ? `, token ${cap.render.token}` : ''})\n` +
          `Timing: prepare ${prepareMs}ms${preparedReused ? ' (cached)' : ''}, readiness ${readinessMs}ms, navigate→ack ${cap.timing.openMs}ms, screenshot ${cap.timing.screenshotMs ?? 0}ms\n` +
          (cap.a11ySnapshot
            ? `\nAccessibility snapshot (score against this + the screenshot):\n${cap.a11ySnapshot}`
            : '\n(No accessibility snapshot — screenshot is the evidence.)') +
          (testIdHint ? `\n\n${testIdHint}` : ''),
      },
    ];
    try {
      const png = readFileSync(cap.screenshotPath);
      content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    } catch {
      content.push({ type: 'text', text: `(screenshot written to ${cap.screenshotPath})` });
    }
    return { _meta: timingMeta, content };
  } catch (err) {
    // A thrown capture is NOT a clean success — drop the warm cache so the next
    // call re-derives device facts from scratch (the cheap safety net).
    nativeSessionCache.invalidate(projectRoot);
    // The bridge port is held and delegation is impossible — machine-readable,
    // never silently degraded to the deep-link ladder (see bridgePortHeldBlock).
    if (err instanceof BridgePortHeldError) {
      return { content: [{ type: 'text', text: bridgePortHeldBlock(err) }] };
    }
    // App is installed but the deep link / capture failed (device asleep,
    // agent-device missing, scheme mismatch). Return the exact retry command.
    const cmd = driver.openTargetCommand(spec);
    return {
      content: [
        {
          type: 'text',
          text:
            `Could not drive the ${platform} device: ${(err as Error).message}\n\n` +
            `The Validity app is installed; check that the device is awake, \`agent-device\` is ` +
            `on PATH (npm i -g agent-device), and the scheme "${app.scheme}" matches the app.\n` +
            `Manual open command: ${cmd.bin} ${cmd.args.join(' ')}`,
        },
      ],
    };
  }
}

/**
 * A spec's hard/property checks had NO eligible render to bind to, so nothing
 * mechanical ran. Names both sides of the mismatch — the spec's target keys and
 * the components actually rendered — because the alternative is a run where
 * every hard criterion reads "checks did not execute" with no cause attached.
 * Exported for tests.
 */
export function unattachedNativeChecksWarning(
  criteriaCount: number,
  specTargetKeys: Set<string>,
  targets: NativeVerifyTarget[],
): string {
  const rendered = [...new Set(targets.map((t) => t.rel))];
  const renderedList = rendered.length > 0 ? rendered.join(', ') : '(nothing rendered)';
  const keys = [...specTargetKeys];
  const targetList = keys.length > 0 ? keys.join(', ') : '(no spec targets)';
  return (
    `${criteriaCount} hard/property criteria executed NO checks on the device: the spec's target ` +
    `components [${targetList}] matched none of the rendered components [${renderedList}]. ` +
    `Those criteria are reported unverifiable, not passed. Re-check the spec's ` +
    `targets.components against the component paths above, then re-verify.`
  );
}

/**
 * Injectable collaborators for {@link renderNativeTargets}. Production passes
 * nothing and gets the real `captureNative` / `diagnoseNativeEnvironment`;
 * a loop-level test passes fakes so the multi-target contract (a mid-loop
 * failure names its cause AND the remaining targets still render) can be
 * exercised without a simulator, an emulator or a network. Same seam
 * `captureNative` itself already offers for `diagnose`.
 */
export interface NativeRenderLoopDeps {
  capture?: typeof captureNative;
  diagnose?: typeof diagnoseNativeEnvironment;
}

/** Everything the per-target render loop reads out of the warm native session. */
export interface NativeRenderLoopInput {
  targets: NativeVerifyTarget[];
  projectRoot: string;
  screenshotsDir: string;
  app: NativeSession['app'];
  driver: NativeSession['driver'];
  bridge: NativeSession['bridge'];
  platform: 'ios' | 'android';
  pinnedDevice?: string;
  metroLogPath: string;
  /** `args.reload` — a forced fresh bundle, applied on the FIRST target only. */
  reload?: boolean;
  /**
   * Spec hard/property criteria, executed on the device against the target's
   * base render — or, when the target has none (fixtures/scenarios), against
   * every eligible variant. See the binding block in {@link renderNativeTargets}.
   */
  checkCriteria?: SpecCriterion[];
  /** Spec target component keys (baseNameNoExtLower); empty = no spec targets. */
  specTargetKeys?: Set<string>;
  deps?: NativeRenderLoopDeps;
}

/** What the loop hands back to handleVerifyNative. */
export interface NativeRenderLoopResult {
  renders: ComponentRender[];
  /** Component source by component id, read once per component. */
  sources: Record<string, string>;
  /** True once ANY target's render was confirmed by the device. */
  anyConfirmed: boolean;
  /** FIRST named cause across this run's captures; undefined on a healthy run. */
  firstDiagnosis?: EnvironmentDiagnosis;
  /** Set (and the loop broken) when the bridge port is unusable session-wide. */
  portHeld: BridgePortHeldError | null;
  /** Run warnings raised by the loop itself (checks with no render to bind to). */
  warnings: string[];
}

/**
 * The multi-target render loop: ONE warm session re-targeted N times
 * (component × fixture/scenario × color-scheme), serially, on one device.
 *
 * Extracted from {@link handleVerifyNative} VERBATIM — the only change is that
 * `captureNative` and `diagnoseNativeEnvironment` arrive through
 * {@link NativeRenderLoopDeps} instead of being called directly, so the loop's
 * two load-bearing guarantees are testable:
 *
 *   1. a capture that throws for ONE target is diagnosed (its message fed back
 *      in as `openErrorText`), recorded as that target's `renderError`, and
 *      the loop CONTINUES — one unreachable target never voids the others'
 *      evidence, and it never exits the process (the old native-gate
 *      `exit(1)` that masked web specs must stay dead);
 *   2. `firstDiagnosis` is FIRST-wins across every failing target, so a loop
 *      driver gets one thing to fix rather than a per-target chorus.
 *
 * A `BridgePortHeldError` is the one exception: the bridge is unusable for the
 * whole session, so it stops the loop instead of being recorded per target.
 */
export async function renderNativeTargets(
  input: NativeRenderLoopInput,
): Promise<NativeRenderLoopResult> {
  const {
    targets,
    projectRoot,
    screenshotsDir,
    app,
    driver,
    bridge,
    platform,
    pinnedDevice,
    metroLogPath,
    reload,
  } = input;
  const checkCriteria = input.checkCriteria ?? [];
  const specTargetKeys = input.specTargetKeys ?? new Set<string>();
  const capture = input.deps?.capture ?? captureNative;
  const diagnose = input.deps?.diagnose ?? diagnoseNativeEnvironment;

  const renders: ComponentRender[] = [];
  const sources: Record<string, string> = {};
  // Guards against two variants of the same component (e.g. fixture names that
  // slugify identically) clobbering one screenshot file → silent data loss.
  const usedScreenshotKeys = new Set<string>();
  let anyConfirmed = false;
  let portHeld: BridgePortHeldError | null = null;
  // FIRST named cause seen across this run's captures. First, not last: the
  // probes already resolve to one cause per capture, and later targets in a
  // broken session just restate it — a loop driver needs one thing to fix, not
  // a per-target chorus. Stays undefined on a healthy run.
  let firstDiagnosis: EnvironmentDiagnosis | undefined;
  const warnings: string[] = [];
  // Which renders carry the spec's hard/property checks (executed on the device
  // by captureNative). Eligible = matches a spec target component; no spec
  // targets ⇒ every target is eligible.
  //
  //   - an eligible BASE render (no scenario AND no fixture) exists: bind to
  //     base renders ONE at a time. The latch closes only on a capture that
  //     actually returned verdicts, so an unconfirmed first base render defers
  //     to the next base candidate — the colorScheme axis fans one base target
  //     into several, and the first one is not guaranteed to render.
  //   - no base render exists (a fixtures- or scenario-driven component — every
  //     target carries a fixtureId/scenarioId): bind to EVERY eligible render.
  //     Single-latching here attached the checks to NOTHING, so every
  //     hard/property criterion fell to the "checks did not execute"
  //     placeholder — zero mechanical verification exactly where fixtures drive
  //     the component. `collectVerdictsFromComponents` merges the per-variant
  //     verdicts fail-wins, so a check still gates. Same fallback web's
  //     prepareVerification takes (run.ts, `bound = renderRequests.filter(…)`).
  const isEligible = (t: NativeVerifyTarget): boolean =>
    specTargetKeys.size === 0 || specTargetKeys.has(baseNameNoExtLower(t.rel));
  const eligible = targets.filter(isEligible);
  const hasBaseTarget = eligible.some((t) => !t.scenarioId && !t.fixtureId);
  // Checks with nowhere to run is the silent failure this whole binding exists
  // to prevent — name the mismatch instead of shipping a run of "did not
  // execute" placeholders with no cause attached.
  if (checkCriteria.length > 0 && eligible.length === 0) {
    warnings.push(unattachedNativeChecksWarning(checkCriteria.length, specTargetKeys, targets));
  }
  let checksAttached = false;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const isCheckTarget =
      checkCriteria.length > 0 &&
      isEligible(t) &&
      (hasBaseTarget ? !checksAttached && !t.scenarioId && !t.fixtureId : true);
    if (sources[t.id] === undefined) {
      try {
        sources[t.id] = readFileSync(t.abs, 'utf-8');
      } catch {
        sources[t.id] = '';
      }
    }
    // Variant slug mirrors web's renderVariantSlug ({scenario}__{fixture} | one |
    // 'base') so each fixture/scenario of a component gets a distinct screenshot.
    const baseVariantSlug =
      t.scenarioId && t.fixtureId
        ? `${slugifyForId(t.scenarioId)}__${slugifyForId(t.fixtureId)}`
        : t.fixtureId
          ? slugifyForId(t.fixtureId)
          : t.scenarioId
            ? slugifyForId(t.scenarioId)
            : 'base';
    // Theme segment last, only when the color-scheme axis is active — so
    // single-theme renders keep their existing screenshot keys + baselines.
    const variantSlug = t.colorScheme
      ? `${baseVariantSlug}__${slugifyForId(t.colorScheme)}`
      : baseVariantSlug;
    // De-dup so two variants whose slugs collapse to the same slug don't
    // overwrite each other's PNG (silent data loss).
    let screenshotKey = `${t.id}__${variantSlug}`;
    for (let n = 2; usedScreenshotKeys.has(screenshotKey); n++) {
      screenshotKey = `${t.id}__${variantSlug}-${n}`;
    }
    usedScreenshotKeys.add(screenshotKey);
    const screenshotPath = resolve(screenshotsDir, `${screenshotKey}.png`);
    // Scenario seed + mock travel INLINE over the bridge navigate (data, not a
    // rebuild) — same mechanism native_browse uses. Fixture props are resolved
    // HOST-SIDE (the device only applies `overrides`; fixtures aren't in the data
    // payload) and shipped inline — identical to native_browse's component path.
    const spec = {
      component: t.rel,
      fixture: t.fixtureId,
      overrides:
        t.props && Object.keys(t.props).length > 0 ? stripProxySentinels(t.props) : undefined,
      scenario: t.scenarioId,
      scenarioSeed: t.scenarioId ? app.prepared.dataPayload.scenarios[t.scenarioId] : undefined,
      mockNetwork: app.prepared.dataPayload.mockNetwork,
      // Force the device theme for this target (color-scheme axis).
      colorScheme: t.colorScheme,
    };
    try {
      const cap = await capture({
        driver,
        spec,
        screenshotPath,
        bridge,
        // A forced fresh bundle only matters once per session — apply it on the
        // FIRST target; the rest ride the warm bundle (the hello contentHash
        // guard still catches genuine per-target staleness).
        forceReload: reload === true && i === 0,
        bundleId: app.bundleId,
        // Per-capture session metrics + failure diagnosis (best-effort, additive).
        projectRoot,
        androidReverseAsserted: !nativeSessionCache.needsAdbReverse(projectRoot, pinnedDevice),
        expectedContentHash: app.prepared.contentHash,
        waitForBundle: () =>
          waitForBundleServed({ logPath: metroLogPath, sinceOffset: metroLogLength(metroLogPath) }),
        // Run the spec's hard/property checks on the device for this render
        // (after a confirmed render, before the screenshot).
        criteriaChecks: isCheckTarget ? checkCriteria : undefined,
      });
      // Latch only matters in the base-render mode; under multi-attach every
      // eligible render carries the checks regardless.
      if (isCheckTarget && cap.criterionVerdicts) checksAttached = true;
      const confirmed = cap.render.status === 'confirmed';
      if (confirmed) {
        anyConfirmed = true;
        nativeSessionCache.markAdbReversed(projectRoot, pinnedDevice);
      }
      if (!confirmed && cap.diagnosis && !firstDiagnosis) firstDiagnosis = cap.diagnosis;
      // Map the structured render status onto the report's `renderError` field
      // (the native analog of web's 'render error:'): anything not CONFIRMED is
      // NOT evidence — the report shows the status block, never the screenshot,
      // so a deliberately-broken component yields a render error, not a scored
      // image.
      const statusBlock = nativeRenderStatusBlock(cap.render, cap.diagnosis);
      // Pixel-diff vs. the last passing run. Native uses a STRICTER gate than
      // web: web's render.ts confirms a baseline on any clean (`!renderError`)
      // render, whereas native only touches baselines for a CONFIRMED render —
      // a non-evidence status-block shot must never become the baseline. The
      // diff is computed BEFORE seeding (so it's against the prior snapshot),
      // and its mismatchedPixels upgrades any `expect.screenshot` stub on this
      // render's verdicts to a real pass/fail (parity with web's capture.ts).
      //
      // GATE INTEGRITY: we seed with `confirmBaseline` (write-IF-MISSING), NOT
      // the unconditional `promoteBaseline`. With an unconditional overwrite a
      // real UI regression would fail exactly ONE run, then that regressed
      // screenshot would become the new baseline and every later run would pass
      // — the gate would self-heal. A stable baseline keeps a regression
      // failing every run. Native has no `validity accept`, so an INTENTIONAL
      // change is re-baselined by deleting
      // `.validity/baselines/<componentId>__<variantSlug>.png`. Both baseline
      // calls are best-effort and never throw. No git SHA in the native path
      // yet, so the baseline block omits `sha` — the diff PNG + pixel count is
      // the evidence the native report previously lacked entirely.
      let baselineMeta:
        { sha?: string; takenAt: string; diffPath: string; mismatchedPixels: number } | undefined;
      if (confirmed) {
        const diff = diffAgainstBaseline({
          projectRoot,
          componentId: t.id,
          variantSlug,
          newScreenshotPath: cap.screenshotPath,
          screenshotsDir,
        });
        if (diff) {
          baselineMeta = {
            takenAt: diff.takenAt,
            diffPath: diff.diffPath,
            mismatchedPixels: diff.mismatchedPixels,
          };
          // Upgrade expect.screenshot stubs on this render's verdicts BEFORE
          // renders.push, so the rolled-up criterionVerdicts (same object
          // references) reflect the pass/fail. Gated on `if (diff)` — when no
          // baseline exists the stub stays unverifiable (never a false-green).
          applyNativeScreenshotDiff(cap.criterionVerdicts, diff);
        }
        confirmBaseline({
          projectRoot,
          componentId: t.id,
          variantSlug,
          screenshotPath: cap.screenshotPath,
        });
      }
      renders.push({
        id: t.id,
        filePath: t.rel,
        screenshotPath: cap.screenshotPath,
        scenarioId: t.scenarioId,
        fixtureId: t.fixtureId,
        renderError: confirmed ? undefined : statusBlock.header,
        // Structured confirmation flag (A3) — `unconfirmed` means the
        // screenshot is not evidence (the `renderError` header carries why).
        renderConfirmation: confirmed ? 'confirmed' : 'unconfirmed',
        a11ySnapshot: cap.a11ySnapshot || undefined,
        // Un-mocked URLs the device's permissive catch-all answered — surfaced
        // below (and persisted to run-meta) like web's unmatched-fetch block.
        unmatchedUrls: cap.render.unmatchedUrls,
        // On-device render timing the companion measured (NativePerf field names
        // line up 1:1 with PerformanceMetrics) — surfaced OBSERVATIONALLY in the
        // report's per-render Performance panel via renderPerformanceBlock,
        // exactly like web's `performance`. Undefined on old companions / a
        // non-confirmed render (the marker/settle fallbacks carry no ack perf).
        performance: cap.render.perf,
        // Pixel-diff vs. the prior baseline (parity with web). Undefined on the
        // first run / a freshly-added variant (nothing to diff against yet).
        baseline: baselineMeta,
        // Mechanical hard/property verdicts executed on the device for this
        // render (spec verify only). Rolled up into run-meta below.
        criterionVerdicts: cap.criterionVerdicts,
        // Pristine pre-interaction shot (present only when click/fill checks
        // mutated this render's screen) — companion evidence for initial-state
        // soft criteria; the evidence shot stays post-interaction (web parity).
        preInteractionScreenshotPath: cap.preInteractionScreenshotPath,
      });
    } catch (err) {
      if (err instanceof BridgePortHeldError) {
        // The bridge is unusable for the whole session — stop and surface it.
        portHeld = err;
        break;
      }
      // A driver/capture throw for THIS target → record it as a render error and
      // keep going; one unreachable target shouldn't void the others' evidence.
      // Diagnose it too (mirrors native-verify-engine.ts's single-target catch):
      // the thrown text goes in as `openErrorText` so the phantom-claim / stale-
      // open signatures can be recognized. Without this, a later target that DID
      // confirm would gate off the run-level diagnosis below (it only runs when
      // `!anyConfirmed`) and this target would ship with zero cause attached —
      // `diagnoseNativeEnvironment` never throws, but `.catch` stays as a second
      // line of defense against a future probe regressing that guarantee.
      const message = (err as Error).message;
      const diagnosis = await diagnose({
        projectRoot,
        platform,
        openErrorText: message,
        renderStatus: 'failed',
      }).catch(() => undefined);
      if (diagnosis && !firstDiagnosis) firstDiagnosis = diagnosis;
      const cause = diagnosis
        ? `\nLIKELY CAUSE (${diagnosis.confidence}, ${diagnosis.cause}): ${diagnosis.symptom}\n${diagnosis.detail}` +
          (diagnosis.fixCommand ? `\nFix:\n${diagnosis.fixCommand}` : '')
        : '';
      renders.push({
        id: t.id,
        filePath: t.rel,
        screenshotPath,
        scenarioId: t.scenarioId,
        fixtureId: t.fixtureId,
        renderError: `RENDER_FAILED: ${message}${cause}`,
        renderConfirmation: 'unconfirmed',
      });
    }
  }

  return { renders, sources, anyConfirmed, firstDiagnosis, portHeld, warnings };
}

/**
 * Native verify: the SAME plan -> verify -> submit_report contract web has, but
 * the evidence is captured on a booted simulator/emulator instead of the Vite
 * sandbox. Reached from handleVerify when `native: true`.
 *
 * Shape parity with handleVerifyIsolation, with native-specific mechanics:
 *   - targets are selected the SAME way (changedFiles → git diff → prompt),
 *     fanned across scenarios, then CAPPED for the serial device
 *     (MAX_NATIVE_RENDER_TARGETS; truncation is reported, never silent);
 *   - ONE warm session (setupNativeSession: one prepare, one readiness pass, one
 *     Metro check, one bridge) is then re-targeted N times — each iteration is a
 *     cheap navigate + two-rAF ack + screenshot, amortizing step 9's caching;
 *   - run-meta is written in the isolation shape so submit_report works
 *     UNMODIFIED, with step 1's structured render status mapped onto each
 *     render's `renderError` (the native analog of web's 'render error:') and the
 *     agent-device a11y tree on `a11ySnapshot`;
 *   - persisted plan criteria are re-injected via planScopedScoringInstructions
 *     so the agent scores the committed contract;
 *   - the device's reported mock-network state is surfaced (ACTIVE/DISABLED) so
 *     real-network data is never scored against fixture criteria unknowingly.
 */
async function handleVerifyNative(args: ToolArgs, injectedRunId?: string): Promise<ServerResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const plan = resolvePlan(projectRoot, args.planId);
  // When the id is a frozen spec, its hard/property criteria run
  // deterministically ON THE DEVICE (the native analog of the web sandbox):
  // each criterion's `checks` drive the agent-device through the companion,
  // and the mechanical verdicts + provenance thread into run-meta. Soft
  // criteria stay LLM-scored from the screenshot below.
  const frozenSpec = resolveSpec(projectRoot, args.planId);
  // dataState-conditioned criteria are held out of the device run (the forced
  // axis is web-only in v1) — their roll-up resolves `unverifiable` with the
  // honest detail below, never a pass against the wrong (populated) state.
  // Command criteria are excluded too: they execute once per RUN on the host
  // (below, after the device captures), never on the device.
  const checkCriteria = holdNativeDataStateCriteria(
    frozenSpec?.criteria.filter(
      (c) => c.checks && c.checks.length > 0 && !criterionUsesCommandChecks(c),
    ) ?? [],
  );
  const specTargetKeys = new Set(
    (frozenSpec?.targets?.components ?? []).map((t) => baseNameNoExtLower(t)),
  );

  // Bootstrap `.validity/` before loading it — same contract isolation mode
  // has. This matters more now than it did when native was opt-in: React
  // Native projects route here by DEFAULT, so a virgin Expo project's very
  // first verify comes through this path, and without the bootstrap it would
  // die on "no validity config found" instead of just working.
  const ensureResult = await ensureValidityConfigured({ projectRoot });
  if (ensureResult.status === 'manual-required') {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: [
            'Setup needs attention before this verify can run.',
            '',
            ...ensureResult.warnings,
            '',
            'Steps:',
            ...(ensureResult.manualSteps ?? []).map((s) => `  • ${s}`),
          ].join('\n'),
        },
      ],
    };
  }

  const { config } = await loadConfig(projectRoot);

  // Validate requested scenarios up front (mirror web): an unknown name is a
  // clean error, not a silent base render.
  const requestedScenarios = args.scenarios ?? [];
  const availableScenarios = Object.keys(config.scenarios ?? {});
  for (const name of requestedScenarios) {
    if (!availableScenarios.includes(name)) {
      throw new UnknownScenarioError(name, availableScenarios);
    }
  }

  // Select targets the SAME way web isolation does, then fan across scenarios
  // and cap for the serial device.
  const componentPaths = selectComponentsToRender({
    prompt: args.prompt!,
    changedFiles: args.changedFiles,
    projectRoot,
    max: 3,
  });
  if (componentPaths.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            'No React components matched the changed files. Pass `changedFiles` explicitly if you ' +
            'know which files to render, or commit the change so `git diff HEAD` picks it up. ' +
            '(Native verify renders the changed component(s) on the simulator — it does not crawl routes.)',
        },
      ],
    };
  }
  // Spec verify: pull the spec's target component(s) into the rendered set and
  // order them FIRST (mirror the web path's orderTargetsFirst), so the device
  // executes the checks against the right component — not whichever changed
  // file sorted first. Targets may be names or project-relative paths.
  let orderedPaths = componentPaths;
  if (specTargetKeys.size > 0) {
    for (const rel of discoverComponentFiles(projectRoot)) {
      const abs = resolve(projectRoot, rel);
      if (specTargetKeys.has(baseNameNoExtLower(rel)) && !orderedPaths.includes(abs)) {
        orderedPaths = [abs, ...orderedPaths];
      }
    }
    const isTarget = (p: string) => specTargetKeys.has(baseNameNoExtLower(p));
    orderedPaths = [...orderedPaths.filter(isTarget), ...orderedPaths.filter((p) => !isTarget(p))];
  }
  const {
    targets: baseTargets,
    truncated: baseTruncated,
    warnings: fixtureWarnings,
  } = selectNativeVerifyTargets(orderedPaths, requestedScenarios, projectRoot, config.components);

  // Color-scheme (theme) axis — native parity with web's prepareVerification.
  // Multiply each target across the resolved schemes (light/dark) so a "looks
  // right in both themes" criterion has both screenshots. Re-cap at the native
  // budget (one device, serial) and fold any drop into the truncation note.
  const colorSchemes = resolveColorSchemes(config, frozenSpec ?? undefined);
  let targets = baseTargets;
  let truncated = baseTruncated;
  if (colorSchemes.length > 0) {
    const expanded = baseTargets.flatMap((t) =>
      colorSchemes.map((scheme) => ({ ...t, colorScheme: scheme })),
    );
    targets = expanded.slice(0, MAX_NATIVE_RENDER_TARGETS);
    truncated = baseTruncated + (expanded.length - targets.length);
  }

  // ONE warm session, reused for every target.
  const setup = await setupNativeSession(args, { targetLabel: 'your changed component(s)' });
  if (!setup.ok) return setup.result;
  const { app, driver, bridge, platform, pinnedDevice, metroLogPath } = setup.session;
  const { pinnedDeviceName, pinnedOsVersion } = setup.session;

  const runId = injectedRunId ?? newRunId();
  const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);

  const {
    renders,
    sources,
    anyConfirmed,
    firstDiagnosis,
    portHeld,
    warnings: loopWarnings,
  } = await renderNativeTargets({
    targets,
    projectRoot,
    screenshotsDir,
    app,
    driver,
    bridge,
    platform,
    pinnedDevice,
    metroLogPath,
    reload: args.reload,
    checkCriteria,
    specTargetKeys,
  });
  // Same channel as the fixture/scenario precedence warnings — printed in the
  // content block below and republished in structuredContent for loop drivers.
  fixtureWarnings.push(...loopWarnings);

  // Cache hygiene: if nothing confirmed (or the bridge died), re-derive device
  // facts on the next call — same safety net as native_browse.
  if (!anyConfirmed) nativeSessionCache.invalidate(projectRoot);

  if (portHeld) {
    return { content: [{ type: 'text', text: bridgePortHeldBlock(portHeld) }] };
  }

  // Spec verify: roll the device-executed hard/property verdicts up per
  // criterion (soft → unverifiable placeholders), exactly like the web path,
  // then merge in the run-level `expect.command` verdicts (A5) — executed once
  // on the HOST at projectRoot, after the device captures (never concurrently
  // with the emulator), replacing their "did not execute" placeholders.
  const criterionVerdicts = frozenSpec
    ? overlayCommandVerdicts(
        collectVerdictsFromComponents(frozenSpec, renders),
        await executeCommandCriteria({
          criteria: frozenSpec.criteria.filter(criterionUsesCommandChecks),
          commands: config.commands,
          projectRoot,
          timeoutMs: config.commandTimeoutMs,
        }),
      )
    : undefined;

  // Name WHY the held-out dataState criteria are unverifiable (A2) — the
  // generic "did not execute" detail would misdirect the agent toward the
  // rendered set instead of the runtime gap.
  annotateNativeDataStateVerdicts(criterionVerdicts, frozenSpec ?? undefined);

  // UNCONFIRMED-RENDER TAINT (A3): when NO render in this run was confirmed by
  // the device, there is literally no scorable evidence for the soft tier —
  // taint it so a later agent "pass" is clamped to `unverifiable`. When at
  // least one confirmed render exists, the citation floor handles the rest
  // (submit_report only accepts confirmed renders as citations). Hard/property
  // criteria already read "checks did not execute" unverifiable on their own.
  if (criterionVerdicts && !renders.some((r) => !r.renderError)) {
    for (const v of criterionVerdicts) {
      if (v.tier !== 'soft') continue;
      v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'unconfirmed-render');
      const note = 'unconfirmed-render: no confirmed native render this run';
      v.detail = v.detail ? `${v.detail} — tainted: ${note}` : `tainted: ${note}`;
    }
  }

  // SYNTHETIC-DATA PROVENANCE (A3, never demoting) — parity with
  // prepareVerification's web stamp: record when a verdict's evidence render
  // was fed by the device's permissive catch-all (unmatched fetches).
  if (criterionVerdicts) {
    const syntheticFed = renders.filter((r) => (r.unmatchedUrls?.length ?? 0) > 0);
    if (syntheticFed.length > 0) {
      const executedOnSynthetic = new Set<string>();
      for (const r of syntheticFed) {
        for (const v of r.criterionVerdicts ?? []) executedOnSynthetic.add(v.id);
      }
      for (const v of criterionVerdicts) {
        if (v.tier === 'soft' || executedOnSynthetic.has(v.id)) {
          v.evidenceTaints = withEvidenceTaint(v.evidenceTaints, 'synthetic-data');
        }
      }
    }
  }

  // Load the previous run of this spec BEFORE writeNativeRunMeta indexes the
  // current one (parity with the web verify path): feeds the display-only
  // regression deltas, the lean/full detail default, and the previous-run
  // screenshot identity below.
  const prevRun = frozenSpec ? loadPreviousRun(projectRoot, frozenSpec.id) : undefined;
  const previousVerdicts = previousVerdictsOf(prevRun);
  const { detail, autoSelected } = resolveVerifyDetail({
    detail: args.detail,
    lean: args.lean,
    hasSpec: Boolean(frozenSpec),
    // Only a SAME-HASH prior run counts (parity with the web path): the first
    // verify of a re-frozen spec is full, with every soft criterion open.
    hasPriorRun: prevRunMatchesSpec(prevRun?.meta, frozenSpec ?? undefined),
  });

  // Persist run-meta in the isolation shape so submit_report works UNMODIFIED.
  const reportConfig = resolveReportConfig(config.report);
  writeNativeRunMeta({
    projectRoot,
    runId,
    prompt: args.prompt!,
    scenarios: requestedScenarios,
    components: renders,
    componentSources: sources,
    changedFiles: args.changedFiles,
    // Device provenance: which simulator/emulator, which OS, which companion
    // build drew these pixels (parity with the CLI native engine).
    nativeDevice: {
      platform,
      ...(pinnedDevice ? { deviceId: pinnedDevice } : {}),
      ...(pinnedDeviceName ? { deviceName: pinnedDeviceName } : {}),
      ...(pinnedOsVersion ? { osVersion: pinnedOsVersion } : {}),
      ...(app.contentHash ? { buildHash: app.contentHash } : {}),
    },
    reportConfig,
    planId: plan?.planId,
    specId: frozenSpec?.id,
    specVersion: frozenSpec?.version,
    specHash: frozenSpec?.hash,
    criterionVerdicts,
    previousVerdicts,
    sessionFingerprint: SESSION_FINGERPRINT,
    // Coverage floor at verify time (C1) — see the isolation/URL writers.
    coverageFloorPercent: config.coverageFloorPercent,
    // Opt-in committed history (F2) — gates the .validity/history/ twin append.
    historyCommitted: config.historyCommitted,
  });

  // ---- Build the verify response (mirrors handleVerifyIsolation) ----
  const content: Content[] = [];
  const scenarioSummary =
    requestedScenarios.length > 0
      ? `Scenarios: ${requestedScenarios.join(', ')}`
      : 'Scenario: base (no scenario applied)';
  content.push({
    type: 'text',
    text:
      `User prompt:\n${args.prompt}\n\n` +
      `Mode: native (${platform}${pinnedDevice ? `, device ${pinnedDevice}` : ''})\n` +
      `${scenarioSummary}\nRun: ${runId}\n` +
      detailHeaderLine(detail, autoSelected),
  });
  if (fixtureWarnings.length > 0) {
    content.push({ type: 'text', text: fixtureWarnings.map((w) => `⚠ ${w}`).join('\n') });
  }

  // Mock-network state (ACTIVE/DISABLED/UNKNOWN) — so a fixture-backed criterion
  // is never scored against real-network data unknowingly.
  content.push({ type: 'text', text: nativeMockStatusBlock(bridge.deviceInfo()) });

  // Device identity cross-check: the ack and the screenshot must be the same device.
  const mismatch = deviceMismatchWarning(bridge.deviceInfo(), platform, pinnedDevice);
  if (mismatch) content.push({ type: 'text', text: mismatch });

  if (truncated > 0) {
    content.push({
      type: 'text',
      text:
        `Note: ${truncated} additional (component × scenario) target(s) were NOT rendered — native ` +
        `drives one device serially and is capped at ${MAX_NATIVE_RENDER_TARGETS} renders per verify. ` +
        `Narrow \`changedFiles\` / \`scenarios\`, or run another native verify, to cover them.`,
    });
  }

  // Group renders by component id so the source block is emitted once per
  // component (mirrors handleVerifyIsolation's grouping).
  const byComponent = new Map<string, ComponentRender[]>();
  for (const r of renders) {
    const arr = byComponent.get(r.id) ?? [];
    arr.push(r);
    byComponent.set(r.id, arr);
  }

  // LEAN MODE (C3, presentation-only) — identical treatment to the web
  // isolation handler so both runtimes trim the response the same way. See
  // lean-verify.ts.
  const lean = detail === 'lean';
  const prevIndex = lean ? buildPrevRenderIndex(prevRun?.meta, frozenSpec ?? undefined) : undefined;
  const { identity, idsToKeys } = lean
    ? buildRenderIdentity(renders, prevIndex)
    : {
        identity: new Map<string, boolean | 'unknown'>(),
        idsToKeys: new Map<string, string[]>(),
      };
  const partition =
    lean && frozenSpec
      ? partitionSoftCriteria({
          spec: frozenSpec,
          prev: prevIndex,
          identity,
          currentIdsToKeys: idsToKeys,
        })
      : {
          carryForward: [] as CarryForwardSoft[],
          open: (frozenSpec?.criteria ?? []).filter((c) => c.tier === 'soft').map((c) => c.id),
        };
  // A2 × native: a dataState-conditioned SOFT criterion can never be scored —
  // or carried forward — on native: even a byte-identical citation was
  // captured at the WRONG (populated) data state, so a recorded pass from a
  // pre-clamp run must not resurface via lean carry-forward.
  const heldSoftIds = nativeHeldDataStateSoftIds(frozenSpec);
  if (heldSoftIds.size > 0) {
    partition.carryForward = partition.carryForward.filter((c) => !heldSoftIds.has(c.id));
  }
  const anySoftOpen = partition.open.length > 0;
  let leanShown = 0;
  let leanTotal = 0;
  const omittedRenderIds: string[] = [];

  for (const [id, group] of byComponent) {
    const filePath = group[0]?.filePath ?? id;
    content.push({ type: 'text', text: `Component: ${id} (${filePath})` });
    // testID hint (A3): the per-render a11y snapshots below carry no testID
    // channel, so name the stable testIDs this component's source declares once
    // up front — lets the agent set `selector.testId` (durable Maestro `id:`)
    // instead of a brittle `text:` matcher. Source is already in memory.
    const testIdHint = testIdSourceHint(sources[id] ?? '');
    if (testIdHint) content.push({ type: 'text', text: testIdHint });
    for (const r of group) {
      // Fixture-aware variant label (mirrors web's renderLabelFor priority):
      // a fixture render must read "fixture: primary", not "scenario: base".
      const label =
        r.scenarioId && r.fixtureId
          ? `${r.scenarioId} · ${r.fixtureId}`
          : (r.fixtureId ?? r.scenarioId ?? 'base');
      const labelKind = r.fixtureId ? 'fixture' : 'scenario';
      content.push({
        type: 'text',
        text: `— ${labelKind}: ${label}${r.renderError ? `\n${r.renderError}` : ''}`,
      });
      // Lean-mode screenshot decision — count only renders that could have
      // shown an image (no renderError) toward the "X of Y" summary.
      const decision = leanScreenshotDecision({
        detail,
        verdicts: r.criterionVerdicts ?? [],
        identicalToPrev: identity.get(renderKeyFor(r)) ?? 'unknown',
        anySoftOpen,
        specInScope: Boolean(frozenSpec),
      });
      if (!r.renderError) {
        leanTotal += 1;
        if (decision.keep) leanShown += 1;
      }
      if (!r.renderError && decision.keep) {
        // Pre-interaction companion (checks target only): the pristine state
        // BEFORE click/fill checks mutated the screen. Shown first, labeled,
        // so initial-state soft criteria aren't scored against post-click
        // residue; the evidence/baseline shot below stays post-interaction.
        if (r.preInteractionScreenshotPath) {
          try {
            const preData = readFileSync(r.preInteractionScreenshotPath).toString('base64');
            content.push({
              type: 'text',
              text: '  base state (before interaction checks) — score initial-state soft criteria against this:',
            });
            content.push({ type: 'image', data: preData, mimeType: 'image/png' });
            content.push({
              type: 'text',
              text: '  post-interaction end state (the evidence/baseline shot):',
            });
          } catch {
            // best-effort companion — the evidence shot below still rides
          }
        }
        try {
          const data = readFileSync(r.screenshotPath).toString('base64');
          content.push({ type: 'image', data, mimeType: 'image/png' });
        } catch (err) {
          content.push({
            type: 'text',
            text: `Could not read screenshot at ${r.screenshotPath}: ${(err as Error).message}`,
          });
        }
      } else if (!r.renderError && lean) {
        omittedRenderIds.push(renderKeyFor(r));
        content.push({
          type: 'text',
          text: `  (lean: screenshot omitted — ${decision.reason}; run detail:'full' to see it)`,
        });
      }
      // Visual-regression block (parity with web's isolation handler, minus the
      // `validity accept` hint — native has no accept command). Surfaces the
      // pixel delta + diff PNG so the agent factors visual drift into its score
      // and knows how to re-baseline an intentional change.
      const px = r.baseline?.mismatchedPixels ?? 0;
      if (r.baseline && px > 0) {
        content.push({
          type: 'text',
          text:
            `Visual regression: ${px} pixel${px === 1 ? '' : 's'} changed` +
            (r.baseline.diffPath ? ` — diff: ${r.baseline.diffPath}` : '') +
            '\n  → If this drift is intentional, delete the baseline ' +
            '(.validity/baselines/<componentId>__<variantSlug>.png) to re-seed it.',
        });
      }
      if (r.a11ySnapshot) {
        content.push({
          type: 'text',
          text: `Accessibility snapshot (score against this + the screenshot):\n${r.a11ySnapshot}`,
        });
      }
      // Un-mocked fetches this target hit — the native analog of web's
      // unmatched-fetch block, so the agent never scores a screen whose data
      // came from the permissive catch-all without knowing which endpoints it
      // should pin. Mirrors handleVerifyIsolation's phrasing.
      if (r.unmatchedUrls && r.unmatchedUrls.length > 0) {
        content.push({
          type: 'text',
          text:
            `Unmatched fetch(es) under '${label}' (answered by the permissive mock): ` +
            r.unmatchedUrls.map((u) => `\n  • ${u}`).join('') +
            "\n  → add a handler in .validity/config.ts mockNetwork.handlers (or the scenario) if the response matters for what you're scoring.",
        });
      }
      // Advisory perf hints (D2) from the companion's on-device NativePerf
      // subset — parity with the web isolation loop; pushed only when a rule
      // fired. Never a verdict.
      const perfHintsBlock = formatPerfHintsBlock(computePerfHints(r.performance), label);
      if (perfHintsBlock) {
        content.push({ type: 'text', text: perfHintsBlock });
      }
    }
    // Source rides in full detail always; in lean only when a render of this
    // component ERRORED (parity with the web isolation handler).
    const source = sources[id];
    if (source && (!lean || group.some((r) => r.renderError))) {
      content.push({
        type: 'text',
        text: `Source for ${id}:\n\`\`\`tsx\n${source.slice(0, 4000)}\n\`\`\``,
      });
    }
  }

  // Lean-mode summary line so the agent knows why some screenshots are absent
  // and how to get them back mechanically.
  if (lean && leanTotal > 0) {
    content.push({
      type: 'text',
      text:
        `Lean detail: ${leanShown} of ${leanTotal} screenshots shown` +
        (omittedRenderIds.length > 0 ? ` — omitted: ${omittedRenderIds.join(', ')}` : '') +
        ". Pass detail:'full' for every screenshot + source.",
    });
  }

  let openPerfDrift: Signal[] = [];
  // Fold receipt (B1) — parity with the web isolation path.
  let fold: FoldResult | undefined;
  if (frozenSpec) {
    const provenBlock = renderProvenChecksBlock(criterionVerdicts ?? []);
    if (provenBlock) content.push({ type: 'text', text: provenBlock });
    // Display-only regression deltas vs. the previous run — read from the
    // run-meta that writeNativeRunMeta just wrote (parity with web verify).
    const freshNativeMeta = readRunMeta(projectRoot, runId);
    // Scorecard seed — parity with the web isolation path: a native verify is
    // a deterministic tick too, so record_soft_scores works after it.
    fold = foldVerifyIntoScorecard(projectRoot, {
      spec: frozenSpec,
      verdicts: criterionVerdicts ?? [],
      sha: freshNativeMeta?.git?.sha,
      // Byte-identical renders must not stale carried soft scores (Rule 1) —
      // parity with the web isolation path.
      renderUnchanged: renderUnchangedForFold(renders, prevRun?.meta, frozenSpec),
      // Relevance-scoped staleness (W3 #10) — parity with the web path.
      codeChanged: codeChangedForSpec({
        projectRoot,
        spec: frozenSpec,
        sinceSha: lastObservedSha(loadScorecard(projectRoot)?.specs[frozenSpec.id]),
      }),
      historyCommitted: config.historyCommitted === true,
      // Maturity ladder — parity with the web isolation path.
      assessMaturity: (s, entry) => assessSpecMaturity(projectRoot, s, config, entry ?? null),
    });
    const deltaBlock = renderRegressionDeltasBlock(freshNativeMeta?.regressionDeltas);
    if (deltaBlock) content.push({ type: 'text', text: deltaBlock });
    // Advisory perf drift (D1) — parity with the web isolation path; native
    // rows carry `@native`-suffixed perf keys so web/native medians never mix.
    openPerfDrift = refreshPerfDrift(projectRoot, frozenSpec.id).filter((s) => s.status === 'open');
    const driftBlock = renderPerfDriftBlock(openPerfDrift);
    if (driftBlock) content.push({ type: 'text', text: driftBlock });
    // Hardening candidates (maturity Phase C) — parity with the web path.
    refreshHardeningCandidates(projectRoot, frozenSpec, { sha: freshNativeMeta?.git?.sha });
    content.push({
      type: 'text',
      text: specScopedScoringInstructions(frozenSpec, partition.carryForward, heldSoftIds),
    });
  } else {
    content.push({
      type: 'text',
      text: plan ? planScopedScoringInstructions(plan) : SCORING_INSTRUCTIONS,
    });
  }

  // Additive loop signal — mirrors the web isolation path. `criterionVerdicts`
  // is the same set just persisted to run-meta (undefined for a non-spec run);
  // `presentation` (C3, registry §9.1) is a SIBLING key of `verdict`.
  // Temporal binding (B2, sibling key) — classified from the run-meta
  // writeNativeRunMeta just persisted (same source as submit_report reads).
  const finalMeta = readRunMeta(projectRoot, runId);
  let temporal: TemporalResult | undefined;
  if (frozenSpec && finalMeta) {
    temporal = resolveTemporalBinding({
      projectRoot,
      freeze: frozenSpec.git,
      meta: finalMeta,
    });
  }
  const presentation: VerifyPresentation = {
    detail,
    autoSelected,
    screenshotsShown: leanShown,
    screenshotsTotal: leanTotal,
    omittedRenderIds,
    carriedForwardSoft: partition.carryForward.map((c) => c.id),
  };
  // RECEIPT (B1) — parity with the web isolation path.
  const receipt = buildVerifyReceipt({
    runId,
    origin: finalMeta?.origin ?? detectRunOrigin(),
    fold,
  });
  content.push({ type: 'text', text: receiptLine(receipt, fold?.error) });
  // Always-a-report (Feature 1): mechanical-only preliminary report now.
  const reportContent = await attachPreliminaryReport(projectRoot, finalMeta, content);
  // NAME THE CAUSE, at the right strength. The verdicts above are already
  // computed and are NOT touched by either branch — an unconfirmed render stays
  // unverifiable whether or not a cause is found.
  //
  //   nothing confirmed  → `environmentBlocked`: this run produced NO usable
  //                        evidence. A loop driver may reasonably read that as
  //                        "stop, fix the machine, re-run".
  //   some confirmed,    → `environmentDegraded`: this run produced real
  //   some lost            evidence, and here is the cause for the targets it
  //                        lost, plus which ones they were. Strictly weaker —
  //                        aborting a sweep over it would be wrong.
  //
  // The blocked branch falls back to a fresh probe when no capture attached one
  // (the catch-all path, and a bridge/driver throw before any capture ran). The
  // degraded branch never probes: it exists only when a capture already
  // resolved a cause, so there is nothing to guess at.
  let environmentBlocked: EnvironmentBlockedContent | undefined;
  let environmentDegraded: EnvironmentDegradedContent | undefined;
  if (!anyConfirmed) {
    const diagnosis =
      firstDiagnosis ??
      (await diagnoseNativeEnvironment({
        projectRoot,
        platform,
        renderStatus: 'unconfirmed',
        avdName: pinnedDeviceName,
      }).catch(() => undefined));
    if (diagnosis) environmentBlocked = environmentBlockedFromDiagnosis(diagnosis);
  } else if (firstDiagnosis) {
    const affected = renders.filter((r) => r.renderConfirmation !== 'confirmed');
    if (affected.length > 0) {
      environmentDegraded = environmentDegradedFromDiagnosis(firstDiagnosis, affected);
    }
  }
  return {
    content,
    structuredContent: {
      ...buildVerifyStructuredContent(
        runId,
        criterionVerdicts,
        frozenSpec ?? undefined,
        projectRoot,
        frozenSpec?.id,
        renders,
        plan !== null,
        openPerfDrift,
        environmentBlocked,
        environmentDegraded,
      ),
      receipt,
      presentation,
      // WHAT RAN (registry §runtime): the agent scoring these screenshots must
      // be able to tell a device render from a react-native-web one WITHOUT
      // reading the HTML report — an RN app pinned to the web proxy proves
      // something adjacent to, not the same as, the shipped app.
      runtime: {
        mode: 'native' as const,
        platform,
        ...(pinnedDevice ? { device: pinnedDevice } : {}),
        ...(pinnedDeviceName ? { deviceName: pinnedDeviceName } : {}),
        ...(pinnedOsVersion ? { osVersion: pinnedOsVersion } : {}),
      },
      ...(temporal && frozenSpec ? { temporal: buildTemporalContent(temporal, frozenSpec) } : {}),
      ...reportContent,
      ...(fixtureWarnings.length > 0 ? { warnings: fixtureWarnings } : {}),
    },
  };
}

/**
 * Author a new view (or, with `force: true`, overwrite an existing one of
 * the same name). The collision check is the load-bearing piece: a view
 * name that matches a component path, screen path, or other view name is
 * surfaced as an error so the LLM tells the user instead of silently
 * shadowing something. Component / screen collisions are always rejected;
 * view collisions are only rejected without `force`.
 */
async function handleViewsCreate(args: ViewsCreateArgs): Promise<ServerResult> {
  if (!args.name || typeof args.name !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'name is required.' }] };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(args.name)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'view name must start with an alphanumeric character and contain only letters, digits, spaces, underscores, or hyphens.',
        },
      ],
    };
  }
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'items must be a non-empty array.' }],
    };
  }
  for (const it of args.items) {
    if (!it || typeof it.componentPath !== 'string' || !it.componentPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'each item must include componentPath (string).' }],
      };
    }
  }

  const projectRoot = resolveProjectRoot(args.projectRoot);
  await ensureValidityConfigured({ projectRoot });
  const { config } = await loadConfig(projectRoot);

  // Collision detection — see `/__validity/api/views` for the matching
  // logic; we duplicate it here so views_create works even without an open
  // browse session.
  const componentPaths = new Set<string>(Object.keys(config.components ?? {}));
  try {
    for (const p of discoverComponentFiles(projectRoot)) componentPaths.add(p);
  } catch {
    /* swallow */
  }
  const screenPaths = new Set<string>(Object.keys(config.screens ?? {}));
  try {
    for (const s of discoverScreenFiles(projectRoot)) screenPaths.add(s.path);
  } catch {
    /* swallow */
  }
  const viewNames = new Set<string>(Object.keys(config.views ?? {}));

  const collisions: Array<{ kind: 'component' | 'screen' | 'view'; with: string }> = [];
  if (componentPaths.has(args.name)) collisions.push({ kind: 'component', with: args.name });
  if (screenPaths.has(args.name)) collisions.push({ kind: 'screen', with: args.name });
  if (viewNames.has(args.name) && !args.force) collisions.push({ kind: 'view', with: args.name });

  const hardCollision = collisions.some((c) => c.kind !== 'view');
  if (hardCollision || (collisions.length > 0 && !args.force)) {
    const lines = [
      `View name "${args.name}" collides with an existing entry — tell the user before retrying.`,
      '',
      ...collisions.map((c) => `  • ${c.kind}: ${c.with}`),
    ];
    if (!hardCollision) {
      lines.push('');
      lines.push('Pass `force: true` to overwrite the existing view, or pick a different name.');
    } else {
      lines.push('');
      lines.push(
        'Component/screen path collisions are always rejected — pick a name that does not match any file path.',
      );
    }
    return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // Validate that referenced component paths actually exist (best-effort —
  // we surface unknowns as warnings, not hard failures, so an LLM that
  // misspelled a path can still see the view file produced and fix it up).
  const unknown: string[] = [];
  for (const item of args.items) {
    if (!componentPaths.has(item.componentPath) && !screenPaths.has(item.componentPath)) {
      unknown.push(item.componentPath);
    }
  }

  const result = writeViewToConfig({
    projectRoot,
    name: args.name,
    view: {
      title: args.title,
      description: args.description,
      layout: args.layout,
      items: args.items,
    },
  });
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error ?? 'unknown write error' }],
    };
  }

  // Nudge an open browse session to refresh + navigate. Silently no-ops if
  // no session is open or the page is disconnected.
  const session = sessions.get(projectRoot);
  if (session?.devServer.bridge?.isConnected()) {
    session.devServer.bridge.send({ type: 'configRefresh' });
    session.devServer.bridge.send({ type: 'navigate', view: args.name });
  }

  const lines = [
    `View "${args.name}" saved to ${result.writtenTo ?? 'config'} (${result.mode ?? 'ast'}).`,
  ];
  if (result.mode === 'sidecar' && result.error) {
    lines.push(`Note: ${result.error}`);
  }
  if (unknown.length > 0) {
    lines.push('');
    lines.push(
      `Warning: ${unknown.length} component path${unknown.length === 1 ? '' : 's'} did not match a known file — verify with the user:`,
    );
    for (const p of unknown) lines.push(`  • ${p}`);
  }
  if (session?.devServer.bridge?.isConnected()) {
    lines.push('');
    lines.push(`Browse session refreshed and navigated to view "${args.name}".`);
  } else {
    lines.push('');
    lines.push(
      `Open browse with validity__browse_open then navigate via { view: "${args.name}" }.`,
    );
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Delete a view by name. Silently succeeds if the view isn't there — the
 * caller's mental model is "I want this view gone" and the post-state
 * matches that whether or not it existed in the first place.
 */
async function handleViewsDelete(args: ViewsDeleteArgs): Promise<ServerResult> {
  if (!args.name) {
    return { isError: true, content: [{ type: 'text', text: 'name is required.' }] };
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);
  await ensureValidityConfigured({ projectRoot });
  const result = deleteViewFromConfig({ projectRoot, name: args.name });
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error ?? 'unknown delete error' }],
    };
  }
  const session = sessions.get(projectRoot);
  if (session?.devServer.bridge?.isConnected()) {
    session.devServer.bridge.send({ type: 'configRefresh' });
  }
  return {
    content: [{ type: 'text', text: `View "${args.name}" removed (or was already absent).` }],
  };
}

/**
 * `validity__plan` — the frictionless wrapper over the spec lifecycle. The
 * agent supplies NL acceptance criteria; Validity validates the shape, mints
 * a SPEC (soft-tier criteria), and freezes it in one call so existing flows
 * keep working: the returned id is a spec id that flows into `validity__verify`
 * and `validity__submit_report` exactly where `planId` used to. The spec is a
 * reviewable, editable YAML file — the user (or a reviewer agent) can promote
 * criteria to hard via `validity__spec_update`/`spec_review` and re-verify.
 *
 * Validity does NO LLM work here.
 */
export async function handlePlan(args: PlanArgs): Promise<ServerResult> {
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new Error('prompt is required');
  }
  const projectRoot = resolveProjectRoot(args.projectRoot);

  let criteria: AcceptanceCriterion[];
  try {
    criteria = validateCriteria(args.criteria);
  } catch (err) {
    // Surface the validation error inline so the agent can fix and retry
    // in the same turn rather than escalating to the user.
    if (err instanceof PlanValidationError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Validity plan validation error: ${err.message}` }],
      };
    }
    throw err;
  }

  // Derive the runtime from config when available (web vs native) so the spec
  // verifies + exports against the right target. Best-effort; default web.
  // The `commands` map rides the same load for the typecheck auto-attach below.
  let runtime: Spec['runtime'] = 'web';
  let commands: Record<string, string | undefined> | undefined;
  let planConfig: ValidityConfig | null = null;
  try {
    const { config } = await loadConfig(projectRoot);
    planConfig = config;
    runtime = config.renderMode === 'native' ? 'native' : 'web';
    commands = config.commands;
  } catch {
    // No config yet (first run) — web is the safe default.
  }

  // Auto-attach the repo-level typecheck proof (A5): when tsconfig.json exists
  // AND config declares commands.typecheck, every plan carries a blocking
  // `repo-typecheck` property criterion — a type error can then never sign off.
  // Happens HERE, not in the deterministic compiler (the compiler can't know
  // whether the config declares the command). `spec_create` does not
  // auto-attach — the agent is in full control there.
  const compiled = planCriteriaToSpecCriteria(criteria);
  const typecheckCriterion = buildRepoTypecheckCriterion({
    hasTsconfig: existsSync(resolve(projectRoot, 'tsconfig.json')),
    typecheckCommand: commands?.typecheck,
    existingCriteria: compiled,
  });
  if (typecheckCriterion) compiled.push(typecheckCriterion);

  // Auto-attach the critical-a11y gate — the a11y sibling of the typecheck
  // proof above: every plan carries a blocking `repo-a11y-critical` property
  // criterion so a critical axe violation can never sign off. No config gate
  // (axe always runs in the sandbox); skipped only when the plan already
  // asserts an a11y budget. `spec_create` does NOT auto-attach — same as
  // typecheck, the agent is in full control there.
  const a11yCriterion = buildRepoA11yCriterion({ existingCriteria: compiled });
  if (a11yCriterion) compiled.push(a11yCriterion);

  // A bare component NAME is resolved to its project-relative path through
  // the catalog before storing — the stored target is what change-mapping and
  // the sandbox consume (raw kept on no/ambiguous match; basename matching
  // still applies downstream).
  const targetComponents = args.componentPath
    ? [resolveComponentTarget(projectRoot, planConfig, args.componentPath)]
    : undefined;
  const { specId, path } = createSpec({
    projectRoot,
    prompt: args.prompt,
    criteria: compiled,
    // Stamp the compiler contract version into the spec hash so a spec compiled
    // under one bar can never be silently re-judged under another.
    compiledWith: CHECK_COMPILER_VERSION,
    runtime,
    createdBy: 'agent',
    targets: targetComponents ? { components: targetComponents } : undefined,
  });
  // `plan` is the one-shot "lock it now" path → freeze immediately with the
  // permissive gate. The explicit `validity__spec_freeze` tool is where the
  // `specApproval: 'always'` policy is enforced.
  const { spec } = freezeSpec({ projectRoot, specId, approval: 'auto' });

  return {
    content: [
      {
        type: 'text',
        text: planSuccessLines(
          spec,
          path,
          Boolean(typecheckCriterion),
          Boolean(a11yCriterion),
        ).join('\n'),
      },
    ],
  };
}

/**
 * The `validity__plan` success message. Extracted (B4) so the docs-consistency
 * suite can assert the copy stays truthful — historically it claimed criteria
 * were "all soft by default" long after the deterministic compiler started
 * assigning tiers.
 */
export function planSuccessLines(
  spec: Spec,
  path: string,
  typecheckAutoAttached = false,
  a11yAutoAttached = false,
): string[] {
  return [
    `Spec created + frozen: ${spec.id}@v${spec.version}`,
    `Saved to: ${path}`,
    '',
    `Pass \`planId: "${spec.id}"\` to validity__verify (the id works everywhere planId did).`,
    'The verify response scores against these exact criteria — no drift between build and verify.',
    '',
    `Criteria (${spec.criteria.length}) — tiers assigned by the deterministic compiler (observable → hard with checks, judgment → soft):`,
    ...spec.criteria.map((c) => `  • ${c.id} [${c.tier}]: ${c.text}`),
    ...(typecheckAutoAttached
      ? [
          '  (repo-typecheck was auto-attached because tsconfig.json exists and config declares commands.typecheck)',
        ]
      : []),
    ...(a11yAutoAttached
      ? [
          '  (repo-a11y-critical was auto-attached: a critical axe violation blocks sign-off — remove it or set your own expect.a11y budget to override)',
        ]
      : []),
    '',
    'Review / modify anytime:',
    `  • Edit ${path} directly, or call validity__spec_update.`,
    '  • Promote a criterion to "hard" with a structured `checks` block to get a',
    '    DETERMINISTIC, exportable proof (run validity__spec_review for suggestions).',
    '  • Re-run validity__verify with the same id to re-score / re-prove.',
    '',
    'Surface these criteria to the user so they can correct any misinterpretation',
    'before you do the work.',
  ];
}

/**
 * Read a screenshot from disk and return it as a `data:image/png;base64,…`
 * URL ready to embed in the report HTML. Returns undefined on read failure
 * (the renderer handles the missing-image case via render-error fallback).
 */
function screenshotAsDataUrl(path: string): string | undefined {
  try {
    const data = readFileSync(path).toString('base64');
    return `data:image/png;base64,${data}`;
  } catch {
    return undefined;
  }
}

/**
 * Phase 2 of the verify flow. Reads the run-meta.json that `validity__verify`
 * wrote, combines it with the agent's verdict + per-file notes, calls the
 * report renderer, writes `report.html` next to the screenshots, and tells
 * the agent how to view it.
 *
 * Idempotent: calling submit_report twice for the same runId rewrites the
 * HTML (later call wins). Useful when the agent iterates on its scoring.
 */
/**
 * "Not validated" facts the renderer can't derive (C2): data states the render
 * budget dropped (persisted at verify time) and planned-but-uncaptured
 * viewports (current config vs. the run's captured renders — best-effort; the
 * drift window is one config edit mid-run, and the list is display-only).
 * Built from run-meta + config ONLY — nothing agent-submitted reaches this.
 */
export function buildNotCovered(
  meta: Pick<RunMeta, 'mode' | 'components' | 'scenarios' | 'droppedDataStates'>,
  config: ValidityConfig | null,
): { dataStates?: string[]; viewports?: string[] } | undefined {
  const dataStates = [
    ...new Set((meta.droppedDataStates ?? []).map((d) => `${d.dataState} (${d.componentId})`)),
  ];

  const viewports: string[] = [];
  if (config && (meta.mode ?? 'isolation') !== 'url') {
    const planned = new Set<string>();
    for (const scenarioId of meta.scenarios ?? []) {
      for (const v of config.scenarios?.[scenarioId]?.viewports ?? []) {
        planned.add(resolveViewport(v).name);
      }
    }
    const captured = new Set((meta.components ?? []).map((c) => c.viewport?.name ?? 'default'));
    for (const name of planned) {
      if (!captured.has(name)) viewports.push(name);
    }
  }

  if (dataStates.length === 0 && viewports.length === 0) return undefined;
  return {
    ...(dataStates.length > 0 ? { dataStates } : {}),
    ...(viewports.length > 0 ? { viewports } : {}),
  };
}

/**
 * Build the renderer's `ReportComponent[]` from a run-meta. Two shapes:
 *   - url mode → one ReportComponent per URL/path (grouped by pathId), its
 *     scenarios flattened into renders[]; no source code.
 *   - isolation/native → one ReportComponent per component file, scenarios
 *     flattened; source code attached.
 * Pure over run-meta (+ screenshot bytes on disk) — no agent input. Shared by
 * `submit_report` and the preliminary (verify-time) report so the two never
 * drift on how a run's renders map into the report.
 */
function buildReportComponentsFromMeta(meta: RunMeta): ReportComponent[] {
  const mode = meta.mode ?? 'isolation';
  const byComponent = new Map<string, ReportComponent>();
  if (mode === 'url') {
    for (const p of meta.pages ?? []) {
      let entry = byComponent.get(p.pathId);
      if (!entry) {
        entry = { id: p.pathId, filePath: p.url, renders: [] };
        byComponent.set(p.pathId, entry);
      }
      entry.renders.push({
        scenarioId: p.scenarioId,
        screenshotDataUrl: p.errorMessage ? undefined : screenshotAsDataUrl(p.screenshotPath),
        renderError: p.errorMessage,
        unmatchedUrls: p.unmatchedUrls,
        consoleErrors: p.consoleErrors,
        pageErrors: p.pageErrors,
        networkErrors: p.networkErrors,
        a11yViolations: p.a11yViolations,
      });
    }
  } else {
    for (const c of meta.components ?? []) {
      let entry = byComponent.get(c.id);
      if (!entry) {
        entry = {
          id: c.id,
          filePath: c.filePath,
          source: meta.componentSources?.[c.id],
          renders: [],
        };
        byComponent.set(c.id, entry);
      }
      entry.renders.push({
        scenarioId: c.scenarioId,
        screenshotDataUrl: c.renderError ? undefined : screenshotAsDataUrl(c.screenshotPath),
        renderError: c.renderError,
        unmatchedUrls: c.unmatchedUrls,
        consoleErrors: c.consoleErrors,
        pageErrors: c.pageErrors,
        networkErrors: c.networkErrors,
        a11yViolations: c.a11yViolations,
        performance: c.performance,
        viewport: c.viewport,
        dataProvenance: c.dataProvenance,
        dataState: c.dataState,
        renderConfirmation: c.renderConfirmation,
        baseline: c.baseline
          ? {
              sha: c.baseline.sha,
              takenAt: c.baseline.takenAt,
              mismatchedPixels: c.baseline.mismatchedPixels,
              diffDataUrl: c.baseline.diffPath
                ? screenshotAsDataUrl(c.baseline.diffPath)
                : undefined,
            }
          : undefined,
      });
    }
  }
  return Array.from(byComponent.values());
}

/**
 * Temporal binding (B2) for a run: classify against the EXACT verified version's
 * freeze-time binding (the live spec.yaml may already be a v+1 draft). A GC'd or
 * malformed history version yields no binding → honest `unknown`. Shared by the
 * report's `temporalBinding` chip and `submit_report`'s structuredContent
 * sibling key. Display-only — never feeds a verdict.
 */
function resolveReportTemporal(
  projectRoot: string,
  meta: RunMeta,
  spec: Spec | null,
): { temporal?: TemporalResult; specRef?: { id: string; version: number } } {
  if (!meta.specId) return {};
  let verifiedSpec: Spec | null = null;
  if (meta.specVersion != null) {
    try {
      verifiedSpec = readSpecVersion(projectRoot, meta.specId, meta.specVersion);
    } catch {
      verifiedSpec = null; // malformed history file — no binding, not a crash
    }
  } else {
    verifiedSpec = spec; // legacy run-meta without a version stamp
  }
  const ref = verifiedSpec ?? spec;
  if (!ref) return {};
  return {
    temporal: resolveTemporalBinding({ projectRoot, freeze: verifiedSpec?.git, meta }),
    specRef: { id: meta.specId, version: meta.specVersion ?? ref.version },
  };
}

/**
 * The "Part of spec …" system-context panel — ties the one-off report back into
 * the durable spec system (maturity, certification distance, open signals, run
 * timeline). Best-effort + display-only: any assembly failure drops the panel,
 * never the report. Shared by `submit_report` and the preliminary report.
 */
function buildReportSpecContext(
  projectRoot: string,
  meta: RunMeta,
  spec: Spec | null,
  repoScorecard: ReturnType<typeof loadScorecard>,
): ReportInput['specContext'] {
  if (!meta.specId || !spec) return undefined;
  try {
    const entry = repoScorecard?.specs[meta.specId] ?? null;
    const maturity = assessSpecMaturity(projectRoot, spec, undefined, entry);
    const openSignals = loadSignals(projectRoot).filter(
      (s) => s.specId === meta.specId && !s.resolvedAt,
    );
    // runs.jsonl is append-faithful: a runId appears twice once scored (the
    // verify append + the submit twin), so read a compensated tail and keep
    // the LAST row per runId (the scored one).
    const byRun = new Map<string, ReturnType<typeof readSpecRunHistory>[number]>();
    for (const r of readSpecRunHistory(projectRoot, meta.specId, 16)) byRun.set(r.runId, r);
    return {
      specId: meta.specId,
      version: spec.version,
      status: spec.status,
      maturity: {
        level: maturity.level,
        blockers: maturity.blockers.map((b) => b.detail),
      },
      ...(entry?.cleanStreak ? { cleanStreak: entry.cleanStreak.count } : {}),
      openSignals: openSignals.map((s) => ({
        kind: s.kind,
        severity: s.severity,
        ...(s.criterionId ? { criterionId: s.criterionId } : {}),
      })),
      history: Array.from(byRun.values())
        .slice(-8)
        .map((r) => ({
          runId: r.runId,
          createdAt: r.createdAt,
          verdict: r.verdict,
          ...(r.signedOff !== undefined ? { signedOff: r.signedOff } : {}),
        })),
    };
  } catch {
    return undefined;
  }
}

/**
 * Repo-level Validity Score chip (F1) from the committed scorecard — labeled
 * "as of <updatedAt>" and may predate this run (submit never writes the
 * scorecard). Informational only; no scorecard ⇒ no chip.
 */
function buildValidityScoreChip(
  repoScorecard: ReturnType<typeof loadScorecard>,
): ReportInput['validityScore'] {
  const repoScore = computeValidityScore(repoScorecard);
  return repoScore && repoScorecard
    ? { score: repoScore.score, asOf: repoScorecard.updatedAt, formula: VALIDITY_SCORE_FORMULA }
    : undefined;
}

/**
 * Assemble the renderer's `ReportInput` from a run-meta + the display blocks the
 * caller already computed. Almost entirely a projection: it maps run-meta fields
 * onto the report shape (diff guard, setup/git/environment projection,
 * viewCommand, coverage-floor fallback, `unplanned`, fresh coverage), so the
 * field mapping lives in ONE place.
 *
 * The ONE disk read is `readRunEvidence`, and it has to be here: the run-dir
 * sidecars (`replay-divergence.json`, the device-evidence bundles) are written
 * by OTHER commands, after run-meta, so there is nothing in run-meta to project
 * them from. It is best-effort and presence-gated — a run with no sidecars
 * contributes no fields and renders byte-identically to before. The
 * scoring-derived inputs (`verdict`, `criteria`, `scoring`, `criterionVerdicts`)
 * differ between a finalized submit and a mechanical preliminary; everything
 * else is identical, which is exactly why it's shared.
 */
function assembleReportInput(args: {
  projectRoot: string;
  meta: RunMeta;
  submitConfig: ValidityConfig | null;
  components: ReportComponent[];
  verdict: ReportInput['verdict'];
  summary?: string;
  criteria?: ReportCriterion[];
  fileNotes?: Record<string, string>;
  criterionVerdicts?: CriterionVerdict[];
  scoring?: ReportInput['scoring'];
  evidence: ReturnType<typeof buildEvidenceMap>;
  notCovered: ReturnType<typeof buildNotCovered>;
  temporalBinding?: TemporalResult['classification'];
  validityScore?: ReportInput['validityScore'];
  specContext?: ReportInput['specContext'];
  signOff?: ReportInput['signOff'];
  /**
   * Display regression list override (prior-run soft-score diffs). When absent
   * the report uses `meta.regressionDeltas` as-is (the preliminary path). The
   * enriched list is in-memory only — `meta.regressionDeltas` on disk is never
   * modified by this override.
   */
  regressionDeltas?: ReportInput['regressionDeltas'];
}): ReportInput {
  const { projectRoot, meta, submitConfig } = args;
  const mode = meta.mode ?? 'isolation';
  return {
    runId: meta.runId,
    createdAt: meta.createdAt,
    mode,
    prompt: meta.prompt,
    scenarios: meta.scenarios,
    verdict: args.verdict,
    summary: args.summary,
    // UNPLANNED badge (B1) — derived from verify-time state (`isRunPlanned`),
    // never from a submit-time planId.
    unplanned: !isRunPlanned(meta),
    // Temporal-binding chip (B2) — absent when the run had no spec in scope.
    temporalBinding: args.temporalBinding,
    // Validity Score chip (F1) — rendered beside the verdict badge.
    validityScore: args.validityScore,
    components: args.components,
    diff: meta.diff.files.length > 0 ? (meta.diff as ReportDiff) : undefined,
    fileNotes: args.fileNotes,
    criteria: args.criteria,
    // Per-criterion evidence + "Not validated" facts (C1/C2). Display-only.
    evidence: args.evidence,
    notCovered: args.notCovered,
    // Verify-time floor stamp wins; the config fallback covers old run-metas.
    coverageFloorPercent: meta.coverageFloorPercent ?? submitConfig?.coverageFloorPercent,
    // Run-level scoring provenance (A3/A6) — drives the judge chips/badges.
    scoring: args.scoring,
    // Proven (deterministic) section — distinct from the soft `criteria` above.
    criterionVerdicts: args.criterionVerdicts,
    // Coverage footnote for the Proven section — how much of the hard/property
    // contract was mechanically DECIDED (pass+fail) vs. left unverifiable.
    coverage: computeCoverageFromVerdicts(args.criterionVerdicts) ?? undefined,
    brand: meta.report.brand,
    viewCommand: `npx http-server ${runDir(projectRoot, meta.runId)}`,
    // Setup-health from the auto-config orchestrator — the renderer suppresses
    // the panel when nothing interesting happened.
    setup: meta.setup
      ? {
          status: meta.setup.status,
          bootstrapped: meta.setup.bootstrapped,
          driftReasons: meta.setup.driftReasons,
          generatedFiles: meta.setup.generatedFiles,
          warnings: meta.setup.warnings,
          manualSteps: meta.setup.manualSteps,
          wrapperFidelity: pickWrapperFidelity(meta.setup.wrapperFidelity),
          // App-manifest record (@validity.ai/verify-plugin-vite). Undefined on runs
          // from before the plugin existed, and on projects without it.
          appManifest: meta.setup.appManifest,
          durationMs: meta.setup.durationMs,
        }
      : undefined,
    // The render session's environment (toolchain, dev server, app-manifest
    // merge, dep pre-scan) — one record, straight through. The renderer
    // suppresses the fact list when it says nothing.
    environment: meta.environment,
    // Run-dir SIDECARS (divergence report, device-evidence bundles). Read at
    // render time and presence-gated, so a run with none is byte-identical.
    ...readRunEvidence(runDir(projectRoot, meta.runId)),
    git: meta.git
      ? { sha: meta.git.sha, branch: meta.git.branch, dirty: meta.git.dirty }
      : undefined,
    regressionDeltas: args.regressionDeltas ?? meta.regressionDeltas,
    specContext: args.specContext,
    // Sign-off standing (display-only). Passthrough — the split between
    // mechanical proof and agent-attested is decided by the caller, never here.
    signOff: args.signOff,
  };
}

/**
 * Render + write the three report artifacts (report-meta.json, report.html,
 * report.md) to a run dir. report-meta is written first (best-effort); an HTML
 * render throw is CAPTURED and returned as `renderError` (not thrown) so the
 * caller decides how to surface it — `submit_report` returns an actionable
 * error, the preliminary path treats it as non-fatal. Markdown is a bonus
 * surface, written only after the HTML succeeds. Shared by both report writers.
 */
function writeReportArtifacts(args: {
  projectRoot: string;
  runId: string;
  reportInput: ReportInput;
  reportMeta: unknown;
}): { reportPath: string; markdownPath: string; renderError?: string; markdownReady: boolean } {
  const { projectRoot, runId, reportInput, reportMeta } = args;
  const dir = runDir(projectRoot, runId);
  const reportPath = resolve(dir, 'report.html');
  const markdownPath = resolve(dir, 'report.md');
  const reportMetaPath = resolve(dir, 'report-meta.json');
  try {
    writeFileSync(reportMetaPath, JSON.stringify(reportMeta, null, 2));
  } catch {
    // non-fatal — export gracefully falls back when the sidecar is missing.
  }
  // Sign run-meta + every screenshot BEFORE rendering, so the footer can print
  // the digest; the report's own bytes are signed after it lands (attest.ts
  // documents why the two signatures cannot be one). Best-effort throughout —
  // a signing failure must never cost the user their report.
  const attestation = attestRun(projectRoot, runId);
  const attestedInput: ReportInput = attestation
    ? { ...reportInput, attestation: stampOf(attestation) }
    : reportInput;
  let renderError: string | undefined;
  try {
    writeFileSync(reportPath, renderHtmlReport(attestedInput));
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
  }
  let markdownReady = false;
  if (!renderError) {
    if (attestation) attestRecording(projectRoot, runId);
    if (attestation) attestReport(projectRoot, runId, reportPath);
    try {
      writeFileSync(markdownPath, renderMarkdownReport(attestedInput));
      markdownReady = true;
    } catch {
      // HTML is the source of truth; markdown is a bonus surface.
    }
  }
  return { reportPath, markdownPath, renderError, markdownReady };
}

/**
 * Write a PRELIMINARY report at verify time (Feature 1). Every verify produces a
 * report artifact immediately — mechanical-only, BEFORE the agent scores the
 * soft criteria — so an abandoned verify loop never leaves an empty run dir and
 * a reviewer always has something to open. `submit_report` later OVERWRITES all
 * three files with the finalized, scored report (it's idempotent, later-wins).
 *
 * The verdict is derived mechanically ONLY: `fail` if any hard/property check
 * failed, else `partial` — NEVER `pass` (nothing soft is scored yet, and the
 * renderer's no-green-without-receipts rollup enforces the same honesty). Soft
 * criteria render as `unverifiable` "scoring pending" placeholders.
 *
 * Honors submit_report's guards: `report: false` (via `meta.report.enabled`)
 * skips; strict-mode + unplanned run skips (mirrors submit's unplanned-run
 * redirect — a report for an unplanned run under strict is never written); a
 * renderer throw is non-fatal (no report, verify proceeds). Returns the report
 * paths for the verify response, or null when skipped/failed.
 */
export async function writePreliminaryReport(
  projectRoot: string,
  meta: RunMeta,
): Promise<{ reportPath: string; reportFileUrl: string; markdownPath?: string } | null> {
  if (!meta.report.enabled) return null;
  // Strict + unplanned: consistent with submit_report's `unplanned-run` refusal.
  if ((await resolveEnforcement(projectRoot)) === 'strict' && !meta.specId) return null;

  const spec = meta.specId ? readSpec(projectRoot, meta.specId) : null;

  // Best-effort config (feeds coverage-floor fallback + notCovered viewports).
  let submitConfig: ValidityConfig | null = null;
  try {
    submitConfig = (await loadConfig(projectRoot)).config;
  } catch {
    submitConfig = null;
  }

  const criterionVerdicts = meta.criterionVerdicts;
  const mech = (criterionVerdicts ?? []).filter((v) => v.tier === 'hard' || v.tier === 'property');
  const prelimVerdict: ReportInput['verdict'] = mech.some((v) => v.status === 'fail')
    ? 'fail'
    : 'partial';

  // Soft criteria as "scoring pending" placeholders — present so the reviewer
  // sees WHAT still needs scoring, honestly marked unverifiable (never a pass).
  const softCriteria: ReportCriterion[] | undefined = spec
    ? spec.criteria
        .filter((c) => c.tier === 'soft')
        .map((c) => ({
          id: c.id,
          description: c.text,
          status: 'unverifiable' as const,
          tier: 'soft' as const,
          reasoning:
            'Scoring pending — score against the screenshots and call submit_report to finalize.',
        }))
    : undefined;

  const repoScorecard = loadScorecard(projectRoot);
  const { temporal } = resolveReportTemporal(projectRoot, meta, spec);
  // Sign-off note (display-only): thread the VERIFY-TIME stop signal when it is
  // determinable. Soft criteria are unscored placeholders at verify time, so a
  // verify-time sign-off can only rest on proven hard/property criteria — but
  // derive `attested` from the same projected inputs rather than assume, so it
  // stays honest if the verify-time verdict shape ever carries a scored soft.
  const prelimSignOff =
    meta.signedOff === true
      ? {
          signedOff: true,
          attested: signOffRestsOnSoft(toSignOffCriteria(criterionVerdicts, spec ?? undefined)),
        }
      : undefined;
  const reportInput = assembleReportInput({
    projectRoot,
    meta,
    submitConfig,
    components: buildReportComponentsFromMeta(meta),
    verdict: prelimVerdict,
    summary:
      'Preliminary report — mechanical checks only. Soft criteria are not yet scored; ' +
      'call submit_report with your scores to finalize.',
    criteria: softCriteria && softCriteria.length > 0 ? softCriteria : undefined,
    criterionVerdicts,
    // No scoring provenance yet — nothing soft has been judged.
    scoring: undefined,
    evidence: buildEvidenceMap({ meta, spec }),
    notCovered: buildNotCovered(meta, submitConfig),
    temporalBinding: temporal?.classification,
    validityScore: buildValidityScoreChip(repoScorecard),
    specContext: buildReportSpecContext(projectRoot, meta, spec, repoScorecard),
    signOff: prelimSignOff,
  });

  const { reportPath, markdownPath, renderError, markdownReady } = writeReportArtifacts({
    projectRoot,
    runId: meta.runId,
    reportInput,
    reportMeta: {
      runId: meta.runId,
      preliminary: true,
      verdict: prelimVerdict,
      summary: reportInput.summary,
      generatedAt: new Date().toISOString(),
      planId: meta.planId ?? meta.specId ?? undefined,
    },
  });
  if (renderError) return null; // non-fatal — verify proceeds without a report

  return {
    reportPath,
    reportFileUrl: pathToFileURL(reportPath).href,
    ...(markdownReady ? { markdownPath } : {}),
  };
}

/**
 * The verify-response line that surfaces the preliminary report AND states the
 * two-phase contract explicitly, WITHOUT weakening the scoring instructions:
 * submit_report is still the documented required follow-up (it overwrites this
 * mechanical-only report with the finalized, scored one).
 */
function preliminaryReportLine(reportFileUrl: string): string {
  return (
    `Preliminary report (mechanical checks only): ${reportFileUrl}\n` +
    'Score the soft criteria against the screenshots above, then call submit_report to ' +
    'finalize — it overwrites this report with your scored verdict.'
  );
}

/**
 * Write the preliminary report for a just-finished verify and, when one was
 * produced, append the surfacing line to the verify `content` and return the
 * `report` structuredContent sibling. Shared by all three verify handlers so
 * the always-a-report contract is identical across isolation / url / native.
 * A null/failed/skipped write adds nothing (no line, no sibling key).
 */
async function attachPreliminaryReport(
  projectRoot: string,
  finalMeta: RunMeta | null,
  content: Content[],
): Promise<{ report: { path: string; preliminary: true } } | Record<string, never>> {
  const preliminary = finalMeta ? await writePreliminaryReport(projectRoot, finalMeta) : null;
  if (!preliminary) return {};
  content.push({ type: 'text', text: preliminaryReportLine(preliminary.reportFileUrl) });
  return { report: { path: preliminary.reportFileUrl, preliminary: true } };
}

/**
 * `validateSoftCitations` returns printable prose prefixed with the criterion
 * id (`"AC-2: soft criterion submission is missing …"`). Split that prefix back
 * off so the structured rejection list carries the id in its own field, without
 * changing the shape of a function several tests pin on its exact strings.
 */
function splitCitationError(error: string): { criterionId: string; reason: string } {
  const at = error.indexOf(': ');
  if (at <= 0) return { criterionId: '', reason: error };
  return { criterionId: error.slice(0, at), reason: error.slice(at + 2) };
}

export async function handleSubmitReport(args: SubmitReportArgs): Promise<ServerResult> {
  if (!args.runId) throw new Error('runId is required');
  const projectRoot = resolveProjectRoot(args.projectRoot);

  // Backstop the in-flight marker (Feature 2): reaching submit means the verify
  // finished, so clear any marker the verify's own finally missed (e.g. a crash
  // between verify returning and submit). Best-effort + idempotent.
  clearInflightMarker(projectRoot, args.runId);

  const meta = readRunMeta(projectRoot, args.runId);
  if (!meta) {
    throw new Error(
      `No run metadata found for runId "${args.runId}". Either the runId is wrong, ` +
        'or `validity__verify` was never called for it. Reports are written next to ' +
        'the screenshots in .validity/runs/<runId>/.',
    );
  }

  // Plan-first enforcement (B1): strict demands a FROZEN spec, so a run
  // captured without one (including a legacy-plan run) redirects. Returns
  // BEFORE any mutation — no report.html, no soft-verdict write-back, no
  // timeline re-index; the run-meta is byte-identical after this redirect.
  if ((await resolveEnforcement(projectRoot)) === 'strict' && !meta.specId) {
    return strictRedirectResult('unplanned-run');
  }

  if (!meta.report.enabled) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Report disabled in .validity/config.ts (\`report: false\` or \`report.enabled: false\`). ` +
            `submit_report was a no-op for run ${args.runId}.`,
        },
      ],
    };
  }

  // `mode` adapts a couple of report labels (empty state, etc.); the renderer's
  // ReportComponent[] itself is assembled by `buildReportComponentsFromMeta`
  // (shared with the preliminary report) at the reportInput site below.
  const mode = meta.mode ?? 'isolation';

  // Reconcile the agent's submitted scores with the mechanical verdicts from
  // verify time (run-meta.criterionVerdicts). Two rules, both load-bearing:
  //   (a) HARD/PROPERTY verdicts are AUTHORITATIVE — a submitted status can
  //       never override a deterministic one (keep mechanical, note it).
  //   (b) SOFT verdicts START as `unverifiable` placeholders at verify time;
  //       the agent's submitted status IS their score, so we write it back
  //       into run-meta + re-index so the per-spec timeline can read pass/fail
  //       instead of a permanent `partial`.
  // Matching is by criterion id (the spec/plan id), with a description-text
  // fallback for older callers that omit the id.
  const spec = meta.specId ? readSpec(projectRoot, meta.specId) : null;
  const submittedById = new Map<string, NonNullable<SubmitReportArgs['criteria']>[number]>();
  const submittedByText = new Map<string, NonNullable<SubmitReportArgs['criteria']>[number]>();
  for (const c of args.criteria ?? []) {
    if (c.id) submittedById.set(c.id, c);
    submittedByText.set(c.description, c);
  }
  const findSubmitted = (id: string, text: string) =>
    submittedById.get(id) ?? submittedByText.get(text);
  // Canonical spec-criterion id for a submitted criterion: trust its `id` ONLY
  // when it resolves to a real criterion, otherwise fall back to the description
  // text. Keyed from the submission side (badge + display overrides below),
  // this mirrors `findSubmitted`'s id ?? text resolution so a submission with a
  // wrong id but the right description can't dodge the self-scoring badge or a
  // taint-display override while still landing its pass through the writeback.
  const canonicalIdFor = (c: { id?: string; description: string }): string | undefined => {
    if (c.id && spec?.criteria.some((cc) => cc.id === c.id)) return c.id;
    return spec?.criteria.find((cc) => cc.text === c.description)?.id;
  };

  // SOFT-SCORING QUALITY FLOOR: every soft criterion submission MUST cite the
  // screenshot(s) it was scored from (the agent must point at the exact image),
  // and the cited ids must be REAL renders from this run. Build the valid-id
  // set from run-meta (never from the submitted ids) so a typo can't slip
  // through. Reject the submission BEFORE persisting any verdict or writing the
  // report — an unsourced soft verdict can never be silently accepted as pass.
  // Errored, unconfirmed (native), and cost-control-skipped renders are NOT
  // citable — their screenshot is missing or isn't evidence, so accepting the
  // id would let citation theater satisfy the floor (A3 §5.3).
  // Derived from the shared primitive so the ids an agent is SHOWN and the ids
  // it may CITE can never drift — including the `<id>::pre` companions.
  const validScreenshotIds = citableScreenshotIds(meta);
  // RELEVANCE (A3 §5.3): blank-PNG renders + the component-path map for the
  // cross-component warning, both built from run-meta alongside the valid set.
  // A `::pre` companion is judged by ITS OWN blank-PNG measurement
  // (`preInteractionLooksEmpty`), never by its post-interaction sibling's —
  // the two frames routinely disagree.
  const emptyScreenshotIds = new Set<string>();
  const renderComponentPathById = new Map<string, string>();
  for (const c of meta.components ?? []) {
    if (!c.renderError && !c.screenshotSkipped) {
      if (c.looksEmpty) emptyScreenshotIds.add(c.id);
      if (c.preInteractionLooksEmpty) emptyScreenshotIds.add(`${c.id}::pre`);
      if (c.filePath) {
        renderComponentPathById.set(c.id, c.filePath);
        if (c.preInteractionScreenshotPath) {
          renderComponentPathById.set(`${c.id}::pre`, c.filePath);
        }
      }
    }
  }
  const citationErrors = validateSoftCitations({
    submitted: args.criteria ?? [],
    spec,
    validScreenshotIds,
    emptyScreenshotIds,
  });
  if (citationErrors.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `submit_report rejected: ${citationErrors.length} soft criterion submission${citationErrors.length === 1 ? '' : 's'} missing valid screenshot citations.\n` +
            citationErrors.map((e) => `  • ${e}`).join('\n') +
            '\n\nRe-score with citations pointing at the exact screenshot(s) you used.',
        },
      ],
      // Machine-readable receipt on the REJECTION path too (B3): the submit
      // wrote nothing, and the agent should be able to read WHICH criterion
      // was refused without parsing the prose above. `softScoresApplied: 0`
      // is the load-bearing fact — an uncited pass never becomes a score.
      structuredContent: {
        runId: meta.runId,
        receipt: {
          runId: meta.runId,
          specId: meta.specId,
          softScoresApplied: 0,
          softScoresRejected: citationErrors.map(splitCitationError),
          signalsRaised: [],
          signalsResolved: [],
        },
      },
    };
  }

  // CROSS-COMPONENT RELEVANCE (advisory, never gates): a soft pass sourced only
  // from a render of a component OUTSIDE this spec's declared targets. Surfaced
  // in the result text + structuredContent (`citationWarnings`) so a reviewer /
  // loop driver can notice a pass backed by the wrong component's screenshot.
  const citationWarnings = crossComponentPassWarnings({
    submitted: args.criteria ?? [],
    spec,
    renderComponentPathById,
  });

  // A2 × native: dataState-conditioned SOFT criteria have no forced-state
  // render on a native run — the populated screenshots are the wrong premise,
  // so a submitted `pass` on one must persist as `unverifiable` (a `fail` is
  // accepted: strictening is always allowed). Same shape as the taint clamp
  // below; empty on web runs, where the sandbox renders the forced state.
  const nativeHeldSoftIds =
    mode === 'native' ? nativeHeldDataStateSoftIds(spec) : new Set<string>();

  // Update the persisted verdicts in place: soft entries take the agent's
  // score; hard/property entries stay mechanical. Also persist the screenshot
  // citations the floor above validated, so the report can show "scored from:
  // <id>" and a reader can audit the trail (even on a same-verdict re-score).
  // Rubric provenance (E2.2), resolved once for this submission: the caller's
  // declared version, else this build's — marked ASSUMED so a reader can tell
  // an attested rubric from a defaulted one.
  const submitRubricVersion = args.rubricVersion ?? RUBRIC_VERSION;
  const submitRubricAssumed = args.rubricVersion === undefined;
  let verdictsChanged = false;
  const criterionVerdicts = meta.criterionVerdicts;
  // Soft ids this submission actually scored — used below to stamp
  // `v.selfScored` (requireFreshJudge, A6) once the run-level `selfScored`
  // flag is computed, without re-deriving `findSubmitted` a second time.
  const touchedSoftIds = new Set<string>();
  if (criterionVerdicts && criterionVerdicts.length > 0) {
    for (const v of criterionVerdicts) {
      if (v.tier === 'hard' || v.tier === 'property') continue;
      const critText = spec?.criteria.find((cc) => cc.id === v.id)?.text ?? v.id;
      const submitted = findSubmitted(v.id, critText);
      if (submitted) {
        touchedSoftIds.add(v.id);
        // TAINT CLAMP (A3): a submitted `pass` on a verdict whose evidence
        // carries a DEMOTING taint (degraded wrapper, fabricated network,
        // unconfirmed render) persists as `unverifiable` — the score attempt is
        // recorded but the gate stays shut. Taints themselves are NEVER erased
        // by the overwrite (sticky through scoring); a submitted `fail` is
        // accepted as-is (strictening is always allowed).
        const taintClamped = applyEvidenceTaints(submitted.status, evidenceTaintsOf(v));
        // NATIVE DATASTATE CLAMP (A2): a `pass` scored against the wrong data
        // state never persists — see `nativeHeldSoftIds` above.
        const clamped =
          taintClamped === 'pass' && nativeHeldSoftIds.has(v.id) ? 'unverifiable' : taintClamped;
        const reasoning = submitted.reasoning?.slice(0, 280) ?? v.detail;
        const newDetail =
          clamped === submitted.status
            ? reasoning
            : taintClamped !== submitted.status
              ? `[evidence tainted: ${demotingTaintsOf(v).join(', ')} — pass withheld]${reasoning ? ` ${reasoning}` : ''}`
              : `[${NATIVE_DATASTATE_UNSUPPORTED_DETAIL} — pass withheld]${reasoning ? ` ${reasoning}` : ''}`;
        if (clamped !== v.status || (clamped !== submitted.status && newDetail !== v.detail)) {
          v.status = clamped;
          v.detail = newDetail;
          verdictsChanged = true;
        }
        if (submitted.screenshotIds && submitted.screenshotIds.length > 0) {
          const newCitations = submitted.screenshotIds.slice();
          if (JSON.stringify(v.screenshotCitations) !== JSON.stringify(newCitations)) {
            v.screenshotCitations = newCitations;
            verdictsChanged = true;
          }
        }
        // Always-on scorer provenance (A3): who scored this soft criterion.
        // The session fingerprint is recorded even when the host doesn't
        // self-report a model id. Metadata only — never feeds the gate.
        const scoredBy: ScorerProvenance = {
          ...(args.scoredBy ? { model: args.scoredBy } : {}),
          session: SESSION_FINGERPRINT,
          // WHICH RUBRIC (E2.2): declared by the submitter, else this build's,
          // flagged assumed. Provenance only — never a gate input.
          rubricVersion: submitRubricVersion,
          rubricVersionAssumed: submitRubricAssumed,
        };
        if (
          v.scoredBy?.model !== scoredBy.model ||
          v.scoredBy?.session !== scoredBy.session ||
          v.scoredBy?.rubricVersion !== scoredBy.rubricVersion ||
          v.scoredBy?.rubricVersionAssumed !== scoredBy.rubricVersionAssumed
        ) {
          v.scoredBy = scoredBy;
          verdictsChanged = true;
        }
      }
    }
  }

  // Config is best-effort at submit time: it feeds DISPLAY facts only (the
  // judge-mode badge, the coverage-floor fallback for old run-metas, and the
  // planned-viewport diff). A broken config never blocks the report.
  let submitConfig: ValidityConfig | null = null;
  try {
    submitConfig = (await loadConfig(projectRoot)).config;
  } catch {
    submitConfig = null;
  }

  // SELF-SCORING DETECTION (A3): the session that ran verify is scoring its own
  // work (fingerprint match), or the host self-reported the builder model
  // (legacy env contract). A warning + structuredContent flag — never a gate.
  // Absent fingerprint (old run-meta / CLI verify) ⇒ no same-session claim.
  const fingerprintSelfScored =
    Boolean(meta.sessionFingerprint && meta.sessionFingerprint === SESSION_FINGERPRINT) ||
    Boolean(
      args.scoredBy &&
      process.env.VALIDITY_BUILDER_MODEL &&
      args.scoredBy === process.env.VALIDITY_BUILDER_MODEL,
    );
  // Judge-mode badging (A6). Deny-by-default: under a fresh-context/human
  // posture, soft scores without an affirmatively recorded distinct judge
  // identity badge as SELF-SCORED — configuring the knob is not laundering.
  // For spec runs "soft scores" = a submitted criterion mapping to a soft-tier
  // verdict; spec-less runs' criteria are screenshot-scored by definition.
  const judgeMode = resolveJudgeMode(submitConfig);
  const softTierIds = new Set(
    (criterionVerdicts ?? []).filter((v) => v.tier === 'soft').map((v) => v.id),
  );
  const softSubmitted =
    spec && (criterionVerdicts?.length ?? 0) > 0
      ? (args.criteria ?? []).some((c) => {
          const id = canonicalIdFor(c);
          return id != null && softTierIds.has(id);
        })
      : (args.criteria?.length ?? 0) > 0;
  const unprovenJudge = judgeMode !== 'self' && !args.scoredBy && softSubmitted;
  const selfScored = fingerprintSelfScored || unprovenJudge;
  // Run-level scoring provenance (A6) — the report badge + downstream tooling
  // read this; it never feeds signedOff or the verdict lattice.
  if (
    !meta.scoring ||
    meta.scoring.judge !== judgeMode ||
    meta.scoring.selfScored !== selfScored ||
    meta.scoring.scoredBy !== args.scoredBy ||
    meta.scoring.rubricVersion !== submitRubricVersion ||
    meta.scoring.rubricVersionAssumed !== submitRubricAssumed
  ) {
    meta.scoring = {
      judge: judgeMode,
      scoredBy: args.scoredBy,
      selfScored,
      rubricVersion: submitRubricVersion,
      rubricVersionAssumed: submitRubricAssumed,
    };
    verdictsChanged = true;
  }

  // PER-CRITERION self-scored stamp (A6/requireFreshJudge): mirrors the
  // run-level `selfScored` flag above onto each soft verdict THIS submission
  // actually scored (touchedSoftIds, set in the write-back loop). Unlike
  // `meta.scoring.selfScored`, this DOES feed `computeSignedOff` below — but
  // only when `requireFreshJudge` is on; the flag is otherwise inert metadata,
  // same posture as `scoredBy`.
  for (const v of criterionVerdicts ?? []) {
    if (v.tier !== 'soft' || !touchedSoftIds.has(v.id)) continue;
    if (v.selfScored !== selfScored) {
      v.selfScored = selfScored;
      verdictsChanged = true;
    }
  }

  // Stamp the scoring-contract version this run was scored under, so a reader
  // can see "scored under contract vN" and compare against a spec frozen under
  // an older contract. Constant for the lifetime of this Validity build.
  if (meta.scoringContractVersion !== SCORING_CONTRACT_VERSION) {
    meta.scoringContractVersion = SCORING_CONTRACT_VERSION;
    verdictsChanged = true;
  }

  // Build the report's per-criterion rows, overriding any submitted status
  // that conflicts with a mechanical hard/property verdict.
  const provenById = new Map<string, CriterionVerdict>();
  for (const v of criterionVerdicts ?? []) {
    if (v.tier === 'hard' || v.tier === 'property') provenById.set(v.id, v);
  }
  let reportCriteria = args.criteria as ReportCriterion[] | undefined;
  if (reportCriteria && provenById.size > 0) {
    reportCriteria = reportCriteria.map((c) => {
      const proven = c.id ? provenById.get(c.id) : undefined;
      if (proven && proven.status !== c.status) {
        return {
          ...c,
          status: proven.status,
          reasoning:
            `[Mechanical verdict kept: ${proven.status}. Agent submitted "${c.status}", ` +
            `overridden by the deterministic check.] ${c.reasoning}`,
        };
      }
      return c;
    });
  }

  // Parallel override for SOFT rows whose persisted verdict is taint-clamped
  // (A1): the agent's submitted row must not display a pass the clamp above
  // refused to persist. Same shape as the mechanical override — the report is
  // a rendering of the persisted truth, never of the raw submission.
  const taintedSoftById = new Map<string, CriterionVerdict>();
  for (const v of criterionVerdicts ?? []) {
    if (v.tier === 'soft' && demotingTaintsOf(v).length > 0) taintedSoftById.set(v.id, v);
  }
  if (reportCriteria && taintedSoftById.size > 0) {
    reportCriteria = reportCriteria.map((c) => {
      const tainted = taintedSoftById.get(canonicalIdFor(c) ?? '');
      if (!tainted) return c;
      const clamped = applyEvidenceTaints(c.status, evidenceTaintsOf(tainted));
      if (clamped === c.status) return c;
      return {
        ...c,
        status: clamped,
        reasoning:
          `[Evidence tainted: ${demotingTaintsOf(tainted).join(', ')} — scored from a degraded ` +
          `render; recorded as ${clamped}.] ${c.reasoning}`,
      };
    });
  }

  // Same override for the NATIVE DATASTATE CLAMP (A2): a submitted soft `pass`
  // on a dataState-held criterion persists as `unverifiable` above, so its
  // report row must not display the pass either.
  if (reportCriteria && nativeHeldSoftIds.size > 0) {
    reportCriteria = reportCriteria.map((c) => {
      const id = canonicalIdFor(c);
      if (!id || !nativeHeldSoftIds.has(id) || c.status !== 'pass') return c;
      return {
        ...c,
        status: 'unverifiable',
        reasoning: `[${NATIVE_DATASTATE_UNSUPPORTED_DETAIL} — recorded as unverifiable.] ${c.reasoning}`,
      };
    });
  }

  // Effective headline verdict — never claim a pass the mechanical checks
  // contradict. Any hard/property fail forces `fail`; otherwise downgrade a
  // submitted `pass` to `partial` when a mechanical check is unverifiable.
  let effectiveVerdict = args.verdict;
  const mech = (criterionVerdicts ?? []).filter((v) => v.tier === 'hard' || v.tier === 'property');
  if (mech.some((v) => v.status === 'fail')) {
    effectiveVerdict = 'fail';
  } else if (effectiveVerdict === 'pass' && mech.some((v) => v.status === 'unverifiable')) {
    effectiveVerdict = 'partial';
  }

  // TAINT DOWNGRADE (A1): a clean headline can't rest on demoting-tainted
  // evidence. Keyed on the DEMOTING set (foundation rule) so `synthetic-data`
  // provenance alone never forces `partial`; a tainted fail stays fail
  // (nothing to downgrade — fail already blocks).
  let taintDowngradeReason: string | undefined;
  const taintedNonFail = (criterionVerdicts ?? []).filter(
    (v) => v.status !== 'fail' && demotingTaintsOf(v).length > 0,
  );
  if (effectiveVerdict === 'pass' && taintedNonFail.length > 0) {
    effectiveVerdict = 'partial';
    taintDowngradeReason = `evidence taints on ${taintedNonFail.map((v) => v.id).join(', ')}`;
  }
  // No-spec runs have no criterionVerdicts to carry the taint — still refuse a
  // clean green from a render under a degraded wrapper. URL mode never uses
  // the web wrapper (and native run-metas carry no `setup`), so only
  // isolation-mode runs can trip this.
  if (
    effectiveVerdict === 'pass' &&
    !spec &&
    (meta.mode ?? 'isolation') === 'isolation' &&
    meta.setup?.wrapperFidelity?.status === 'degraded'
  ) {
    effectiveVerdict = 'partial';
    taintDowngradeReason =
      'the render used a degraded wrapper (missing ' +
      `${meta.setup.wrapperFidelity.missingProviders.join(', ') || 'app providers'})`;
  }

  // The loop's stop signal, computed over the FINAL (soft-overridden) criterion
  // verdicts joined with the frozen spec for severity/threshold. `meta.signedOff`
  // still carries the VERIFY-TIME value (computed when soft criteria were
  // `unverifiable` placeholders), so refresh it BELOW before the timeline append
  // captures the scored state. Reused for the structuredContent loop signal.
  const signOffInputs = toSignOffCriteria(criterionVerdicts, spec ?? undefined);
  // requireFreshJudge (A6/1.5, opt-in, default OFF): a self-scored soft pass
  // cannot satisfy sign-off on its own. `submitConfig` is best-effort (see
  // above) — a broken/missing config reads as off, same posture as every
  // other submit-time config read here.
  const requireFreshJudge = submitConfig?.requireFreshJudge === true;
  const signedOff = computeSignedOff(signOffInputs, { requireFreshJudge });
  // Named reason for a requireFreshJudge block (surface, never re-gate): the
  // exact blocking soft passes `computeSignedOff` skipped over via
  // `selfScored`. Empty when the knob is off or nothing was blocked by it.
  const selfScoredBlockers = requireFreshJudge ? selfScoredSignOffBlockers(signOffInputs) : [];
  const requireFreshJudgeReason =
    selfScoredBlockers.length > 0
      ? `${selfScoredBlockers.length} soft pass${selfScoredBlockers.length === 1 ? '' : 'es'} ` +
        `${selfScoredBlockers.length === 1 ? 'is' : 'are'} self-scored; requireFreshJudge is on`
      : undefined;
  // VACUOUS SIGN-OFF (surface, never gate): sign-off achieved with ZERO blocking
  // criteria (an all-advisory spec) is technically "done" but proves nothing.
  // computeSignedOff legitimately returns true here (advisory-only specs must be
  // able to sign off); we only make it VISIBLE so a loop driver / reviewer knows
  // the green rests on no blocking check.
  const blockingCount = signOffInputs.filter((c) => c.severity !== 'advisory').length;
  const vacuousSignoff = signedOff && blockingCount === 0;
  // CRITERION WEAKENING (surface, never gate): a re-frozen v+1 that relaxed a
  // check vs its predecessor (tier hard→soft, blocking→advisory, threshold
  // lowered). Advisory only — named so a silent bar-drop is visible.
  const weakened = spec ? weakenedSincePrevVersion(projectRoot, spec) : null;

  // Persist the agent's soft scores back to run-meta + refresh the per-spec
  // regression timeline so `spec_get` reflects the final verdict, not the
  // verify-time placeholders.
  if (verdictsChanged) {
    // Refresh the stop signal too: `meta.criterionVerdicts` now holds the
    // agent's folded soft scores, so the verify-time `meta.signedOff` is stale.
    // Set it to the final post-scoring value BEFORE the timeline append so the
    // per-spec history records the SCORED sign-off, not the placeholder.
    meta.signedOff = signedOff;
    try {
      writeFileAtomic(runMetaPathFor(projectRoot, meta.runId), JSON.stringify(meta, null, 2));
      // Re-index only spec runs — the per-spec timeline keys off specId. A
      // non-spec run still persists its run-meta (e.g. the contract-version
      // stamp) but has no timeline to refresh. This re-append carries the
      // SCORED sign-off, so the committed-history twin (F2) rides it too.
      if (meta.specId) {
        indexRunForSpec(projectRoot, meta, {
          historyCommitted: submitConfig?.historyCommitted,
        });
      }
    } catch {
      // Non-fatal — the report still renders; the timeline just keeps the
      // verify-time entry.
    }
  }

  // SOFT SCORES ON SUBMIT (B3). Until now submit_report wrote the agent's soft
  // scores to run-meta only — the durable scorecard kept its `unscored` rows
  // and its open `needs-scoring` signal for criteria the agent had just
  // scored, unless the agent ALSO called record_soft_scores. The judgments now
  // go through the SAME citation gate + `applySoftScores` merge that tool uses,
  // so nothing is laundered and a later record_soft_scores for the same run is
  // idempotent (applySoftScores replaces per criterion).
  const softOutcome =
    spec && meta.specId
      ? applySubmittedSoftScores({
          projectRoot,
          spec,
          meta,
          criterionVerdicts,
          submitted: args.criteria ?? [],
          scoredBy: args.scoredBy,
          sessionFingerprint: SESSION_FINGERPRINT,
          historyCommitted: submitConfig?.historyCommitted,
        })
      : undefined;

  // EVIDENCE ASSEMBLY (C1) — built over the FINAL (soft-folded, taint-clamped)
  // verdicts, exclusively from persisted verify-time facts. HARD RULE (gate
  // integrity): nothing in `SubmitReportArgs` reaches `buildEvidenceMap` or
  // `buildNotCovered`; the only agent-influenced input (`screenshotCitations`)
  // was validated against run-meta render ids by the quality floor above.
  const evidence = buildEvidenceMap({ meta, spec });
  const notCovered = buildNotCovered(meta, submitConfig);

  // Label each submitted criterion row with its spec tier so the evidence
  // line can say "judge: mechanical" vs. the scored-by chip.
  if (reportCriteria && spec) {
    reportCriteria = reportCriteria.map((c) => {
      const specCriterion = spec.criteria.find(
        (cc) => (c.id && cc.id === c.id) || cc.text === c.description,
      );
      return specCriterion ? { ...c, tier: specCriterion.tier } : c;
    });
  }

  // Temporal binding (B2), repo Validity Score chip (F1), spec-context panel:
  // all display-only, all shared with the preliminary report via the helpers.
  // `temporal`/`temporalSpecRef` + `repoScore` are also read by the
  // structuredContent siblings below, so they're bound here (not buried inside
  // assembleReportInput).
  const { temporal, specRef: temporalSpecRef } = resolveReportTemporal(projectRoot, meta, spec);
  const repoScorecard = loadScorecard(projectRoot);
  const repoScore = computeValidityScore(repoScorecard);

  // PRIOR-RUN SOFT-SCORE DIFFS (display-only): enrich the verify-time regression
  // list (hard/property rows) with SOFT rows for criteria whose folded status
  // changed vs. the previous scored run, read from that run's report-meta on
  // disk. In-memory only — `meta.regressionDeltas` on disk stays untouched.
  const regressionDeltas = enrichRegressionDeltasWithPriorSoft({
    projectRoot,
    meta,
    criterionVerdicts,
  });

  const reportInput = assembleReportInput({
    projectRoot,
    meta,
    submitConfig,
    components: buildReportComponentsFromMeta(meta),
    verdict: effectiveVerdict,
    summary: args.summary,
    criteria: reportCriteria,
    fileNotes: args.fileNotes,
    // Run-level scoring provenance (A3/A6) — drives the judge chips/badges.
    scoring: meta.scoring,
    criterionVerdicts,
    evidence,
    notCovered,
    temporalBinding: temporal?.classification,
    validityScore: buildValidityScoreChip(repoScorecard),
    specContext: buildReportSpecContext(projectRoot, meta, spec, repoScorecard),
    // Sign-off note (display-only): the FINAL post-scoring stop signal, plus
    // whether it rests on an agent-scored soft pass. `attested` reads the same
    // projected inputs `computeSignedOff` saw, so it can't drift from `signedOff`.
    signOff: { signedOff, attested: signOffRestsOnSoft(signOffInputs) },
    regressionDeltas,
  });

  // Plan id can come from either the agent's explicit submit_report arg or
  // the run-meta written by verify (which captured args.planId at that
  // point). Prefer the explicit arg so the agent can override.
  const resolvedPlanId = args.planId ?? meta.planId ?? meta.specId;
  // resolvePlan is spec-aware (spec ids resolve through the spec store and
  // adapt to the plan shape); guard so a stale id can't throw inside report.
  let plan: ValidityPlan | null = null;
  try {
    plan = resolvedPlanId ? resolvePlan(projectRoot, resolvedPlanId) : null;
  } catch {
    plan = null;
  }
  // Render + write the three artifacts (shared with the preliminary report).
  // The sidecar report-meta.json captures the agent's scoring inputs so
  // downstream tooling (`validity export`) can recover the verdict + criteria
  // + fileNotes without re-running the agent. A render throw is CAPTURED (not
  // thrown) so we can still tell the user how to view the raw screenshots.
  const { reportPath, markdownPath, renderError, markdownReady } = writeReportArtifacts({
    projectRoot,
    runId: meta.runId,
    reportInput,
    reportMeta: {
      runId: meta.runId,
      verdict: args.verdict,
      summary: args.summary,
      criteria: args.criteria,
      fileNotes: args.fileNotes,
      submittedAt: new Date().toISOString(),
      // Audit-trail link to the upfront plan.
      planId: resolvedPlanId ?? undefined,
      planCriteria: plan?.criteria,
      // Judging provenance (A6) — mirrors meta.scoring for downstream tooling.
      judgeMode,
      scoredBy: args.scoredBy,
      selfScored,
    },
  });
  if (renderError) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Failed to render report.html (${renderError}).\n\n` +
            `The screenshots from this run are still on disk. To view them:\n` +
            `  ${reportInput.viewCommand}\n\n` +
            `Then open http://127.0.0.1:8080/ in your browser to browse the run dir.`,
        },
      ],
    };
  }

  // Lead with a clickable file:// URL — the report is self-contained
  // (inline CSS/JS, sibling screenshots referenced by relative path) so
  // most browsers open it without needing a local server. Mention the
  // http-server fallback for browsers that block local file access.
  const reportFileUrl = pathToFileURL(reportPath).href;

  const lines = [
    `Report: ${reportFileUrl}`,
    `(If your browser blocks local files, run \`${reportInput.viewCommand}\` and open http://127.0.0.1:8080/report.html instead.)`,
  ];
  if (markdownReady) {
    lines.push(`Markdown report (paste-friendly): ${markdownPath}`);
  }
  if (fingerprintSelfScored) {
    lines.push(
      'WARNING: scored in the same session that ran verify — self-scoring is a weak signal; ' +
        'prefer a fresh-context judge. (Not blocked.)',
    );
    if (judgeMode === 'fresh-context') {
      lines.push(
        "WARNING: scoring.judge is 'fresh-context' but this scoring came from the builder — it " +
          'does NOT satisfy the configured posture. Re-score from a clean context ' +
          `(validity judge-pack ${meta.runId}). (Not blocked.)`,
      );
    }
  } else if (unprovenJudge) {
    lines.push(
      `WARNING: scoring.judge is '${judgeMode}' but no scoredBy was provided — the judge identity ` +
        `is unrecorded, so ${judgeMode} judging cannot be confirmed. Badged as self-scored. ` +
        '(Not blocked.)',
    );
  }
  if (requireFreshJudgeReason) {
    lines.push(
      `NOTE: not signed off — ${requireFreshJudgeReason}. Re-score from a fresh context ` +
        `(validity judge-pack ${meta.runId}) or an automated model judge to clear this.`,
    );
  }
  if (taintDowngradeReason) {
    lines.push(
      `NOTE: verdict downgraded to partial — ${taintDowngradeReason}. ` +
        'Fix the setup (see the Setup health block on verify), then re-verify and re-score.',
    );
  }
  if (vacuousSignoff) {
    lines.push(
      'NOTE: signed off VACUOUSLY — this spec has no blocking criteria (all advisory), so ' +
        'sign-off proves nothing was actually gated. Add at least one blocking criterion ' +
        '(typecheck/a11y anchors, or promote a soft criterion) if you want a real bar. (Not blocked.)',
    );
  }
  if (weakened) {
    lines.push(
      `NOTE: ${weakened.weakenings.length} criterion(s) were WEAKENED since v${weakened.fromVersion} ` +
        '(a check was relaxed on re-freeze — a prior fail can now read as a pass):',
    );
    for (const w of weakened.weakenings) lines.push(`  • ${w.detail}`);
    lines.push('Confirm these downgrades were intended. (Not blocked.)');
  }
  if (citationWarnings.length > 0) {
    lines.push(
      `NOTE: ${citationWarnings.length} soft pass(es) cite a render outside this spec's targets:`,
    );
    for (const w of citationWarnings) lines.push(`  • ${w}`);
    lines.push('Confirm the screenshot is of the component under test. (Not blocked.)');
  }
  // The write-through receipt (B3), in one citable line.
  if (softOutcome) {
    lines.push(
      `Ledger: ${softOutcome.applied.length} soft score(s) written to the scorecard for ${meta.specId}` +
        (softOutcome.signalsResolved.length > 0
          ? ` · ${softOutcome.signalsResolved.length} signal(s) resolved`
          : '') +
        (softOutcome.rejected.length > 0
          ? ` · ${softOutcome.rejected.length} rejected (not applied)`
          : ''),
    );
    for (const r of softOutcome.rejected) lines.push(`  ✗ ${r.criterionId}: ${r.reason}`);
  }

  // Additive loop signal: `signedOff` (computed above over the FINAL
  // soft-overridden criterion verdicts joined with the frozen spec for
  // severity/threshold) is THE stop rule. Mechanical-override of
  // `effectiveVerdict` above is unchanged; this only ADDS structuredContent for
  // loop drivers. `taintedCriteria` (A3, sibling — `verdict` is a plain string
  // here) mirrors verify's `verdict.taintedCriteria`; key omitted when empty.
  const taintedCriteria = taintedCriteriaOf(criterionVerdicts ?? []);
  const wrapperFidelity = pickWrapperFidelity(meta.setup?.wrapperFidelity);
  return {
    content: [
      {
        type: 'text',
        text: lines.join('\n'),
      },
    ],
    structuredContent: {
      runId: meta.runId,
      // The FINAL report path, as a sibling key (mirrors verify's
      // `report.path`). The tool contract promises "returns a clickable
      // file:// URL", and the text content carries one — but a structured
      // consumer reading only structuredContent got nothing back, so the
      // scored report it just wrote appeared to have no artifact.
      // `preliminary: false` distinguishes it from verify's mechanical-only one.
      report: { path: reportFileUrl, preliminary: false as const },
      ...(markdownReady ? { reportMarkdownPath: markdownPath } : {}),
      verdict: effectiveVerdict,
      signedOff,
      // Vacuous sign-off (surface, never gate): present only when the green rests
      // on zero blocking criteria. Omitted otherwise so normal payloads are
      // byte-identical.
      ...(vacuousSignoff ? { vacuousSignoff: true } : {}),
      // requireFreshJudge block reason (A6/1.5, surface — computeSignedOff
      // already refused these criteria; this only NAMES why). Omitted when the
      // knob is off or nothing was blocked by it, so normal payloads stay
      // byte-identical.
      ...(requireFreshJudgeReason
        ? {
            requireFreshJudgeBlocked: {
              count: selfScoredBlockers.length,
              reason: requireFreshJudgeReason,
            },
          }
        : {}),
      // Criterion weakening (surface, never gate): criteria relaxed since the
      // prior frozen version. Omitted when nothing weakened.
      ...(weakened
        ? { weakenedSince: { fromVersion: weakened.fromVersion, criteria: weakened.weakenings } }
        : {}),
      // Cross-component citation notes (advisory): soft passes citing a render
      // outside the spec's targets. Omitted when clean.
      ...(citationWarnings.length > 0 ? { citationWarnings } : {}),
      // Display-only provenance (B1) — mirrors verify's `verdict.planned`.
      planned: isRunPlanned(meta),
      scoredBy: args.scoredBy,
      selfScored,
      judgeMode,
      // Which rubric produced these scores (E2.2). Add-only, never a gate.
      rubricVersion: submitRubricVersion,
      rubricVersionAssumed: submitRubricAssumed,
      // WRITE-THROUGH RECEIPT (B3): what this submit did to the durable
      // scorecard. Present whenever a frozen spec was in scope, even when
      // nothing was applied — "0 applied, here is why" is the answer an agent
      // needs. Nothing here feeds `verdict`/`signedOff`.
      ...(softOutcome
        ? {
            receipt: {
              runId: meta.runId,
              specId: meta.specId,
              softScoresApplied: softOutcome.applied.length,
              softScoresRejected: softOutcome.rejected,
              signalsRaised: softOutcome.signalsOpened,
              signalsResolved: softOutcome.signalsResolved,
            },
          }
        : {}),
      // Repo-level Validity Score (F1) — informational sibling key (§9.1).
      // Recomputed AFTER the soft-score write-through above, so it reflects
      // the scores this very submit landed (B3).
      validityScore: repoScore?.score ?? null,
      ...(taintedCriteria.length > 0 ? { taintedCriteria } : {}),
      // `setup.wrapperFidelity` (A1): "fix setup, not component" routing for
      // loop drivers. Mirrors the verify response's sibling key.
      ...(wrapperFidelity ? { setup: { wrapperFidelity } } : {}),
      // `temporal` (B2): spec-preceded-the-work provenance, sibling of the
      // verdict fields. Mirrors verify's sibling key; omitted without a spec.
      ...(temporal && temporalSpecRef
        ? { temporal: buildTemporalContent(temporal, temporalSpecRef) }
        : {}),
    },
  };
}

/**
 * The MCP tool definitions (name + description + JSON inputSchema), exported so
 * a docs-consistency test can assert the schema strings stay truthful — e.g.
 * the verify render cap quotes the real {@link MAX_RENDER_PAIRS} constant rather
 * than a hand-typed number that silently drifts. The runtime list handler below
 * just returns this.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'validity__verify',
    description:
      "Capture screenshots of the user's UI and return them with a scoring prompt for you to evaluate. " +
      'DEFAULT to isolation mode: pass only `prompt` (and optionally `changedFiles` / `scenarios`). ' +
      "Validity renders the changed React components in its own Vite sandbox using the project's `.validity/wrapper.tsx` — " +
      "it does NOT use the project's dev server, and you should NOT run `npm run dev` / `pnpm dev` / `yarn dev` for it. " +
      'For login-gated UI, seed cookies / localStorage / fetch handlers in `.validity/config.ts` scenarios and pass `scenarios: [...]` — do not start the real app to "log in". ' +
      'Use URL mode (pass `url` or `paths`) ONLY when (a) the user explicitly asked about a page, route, or full-app flow, AND (b) the user has already started their dev server themselves. ' +
      'URL mode supports non-Vite frameworks (Next, TanStack Start, Remix, Astro) and applies `mockNetwork` via Playwright route interception (browser-side fetches only — SSR data is not interceptable). ' +
      'Use NATIVE mode (pass `native: true`) for React Native / Expo native UI: it renders the changed component(s) on a booted simulator/emulator (the Validity companion) and returns the SAME run-meta + scoring rubric as isolation, so `submit_report` works the same — needs a booted device + the companion dev build (run `validity browse --native` once if prompted). ' +
      'On a React Native / Expo project NATIVE MODE IS AUTOMATIC — you do not need to pass `native: true`, and you must NOT reach for the react-native-web proxy (`webTarget: true`) to avoid a device build. That proxy renders a different runtime than the app ships on; use it ONLY when the user explicitly asked for the web target. ' +
      'In every mode, Validity does no LLM work — you (the host model) score the returned screenshots against the user prompt yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The original user prompt — Validity uses it verbatim in the scoring instructions returned to you.',
        },
        url: {
          type: 'string',
          description:
            'URL mode: capture this single URL (e.g. http://localhost:5173/dashboard). Mutually exclusive with `paths`.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'URL mode: list of paths to capture, joined against baseUrl. e.g. ["/", "/login", "/dashboard"].',
        },
        baseUrl: {
          type: 'string',
          description:
            'URL mode: explicit base URL for `paths`. Overrides the auto-detected one (read from scripts.dev in package.json).',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Isolation mode: explicit list of files to render. Falls back to `git diff HEAD` + untracked.',
        },
        scenarios: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Render under each named scenario from `.validity/config.ts`. Works in both modes: in isolation mode it ' +
            'multiplies (components × scenarios); in URL mode it multiplies (urls × scenarios). ' +
            'Use to compare states like ["logged-in", "logged-out"]. Omit (or pass []) for a single base render. ' +
            `Isolation-mode total (components × scenarios × fixtures × viewports) pairs are capped at ${MAX_RENDER_PAIRS}.`,
        },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
        planId: {
          type: 'string',
          description:
            "Plan/spec id from a prior `validity__plan` (or `validity__spec_freeze`) call. When set, the scoring rubric uses the persisted criteria instead of asking you to re-extract them from the prompt — locks build-time intent and verify-time scoring to the same contract. REQUIRED when `.validity/config.ts` sets `enforcement: 'strict'` (verify redirects you to plan first otherwise).",
        },
        native: {
          type: 'boolean',
          description:
            'Native mode: render the changed component(s) on a booted iOS Simulator / Android Emulator ' +
            '(the React Native companion) instead of the Vite sandbox. Selects targets like isolation mode ' +
            '(`changedFiles` / `scenarios`), drives them onto one pinned device in a single warm session, and ' +
            `writes the same run-meta so submit_report works unchanged. Capped at ${MAX_NATIVE_RENDER_TARGETS} ` +
            'renders per call (one device renders serially).',
        },
        webTarget: {
          type: 'boolean',
          description:
            'React Native / Expo ONLY: render through the Expo Web (react-native-web) proxy in the Vite ' +
            'sandbox instead of on a device. Off by default — an RN/Expo project verifies natively, because ' +
            'react-native-web composes onto DOM nodes and therefore proves something adjacent to, but not the ' +
            'same as, the shipped app. Pass this ONLY when the user explicitly asked for the web target ' +
            '("check it on web", "use Expo Web"). Never pass it because no simulator is booted or to save time — ' +
            'report the device requirement instead.',
        },
        platform: {
          type: 'string',
          enum: ['ios', 'android'],
          description:
            "Native mode only: device platform. Defaults to native.target in config, else 'ios'.",
        },
        device: {
          type: 'string',
          description:
            'Native mode only: simulator udid / emulator serial to pin the capture to. Auto-pinned with ' +
            'exactly one booted device; with several and no value the call returns a MULTIPLE_DEVICES error.',
        },
        scheme: {
          type: 'string',
          description:
            'Native mode only: URL-scheme override for the companion deep link. Defaults to a ' +
            'companion-unique derived scheme — pass only to override deliberately.',
        },
        reload: {
          type: 'boolean',
          description:
            'Native mode only: force a fresh JS bundle before the first render (stale-UI escape hatch after ' +
            'editing source). Validity also reloads automatically when the running bundle is provably stale.',
        },
        detail: {
          type: 'string',
          enum: ['full', 'lean'],
          description:
            "Response detail level. Omitted ⇒ auto: 'full' on the FIRST verify of a spec (you must see everything " +
            "once), 'lean' on later iterations once the spec has prior runs. Lean keeps the proven verdicts, " +
            'regression deltas, and structuredContent whole, but attaches ONLY the load-bearing screenshots: any ' +
            'render with a failing/unverifiable check, every render while a soft criterion still needs scoring, and ' +
            'anything pixel-changed vs the previous run. All-pass renders byte-identical to the previous run are ' +
            'omitted, component source is omitted unless a render errored, and soft criteria already scored on ' +
            "byte-identical evidence are carried forward explicitly (never re-judge them from memory). Pass detail:'full' " +
            'to see every screenshot + source. Presentation-only — verdicts, run-meta, and the gate are unchanged. ' +
            'No effect in URL mode (nothing can be proven unchanged there).',
        },
        lean: {
          type: 'boolean',
          description:
            "Deprecated alias for detail:'lean' (`detail` wins when both are set). Prefer `detail`.",
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'validity__plan',
    description:
      'Capture acceptance criteria for the user prompt BEFORE you do the work. You (the host model) ' +
      'extract structured criteria from the prompt; Validity validates the shape, compiles observable ' +
      'criteria into deterministic hard checks, and persists a FROZEN spec at ' +
      '`.validity/specs/<specId>/spec.yaml`. The returned id is a spec id — it works everywhere `planId` ' +
      'does. Pass it to `validity__verify` afterwards so the scoring rubric matches what you built ' +
      'against — no drift between "what I built for" and "what I\'m scoring against." Call this FIRST ' +
      'for non-trivial UI work where multiple requirements exist; skip for trivial tweaks (one-line ' +
      'styling changes, typos) where the ceremony costs more than it adds.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: "The user's original prompt. Stored verbatim for audit.",
        },
        criteria: {
          type: 'array',
          description:
            'Structured acceptance criteria you extracted from the prompt. Each criterion needs a stable id ' +
            '(slug-like, e.g. "primary-blue") + a human-readable description. The optional `observable` hints ' +
            'what kind of evidence resolves the criterion: visual / behavioral / console / a11y / network.',
          items: {
            type: 'object',
            required: ['id', 'description'],
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              observable: {
                type: 'string',
                enum: ['visual', 'behavioral', 'console', 'a11y', 'network'],
              },
            },
          },
        },
        componentPath: {
          type: 'string',
          description: 'Optional project-relative path of the component this plan targets.',
        },
        url: {
          type: 'string',
          description: 'Optional URL this plan targets (URL-mode verifies).',
        },
        projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['prompt', 'criteria'],
    },
  },
  {
    name: 'validity__get_config',
    description: 'Read the current resolved validity config (for debugging/visibility).',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string' },
      },
    },
  },
  {
    name: 'validity__catalog',
    description:
      "List the project's component / screen / view library — the deterministic answer to " +
      '"what components do I have?". Use it to explore before driving browse, or to confirm a ' +
      'path before validity__browse_open. Cheap read (a discovery walk + config); pass ' +
      '`includeProps` for prop-type summaries. Filter with `kind` and/or `query`.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['component', 'screen', 'view'],
          description: 'Optional filter to one kind.',
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on name/path.',
        },
        includeProps: {
          type: 'boolean',
          description: 'Include prop-type summaries per entry (slower). Default false.',
        },
        projectRoot: { type: 'string', description: 'Absolute path; defaults to the MCP cwd.' },
      },
    },
  },
  {
    name: 'validity__resolve',
    description:
      'Resolve a casual name ("button", "the login form", "/dashboard") to a concrete library ' +
      'entry path. Use this to turn what the user said into the right path before ' +
      'validity__browse_open. Returns a single confident match, or — on a tie — the candidate ' +
      'list so you can ask the user which one (it never guesses on ambiguity).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The casual name to resolve.' },
        projectRoot: { type: 'string', description: 'Absolute path; defaults to the MCP cwd.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'validity__tokens',
    description:
      "Read the project's design tokens (CSS custom properties + Tailwind theme) and their " +
      'source files. Use this when a designer asks for a visual change ("make the primary ' +
      'warmer", "bump the base radius") so you know which token to edit IN CODE. Validity is ' +
      'read-only here — it reports tokens + where they live; you make the edit in the source ' +
      'file, then re-render. Optional `group` filter (color/spacing/font/radius/shadow).',
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: 'Optional group filter: color | spacing | font | radius | shadow | other.',
        },
        projectRoot: { type: 'string', description: 'Absolute path; defaults to the MCP cwd.' },
      },
    },
  },
  {
    name: 'validity__native_browse',
    description:
      'Mount ONE component/screen in isolation on a booted iOS Simulator / Android Emulator ' +
      '(React Native / Expo), with the SAME mocked network/nav/auth as web — then return a ' +
      'screenshot + accessibility snapshot. A component with multiple fixtures/variants ' +
      '(authored or inferred from a literal-union prop like `variant`) renders as a ' +
      'GALLERY by default — one scrollable frame showing every variant — so "show me my ' +
      'buttons" needs no fixture picking; pass `fixture` or `propOverrides` for a single ' +
      'render. Screens always render as a single full view. Pass `view` (not `component`) to ' +
      'mount an author-defined composition. Use it BOTH to "show me my ' +
      'Button in the simulator" AND to validate native UI ("build this feature and validate ' +
      'it works"): score the returned screenshot + a11y tree against the plan, just like ' +
      'validity__verify on web. Needs a booted device + the Validity playground dev build + ' +
      "agent-device; if they're missing, the tool returns one-time setup steps instead of " +
      'failing.',
    inputSchema: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          description:
            'Component/screen name or path to mount (resolved like validity__resolve). ' +
            'Mutually exclusive with `view`.',
        },
        view: {
          type: 'string',
          description:
            'Author-defined view (composition) name to mount as a stacked native composition. ' +
            'Mutually exclusive with `component` — pass exactly one. (Views used to be smuggled ' +
            'through `component`; this is the dedicated arg, matching web browse_navigate.)',
        },
        platform: {
          type: 'string',
          enum: ['ios', 'android'],
          description: "Device platform. Defaults to native.target in config, else 'ios'.",
        },
        scheme: {
          type: 'string',
          description:
            'URL scheme override for the deep link. Defaults to native.scheme in config, ' +
            "else a companion-unique derived scheme — do NOT pass the host app's own scheme " +
            '(both apps would register it and deep links could open the wrong app).',
        },
        device: {
          type: 'string',
          description:
            'Simulator udid / emulator serial to pin the capture to. Auto-pinned when ' +
            'exactly one device is booted; with several booted and no value, the call ' +
            'returns a MULTIPLE_DEVICES error listing the candidates.',
        },
        fixture: { type: 'string', description: 'Optional fixture name.' },
        scenario: {
          type: 'string',
          description:
            "Optional scenario id — seeds the screen's auto-mocked app contexts. Built-in " +
            "'logged-in' and 'logged-out' make useAuth()/auth-context hooks render in that " +
            'state with no config (so "show me this screen in a logged-in/out context" just ' +
            'works); any scenario in .validity/config.ts with a `native.context` overlay also ' +
            'applies. Omit to render in the default (logged-out-ish) state.',
        },
        propOverrides: {
          type: ['object', 'null'],
          description: 'Optional explicit prop values (same contract as web propOverrides).',
          additionalProperties: true,
        },
        reload: {
          type: 'boolean',
          description:
            'Force a fresh JS bundle before rendering (a cheap in-place reload when the ' +
            'companion is live; terminate + cold relaunch only as the last resort). Set this ' +
            'after editing source files if the screenshot shows STALE UI — the change not ' +
            'appearing means Fast Refresh did not reach the device. Validity also reloads ' +
            'automatically whenever the running bundle is provably stale (generated content ' +
            'changed under a connected companion).',
        },
        projectRoot: { type: 'string', description: 'Absolute path; defaults to the MCP cwd.' },
      },
      // One of `component` / `view` is required, enforced in the handler
      // (JSON Schema can't express the mutual-exclusion cleanly).
    },
  },
  {
    name: 'validity__browse_open',
    description:
      'WEB browser preview (Vite / Next / Expo WEB). **If this is a React Native / Expo ' +
      'app and the user wants to SEE it (a component, screen, or VIEW), use ' +
      'validity__native_browse instead — it renders on the simulator. Do NOT use this ' +
      'web tool for a native app.** ' +
      'Launches (or reuses) a persistent browse-mode dev server and opens the ' +
      "user's default browser pointed at it. Use it to interactively inspect web UI with " +
      'you driving — switching components, applying scenarios, tweaking props. The dev ' +
      'server stays alive across calls; follow-ups go through `validity__browse_navigate`. ' +
      'Returns the URL even if the browser failed to launch.',
    inputSchema: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          description:
            'Project-relative path of a component to focus on initial load (e.g. ' +
            '"src/components/Button.tsx"). Appended to the URL as `?focus=<component>`. ' +
            'Omit to land on the browse index.',
        },
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the project root. Defaults to the MCP cwd.',
        },
        webTarget: {
          type: 'boolean',
          description:
            'React Native / Expo only: browse through the Expo Web (react-native-web) proxy instead ' +
            'of being redirected to validity__native_browse. Pass ONLY when the user explicitly asked ' +
            'for the web target — never to skip a simulator build.',
        },
      },
    },
  },
  {
    name: 'validity__browse_navigate',
    description:
      'WEB browse only. **For a React Native / Expo app, use validity__native_browse (it ' +
      'takes component OR view + scenario + propOverrides too) — not this.** ' +
      'Drive an already-open WEB browse session: switch component (or view), apply a ' +
      'scenario, override props, or change the viewport. Requires `validity__browse_open` ' +
      'was called for this projectRoot AND a browser tab is connected. Pass `view` (from ' +
      'validity__views_list) instead of `component` to render a view composition. ' +
      'Navigating to a component galleries ALL its fixtures/variants as frames on the ' +
      'canvas (literal-union props like `variant` are auto-enumerated) — no fixture ' +
      'picking needed for "show me my buttons".',
    inputSchema: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          description:
            'Project-relative path of the component to navigate to. One of `component` or `view` is required.',
        },
        view: {
          type: 'string',
          description:
            'Name of an author-defined view (see validity__views_list). When set, the canvas ' +
            'renders the view composition instead of a single component. Mutually exclusive with `component`.',
        },
        scenario: {
          type: 'string',
          description: 'Optional scenario id from `.validity/config.ts`.',
        },
        propOverrides: {
          type: ['object', 'null'],
          description:
            'Optional explicit prop values merged over the auto-mocked defaults. Pass null ' +
            'to clear any existing overrides on the page. Ignored when `view` is set.',
          additionalProperties: true,
        },
        viewport: {
          type: 'string',
          enum: ['desktop', 'tablet', 'mobile'],
          description: 'Optional viewport to switch the canvas to.',
        },
        projectRoot: {
          type: 'string',
          description:
            'Absolute path to the project root. Must match what was passed to validity__browse_open.',
        },
      },
    },
  },
  {
    name: 'validity__views_list',
    description:
      "List every author-defined view in the project's `.validity/config.ts`, with item " +
      'counts and the components each pulls in. Use this BEFORE recommending a view to ' +
      'render so the user sees what already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the project root. Defaults to the MCP cwd.',
        },
      },
    },
  },
  {
    name: 'validity__views_create',
    description:
      'Author a new browse-mode view — a named composition of components/screens rendered as ' +
      'separate device FRAMES on a single canvas. Use this when the user says things like ' +
      '"make a view that shows my Text with all sizing tokens", "give me a high-level overview ' +
      'of DashboardButton + FenChessboard", or "save this layout as a view". ' +
      'FRAMING (important): each item gets placed in a frame. Items without a `frame` auto-group ' +
      'by componentPath — variants of the SAME component cluster into ONE frame (e.g. all Text ' +
      'sizes = one spec-sheet frame), while DISTINCT components/screens each get their OWN frame ' +
      '(e.g. "my button + these two screens" = one Button frame + two screen frames). Set an ' +
      'explicit `frame` id to override: same id on different components groups them together, ' +
      'and distinct ids on one component split it across frames. ' +
      'ASK FIRST when the grouping is genuinely ambiguous (e.g. several different components and ' +
      "it's unclear whether they belong in one frame or separate ones) — confirm with the user " +
      'rather than guessing. ' +
      'IMPORTANT: if the view name collides with an existing component path, screen path, or ' +
      'view name, this tool returns a structured error listing the collisions — surface that ' +
      'to the user (do not invent your own explanation) before retrying with a different name ' +
      'or `force: true`. Component/screen path collisions are always rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Unique view name (alphanumerics, spaces, underscores, or hyphens; must start with an alphanumeric).',
        },
        title: { type: 'string', description: 'Optional display title (defaults to `name`).' },
        description: { type: 'string', description: 'Optional one-line description.' },
        layout: {
          type: 'string',
          enum: ['stack', 'grid'],
          description: 'Vertical column ("stack", default) or wrapped flex row ("grid").',
        },
        items: {
          type: 'array',
          description:
            'Items to render inside the view. Order is preserved. Each item is a component/screen ' +
            'path with optional fixture name, prop overrides, label, and frame group id.',
          items: {
            type: 'object',
            required: ['componentPath'],
            properties: {
              componentPath: {
                type: 'string',
                description: 'Project-relative component path (e.g. "src/Text.tsx").',
              },
              fixtureName: {
                type: 'string',
                description:
                  'Optional fixture name under `components[componentPath].fixtures` to source props from.',
              },
              props: {
                type: 'object',
                description: 'Optional explicit props. Win over fixture props when both present.',
                additionalProperties: true,
              },
              label: {
                type: 'string',
                description: 'Optional section header label shown above this item.',
              },
              frame: {
                type: 'string',
                description:
                  'Optional frame group id. Items sharing a `frame` render together in ONE ' +
                  'device frame; items without one auto-group by componentPath (same component ' +
                  'clusters into a frame, distinct components/screens get their own). Use to ' +
                  'group different components into one frame or split one component across frames.',
              },
            },
          },
        },
        force: {
          type: 'boolean',
          description:
            'Overwrite an existing view of the same name. Never bypasses collisions with component or screen paths.',
        },
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the project root. Defaults to the MCP cwd.',
        },
      },
      required: ['name', 'items'],
    },
  },
  {
    name: 'validity__views_delete',
    description:
      'Delete a view by name from `.validity/config.ts`. Idempotent — missing names succeed silently.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the view to delete.' },
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the project root. Defaults to the MCP cwd.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'validity__submit_report',
    description:
      'REQUIRED follow-up to validity__verify in both URL and isolation modes. After scoring the screenshots, ' +
      'call this tool with your verdict + per-criterion details + per-file notes describing what changed. ' +
      'Validity writes a self-contained HTML report (screenshots + diff + your commentary) to the run dir ' +
      'and returns a clickable file:// URL the user can open in their browser. ' +
      'Soft scores are badged by judge mode (`scoring.judge` in config): self-scored submissions get a ' +
      'SELF-SCORED badge + warning — visibility only, verdicts and sign-off never change. ' +
      'Skip only if `.validity/config.ts` has `report: false`.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description:
            'The runId returned by validity__verify (look in the response header line "Run: …").',
        },
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the project root. Must match what was passed to verify.',
        },
        verdict: {
          type: 'string',
          enum: ['pass', 'fail', 'partial'],
          description: 'Top-level verdict you reached after scoring.',
        },
        summary: {
          type: 'string',
          description:
            'Optional 1-paragraph human-friendly summary surfaced at the top of the report.',
        },
        criteria: {
          type: 'array',
          description: 'Per-criterion scoring. Mirror the JSON you emit to the user.',
          items: {
            type: 'object',
            required: ['description', 'status', 'reasoning'],
            properties: {
              id: {
                type: 'string',
                description:
                  'Stable criterion id (the AC-… id from the plan/spec). Pass it so the report can match your score to the upfront criterion and reconcile against any mechanical (hard-tier) verdict.',
              },
              description: { type: 'string' },
              status: { type: 'string', enum: ['pass', 'fail', 'unverifiable'] },
              reasoning: { type: 'string' },
              suggestion: { type: 'string' },
              screenshotIds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'For SOFT criteria: ids of the screenshot(s) you scored this verdict from. Required — ' +
                  'submit_report rejects a soft submission without valid citations. Use the Component id ' +
                  'printed above each screenshot in the verify response. Optional for hard/property criteria ' +
                  '(those are mechanically proven, not scored from a screenshot).',
              },
            },
          },
        },
        fileNotes: {
          type: 'object',
          description:
            'Map of project-relative file path → 1–3 sentence note describing the change you made. ' +
            'Surfaced alongside the diff in the report so a reader sees what & why per file.',
          additionalProperties: { type: 'string' },
        },
        planId: {
          type: 'string',
          description:
            'Optional plan/spec id from `validity__plan` (or `validity__spec_freeze`). Defaults to the id persisted in run-meta by `validity__verify`. Used to surface the upfront acceptance criteria alongside your verdict.',
        },
        scoredBy: {
          type: 'string',
          description:
            'Optional identifier of the model/agent doing the scoring (e.g. "claude-opus-4"). ' +
            'Persisted on each scored soft criterion for provenance. Use a DISTINCT model from the ' +
            'one that built the change; if it equals VALIDITY_BUILDER_MODEL the response flags ' +
            '`selfScored` (a warning, not a block).',
        },
        rubricVersion: {
          type: 'string',
          description:
            'Optional: the soft-scoring rubric version you scored against — the "Rubric version: ' +
            `<n>" marker in the Validity skill (currently "${RUBRIC_VERSION}"). Omit and Validity ` +
            'stamps its own current rubric with `rubricVersionAssumed: true`. Provenance only — ' +
            'it never changes a verdict, it just keeps scores from different rubrics comparable.',
        },
      },
      required: ['runId'],
    },
  },
  // Spec lifecycle tools (spec_create / review / update / freeze / list / get).
  // Defined in spec-tools.ts and spread in here so the ListTools handler
  // advertises them and the docs-consistency test sees one flat array.
  ...SPEC_TOOL_DEFINITIONS,
  ...SCORECARD_TOOL_DEFINITIONS,
  ...SIGNAL_TOOL_DEFINITIONS,
  ...ONBOARD_TOOL_DEFINITIONS,
] as const;

export async function startMcpServer(): Promise<void> {
  // Build-stamped version ('0.0.1+<sha>.<ts>' in shipped bundles, '+dev' from
  // tsc) — surfaced in the MCP handshake AND recorded to ~/.validity/
  // mcp-runtime.json so `validity doctor` can flag a host still running a
  // pre-reinstall server.
  const version = formatBuildVersion('0.0.1');
  const server = new Server({ name: 'validity', version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as ToolArgs;
    try {
      switch (request.params.name) {
        case 'validity__verify':
          return await handleVerify(args);
        case 'validity__plan':
          return await handlePlan((request.params.arguments ?? {}) as unknown as PlanArgs);
        case 'validity__get_config':
          return await handleGetConfig(args);
        case 'validity__catalog':
          return await handleCatalog((request.params.arguments ?? {}) as unknown as CatalogArgs);
        case 'validity__resolve':
          return await handleResolve((request.params.arguments ?? {}) as unknown as ResolveArgs);
        case 'validity__tokens':
          return await handleTokens((request.params.arguments ?? {}) as unknown as TokensArgs);
        case 'validity__native_browse':
          return await handleNativeBrowse(
            (request.params.arguments ?? {}) as unknown as NativeBrowseArgs,
          );
        case 'validity__browse_open':
          return await handleBrowseOpen(
            (request.params.arguments ?? {}) as unknown as BrowseOpenArgs,
          );
        case 'validity__browse_navigate':
          return await handleBrowseNavigate(
            (request.params.arguments ?? {}) as unknown as BrowseNavigateArgs,
          );
        case 'validity__views_list':
          return await handleViewsList(
            (request.params.arguments ?? {}) as unknown as ViewsListArgs,
          );
        case 'validity__views_create':
          return await handleViewsCreate(
            (request.params.arguments ?? {}) as unknown as ViewsCreateArgs,
          );
        case 'validity__views_delete':
          return await handleViewsDelete(
            (request.params.arguments ?? {}) as unknown as ViewsDeleteArgs,
          );
        case 'validity__submit_report':
          return await handleSubmitReport(
            (request.params.arguments ?? {}) as unknown as SubmitReportArgs,
          );
        case 'validity__spec_create':
          return await handleSpecCreate(request.params.arguments as never);
        case 'validity__spec_review':
          return await handleSpecReview(request.params.arguments as never);
        case 'validity__spec_update':
          return await handleSpecUpdate(request.params.arguments as never);
        case 'validity__spec_freeze':
          return await handleSpecFreeze(request.params.arguments as never);
        case 'validity__spec_list':
          return await handleSpecList(request.params.arguments as never);
        case 'validity__spec_get':
          return await handleSpecGet(request.params.arguments as never);
        case 'validity__score_soft_criteria':
          return await handleScoreSoftCriteria(request.params.arguments as never);
        case 'validity__record_soft_scores':
          return await handleRecordSoftScores(request.params.arguments as never);
        case 'validity__signals':
          return await handleSignals(request.params.arguments as never);
        case 'validity__onboard_enumerate':
          return await handleOnboardEnumerate(request.params.arguments as never);
        case 'validity__onboard_progress':
          return await handleOnboardProgress(request.params.arguments as never);
        case 'validity__onboard_report':
          return await handleOnboardReport(request.params.arguments as never);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      let prefix = 'Validity error';
      if (err instanceof UnknownScenarioError) prefix = 'Validity scenarios error';
      else if (err instanceof TooManyRenderPairsError) prefix = 'Validity request too large';
      return {
        isError: true,
        content: [{ type: 'text', text: `${prefix}: ${(err as Error).message}` }],
      };
    }
  });

  writeMcpRuntimeStamp({ version });
  const transport = new StdioServerTransport();
  // Sessions stay WARM across verify calls — that is the whole point of this
  // process being long-lived, and nothing here closes one between tools. This
  // is the other end of it: when the host closes the pipe or signals us, the
  // agent-device session is handed back so the DEVICE CLAIM goes with it.
  // Without that, every MCP session that ends leaves a claim file whose daemon
  // later exits, and the next run's readiness pass calls it a phantom claim.
  installNativeSessionShutdownHandlers();
  await server.connect(transport);
  // Chained AFTER connect: `server.connect` installs its own `onclose`, and
  // replacing it would drop the SDK's teardown.
  const sdkOnClose = transport.onclose?.bind(transport);
  transport.onclose = () => {
    sdkOnClose?.();
    void closeEstablishedNativeSessions();
  };
}
