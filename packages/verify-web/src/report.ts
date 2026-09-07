/**
 * HTML report renderer for a Validity run.
 *
 * The output is a complete HTML5 document, returned as a string. The caller
 * (the MCP server) writes it to disk; opening it in a browser shows the run
 * summary, screenshots, and diffs. Screenshots, fonts, CSS/JS, and the Validity
 * wordmark are all inlined, so the report is fully self-contained and always
 * shows its branding, even opened offline or from a file:// URL under a strict
 * CSP.
 *
 * Design notes:
 *   - The page is built with `@validity.ai/verify-report`: `pageShell` supplies the
 *     inlined fonts, the three-layer token CSS (dark base → OS light → explicit
 *     [data-theme]), the shared `v-` component vocabulary, and the sticky
 *     topbar carrying the ACTUAL wordmark. `reportCss()` below adds ONLY what
 *     this surface needs on top, and every value in it is a token.
 *   - The `report-*` class names are stable HOOKS: the embedded JS, the tests,
 *     and downstream tooling pin them, so they are never renamed. Where a hook
 *     is exactly a shared recipe (pill, chip, banner, panel) it is aliased onto
 *     `RECIPES.*` rather than re-declared — one copy, in @validity.ai/verify-report.
 *   - Every dynamic string is HTML-escaped via `esc()` (the shared one).
 *   - Carousels are scoped via a numeric instance id so multiple carousels
 *     on the page never collide.
 *   - Scripts are progressive enhancement only. Everything is readable with
 *     JS disabled: the first carousel slide ships `is-active`, evidence
 *     thumbnails fall back to their anchor + id label, and the JS-revealed
 *     controls (theme toggle, dashboard up-link, copy button) ship `hidden`.
 */

import {
  buildHandlerStub,
  computePerfHints,
  evidenceTaintsOf,
  perfTint,
  URL_MODE_DISCLOSURE,
  type CriterionVerdict,
  type DataProvenance,
  type DataState,
  type EvidenceTaint,
  type JudgeMode,
  type PerformanceMetrics,
  type UnmatchedRequest,
  type WrapperFidelityInfo,
} from '@validity.ai/verify-spec';
import {
  BREAKPOINT_MOBILE,
  FONT_MONO,
  FONT_SANS,
  GLYPHS,
  RADII,
  RECIPES,
  TYPE,
  chip,
  crumbs,
  esc,
  pageShell,
  statusPillKind,
  topbar,
  type Crumb,
  type NavItem,
  type PillKind,
} from '@validity.ai/verify-report';
import type {
  ReportDeviceEvidenceGroup,
  ReportDeviceEvidenceRecord,
  ReportReplayDivergence,
} from './report-run-evidence.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReportInput {
  runId: string;
  createdAt: string;
  prompt: string;
  scenarios: string[];
  verdict?: 'pass' | 'fail' | 'partial';
  summary?: string;
  /**
   * Render mode that produced this run. Default 'isolation' for backward
   * compat. URL mode shapes the screenshots section as pages-with-scenarios
   * and tweaks a few labels — no component source code, no fixture-suggestion
   * notice on empty renders. `'native'` (C1) is the native-playground path.
   */
  mode?: 'isolation' | 'url' | 'native';

  components: ReportComponent[];
  diff?: ReportDiff;
  fileNotes?: Record<string, string>;
  brand: 'validity' | 'none';
  viewCommand: string;

  /** Optional per-criterion details rendered after the diff section. */
  criteria?: ReportCriterion[];

  /**
   * Optional mechanical verdicts for the spec's hard/property criteria,
   * executed deterministically in the sandbox. Rendered in their OWN
   * "Proven (deterministic)" section, visually separated from the soft,
   * LLM-scored `criteria` above — a proven pass reads as proof, never as
   * opinion. Soft-tier entries here are ignored (they live in `criteria`).
   */
  criterionVerdicts?: CriterionVerdict[];

  /**
   * Coverage metrics for hard + property criteria (soft excluded).
   * Computed fresh from criterionVerdicts on report render (not persisted).
   * Example: { ratio: 0.8, hardPropertyTotal: 5, verifiableCount: 4 }
   * Omit when no hard/property criteria exist. When present, surfaced as a
   * footnote in the "Proven (deterministic)" section so a reader can see how
   * much of the contract was mechanically decided.
   */
  coverage?: {
    ratio: number; // [0, 1]
    hardPropertyTotal: number;
    verifiableCount: number;
  };

  /**
   * Optional auto-config orchestrator output. When present (and surfacing
   * something interesting — bootstrap, drift, warnings), the report
   * renders a "Setup" panel near the top so a reader can attribute
   * unexpected screenshots to setup changes.
   */
  setup?: ReportSetupHealth;

  /**
   * The render session's environment (toolchain, dev-server provenance,
   * app-manifest merge, Tailwind shim, dep pre-scan) — ONE record for the whole
   * session. Renders as a fact list inside the Setup panel, which is where a
   * reader already looks to decide how far to trust a screenshot.
   *
   * DISPLAY-ONLY. Absent on native/URL runs and on run-metas written before the
   * environment channel landed.
   */
  environment?: ReportEnvironment;

  /**
   * Drift a later `validity replay` observed against this run's recorded
   * journey, read from the run dir's `replay-divergence.json`.
   *
   * ADVISORY BY CONSTRUCTION and stated as such on the page: the file is written
   * AFTER the run was signed, by a command the run's key never authorized, so it
   * is not part of the attested evidence and it never touches a verdict,
   * coverage, or the gate. Presence-gated — absent adds zero bytes.
   */
  replayDivergence?: ReportReplayDivergence;

  /**
   * Device evidence bundles (perf metrics, frame health, network dump) captured
   * at verify time and/or after a `--keep-session` replay.
   *
   * CAPTURED, NEVER SCORED. The producers stamp `advisory-evidence-only` into
   * every record and no threshold exists anywhere in Validity that reads these
   * numbers. The section is rendered in wholly neutral tone — no status color,
   * no glyph from the verdict vocabulary — so it cannot be misread as a score.
   * Presence-gated — absent adds zero bytes.
   */
  deviceEvidence?: ReportDeviceEvidenceGroup[];

  /**
   * Optional git HEAD metadata captured at verify time. Renders as a small,
   * subtle line in the header so a reader can correlate the report to a
   * specific commit. Omitted when the project isn't a git repo.
   */
  git?: ReportGitInfo;

  /**
   * Optional per-criterion regression deltas vs. the previous run of the same
   * spec, for hard/property criteria only. Renders as a compact "Regression
   * vs. last run" strip in the prompt section — only criteria that changed
   * status are listed, with a directional arrow. DISPLAY-ONLY: this never
   * participates in the pass/fail gate. Absent on first run / non-spec
   * verifies / when nothing changed.
   */
  regressionDeltas?: ReportRegressionDelta[];

  /**
   * Scoring provenance for the run (A6). Drives the judge chip. `judgeModel`
   * (ADD-ONLY) is the provider/model string when an automated model judged the
   * soft criteria (`judge === 'model'`).
   */
  scoring?: { judge: JudgeMode; scoredBy?: string; selfScored?: boolean; judgeModel?: string };
  /** True when the run was captured without a plan/spec (B1). Badges UNPLANNED. */
  unplanned?: boolean;
  /** Cached Validity Score snapshot for the header (F1). */
  validityScore?: { score: number; asOf: string; formula: string };
  /** Per-criterion evidence, keyed by criterion id (C1). Assembled from run-meta. */
  evidence?: Record<string, ReportEvidence>;
  /** Coverage floor (percent, 0-100) the run was gated against (C1). */
  coverageFloorPercent?: number;
  /** Facts the renderer cannot derive: what was planned but NOT rendered (C1/A2). */
  notCovered?: { dataStates?: string[]; viewports?: string[] };
  /** Temporal-binding classification of the spec vs. the work (B2). Populated by Track 3. */
  temporalBinding?: 'frozen-before-work' | 'frozen-mid-work' | 'unknown';
  /**
   * Add-only: some specs in this run were `unknown` while others classified.
   * The chip keeps the known `temporalBinding` and names the unknown count.
   */
  temporalPartial?: true;
  temporalUnknownSpecs?: string[];

  /**
   * Where this run sits in the durable spec system. The one-off report is the
   * touch-point a user sees while working on a feature — this panel is what
   * ties it back to the spec's timeline (maturity, certification distance,
   * open signals, recent run history) instead of reading as a dead-end
   * artifact. Absent on unplanned runs; the renderer skips the panel.
   */
  specContext?: ReportSpecContext;

  /**
   * Sign-off standing for this run. DISPLAY-ONLY — never gates anything; the
   * renderer must not re-derive it. `signedOff` is `computeSignedOff`'s stop
   * signal; `attested` is true when that sign-off rests on ≥1 agent-scored soft
   * pass (a blocking soft criterion), so a green that leans on a judged opinion
   * reads "agent-attested — worth a human check" instead of full pass-proof.
   * Absent / `signedOff: false` renders nothing. ADD-ONLY.
   */
  signOff?: { signedOff: boolean; attested: boolean };

  /**
   * The run failed BEFORE any criterion could be decided — a broken sandbox, a
   * device that never rendered, a Metro that never came up. Renders as an
   * "Environment blocked — verdicts withheld" banner under the header.
   *
   * WHY IT EXISTS (handoff-2026-07-28): an env-blocked run's criteria all land
   * as `unverifiable`, which on the page is indistinguishable from a spec whose
   * checks simply could not decide. The reader was left to guess whether their
   * code was undecidable or their emulator was wedged. `cause`/`fixCommand`
   * come from the native `EnvironmentDiagnosis`; `message` is the raw error and
   * is the only required half, so a diagnosis-less failure still gets a banner.
   *
   * DISPLAY-ONLY and NEVER GREEN: it does not touch `verdict`, coverage, or any
   * criterion status. The banner is amber-framed by construction — there is no
   * code path that renders it in pass tones.
   */
  specError?: { message: string; cause?: string; fixCommand?: string };

  /**
   * Attestation stamp for this run (Ed25519, `core/src/attest.ts`). Rendered in
   * the FOOTER only — it is a receipt, not a verdict, and must never compete
   * with the headline. The digest covers run-meta + every screenshot's sha256,
   * so a reader can re-check the whole chain with
   * `validity attest verify <run-dir>`.
   *
   * These three values are the only part of the page that varies for otherwise
   * identical inputs; everything else the renderer emits stays byte-stable.
   */
  attestation?: { digest: string; signature: string; publicKey: string };
}

/** Input for the "Part of spec …" system-context panel. Display-only. */
export interface ReportSpecContext {
  specId: string;
  version?: number;
  /** Spec lifecycle status (draft | reviewed | approved | frozen …). */
  status?: string;
  /** Derived maturity level + the human-readable blockers to `certified`. */
  maturity?: {
    level: 'probation' | 'dev' | 'team' | 'certified' | (string & {});
    blockers?: string[];
  };
  /** Consecutive clean verifications at distinct commits (certification input). */
  cleanStreak?: number;
  /** Open signal-queue entries scoped to this spec. */
  openSignals?: Array<{ kind: string; severity?: string; criterionId?: string }>;
  /** runs.jsonl tail, oldest→newest. The current run is matched by runId. */
  history?: Array<{
    runId: string;
    createdAt: string;
    verdict: 'pass' | 'fail' | 'partial' | 'unknown';
    signedOff?: boolean;
  }>;
}

/**
 * Mirrors core's `EvidenceTaint` (A3). Widened with `(string & {})` so the
 * renderer never breaks on a future taint kind — an unknown value renders
 * verbatim under an "other" group.
 */
export type ReportEvidenceTaint = EvidenceTaint | (string & {});

/** Alias of core's canonical `DataProvenance` union (C1's local name). */
export type ReportDataProvenance = DataProvenance;

/**
 * Everything the evidence line renders for ONE criterion (C1). Assembled by the
 * caller from run-meta — NEVER from agent-submitted args.
 */
export interface ReportEvidence {
  /** Component/page ids whose screenshots back this verdict (citation ids). */
  screenshotIds?: string[];
  /** Render mode of the backing evidence; falls back to `input.mode`. */
  mode?: 'isolation' | 'url' | 'native';
  dataProvenance?: ReportDataProvenance[];
  /** Native only. Web renders omit (renders as nothing). */
  renderConfirmation?: 'confirmed' | 'unconfirmed';
  /** Judge identity — the display string the evidence builder derives from `ScorerProvenance` (`model ?? session`). */
  scoredBy?: string;
  /** True ⇒ badge "self-scored"; false ⇒ "fresh-context"; absent ⇒ no badge. */
  selfScored?: boolean;
  /** Taints (A3). Also drive the Not-validated grouping. */
  taints?: ReportEvidenceTaint[];
}

/** Report-shape for a per-criterion regression delta (mirrors core's `RegressionDelta`). */
export interface ReportRegressionDelta {
  criterionId: string;
  previousStatus?: 'pass' | 'fail' | 'unverifiable';
  currentStatus: 'pass' | 'fail' | 'unverifiable';
  delta: 'regressed' | 'improved' | 'unchanged' | 'new';
  /**
   * Prior-run context for this criterion, read from the previous run's
   * report-meta on disk (SOFT criteria only — the mcp-server attaches it when a
   * soft criterion's folded status changed vs. the last scored run). Lets the
   * strip say "UI regressed" vs. "different scorer": the prior receipt (status,
   * reasoning excerpt, scorer) sits beside the before/after transition.
   * DISPLAY-ONLY — never participates in the pass/fail gate.
   */
  prior?: { status: 'pass' | 'fail' | 'unverifiable'; reasoning?: string; scoredBy?: string };
}

export interface ReportGitInfo {
  sha: string;
  branch?: string;
  dirty: boolean;
}

/**
 * Report-shape twin of core's `RunEnvironment` — the render session's
 * environment, as the page needs it. Widened on `target`/`devServer` with
 * `(string & {})` so a future toolchain renders verbatim instead of breaking
 * the panel (same tolerance `ReportEvidenceTaint` takes).
 */
export interface ReportEnvironment {
  target: 'web' | 'expo-web' | 'next-web' | (string & {});
  devServer: 'cold' | 'reused-browse' | (string & {});
  tailwindShim?: boolean;
  appManifest?: string;
  depScanFailure?: string;
}

export interface ReportSetupHealth {
  status: 'fresh' | 'unchanged' | 'drift-resolved' | 'drift-warned' | 'manual-required';
  bootstrapped: boolean;
  /** Per-field drift reasons. Renderer suppresses 'silent' severity. */
  driftReasons: Array<{
    category: string;
    field: string;
    before: string | null;
    after: string;
    severity: 'silent' | 'warn' | 'block';
  }>;
  /** Files Validity wrote / preserved / forked during configuration. */
  generatedFiles: Array<{ path: string; action: 'wrote' | 'skipped' | 'preserved' | 'forked' }>;
  warnings: string[];
  manualSteps?: string[];
  /**
   * Wrapper-fidelity summary (A1). A `degraded` status is surfaced as a
   * setup-health warning so a reader can attribute a suspicious render to a
   * missing provider. Absent on runs written before A1 lands.
   */
  wrapperFidelity?: Pick<WrapperFidelityInfo, 'status' | 'missingProviders' | 'expectedProviders'>;
  /**
   * One-line description of `.validity/app-manifest.json`, written by the
   * `@validity.ai/verify-plugin-vite` Vite plugin from inside the user's REAL build.
   * Present only when the user installed that plugin.
   *
   * Strictly a record of what the manifest CONTAINS — it never claims the
   * sandbox mirrored any of it. The mirrored half is decided at sandbox boot
   * and lives in the run log (`DevServer.appManifest`); conflating the two
   * here would let a reader believe a fidelity improvement that may not have
   * happened. Absent on runs written before the plugin existed.
   */
  appManifest?: string;
  durationMs: number;
}

export interface ReportComponent {
  id: string;
  filePath: string;
  source?: string;
  renders: ReportRender[];
}

export interface ReportRender {
  scenarioId?: string;
  /** Fixture name for this render (when the component has fixtures defined). */
  fixtureId?: string;
  /**
   * Names of all fixtures rendered as siblings on the same page. When
   * set, this is the "stacked" path — one screenshot of all variants —
   * and the report shows it without scenario tabs/arrows since there's
   * nothing to switch between.
   */
  stackedFixtureIds?: string[];
  screenshotDataUrl?: string;
  renderError?: string;
  unmatchedUrls?: string[];
  /**
   * Structured form of `unmatchedUrls` — each unmatched request plus the
   * fabricated fallback body, rendered with a paste-ready handler stub. Falls
   * back to `unmatchedUrls` for run-metas written before this landed.
   */
  unmatchedRequests?: UnmatchedRequest[];
  /** True when the captured PNG looks suspiciously empty (likely missing fixture props). */
  looksEmpty?: boolean;
  /** Slug of another render of the same component this one is byte-equal to. */
  identicalTo?: string;
  /** `console.error` calls captured during this render. */
  consoleErrors?: ReportConsoleError[];
  /** Uncaught exceptions that escaped React error boundaries. */
  pageErrors?: ReportPageError[];
  /** Failed network responses (4xx/5xx). */
  networkErrors?: ReportNetworkError[];
  /** Viewport this render was captured at. Used as a tab label suffix. */
  viewport?: { width: number; height: number; name: string };
  /**
   * Pixel-diff vs. baseline metadata. NOT rendered in the HTML report (the
   * visual-diff banner was removed — specs are the first-class content);
   * `expect.screenshot` hard checks and the markdown one-liner still consume it.
   */
  baseline?: {
    sha?: string;
    takenAt: string;
    mismatchedPixels?: number;
    /** Data URL of the diff PNG, or a path the report can reference. */
    diffDataUrl?: string;
  };
  /** A11y violations captured. Rendered as a severity-tinted block. */
  a11yViolations?: ReportA11yViolation[];
  /**
   * Performance metrics measured for this render (web sandbox). Rendered as a
   * neutral, observational panel below the screenshot. Pass/fail against any
   * `expect.performance` budget is shown separately in the Proven section.
   */
  performance?: PerformanceMetrics;
  /** Where this render's data came from (A4/A2). Display-only. */
  dataProvenance?: DataProvenance[];
  /** Data-population state this render was forced into (A2). */
  dataState?: DataState;
  /** Native only: whether the device confirmed this render (A3). */
  renderConfirmation?: 'confirmed' | 'unconfirmed';
}

export interface ReportA11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  helpUrl?: string;
  nodes: number;
  /**
   * Bounded evidence slice mirrored from `A11yViolation.nodeDetails` (core).
   * Rendered as per-node sub-lines (selector + failure summary; the `html`
   * snippet is shown as text, never injected as markup).
   */
  nodeDetails?: Array<{ target: string; html?: string; failureSummary?: string }>;
}

export interface ReportConsoleError {
  text: string;
  url?: string;
  lineNumber?: number;
}

export interface ReportPageError {
  message: string;
  stack?: string;
}

export interface ReportNetworkError {
  method: string;
  url: string;
  status: number;
  statusText?: string;
}

export interface ReportDiff {
  files: ReportDiffFile[];
}

export interface ReportDiffFile {
  path: string;
  hunks: ReportDiffHunk[];
  binary?: boolean;
  byteSize?: number;
}

export interface ReportDiffHunk {
  header: string;
  lines: ReportDiffLine[];
}

export interface ReportDiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export interface ReportCriterion {
  /** Stable criterion id (from the spec/plan), when the caller supplies it. */
  id?: string;
  description: string;
  status: 'pass' | 'fail' | 'unverifiable';
  /** Criterion tier (C1) — labels the evidence line. Absent on legacy inputs. */
  tier?: 'hard' | 'property' | 'soft';
  reasoning: string;
  suggestion?: string;
  /**
   * Screenshot ids the host agent cited as the source of this soft verdict.
   * Absent on hard/property criteria (mechanically proven) and on legacy
   * submits written before the quality-floor requirement. Surfaced in the
   * report as "Scored from: <id>" so a reader can audit the trail.
   */
  screenshotIds?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cap to N lines; if more, render the rest inside a <details> "more lines" block. */
const HUNK_VISIBLE_LIMIT = 200;

/**
 * DOM-id-safe slug for anchor targets. Deterministic; collisions are
 * acceptable — anchors are best-effort navigation, never evidence.
 */
function slugifyDom(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

/** GitHub-slugger-lite for markdown heading links (best-effort navigation). */
function mdHeadingSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, '')
    .replace(/ /g, '-');
}

/** Evidence-line thumbnails per criterion are capped; the rest become "+N more". */
const EVIDENCE_THUMB_LIMIT = 4;

/** Fixed display order + honest labels for the Not-validated taint groups. */
const TAINT_GROUP_LABELS: Array<{ key: string; label: string }> = [
  { key: 'network', label: 'Network evidence was fabricated (permissive mock)' },
  { key: 'wrapper', label: 'Rendered under a degraded wrapper clone' },
  { key: 'synthetic-data', label: 'Data was synthetic (Proxy/auto-populate)' },
  { key: 'unconfirmed-render', label: 'Native render was never confirmed' },
  { key: 'dep-scan', label: 'Dependency pre-scan aborted (module graph unstable)' },
  { key: 'data-state', label: 'Data-state branch (loading/empty/error) never rendered' },
];
const UNKNOWN_TAINT_GROUP = 'checks did not execute / unknown';

/** Display labels for render data provenance (A4/A2). Proxy fallback reads amber. */
const DATA_PROVENANCE_LABELS: Record<DataProvenance, { label: string; tone: '' | 'amber' }> = {
  'declared-mock': { label: 'data: declared mock', tone: '' },
  'auto-populate': { label: 'data: auto-populate', tone: '' },
  'proxy-fallback': { label: 'data: Proxy fallback (unverified data)', tone: 'amber' },
  'dataState-forced': { label: 'data: dataState-forced', tone: '' },
};

function dataProvenanceChipFor(p: ReportDataProvenance): { label: string; tone: '' | 'amber' } {
  return DATA_PROVENANCE_LABELS[p] ?? { label: `data: ${p}`, tone: '' };
}

/** One small chip in the evidence line / render provenance strip. */
function evidenceChip(text: string, tone: '' | 'amber' | 'blue' | 'green' = ''): string {
  const mod = tone ? ` report-evidence-chip--${tone}` : '';
  return `<span class="report-evidence-chip${mod}">${esc(text)}</span>`;
}

/**
 * IDs proven mechanically (hard/property). A soft `criteria` row that duplicates
 * one of these is an agent copy-back (see SKILL.md) — it is folded out of the
 * per-criterion section and the summary count so a single proof is never counted
 * twice, once as proof and once as a scored opinion.
 */
function provenCriterionIds(input: ReportInput): Set<string> {
  const ids = new Set<string>();
  for (const v of input.criterionVerdicts ?? []) {
    if (v.tier === 'hard' || v.tier === 'property') ids.add(v.id);
  }
  return ids;
}

/** Soft `criteria` rows NOT already represented by a proven verdict of the same id. */
function dedupedSoftCriteria(input: ReportInput): ReportCriterion[] {
  const proven = provenCriterionIds(input);
  return (input.criteria ?? []).filter((c) => !(c.id && proven.has(c.id)));
}

/**
 * When submit_report REWROTE a submitted row because the agent's status conflicted
 * with a mechanical verdict, it prepends a bracketed audit note to the reasoning —
 * e.g. `[Mechanical verdict kept: fail. Agent submitted "pass", overridden by the
 * deterministic check.] <original reasoning>`. This returns that note (the text
 * INSIDE the leading brackets) — a receipt of an attempted false green — or
 * `undefined` when the reasoning carries no such override. Keying on the leading
 * bracket is submit_report's uniform annotation convention; it is display-only.
 */
function extractOverrideNote(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined;
  const trimmed = reasoning.trimStart();
  if (!trimmed.startsWith('[')) return undefined;
  const end = trimmed.indexOf(']');
  if (end === -1) return undefined;
  const note = trimmed.slice(1, end).trim();
  return note.length > 0 ? note : undefined;
}

/**
 * The override receipt for a proven verdict, read from the matching submitted soft
 * row (proven `CriterionVerdict`s carry the mechanical detail, but NOT the agent's
 * overridden claim — that lives only in `input.criteria[].reasoning`, reshaped by
 * submit_report). Returns the bracketed note so the Proven card can display it
 * alongside the mechanical detail. `undefined` when nothing was overridden.
 */
function overrideNoteForProven(input: ReportInput, id: string): string | undefined {
  const row = (input.criteria ?? []).find((c) => c.id === id);
  return row ? extractOverrideNote(row.reasoning) : undefined;
}

/**
 * NOTE: the blended union counter ("Criteria passed 3/4", proven verdicts UNION
 * de-duplicated soft criteria) lived here. It is gone on purpose — plan 1.3:
 * mechanical proof and judged opinion may never be summed into one number, since
 * that number cannot say which half the passes came from. `machineLaneCounts` +
 * `judgedLaneCounts` below are its honest replacement; their totals still sum to
 * the old union total by construction (the same two loops, unblended).
 */

/**
 * One lane's tally. `pass + fail + undecided === total`; the lane never mixes
 * with the other, which is the entire point (plan 1.3): a judged pass may not be
 * averaged into a machine-verified count, in either direction.
 */
interface LaneCounts {
  pass: number;
  fail: number;
  total: number;
}

/** MACHINE lane: the mechanical (hard/property) verdicts, verbatim. */
function machineLaneCounts(input: ReportInput): LaneCounts {
  const counts: LaneCounts = { pass: 0, fail: 0, total: 0 };
  for (const v of input.criterionVerdicts ?? []) {
    if (v.tier !== 'hard' && v.tier !== 'property') continue;
    counts.total++;
    if (v.status === 'pass') counts.pass++;
    else if (v.status === 'fail') counts.fail++;
  }
  return counts;
}

/** JUDGED lane: the de-duplicated soft criteria (an agent/model's read). */
function judgedLaneCounts(input: ReportInput): LaneCounts {
  const counts: LaneCounts = { pass: 0, fail: 0, total: 0 };
  for (const c of dedupedSoftCriteria(input)) {
    counts.total++;
    if (c.status === 'pass') counts.pass++;
    else if (c.status === 'fail') counts.fail++;
  }
  return counts;
}

type LaneStatus = 'pass' | 'fail' | 'partial' | 'empty';

/**
 * A lane's own status — never-false-green applies per lane: `pass` only when the
 * lane is non-empty and EVERY row in it passed; any fail dominates; anything
 * else (undecided/unverifiable rows) is partial, and an empty lane is ◌.
 */
function laneStatus(counts: LaneCounts): LaneStatus {
  if (counts.total === 0) return 'empty';
  if (counts.fail > 0) return 'fail';
  if (counts.pass === counts.total) return 'pass';
  return 'partial';
}

/** Shape-doubled lane vocabulary (house law: the WORD carries the status, hue confirms). */
const LANE_VIEW: Record<LaneStatus, { glyph: string; word: string }> = {
  pass: { glyph: GLYPHS.pass, word: 'pass' },
  fail: { glyph: GLYPHS.fail, word: 'fail' },
  partial: { glyph: GLYPHS.partial, word: 'partial' },
  empty: { glyph: GLYPHS.unverifiable, word: 'none' },
};

type EffectiveVerdict = 'pass' | 'fail' | 'partial' | 'unverified';

/**
 * Display grammar for the verdict hero — glyph + word, mirroring the dashboard
 * health hero (● pass · ✕ fail · ▲ partial · ◌ unverified). Color is
 * confirmation only; the glyph and word carry the verdict (house law).
 */
const HERO_VIEW: Record<EffectiveVerdict, { glyph: string; word: string }> = {
  pass: { glyph: GLYPHS.pass, word: 'Pass' },
  fail: { glyph: GLYPHS.fail, word: 'Fail' },
  partial: { glyph: GLYPHS.partial, word: 'Partial' },
  unverified: { glyph: GLYPHS.unverifiable, word: 'Unverified' },
};

/** Any backing evidence at all — soft criteria OR proven verdicts. */
function hasBackingEvidence(input: ReportInput): boolean {
  return (input.criteria?.length ?? 0) > 0 || (input.criterionVerdicts?.length ?? 0) > 0;
}

/**
 * The verdict the report actually shows. Honest by construction: a bare `pass`
 * with NO criteria and NO proven verdicts has nothing backing it, so it renders
 * `unverified` (◌, neutral) — never a green Pass (the never-false-green rule).
 * `fail` and `partial` always render as themselves. Null when no verdict was set.
 */
function effectiveVerdict(input: ReportInput): EffectiveVerdict | null {
  if (!input.verdict) return null;
  if (input.verdict === 'pass' && !hasBackingEvidence(input)) return 'unverified';
  return input.verdict;
}

/** Failing criteria (proven fails + soft fails), flattened for the copy-as-prompt affordance. */
function collectFailingCriteria(
  input: ReportInput,
): Array<{ id: string; title: string; suggestion?: string }> {
  const out: Array<{ id: string; title: string; suggestion?: string }> = [];
  for (const v of input.criterionVerdicts ?? []) {
    if ((v.tier === 'hard' || v.tier === 'property') && v.status === 'fail') {
      out.push({ id: v.id, title: v.detail ?? v.id });
    }
  }
  for (const c of dedupedSoftCriteria(input)) {
    if (c.status === 'fail') {
      out.push({ id: c.id ?? c.description, title: c.description, suggestion: c.suggestion });
    }
  }
  return out;
}

/**
 * Deterministic plain-text "fix prompt" listing the failing criteria — the text
 * a reader hands a coding agent. Pure function of the input: no dates, no
 * randomness, order preserved as collected (proven fails, then soft fails).
 */
function buildFixPromptText(
  failing: Array<{ id: string; title: string; suggestion?: string }>,
): string {
  const lines = ['Fix the following failing acceptance criteria from the Validity report:', ''];
  failing.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.id}] ${f.title}`);
    if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
  });
  return lines.join('\n');
}

/**
 * "Copy failing criteria as fix prompt" button. Ships `hidden` — it is a
 * clipboard affordance, useful only when scripts run, so the inline JS reveals
 * and wires it (and it stays invisible under scripts-disabled, which is
 * acceptable for a copy control). The prompt text is a static, esc()'d data
 * attribute so the bytes appear exactly once and the output stays deterministic.
 */
function renderFixPromptButton(input: ReportInput): string {
  const failing = collectFailingCriteria(input);
  if (failing.length === 0) return '';
  const text = buildFixPromptText(failing);
  return (
    `<button type="button" class="report-fix-prompt" data-fix-prompt="${esc(text)}" data-copy-done="Copied" hidden>` +
    `Copy failing criteria as fix prompt` +
    `</button>`
  );
}

/**
 * Taints for one criterion id: the assembled evidence entry wins; a raw
 * verdict falls back to `evidenceTaintsOf` (which normalizes the legacy
 * `networkTainted` boolean). Display-only.
 */
function taintsFor(
  input: ReportInput,
  id: string | undefined,
  verdict?: Pick<CriterionVerdict, 'networkTainted' | 'evidenceTaints'>,
): ReportEvidenceTaint[] {
  const fromEvidence = id ? input.evidence?.[id]?.taints : undefined;
  if (fromEvidence !== undefined) return fromEvidence;
  return verdict ? evidenceTaintsOf(verdict) : [];
}

/** Count of criteria whose evidence carries ANY taint (header badge). */
function taintedCriteriaCount(input: ReportInput): number {
  const tainted = new Set<string>();
  for (const v of input.criterionVerdicts ?? []) {
    if (taintsFor(input, v.id, v).length > 0) tainted.add(v.id);
  }
  for (const [id, ev] of Object.entries(input.evidence ?? {})) {
    if ((ev.taints?.length ?? 0) > 0) tainted.add(id);
  }
  return tainted.size;
}

/** Header pill (presence-gated badge) sharing the verdict row. */
function headerFlag(
  text: string,
  tone: 'amber' | 'blue' | 'green' | 'neutral',
  title?: string,
): string {
  const titleAttr = title ? ` title="${esc(title)}"` : '';
  return `<span class="report-flag report-flag--${tone}"${titleAttr}>${esc(text)}</span>`;
}

/**
 * Presence-gated badges for the ONE shared verdict pill row. Every later
 * populator (B1 `unplanned`, B2 `temporalBinding`, F1 `validityScore`) just
 * fills its `ReportInput` slot — the badge appears here without new markup.
 */
function headerFlags(input: ReportInput): string[] {
  const flags: string[] = [];
  const taintedCount = taintedCriteriaCount(input);
  if (taintedCount > 0) {
    flags.push(
      headerFlag(
        `tainted evidence: ${taintedCount}`,
        'amber',
        'Criteria whose evidence was fabricated or degraded — see "Not validated".',
      ),
    );
  }
  // NOTE: scoring provenance (model-judged / self-scored / fresh-context) is NOT
  // a flag pill any more — it belongs to the JUDGED lane, which is the only place
  // it means anything (see renderVerdictLanes). Keeping a duplicate pill here
  // would restate the same taint twice in one band.
  if (input.unplanned) {
    flags.push(
      headerFlag(
        'unplanned',
        'amber',
        'Verified without an upfront plan/spec — criteria were not frozen before the work.',
      ),
    );
  }
  if (input.temporalBinding === 'frozen-before-work') {
    flags.push(headerFlag(temporalChipLabel(input), 'green'));
  } else if (input.temporalBinding === 'frozen-mid-work') {
    flags.push(headerFlag(temporalChipLabel(input), 'amber'));
  } else if (input.temporalBinding === 'unknown') {
    flags.push(headerFlag(temporalChipLabel(input), 'neutral'));
  }
  if (input.validityScore) {
    flags.push(
      headerFlag(
        `validity score: ${input.validityScore.score}`,
        'blue',
        `${input.validityScore.formula} — as of ${input.validityScore.asOf}`,
      ),
    );
  }
  return flags;
}

/**
 * Provenance of the JUDGED lane — WHO scored the soft criteria, and how much
 * that is worth. Same precedence (and the same anti-laundering guard) the header
 * pill used before it moved into the lane: an independent model outranks a
 * self-score, a `judge:'model'` run the builder self-scored still reads
 * self-scored, and an unstamped run says so rather than implying independence.
 */
function judgedProvenance(input: ReportInput): {
  text: string;
  tone: '' | 'amber' | 'blue';
  title: string;
} {
  const scoring = input.scoring;
  if (scoring?.judge === 'model' && scoring.selfScored !== true) {
    const model = scoring.judgeModel ?? scoring.scoredBy;
    return {
      text: 'model-judged',
      tone: 'blue',
      title: `Soft criteria scored by an independent model${model ? ` (${model})` : ''}, not the building agent. Not machine proof.`,
    };
  }
  if (scoring?.selfScored === true) {
    return {
      text: 'self-scored',
      tone: 'amber',
      title:
        'Scored in the same session that ran verify — a weak signal; prefer a fresh-context judge.',
    };
  }
  if (scoring && scoring.selfScored === false) {
    return {
      text: 'fresh-context',
      tone: 'blue',
      title: 'Scored outside the building session.',
    };
  }
  // No run-level stamp. Two very different situations, and calling both the same
  // thing would lie: a CLI sweep (`verify --all`) has no model at all, so its
  // soft criteria are simply UNSCORED — advisory, never a pass. A run that DID
  // stamp per-criterion scorers but no run-level provenance is a partial record,
  // and that gap is worth flagging.
  const anyScorer = Object.values(input.evidence ?? {}).some((e) => e.scoredBy);
  if (anyScorer) {
    return {
      text: 'scorer provenance unrecorded',
      tone: 'amber',
      title:
        'Soft criteria were scored, but this run recorded no run-level provenance — treat them as unattributed opinion.',
    };
  }
  return {
    text: 'not scored',
    tone: '',
    title:
      'No judge ran for this report — soft criteria are advisory only and never count as a pass.',
  };
}

/** One lane block: eyebrow label, glyph + tabular count, status word, provenance note. */
function renderLane(args: {
  kind: 'machine' | 'judged';
  label: string;
  counts: LaneCounts;
  note: string;
  noteTone: '' | 'amber' | 'blue';
  noteTitle?: string;
  title: string;
}): string {
  const status = laneStatus(args.counts);
  const view = LANE_VIEW[status];
  const noteMod = args.noteTone ? ` report-lane-note--${args.noteTone}` : '';
  const noteTitleAttr = args.noteTitle ? ` title="${esc(args.noteTitle)}"` : '';
  return `<div class="report-lane report-lane--${args.kind} report-lane--${status}" title="${esc(args.title)}">
           <div class="report-section-label">${esc(args.label)}</div>
           <div class="report-lane-count"><span class="report-lane-glyph" aria-hidden="true">${view.glyph}</span><span class="report-lane-tally">${args.counts.pass}<span class="report-lane-total">/${args.counts.total}</span></span><span class="report-lane-word">${view.word}</span></div>
           <div class="report-lane-note${noteMod}"${noteTitleAttr}>${esc(args.note)}</div>
         </div>`;
}

/**
 * The TWO-LANE headline (plan 1.3). Machine-checked and judged results are never
 * blended into one rollup: each lane carries its own count, its own shape-doubled
 * status, and — for the judged lane — the provenance of whoever scored it. The
 * lanes are drawn differently on purpose: the machine lane is a solid, filled
 * card (proof); the judged lane is dashed and unfilled (house law — dashed means
 * unproven), so the distinction survives greyscale and a screenshot.
 *
 * PRESENTATION ONLY: both tallies are read from the same verdicts the rollup
 * already computed. Renders nothing when there is neither a criterion nor a
 * scoring stamp to report.
 */
function renderVerdictLanes(input: ReportInput): string {
  const machine = machineLaneCounts(input);
  const judged = judgedLaneCounts(input);
  if (machine.total === 0 && judged.total === 0 && !input.scoring) return '';
  const prov = judgedProvenance(input);
  return `<div class="report-lanes">
           ${renderLane({
             kind: 'machine',
             label: 'Machine-verified',
             counts: machine,
             note: 'deterministic checks',
             noteTone: '',
             title:
               'Hard and property criteria decided mechanically by Validity. Not scored by any model.',
           })}
           ${renderLane({
             kind: 'judged',
             label: 'Judged',
             counts: judged,
             note: prov.text,
             noteTone: prov.tone,
             noteTitle: prov.title,
             title: 'Soft criteria scored from screenshots — opinion, not machine proof.',
           })}
         </div>`;
}

function temporalUnknownSuffix(
  input: Pick<ReportInput, 'temporalPartial' | 'temporalUnknownSpecs'>,
): string {
  const n = input.temporalUnknownSpecs?.length ?? 0;
  if (!input.temporalPartial || n === 0) return '';
  return ` (${n} spec${n === 1 ? '' : 's'} unknown)`;
}

function temporalChipLabel(
  input: Pick<ReportInput, 'temporalBinding' | 'temporalPartial' | 'temporalUnknownSpecs'>,
): string {
  const base =
    input.temporalBinding === 'frozen-before-work'
      ? 'spec frozen before work'
      : input.temporalBinding === 'frozen-mid-work'
        ? 'spec frozen mid-work'
        : 'spec timing unknown';
  return base + temporalUnknownSuffix(input);
}

/**
 * Honesty footnote for the temporal-binding badge (B2): the classification is
 * provenance, not a gate, and a mid-work freeze deserves an explicit caveat.
 */
function temporalBindingNote(
  input: Pick<ReportInput, 'temporalBinding' | 'temporalPartial' | 'temporalUnknownSpecs'>,
): string {
  const binding = input.temporalBinding;
  if (!binding) return '';
  const caveat =
    binding === 'frozen-mid-work'
      ? 'The spec was frozen after work on this change began — its criteria may describe the implementation rather than the original intent.'
      : binding === 'unknown'
        ? 'The spec’s freeze timing could not be classified against this change.'
        : 'The spec was frozen before work on this change began.';
  const partial =
    input.temporalPartial && (input.temporalUnknownSpecs?.length ?? 0) > 0
      ? ` ${input.temporalUnknownSpecs!.length} spec${input.temporalUnknownSpecs!.length === 1 ? '' : 's'} in this run could not be classified.`
      : '';
  return `<div class="report-temporal-note">${esc(caveat)}${esc(partial)} Temporal binding is display-only provenance — it never changes a verdict.</div>`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/**
 * DISPLAY-ONLY sign-off note beside the verdict hero. Renders nothing unless the
 * run signed off (absent/false ⇒ '' — the verdict already carries failures, no
 * negative noise). Never reads as full pass-green: the WORDS carry the
 * distinction (house law — hue is confirmation only). An agent-attested sign-off
 * (rests on a judged soft pass) is flagged dashed (dashed = unproven) and says
 * "worth a human check"; a fully-mechanical sign-off says so plainly.
 */
function renderSignOffNote(input: ReportInput): string {
  const so = input.signOff;
  if (!so || !so.signedOff) return '';
  const attested = so.attested;
  // An attested sign-off scored by an INDEPENDENT model is still unproven-by-
  // machine (dashed frame stays), but it does NOT rest on the builder's own
  // word — so the note names the independent judge rather than "agent-attested".
  const modelJudged =
    attested && input.scoring?.judge === 'model' && input.scoring.selfScored !== true;
  const note = modelJudged
    ? 'signed off (model-judged) — an independent model scored the soft passes; worth a human check'
    : attested
      ? 'signed off (agent-attested) — worth a human check'
      : 'signed off — every blocking criterion proven mechanically';
  return `<div class="report-signoff report-signoff--${attested ? 'attested' : 'proven'}">
           <span class="report-signoff-check" aria-hidden="true">✓</span>
           <span class="report-signoff-note">${note}</span>
         </div>`;
}

/**
 * The breadcrumb row. Static crumbs only — the report is normally read from
 * file:// or a CI artifact, where any absolute link is a dead link. The spec
 * crumb names where this run sits without pretending to navigate there (the
 * "Part of spec …" panel below is the real destination, and the topbar's
 * up-link is the only navigation that exists, revealed over http(s) only).
 */
function renderCrumbs(input: ReportInput): string {
  const items: Crumb[] = [{ label: 'Validity report' }];
  if (input.specContext) items.push({ label: input.specContext.specId });
  items.push({ label: 'this run', here: true });
  return crumbs(items);
}

/**
 * Commit / branch / tree-state chips beside the run title.
 *
 * The tree-state chip is always drawn when git metadata exists, because its
 * absence is exactly the fact a reader needs: a dirty tree means the commit
 * named here is NOT what was verified. Dirty reads amber; clean reads plain —
 * never green, since a clean tree is not a verdict about anything.
 */
function renderGitChips(git: ReportGitInfo | undefined): string {
  if (!git) return '';
  const parts = [chip(git.sha.slice(0, 7), { title: `commit ${git.sha}` })];
  if (git.branch) parts.push(chip(git.branch, { title: 'branch' }));
  parts.push(
    git.dirty
      ? `<span class="v-chip v-chip--warn report-header-git-dirty" title="Uncommitted changes were present — the commit above is not exactly what was verified.">dirty</span>`
      : chip('clean', { title: 'Working tree matched the commit above.' }),
  );
  return `<div class="report-header-git">${parts.join('')}</div>`;
}

function renderHeader(input: ReportInput): string {
  const eff = effectiveVerdict(input);

  // The loudest element of the summary band: the effective verdict as a
  // Display-size, glyph-doubled hero (mirrors the dashboard health hero
  // grammar). Never-false-green — a pass with no backing evidence renders as
  // ◌ Unverified, muted, never green.
  const heroBlock = eff
    ? `<div class="report-hero report-hero--${eff}">
           <p class="report-hero-eyebrow">Verdict</p>
           <div class="report-hero-verdict"><span class="report-hero-glyph" aria-hidden="true">${HERO_VIEW[eff].glyph}</span>${esc(HERO_VIEW[eff].word)}</div>
           ${
             eff === 'unverified'
               ? `<p class="report-hero-note">A pass was reported, but this run recorded no criteria or proven checks to back it.</p>`
               : ''
           }
         </div>`
    : '';

  // The two-lane rollup that REPLACED the single blended counter: a
  // "Criteria passed N/M" that summed mechanical proofs and judged opinion into
  // one number was exactly the blend plan 1.3 forbids — a reader could not tell
  // which half the greens came from. Machine-verified and Judged now stand side
  // by side, each with its own status and (for Judged) its provenance.
  const lanes = renderVerdictLanes(input);

  // The blurb renders OUTSIDE the flex row (full content width) — the hero,
  // lanes, and flags share the top row; long summaries must never be
  // squeezed into a narrow column beside them.
  const summaryBlurb = input.summary
    ? `<div class="report-summary-blurb">${esc(input.summary)}</div>`
    : '';

  // Copy-as-fix-prompt affordance (JS-gated) — present only when something failed.
  const fixPromptButton = renderFixPromptButton(input);

  // DISPLAY-ONLY sign-off standing beside the hero (empty unless signed off).
  const signOffNote = renderSignOffNote(input);

  // Presence-gated flag pills (C1/B1/B2/F1). The verdict now leads as the hero,
  // so this row carries only the flags — later populators just fill their slot.
  const flags = headerFlags(input);
  const verdictRow =
    flags.length > 0 ? `<div class="report-verdict-row">${flags.join('')}</div>` : '';

  const summaryBand =
    heroBlock || lanes || signOffNote || fixPromptButton || verdictRow || summaryBlurb
      ? `<div class="report-summary">
           ${heroBlock}
           ${lanes}
           ${signOffNote}
           ${fixPromptButton}
           ${verdictRow ? `<div class="report-summary-badge">${verdictRow}</div>` : ''}
         </div>
         ${summaryBlurb}`
      : '';

  const temporalNote = temporalBindingNote(input);

  // The run identity block: the run id IS the page title (mono, breakable —
  // these ids are long and must never force a horizontal scrollbar), with the
  // ISO timestamp under it and the commit/branch/tree chips opposite.
  return `
    <header class="report-header">
      ${renderCrumbs(input)}
      <div class="report-header-row">
        <div class="report-header-meta">
          <div class="report-header-runid">${esc(input.runId)}</div>
          <div class="report-header-time">${esc(input.createdAt)}</div>
        </div>
        ${renderGitChips(input.git)}
      </div>
      ${summaryBand}
      ${temporalNote}
    </header>
  `;
}

/**
 * The "big picture" up-link, as the topbar's single nav item.
 *
 * STATIC markup shipped `hidden` — the report is usually opened from file:// or
 * unpacked from a CI artifact where no dashboard exists; the inline JS reveals
 * it only when the document is actually served over http(s) (see the
 * location.protocol gate in `JS`). A root-relative "/" lands on the dashboard
 * root regardless of the served report's path depth (/run/<id>/report,
 * /spec/<id>/report). NOT gated by `brand`: this is navigation, not branding —
 * `brand: 'none'` drops the wordmark, not the reader's path back to the
 * overview. No dynamic input, so nothing to esc().
 */
const DASHBOARD_NAV_ITEM: NavItem = {
  label: '↑ Project dashboard',
  href: '/',
  attrs:
    'class="report-header-dashlink" data-dashboard-link hidden ' +
    'title="Open this project’s Validity dashboard — health, signals, specs, trends"',
};

function renderPrompt(input: ReportInput): string {
  return `
    <section class="report-prompt">
      <div class="report-section-label">User prompt</div>
      <blockquote class="report-prompt-quote">${esc(input.prompt)}</blockquote>
      ${renderRegressionDeltasStrip(input)}
    </section>
  `;
}

/** Deterministic cap for a prior-run reasoning excerpt in the regression strip. */
const PRIOR_NOTE_LIMIT = 160;

/** Truncate a raw reasoning string to a fixed budget (+ ellipsis). Pure. */
function truncatePriorNote(note: string): string {
  return note.length > PRIOR_NOTE_LIMIT ? `${note.slice(0, PRIOR_NOTE_LIMIT)}…` : note;
}

/**
 * Current soft-criterion scorer for a delta row: the per-criterion scorer wins,
 * with the run-level scorer as the fallback. Used only to make a scorer CHANGE
 * legible against the prior run — never a gate input.
 */
function currentScorerFor(input: ReportInput, criterionId: string): string | undefined {
  return (
    input.criterionVerdicts?.find((v) => v.id === criterionId)?.scoredBy?.model ??
    input.scoring?.scoredBy
  );
}

/**
 * Quiet sub-line under a regression row carrying the PRIOR run's receipt for a
 * soft criterion: scorer attribution (with an explicit `X → Y` when the current
 * scorer differs, so "different scorer" reads distinctly from "same scorer, UI
 * regressed") and a deterministically-truncated prior reasoning excerpt. Every
 * dynamic string is esc'd; returns '' when there is nothing to show.
 */
function renderPriorReceipt(d: ReportRegressionDelta, currentScorer: string | undefined): string {
  const prior = d.prior;
  if (!prior) return '';
  const parts: string[] = [];
  if (prior.scoredBy) {
    const changed = Boolean(currentScorer) && currentScorer !== prior.scoredBy;
    const label = changed
      ? `scored by ${esc(prior.scoredBy)} → ${esc(currentScorer!)}`
      : `scored by ${esc(prior.scoredBy)}`;
    parts.push(
      `<span class="report-regression-scorer${changed ? ' report-regression-scorer--changed' : ''}">${label}</span>`,
    );
  }
  if (prior.reasoning) {
    parts.push(
      `<span class="report-regression-prior-note">${esc(truncatePriorNote(prior.reasoning))}</span>`,
    );
  }
  if (parts.length === 0) return '';
  return `<div class="report-regression-prior">${parts.join('')}</div>`;
}

/**
 * Compact "Regression vs. last run" strip — only criteria that CHANGED status
 * are listed, with a directional arrow (↓ regressed / ↑ improved / + new).
 * Returns '' on first run / non-spec verifies / when nothing changed, so the
 * strip is emitted only when there is something to say. DISPLAY-ONLY: this
 * never feeds the gate — it sits beside the verdict, not inside it.
 *
 * A row carrying `prior` (a SOFT criterion the mcp-server matched to the
 * previous scored run) additionally renders the prior receipt underneath, so a
 * reader can tell a real UI regression from a scorer swap. Rows without `prior`
 * render exactly as before.
 */
function renderRegressionDeltasStrip(input: ReportInput): string {
  const deltas = input.regressionDeltas;
  if (!deltas || deltas.length === 0) return '';
  const changed = deltas.filter((d) => d.delta !== 'unchanged');
  if (changed.length === 0) return '';

  const glyphFor = (delta: ReportRegressionDelta['delta']): string =>
    delta === 'regressed' ? '↓' : delta === 'improved' ? '↑' : '+';
  const rows = changed
    .map((d) => {
      const transition =
        d.delta === 'new'
          ? 'new (not in previous run)'
          : `${esc(d.previousStatus ?? '—')} → ${esc(d.currentStatus)}`;
      const line =
        `<span class="report-regression-arrow">${glyphFor(d.delta)}</span>` +
        `<span class="report-regression-id">${esc(d.criterionId)}</span>` +
        `<span class="report-regression-status">${transition}</span>`;
      if (!d.prior) {
        return `<li class="report-regression-row report-regression-row--${esc(d.delta)}">${line}</li>`;
      }
      const receipt = renderPriorReceipt(d, currentScorerFor(input, d.criterionId));
      return (
        `<li class="report-regression-row report-regression-row--${esc(d.delta)} report-regression-row--has-prior">` +
        `<div class="report-regression-line">${line}</div>` +
        receipt +
        `</li>`
      );
    })
    .join('');

  const regressed = changed.filter((d) => d.delta === 'regressed').length;
  const improved = changed.filter((d) => d.delta === 'improved').length;
  const isNew = changed.filter((d) => d.delta === 'new').length;
  const summary = `${regressed} regressed, ${improved} improved, ${isNew} new, ${
    deltas.length - changed.length
  } unchanged`;

  return `
    <div class="report-regression-strip">
      <div class="report-section-label">Regression vs. last run of this spec</div>
      <div class="report-regression-summary">${esc(summary)}</div>
      <ul class="report-regression-list">${rows}</ul>
    </div>
  `;
}

interface CarouselSlide {
  /** Optional data attribute for tests / styling. */
  dataAttr?: string;
  body: string;
}

/**
 * Render a generic carousel. `instanceId` must be unique per page so the
 * embedded JS targets the right buttons / bullets / slides.
 */
function renderCarousel(instanceId: number, slides: CarouselSlide[]): string {
  if (slides.length === 0) return '';

  // The FIRST slide ships `is-active` at render time so the diff section shows
  // it statically with scripts disabled (CSS hides non-active slides). The JS
  // re-asserts slide 0 on init, so this is byte-consistent with the JS path.
  const slidesHtml = slides
    .map((slide, idx) => {
      const dataAttr = slide.dataAttr ? ` ${slide.dataAttr}` : '';
      const active = idx === 0 ? ' is-active' : '';
      return `<div class="report-carousel-slide${active}" data-slide-index="${idx}"${dataAttr}>${slide.body}</div>`;
    })
    .join('');

  const bullets = slides
    .map(
      (_, idx) =>
        `<button type="button" class="report-carousel-bullet${idx === 0 ? ' is-active' : ''}" data-bullet-index="${idx}" aria-label="Go to slide ${idx + 1}"></button>`,
    )
    .join('');

  const showNav = slides.length > 1;

  return `
    <div class="report-carousel" data-carousel-id="${instanceId}" tabindex="0">
      <div class="report-carousel-track" data-carousel-track="${instanceId}">
        ${slidesHtml}
      </div>
      ${
        showNav
          ? `
        <div class="report-carousel-controls">
          <button type="button" class="report-carousel-prev" data-carousel-prev="${instanceId}" aria-label="Previous slide">&lsaquo;</button>
          <div class="report-carousel-bullets" data-carousel-bullets="${instanceId}">${bullets}</div>
          <button type="button" class="report-carousel-next" data-carousel-next="${instanceId}" aria-label="Next slide">&rsaquo;</button>
        </div>
      `
          : ''
      }
    </div>
  `;
}

/** Stable label for a render — combines scenario + fixture for readability. */
function renderLabelFor(render: ReportRender): string {
  let base: string;
  if (render.stackedFixtureIds && render.stackedFixtureIds.length > 0) {
    // Show count rather than the joined names — for 5+ fixtures, the names
    // are long and not all that informative as a tab label.
    base = `${render.stackedFixtureIds.length} fixtures stacked`;
  } else if (render.fixtureId && render.scenarioId) {
    base = `${render.scenarioId} · ${render.fixtureId}`;
  } else {
    base = render.fixtureId ?? render.scenarioId ?? 'base';
  }
  // Forced data-state renders (A2) get their own label segment — without it a
  // component's base render and its forced-state clone would share the label
  // 'base' and the scenario tabs couldn't tell them apart.
  if (render.dataState) {
    base = `${base} · data: ${render.dataState}`;
  }
  if (render.viewport) {
    return `${base} · ${render.viewport.name}`;
  }
  return base;
}

/**
 * Small provenance strip under a render (A2/A4/A3 stamps): forced data state,
 * data provenance, native render confirmation. Display-only chips; absent
 * fields render nothing (legacy runs are byte-identical).
 */
function renderProvenanceStrip(render: ReportRender): string {
  const chips: string[] = [];
  if (render.dataState) {
    chips.push(evidenceChip(`data state: ${render.dataState} (forced)`, 'blue'));
  }
  for (const p of render.dataProvenance ?? []) {
    // The forced-state chip above already says it — don't repeat.
    if (p === 'dataState-forced' && render.dataState) continue;
    const { label, tone } = dataProvenanceChipFor(p);
    chips.push(evidenceChip(label, tone));
  }
  if (render.renderConfirmation === 'confirmed') {
    chips.push(evidenceChip('render: confirmed', 'green'));
  } else if (render.renderConfirmation === 'unconfirmed') {
    chips.push(evidenceChip('render: UNCONFIRMED', 'amber'));
  }
  if (chips.length === 0) return '';
  return `<div class="report-render-provenance">${chips.join('')}</div>`;
}

function renderRenderBody(
  component: ReportComponent,
  render: ReportRender,
  isPrimary = false,
): string {
  const label = renderLabelFor(render);

  if (render.renderError) {
    return `
      <div class="report-render-error" data-render-error="${esc(label)}">
        <strong>Render error</strong>
        <pre>${esc(render.renderError)}</pre>
      </div>
    `;
  }

  // `data-shot` / `data-shot-primary` let the evidence-line thumbnails clone
  // this <img>'s src at DOMContentLoaded — the base64 bytes appear exactly
  // once in the document (byte-reuse guarantee).
  const shotAttrs =
    ` data-shot="${esc(component.id)}"` +
    (isPrimary ? ` data-shot-primary="${esc(component.id)}"` : '');
  const img = render.screenshotDataUrl
    ? `<img class="report-render-image"${shotAttrs} src="${esc(render.screenshotDataUrl)}" alt="Screenshot of ${esc(component.id)} (${esc(label)})" />`
    : '<div class="report-render-missing">No screenshot captured.</div>';

  // Empty-render heuristic — surface as a yellow notice so the user
  // knows the screenshot is suspect without digging through pixels.
  // The "Add a fixture in .validity/config.ts" hint is the actionable fix
  // for the by-far-most-common cause: a component rendered with `{}` props.
  const emptyNotice = render.looksEmpty
    ? `
      <div class="report-render-empty-notice" role="note">
        <strong>This screenshot looks empty.</strong>
        Likely cause: the component renders nothing with default props.
        Add a fixture in <code>.validity/config.ts</code>:
        <pre>components: {
  '${esc(component.filePath)}': {
    fixtures: {
      primary: { props: { /* … */ } },
    },
  },
}</pre>
      </div>
    `
    : '';

  // Identical-screenshot notice — shows when this render's pixels are
  // byte-equal to another render of the same component. Helps users
  // spot redundant scenarios / fixtures without manually diffing.
  const identicalNotice = render.identicalTo
    ? `
      <div class="report-render-identical-notice" role="note">
        Pixels identical to <code>${esc(render.identicalTo)}</code>.
        These render the same — the network/state mocks differ, but the
        rendered output doesn't. Consider whether you need both, or
        whether one needs a <code>play</code> function to drive it into
        a different visible state.
      </div>
    `
    : '';

  const unmatched =
    render.unmatchedRequests && render.unmatchedRequests.length > 0
      ? `
        <div class="report-render-unmatched">
          <div class="report-render-unmatched-label">Unmatched network requests — answered by the fallback (fabricated data)</div>
          <ul>
            ${render.unmatchedRequests
              .map(
                (r) => `<li>
                  <code>${esc(r.method)} ${esc(r.url)}</code>
                  <details class="report-render-unmatched-stub">
                    <summary>Promote to a declared mock</summary>
                    <pre><code>${esc(buildHandlerStub(r))},</code></pre>
                  </details>
                </li>`,
              )
              .join('')}
          </ul>
        </div>
      `
      : render.unmatchedUrls && render.unmatchedUrls.length > 0
        ? `
        <div class="report-render-unmatched">
          <div class="report-render-unmatched-label">Unmatched network requests</div>
          <ul>
            ${render.unmatchedUrls.map((u) => `<li><code>${esc(u)}</code></li>`).join('')}
          </ul>
        </div>
      `
        : '';

  const diagnostics = renderDiagnosticsBlock(render);
  const a11y = renderA11yBlock(render);
  const perf = renderPerformanceBlock(render);

  return `
    <div class="report-render-pane" data-render-label="${esc(label)}">
      ${img}
      ${renderProvenanceStrip(render)}
      ${emptyNotice}
      ${identicalNotice}
      ${unmatched}
      ${diagnostics}
      ${a11y}
      ${perf}
    </div>
  `;
}

/**
 * Friendly labels for each captured performance metric, in display order. Kept
 * here (not in core) because it's purely presentational.
 */
const PERF_METRIC_LABELS: Array<{ key: keyof PerformanceMetrics; label: string; unit: string }> = [
  { key: 'readyMs', label: 'Time to ready', unit: 'ms' },
  { key: 'loadMs', label: 'Page load', unit: 'ms' },
  { key: 'firstContentfulPaintMs', label: 'First contentful paint', unit: 'ms' },
  { key: 'mountMs', label: 'Initial render (mount)', unit: 'ms' },
  { key: 'updateMs', label: 'Slowest re-render (update)', unit: 'ms' },
  { key: 'updateTotalMs', label: 'Total re-render time', unit: 'ms' },
  { key: 'commitCount', label: 'React commits', unit: '' },
  // Last on purpose: harness cost, not the app's. Shown so a reader can tell a
  // slow component apart from a cold sandbox — the two used to be conflated in
  // `readyMs`, which is why it is now subtracted out.
  { key: 'harnessBootMs', label: 'Sandbox cold start', unit: 'ms' },
];

/**
 * Performance panel — measured numbers with ADVISORY threshold tinting plus
 * heuristic fix hints (D2). Never a verdict: only the value text tints (the
 * card stays the neutral surface — a fully-red card would read as a verdict
 * banner), the badge/legend state the advisory framing, and a perf budget's
 * pass/fail still lives exclusively in the Proven section. Returns '' when
 * nothing was measured (native renders, older sandbox).
 */
function renderPerformanceBlock(render: ReportRender): string {
  const perf = render.performance;
  if (!perf) return '';
  const rows = PERF_METRIC_LABELS.filter((m) => typeof perf[m.key] === 'number').map((m) => {
    const value = perf[m.key] as number;
    const display = m.unit ? `${value} ${m.unit}` : String(value);
    const tint = perfTint(m.key, value);
    const tintClass = tint === 'ok' ? '' : ` report-perf-metric-value--${tint}`;
    return `
      <li class="report-perf-metric-row">
        <span class="report-perf-metric-label">${esc(m.label)}</span>
        <span class="report-perf-metric-value${tintClass}">${esc(display)}</span>
      </li>`;
  });
  if (rows.length === 0) return '';
  const hints = computePerfHints(perf);
  const hintsBlock =
    hints.length === 0
      ? ''
      : `
    <ul class="report-perf-hints">
      ${hints
        .map(
          (h) => `
        <li class="report-perf-hint">
          <span class="report-perf-hint-sev report-perf-hint-sev--${esc(h.severity)}">${esc(h.severity)}</span>
          ${esc(h.message)}
        </li>`,
        )
        .join('')}
    </ul>`;
  return `
    <div class="report-render-performance" role="note">
      <div class="report-perf-banner-label">Performance
        <span class="report-perf-advisory-badge">advisory — not a verdict</span>
      </div>
      <ul class="report-perf-metric-list">${rows.join('')}</ul>
      ${hintsBlock}
      <div class="report-perf-legend">
        Advisory thresholds: React commits &gt;16&nbsp;ms amber / &gt;50&nbsp;ms red (60&nbsp;fps
        frame budget / long-task) · page timings &gt;1&nbsp;s amber / &gt;3&nbsp;s red. Measured on
        unthrottled hardware in the dev sandbox. Budget pass/fail lives in the Proven section only.
      </div>
    </div>
  `;
}

/**
 * A11y panel — severity-tinted (red for critical, amber for serious). Mirrors
 * the diagnostics block's visual hierarchy: header + bulleted issues.
 */
function renderA11yBlock(render: ReportRender): string {
  const list = render.a11yViolations ?? [];
  if (list.length === 0) return '';
  const hasCritical = list.some((v) => v.impact === 'critical');
  const tone = hasCritical ? 'critical' : 'serious';

  const items = list
    .map((v) => {
      const help = v.helpUrl
        ? ` <a href="${esc(v.helpUrl)}" target="_blank" rel="noreferrer">help</a>`
        : '';
      // Per-node evidence: selector + axe failure summary. The `html` snippet
      // is rendered as escaped text inside <code> — never injected as markup
      // (a malicious/strange snippet could otherwise break the report DOM).
      const details = (v.nodeDetails ?? [])
        .map((n) => {
          const summary = n.failureSummary ? ` — ${esc(n.failureSummary)}` : '';
          const html = n.html ? `<code class="report-a11y-node-html">${esc(n.html)}</code>` : '';
          return `
          <div class="report-a11y-node">
            <code class="report-a11y-node-target">${esc(n.target)}</code>${summary}${html ? ` ${html}` : ''}
          </div>`;
        })
        .join('');
      return `
        <li>
          <div class="report-a11y-line">
            <span class="report-a11y-impact report-a11y-impact--${esc(v.impact)}">${esc(v.impact)}</span>
            <code>${esc(v.id)}</code>
            ${v.nodes > 0 ? `<span class="report-a11y-nodes">${v.nodes} node${v.nodes === 1 ? '' : 's'}</span>` : ''}
          </div>
          <div class="report-a11y-desc">${esc(v.description)}${help}</div>${details ? `          <div class="report-a11y-nodes-list">${details}</div>` : ''}
        </li>`;
    })
    .join('');

  return `
    <div class="report-render-a11y report-render-a11y--${esc(tone)}" role="note">
      <div class="report-a11y-banner-label">A11y violations (${list.length})</div>
      <ul class="report-a11y-list">${items}</ul>
    </div>
  `;
}

/**
 * Diagnostics panel — console errors, uncaught page errors, failed network
 * responses. Rendered red-tinted to signal "the screenshot may look fine
 * but something fired during render." If a reader sees this panel, they
 * should NOT mark the render pass without understanding what fired.
 */
function renderDiagnosticsBlock(render: ReportRender): string {
  const consoleErrors = render.consoleErrors ?? [];
  const pageErrors = render.pageErrors ?? [];
  const networkErrors = render.networkErrors ?? [];
  if (consoleErrors.length === 0 && pageErrors.length === 0 && networkErrors.length === 0) {
    return '';
  }

  const sections: string[] = [];

  if (pageErrors.length > 0) {
    const items = pageErrors
      .map(
        (e) => `
          <li>
            <div class="report-diag-line">${esc(e.message)}</div>
            ${e.stack ? `<details class="report-diag-details"><summary>stack</summary><pre>${esc(e.stack)}</pre></details>` : ''}
          </li>`,
      )
      .join('');
    sections.push(`
      <div class="report-diag-section">
        <div class="report-diag-heading">Uncaught errors (${pageErrors.length})</div>
        <ul class="report-diag-list">${items}</ul>
      </div>
    `);
  }

  if (consoleErrors.length > 0) {
    const items = consoleErrors
      .map((e) => {
        const loc = e.url
          ? `<div class="report-diag-meta"><code>${esc(e.url)}${e.lineNumber ? `:${e.lineNumber}` : ''}</code></div>`
          : '';
        return `<li><div class="report-diag-line">${esc(e.text)}</div>${loc}</li>`;
      })
      .join('');
    sections.push(`
      <div class="report-diag-section">
        <div class="report-diag-heading">Console errors (${consoleErrors.length})</div>
        <ul class="report-diag-list">${items}</ul>
      </div>
    `);
  }

  if (networkErrors.length > 0) {
    const items = networkErrors
      .map(
        (e) => `
          <li>
            <div class="report-diag-line">
              <code>${esc(e.method)}</code> <code>${esc(e.url)}</code>
              → <strong>${e.status}</strong>${e.statusText ? ` ${esc(e.statusText)}` : ''}
            </div>
          </li>`,
      )
      .join('');
    sections.push(`
      <div class="report-diag-section">
        <div class="report-diag-heading">Failed network responses (${networkErrors.length})</div>
        <ul class="report-diag-list">${items}</ul>
      </div>
    `);
  }

  return `
    <div class="report-render-diagnostics" role="note">
      <div class="report-diag-banner-label">Diagnostics</div>
      ${sections.join('')}
    </div>
  `;
}

function renderComponentSection(component: ReportComponent): string {
  const renders = component.renders;

  // Three layout regimes:
  //
  //   1. Single render (one fixture, one scenario, or no variants at all)
  //      → just show the screenshot.
  //   2. Stacked render (one entry whose `stackedFixtureIds` carries 2+
  //      names) → still one screenshot — the variants are siblings IN the
  //      image. Caption lists which fixtures are present.
  //   3. Multiple separate renders (scenarios passed, no fixtures defined)
  //      → tabs + prev/next inside this section so the user can flip
  //      between scenarios. Without this we'd lose the only way to switch
  //      between, e.g., logged-in vs logged-out screenshots.
  //
  // Components flow vertically — there is no outer carousel paginating
  // between components anymore. Less clicking, more scrolling.
  const sourceBlock = component.source
    ? `
      <details class="report-source">
        <summary>Source</summary>
        <pre><code>${esc(component.source)}</code></pre>
      </details>
    `
    : '';

  const head = `
    <div class="report-component-head">
      <div class="report-component-id">${esc(component.id)}</div>
      <div class="report-component-path"><code>${esc(component.filePath)}</code></div>
    </div>
  `;

  // Anchor target for evidence-line thumbnails ("#component-<slug>").
  const anchorId = `component-${slugifyDom(component.id)}`;

  // The PRIMARY render is the first one with real pixels — its <img> carries
  // `data-shot-primary`, the byte source the evidence thumbnails clone from.
  const primaryIndex = renders.findIndex((r) => !r.renderError && Boolean(r.screenshotDataUrl));

  if (renders.length === 0) {
    return `<section class="report-component" id="${anchorId}" data-component="${esc(component.id)}">${head}</section>`;
  }

  if (renders.length === 1) {
    const r = renders[0]!;
    const stackedCaption =
      r.stackedFixtureIds && r.stackedFixtureIds.length > 0
        ? `<div class="report-stack-caption">Variants stacked: ${r.stackedFixtureIds
            .map((id) => `<code>${esc(id)}</code>`)
            .join(' · ')}</div>`
        : '';
    return `
      <section class="report-component" id="${anchorId}" data-component="${esc(component.id)}">
        ${head}
        ${stackedCaption}
        ${renderRenderBody(component, r, primaryIndex === 0)}
        ${sourceBlock}
      </section>
    `;
  }

  // 2+ separate renders (scenario fanout). Keep the tabs+arrows for switching.
  const tabs = renders
    .map((r, idx) => {
      const label = renderLabelFor(r);
      const active = idx === 0 ? ' is-active' : '';
      return `<button type="button" class="report-scenario-tab${active}" data-scenario-tab="${esc(label)}">${esc(label)}</button>`;
    })
    .join('');

  const navButtons = `
    <button type="button" class="report-scenario-prev" data-scenario-prev aria-label="Previous render">&lsaquo;</button>
    <button type="button" class="report-scenario-next" data-scenario-next aria-label="Next render">&rsaquo;</button>
  `;

  const panes = renders
    .map((r, idx) => {
      const label = renderLabelFor(r);
      const active = idx === 0 ? ' is-active' : '';
      return `<div class="report-scenario-pane${active}" data-scenario-pane="${esc(label)}">${renderRenderBody(component, r, idx === primaryIndex)}</div>`;
    })
    .join('');

  return `
    <section class="report-component" id="${anchorId}" data-component="${esc(component.id)}" data-scenario-group>
      ${head}
      <div class="report-scenario-bar">${navButtons}<div class="report-scenario-tabs" role="tablist">${tabs}</div></div>
      <div class="report-scenario-panes">${panes}</div>
      ${sourceBlock}
    </section>
  `;
}

function renderScreenshotsSection(input: ReportInput): string {
  const isUrl = input.mode === 'url';
  if (input.components.length === 0) {
    const empty = isUrl
      ? 'No pages were captured for this run.'
      : 'No components were rendered for this run.';
    return `
      <section class="report-section report-screenshots">
        <h2 class="report-section-heading">Rendered screenshots</h2>
        <div class="report-empty">${empty}</div>
      </section>
    `;
  }

  // Components flow vertically — no outer carousel. Each component renders
  // a self-contained section with its head, screenshots, and (where
  // applicable) scenario tabs. The diff section below remains a carousel.
  const sections = input.components.map((c) => renderComponentSection(c)).join('\n');

  return `
    <section class="report-section report-screenshots">
      <h2 class="report-section-heading">Rendered screenshots</h2>
      <div class="report-component-list">${sections}</div>
    </section>
  `;
}

function renderHunk(hunk: ReportDiffHunk): string {
  const allLines = hunk.lines
    .map((line) => {
      const cls =
        line.kind === 'add'
          ? 'report-diff-line-add'
          : line.kind === 'del'
            ? 'report-diff-line-del'
            : 'report-diff-line-context';
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      return `<div class="report-diff-line ${cls}"><span class="report-diff-prefix">${prefix}</span><span class="report-diff-text">${esc(line.text)}</span></div>`;
    })
    .join('');

  if (hunk.lines.length <= HUNK_VISIBLE_LIMIT) {
    return `
      <div class="report-diff-hunk">
        <div class="report-diff-hunk-header"><code>${esc(hunk.header)}</code></div>
        <div class="report-diff-hunk-body">${allLines}</div>
      </div>
    `;
  }

  // Render visible chunk + collapsed remainder. All lines are still in HTML.
  const visible = hunk.lines.slice(0, HUNK_VISIBLE_LIMIT);
  const hidden = hunk.lines.slice(HUNK_VISIBLE_LIMIT);
  const renderLine = (line: ReportDiffLine): string => {
    const cls =
      line.kind === 'add'
        ? 'report-diff-line-add'
        : line.kind === 'del'
          ? 'report-diff-line-del'
          : 'report-diff-line-context';
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    return `<div class="report-diff-line ${cls}"><span class="report-diff-prefix">${prefix}</span><span class="report-diff-text">${esc(line.text)}</span></div>`;
  };
  const visibleHtml = visible.map(renderLine).join('');
  const hiddenHtml = hidden.map(renderLine).join('');
  return `
    <div class="report-diff-hunk">
      <div class="report-diff-hunk-header"><code>${esc(hunk.header)}</code></div>
      <div class="report-diff-hunk-body">
        ${visibleHtml}
        <details class="report-diff-more">
          <summary>… (${hidden.length} more lines)</summary>
          ${hiddenHtml}
        </details>
      </div>
    </div>
  `;
}

function renderDiffFileSlide(file: ReportDiffFile, note?: string): string {
  const noteBlock = note ? `<blockquote class="report-file-note">${esc(note)}</blockquote>` : '';

  if (file.binary) {
    const kb = file.byteSize ? Math.round(file.byteSize / 1024) : 0;
    return `
      <div class="report-diff-file" data-diff-slide="${esc(file.path)}">
        <div class="report-diff-file-head"><code>${esc(file.path)}</code></div>
        ${noteBlock}
        <div class="report-diff-binary">Binary file changed (${kb} KB)</div>
      </div>
    `;
  }

  const hunksHtml = file.hunks.map(renderHunk).join('');

  return `
    <div class="report-diff-file" data-diff-slide="${esc(file.path)}">
      <div class="report-diff-file-head"><code>${esc(file.path)}</code></div>
      ${noteBlock}
      <div class="report-diff-hunks">${hunksHtml}</div>
    </div>
  `;
}

function renderDiffSection(input: ReportInput): string {
  if (!input.diff || input.diff.files.length === 0) return '';

  const slides: CarouselSlide[] = input.diff.files.map((file) => ({
    body: renderDiffFileSlide(file, input.fileNotes?.[file.path]),
  }));

  return `
    <section class="report-section report-diffs">
      <h2 class="report-section-heading">Code changes</h2>
      ${renderCarousel(2, slides)}
    </section>
  `;
}

/**
 * Map a pass/fail/unverifiable status to its pill hook class.
 *
 * The TONE decision is delegated to the design system's `statusPillKind`, which
 * is the never-false-green rule as code: only the exact string `pass` can reach
 * the green tokens. The hook name is retained so the report's own selectors and
 * the tests that pin them keep working — `.report-pill-*` carries no colour of
 * its own; the CSS below aliases each hook onto the shared pill kind.
 */
function pillClassFor(status: 'pass' | 'fail' | 'unverifiable'): string {
  const kind: PillKind = statusPillKind(status);
  return `report-pill-${kind === 'neutral' ? 'unverifiable' : kind}`;
}

/**
 * Per-criterion EVIDENCE line (C1): cited screenshot thumbnails (src-cloned
 * from the gallery — never a second copy of the base64 bytes), render mode,
 * data provenance, native render confirmation, judge identity, and taints.
 * Returns '' when no evidence entry exists — legacy output stays byte-stable.
 */
function renderEvidenceLine(
  ev: ReportEvidence | undefined,
  opts: { input: ReportInput; tier?: 'hard' | 'property' | 'soft' },
): string {
  if (!ev) return '';

  const parts: string[] = [];

  const ids = ev.screenshotIds ?? [];
  const shown = ids.slice(0, EVIDENCE_THUMB_LIMIT);
  for (const id of shown) {
    // Script-free by construction: the anchor + visible <code> id label are the
    // receipt when JS is off (the src-less <img> is CSS-hidden until the inline
    // JS clones the primary screenshot's bytes into it — see the JS payload).
    // The link jumps to the full embedded screenshot, so the evidence is always
    // reachable without duplicating the base64 bytes.
    parts.push(
      `<a class="report-evidence-thumb" href="#component-${slugifyDom(id)}" title="Jump to the ${esc(id)} screenshot">` +
        `<img data-shot-ref="${esc(id)}" alt="" />` +
        `<code>${esc(id)}</code>` +
        `</a>`,
    );
  }
  if (ids.length > shown.length) {
    parts.push(`<span class="report-evidence-more">+${ids.length - shown.length} more</span>`);
  }

  parts.push(evidenceChip(`mode: ${ev.mode ?? opts.input.mode ?? 'isolation'}`));

  for (const p of ev.dataProvenance ?? []) {
    const { label, tone } = dataProvenanceChipFor(p);
    parts.push(evidenceChip(label, tone));
  }

  if (ev.renderConfirmation === 'confirmed') {
    parts.push(evidenceChip('render: confirmed', 'green'));
  } else if (ev.renderConfirmation === 'unconfirmed') {
    parts.push(evidenceChip('render: UNCONFIRMED', 'amber'));
  }

  if (opts.tier === 'hard' || opts.tier === 'property') {
    parts.push(evidenceChip('judge: mechanical'));
  } else if (ev.scoredBy) {
    parts.push(evidenceChip(`scored by: ${ev.scoredBy}`));
    // An independent MODEL judge is its own provenance chip (info-toned) — never
    // relabel it as "fresh-context" (a subagent/human) or "self-scored". Guarded
    // by selfScored !== true so a self-scored config-'model' can't launder.
    if (opts.input.scoring?.judge === 'model' && opts.input.scoring.selfScored !== true) {
      parts.push(evidenceChip('model-judged', 'blue'));
    } else {
      const selfScored = ev.selfScored ?? opts.input.scoring?.selfScored;
      if (selfScored === true) parts.push(evidenceChip('self-scored', 'amber'));
      else if (selfScored === false) parts.push(evidenceChip('fresh-context', 'blue'));
    }
  }

  for (const t of ev.taints ?? []) {
    parts.push(evidenceChip(`tainted: ${t}`, 'amber'));
  }

  return `<div class="report-evidence"><span class="report-evidence-label">Evidence:</span>${parts.join('')}</div>`;
}

/** Not-validated Part-1 row shape: one unverifiable criterion under a taint group. */
interface NotValidatedRow {
  id: string;
  detail?: string;
  taints: ReportEvidenceTaint[];
}

/**
 * Collect every criterion whose FINAL status is `unverifiable`: the persisted
 * verdicts (all tiers — unscored soft placeholders included) plus any soft
 * `criteria` row not already covered by id. Display-only: reads statuses,
 * never computes or filters one.
 */
function collectUnverifiableRows(input: ReportInput): NotValidatedRow[] {
  const rows: NotValidatedRow[] = [];
  const seen = new Set<string>();
  for (const v of input.criterionVerdicts ?? []) {
    if (v.status !== 'unverifiable') continue;
    rows.push({ id: v.id, detail: v.detail, taints: taintsFor(input, v.id, v) });
    seen.add(v.id);
  }
  for (const c of input.criteria ?? []) {
    if (c.status !== 'unverifiable') continue;
    if (c.id && seen.has(c.id)) continue;
    rows.push({
      id: c.id ?? c.description,
      detail: c.reasoning,
      taints: taintsFor(input, c.id, undefined),
    });
  }
  return rows;
}

/** Group Part-1 rows by taint (a row with 2 taints appears in both groups). */
function groupRowsByTaint(
  rows: NotValidatedRow[],
): Array<{ label: string; rows: NotValidatedRow[] }> {
  const groups = new Map<string, NotValidatedRow[]>();
  for (const row of rows) {
    const keys = row.taints.length > 0 ? row.taints : [UNKNOWN_TAINT_GROUP];
    for (const key of keys) {
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
  }
  const ordered: Array<{ label: string; rows: NotValidatedRow[] }> = [];
  for (const { key, label } of TAINT_GROUP_LABELS) {
    const list = groups.get(key);
    if (list) {
      ordered.push({ label, rows: list });
      groups.delete(key);
    }
  }
  // Unknown taint kinds render verbatim (never silently dropped); the
  // no-taint group goes last.
  const unknownGroup = groups.get(UNKNOWN_TAINT_GROUP);
  groups.delete(UNKNOWN_TAINT_GROUP);
  for (const [key, list] of groups) ordered.push({ label: key, rows: list });
  if (unknownGroup) ordered.push({ label: UNKNOWN_TAINT_GROUP, rows: unknownGroup });
  return ordered;
}

/** Coverage-vs-floor line data shared by the HTML and markdown renderers. */
function coverageFloorLine(input: ReportInput): {
  text: string;
  floorMet: boolean;
  breach: boolean;
} | null {
  if (!input.coverage) return null;
  const pct = Math.round(input.coverage.ratio * 100);
  const base = `Mechanically decided: ${input.coverage.verifiableCount}/${input.coverage.hardPropertyTotal} (${pct}%)`;
  const floor = input.coverageFloorPercent;
  if (floor === undefined) return { text: base, floorMet: true, breach: false };
  const met = pct >= floor;
  return {
    text: `${base} — floor ${floor}%`,
    floorMet: met,
    breach: !met,
  };
}

/**
 * "Environment blocked" banner — the run produced no verdicts because the
 * verification environment failed, not because the code was undecidable.
 *
 * Presence-gated on `input.specError`: absent ⇒ the empty string, so every
 * healthy report is byte-identical to the pre-feature output.
 *
 * Design ("The Lab Notebook" visual system):
 *   - amber on the FULL FRAME, never a side stripe (the `.report-notvalidated`
 *     recipe), over `--panel`; flat, no shadow;
 *   - status is SHAPE-DOUBLED — the `◌` glyph is aria-hidden and the word
 *     "withheld" carries the meaning, so hue is confirmation only;
 *   - every color is a token, so light/dark parity comes for free;
 *   - it can never render green: there is one code path and it is amber.
 * The fix command sits in a `<pre>` that drops back to `--panel2`/`--tx` so
 * the command is readable rather than tinted (the empty-notice recipe).
 */
function renderEnvironmentBlockedBanner(input: ReportInput): string {
  const err = input.specError;
  if (!err) return '';
  const cause = err.cause
    ? `<div class="report-envblocked-cause">Cause: <code>${esc(err.cause)}</code></div>`
    : '';
  const fix = err.fixCommand
    ? `<div class="report-envblocked-fixlabel">Fix</div><pre>${esc(err.fixCommand)}</pre>`
    : '';
  return `
    <section class="report-section report-envblocked" role="note">
      <div class="report-envblocked-label"><span aria-hidden="true">◌</span> Environment blocked — verdicts withheld</div>
      <div class="report-envblocked-body">This run failed before any criterion could be decided, so nothing below was proven or disproven. The undecided criteria are a consequence of the environment, <em>not</em> evidence about the code.</div>
      <pre class="report-envblocked-message">${esc(err.message)}</pre>
      ${cause}
      ${fix}
    </section>
  `;
}

/**
 * URL-MODE DISCLOSURE (B6). A URL run screenshots a page the user's own dev
 * server rendered — Validity's sandbox, and therefore every mechanical check,
 * is out of the loop. Without this banner a clean-looking URL report reads as
 * "the hard criteria passed"; they were never asked. Text is the shared
 * {@link URL_MODE_DISCLOSURE} constant so the report and the MCP tool response
 * cannot drift apart. Rendered only for `mode: 'url'`, so every other report
 * stays byte-identical.
 */
function renderUrlModeDisclosure(input: ReportInput): string {
  if (input.mode !== 'url') return '';
  return `
    <section class="report-section report-urlmode" role="note">
      <div class="report-urlmode-label"><span aria-hidden="true">◌</span> URL mode — mechanical criteria not evaluated</div>
      <div class="report-urlmode-body">${esc(URL_MODE_DISCLOSURE)}</div>
    </section>
  `;
}

/**
 * "Not validated" section (C2) — rendered under the verdict banner (after the
 * "Part of spec" panel when the run is spec-bound).
 * The honest remainder: unverifiable criteria grouped by taint reason, data
 * states/viewports the run never rendered, and coverage vs. the configured
 * floor. DISPLAY-ONLY by construction: it enumerates final statuses and can
 * only ADD visibility — there is no filter that hides an unverifiable row.
 */
function renderNotValidatedSection(input: ReportInput): string {
  const hasVerdicts = (input.criterionVerdicts?.length ?? 0) > 0;
  const notCoveredStates = input.notCovered?.dataStates ?? [];
  const notCoveredViewports = input.notCovered?.viewports ?? [];
  const hasNotCovered = notCoveredStates.length > 0 || notCoveredViewports.length > 0;
  // Surface the section wherever the run is weakest — including an UNPLANNED run
  // that has no verdicts/coverage but did collect unverifiable soft criteria.
  const hasUnverifiableSoft = (input.criteria ?? []).some((c) => c.status === 'unverifiable');
  if (!hasVerdicts && !hasNotCovered && !input.coverage && !hasUnverifiableSoft) return '';

  const rows = collectUnverifiableRows(input);
  const groups = groupRowsByTaint(rows);

  const groupsHtml = groups
    .map((g) => {
      const items = g.rows
        .map((r) => {
          const excerpt = r.detail ? r.detail.slice(0, 160) : '';
          return (
            `<li class="report-notvalidated-row">` +
            `<span class="report-pill report-pill--sm report-pill-unverifiable">unverifiable</span>` +
            `<code>${esc(r.id)}</code>` +
            (excerpt ? `<span class="report-notvalidated-detail">${esc(excerpt)}</span>` : '') +
            `</li>`
          );
        })
        .join('');
      return `
        <div class="report-notvalidated-group">
          <div class="report-notvalidated-group-label">${esc(g.label)}</div>
          <ul class="report-notvalidated-list">${items}</ul>
        </div>`;
    })
    .join('');

  const statesHtml =
    notCoveredStates.length > 0
      ? `
        <div class="report-notvalidated-part">
          <div class="report-notvalidated-part-label">Data states not rendered</div>
          <div>${notCoveredStates.map((s) => evidenceChip(s, 'amber')).join('')}</div>
          <div class="report-notvalidated-note">Bugs in those branches are invisible to this run.</div>
        </div>`
      : '';

  const viewportsHtml =
    notCoveredViewports.length > 0
      ? `
        <div class="report-notvalidated-part">
          <div class="report-notvalidated-part-label">Viewports not covered</div>
          <div>${notCoveredViewports.map((s) => evidenceChip(s, 'amber')).join('')}</div>
        </div>`
      : '';

  const coverageLine = coverageFloorLine(input);
  const coverageHtml = coverageLine
    ? `<div class="report-notvalidated-coverage">${esc(coverageLine.text)}${
        input.coverageFloorPercent === undefined
          ? ''
          : coverageLine.breach
            ? ` <span class="report-pill report-pill--sm report-pill-fail">BREACH</span>`
            : ' ✓'
      }</div>`
    : '';

  // Everything this run could NOT decide, as one number for the heading —
  // so an empty ledger reads as "none", never as a bare scary "Not validated".
  const outstanding =
    rows.length +
    notCoveredStates.length +
    notCoveredViewports.length +
    (coverageLine?.breach ? 1 : 0);

  const honestEmpty =
    outstanding === 0
      ? `<div class="report-notvalidated-empty">Nothing outstanding — every criterion was decided and every planned state rendered.</div>`
      : '';

  const headingSuffix = outstanding === 0 ? ' — none' : ` — ${outstanding} outstanding`;

  return `
    <section class="report-section report-notvalidated${outstanding === 0 ? ' report-notvalidated--clear' : ''}">
      <h2 class="report-section-heading">Not validated${headingSuffix}</h2>
      <div class="report-notvalidated-intent">The run's coverage ledger: anything this run could <em>not</em> decide — unverifiable criteria, data states or viewports that never rendered — is listed here so gaps are never hidden. This is not a verdict; the verdict is in the header above.</div>
      ${groupsHtml}
      ${statesHtml}
      ${viewportsHtml}
      ${coverageHtml}
      ${honestEmpty}
    </section>
  `;
}

/**
 * "Part of spec …" system-context panel — where this one-off report sits in
 * the durable spec system. Renders the spec identity, derived maturity with
 * its certification blockers, open signals, and the recent run timeline, plus
 * the commands that open the durable surfaces. This is the report's answer to
 * "how does this run fit the overall system": the run is one tick in the
 * spec's timeline, not a dead-end artifact.
 */
function renderSpecContextSection(input: ReportInput): string {
  const ctx = input.specContext;
  if (!ctx) return '';

  const levelToneClass: Record<string, string> = {
    certified: 'report-pill-pass',
    team: 'report-spec-pill-blue',
    dev: 'report-spec-pill-neutral',
    probation: 'report-pill-unverifiable',
  };
  const level = ctx.maturity?.level;
  const levelPill = level
    ? `<span class="report-pill ${levelToneClass[level] ?? 'report-spec-pill-neutral'}">${esc(level)}</span>`
    : '';
  const identity = [
    `<code class="report-spec-id">${esc(ctx.specId)}</code>`,
    ctx.version !== undefined ? `<span class="report-spec-meta">v${ctx.version}</span>` : '',
    ctx.status ? `<span class="report-spec-meta">${esc(ctx.status)}</span>` : '',
    levelPill,
  ]
    .filter(Boolean)
    .join(' ');

  // Certification distance: certified reads as an achievement; anything else
  // names exactly what stands between this spec and certified.
  const blockers = ctx.maturity?.blockers ?? [];
  const streak =
    ctx.cleanStreak !== undefined
      ? `<span class="report-spec-meta">clean streak: ${ctx.cleanStreak}</span>`
      : '';
  const certLine =
    level === 'certified'
      ? `<div class="report-spec-cert report-spec-cert--met">Certified — the frozen contract is currently proven on fresh evidence. ${streak}</div>`
      : blockers.length > 0
        ? `<div class="report-spec-cert">To reach <strong>certified</strong>: <ul>${blockers
            .map((b) => `<li>${esc(b)}</li>`)
            .join('')}</ul>${streak}</div>`
        : '';

  const signals = ctx.openSignals ?? [];
  const signalsLine =
    signals.length > 0
      ? `<div class="report-spec-signals">Open signals: ${signals
          .map(
            (s) =>
              `<span class="report-pill report-pill--sm ${
                s.severity === 'high' ? 'report-pill-fail' : 'report-pill-unverifiable'
              }">${esc(s.kind)}${s.criterionId ? ` · ${esc(s.criterionId)}` : ''}</span>`,
          )
          .join(' ')}</div>`
      : `<div class="report-spec-signals report-spec-signals--clean">No open signals for this spec.</div>`;

  const history = ctx.history ?? [];
  const historyLine =
    history.length > 0
      ? `<div class="report-spec-history">Timeline: ${history
          .map((h) => {
            const current = h.runId === input.runId;
            const cls =
              h.verdict === 'pass'
                ? 'report-spec-dot--pass'
                : h.verdict === 'fail'
                  ? 'report-spec-dot--fail'
                  : 'report-spec-dot--other';
            return `<span class="report-spec-dot ${cls}${current ? ' report-spec-dot--current' : ''}" title="${esc(
              `${h.runId} — ${h.verdict}${current ? ' (this run)' : ''} · ${h.createdAt}`,
            )}"></span>`;
          })
          .join('')} <span class="report-spec-meta">(oldest → newest${
          history.some((h) => h.runId === input.runId) ? ', this run highlighted' : ''
        })</span></div>`
      : '';

  return `
    <section class="report-section report-spec-context">
      <h2 class="report-section-heading">Part of spec ${esc(ctx.specId)}</h2>
      <div class="report-spec-identity">${identity}</div>
      ${certLine}
      ${signalsLine}
      ${historyLine}
      <div class="report-spec-commands">
        Durable surfaces: <code>validity spec show ${esc(ctx.specId)}</code> ·
        <code>validity trends</code> ·
        <code>validity verify --all</code>
      </div>
    </section>
  `;
}

/**
 * Tone hook for a criterion's TIER pill (`proven · hard`, `proven · property`).
 *
 * The tier pill names the strength of the CHECK, not its outcome — so it is
 * fenced by the same rule as everything else on the page: the strongest tier
 * (`hard`, mechanically executed) may wear the pass tone ONLY where the verdict
 * actually passed. A failing or undecided hard criterion drops to the
 * informational tone, so no green can ever sit beside a non-pass status.
 * `property` is always informational; the judged section's tier pill is violet
 * (the judge tone), which is never a verdict colour at all.
 */
function provenTagKind(tier: string, status: string): string {
  const kind: PillKind = tier === 'hard' && statusPillKind(status) === 'pass' ? 'pass' : 'info';
  return `report-proven-tag--${kind}`;
}

/**
 * "Proven (deterministic)" section — the spec's hard/property criteria that
 * Validity executed MECHANICALLY in the sandbox (no LLM judgement). Rendered
 * distinctly from the soft `criteria` table so a reader never mistakes a
 * scored opinion for a proof: a pass here reads as proven, backed by the
 * per-check breakdown. Soft-tier verdicts are filtered out — they belong to
 * the LLM-scored section below.
 */
function renderProvenSection(input: ReportInput): string {
  const proven = (input.criterionVerdicts ?? []).filter(
    (v) => v.tier === 'hard' || v.tier === 'property',
  );
  if (proven.length === 0) return '';

  const cards = proven
    .map((v) => {
      const checks = v.checks ?? [];
      const checksList =
        checks.length > 0
          ? `<ul class="report-proven-checks">${checks
              .map((c) => {
                const detail = c.detail ?? JSON.stringify(c.check);
                return `<li class="report-proven-check"><span class="report-pill report-pill--sm ${pillClassFor(
                  c.status,
                )}">${esc(c.status)}</span><span class="report-proven-check-detail">${esc(detail)}</span></li>`;
              })
              .join('')}</ul>`
          : '';
      const detail = v.detail
        ? `<div class="report-criterion-reasoning">${esc(v.detail)}</div>`
        : '';
      // Override receipt: when the agent submitted a status this mechanical
      // verdict contradicts, submit_report reshapes the matching soft row's
      // reasoning with a bracketed audit note. Surface it here — quiet but
      // explicit — so an attempted false green is never silently dropped. The
      // amber ▲ shape-doubles the tint (color is never the sole carrier).
      const overrideNote = overrideNoteForProven(input, v.id);
      const overrideBlock = overrideNote
        ? `<div class="report-proven-override"><span class="report-proven-override-glyph" aria-hidden="true">▲</span><span>${esc(overrideNote)}</span></div>`
        : '';
      // Evidence line (C1). The per-check <ul> below IS the check-log excerpt
      // for hard verdicts — kept as-is, no duplication.
      const evidenceLine = renderEvidenceLine(input.evidence?.[v.id], {
        input,
        tier: v.tier === 'property' ? 'property' : 'hard',
      });
      return `
        <div class="report-criterion-card report-proven-card">
          <div class="report-criterion-head">
            <span class="report-pill ${pillClassFor(v.status)}">${esc(v.status)}</span>
            <span class="report-proven-tag ${provenTagKind(v.tier, v.status)}">proven · ${esc(v.tier)}</span>
            <div class="report-criterion-desc"><code>${esc(v.id)}</code></div>
          </div>
          ${evidenceLine}
          ${detail}
          ${overrideBlock}
          ${checksList}
        </div>
      `;
    })
    .join('');

  const coverageNote = input.coverage
    ? `<p class="report-proven-blurb">Coverage: ${esc(
        `${input.coverage.verifiableCount}/${input.coverage.hardPropertyTotal}`,
      )} (${Math.round(input.coverage.ratio * 100)}%) of hard/property criteria mechanically decided.</p>`
    : '';

  return `
    <section class="report-section report-proven">
      <h2 class="report-section-heading">Proven (deterministic)</h2>
      <p class="report-proven-blurb">
        Executed mechanically in the sandbox — no LLM judgement. These verdicts
        are authoritative: a pass here is proof, not opinion.
      </p>
      ${coverageNote}
      <div class="report-criteria-list">${cards}</div>
    </section>
  `;
}

function renderCriteriaSection(input: ReportInput): string {
  // Agents copy proven verdicts into their submitted criteria rows (SKILL.md),
  // so a hard criterion can arrive here AND in the authoritative Proven section.
  // Fold those duplicates out — the Proven section stays the single source, and
  // carries the "Mechanical verdict kept" override receipt when the agent's
  // submitted status conflicted (see renderProvenSection).
  const rows = dedupedSoftCriteria(input);
  if (rows.length === 0) return '';

  const cards = rows
    .map((c) => {
      const pillClass = pillClassFor(c.status);
      const suggestion = c.suggestion
        ? `<div class="report-criterion-suggestion"><strong>Suggestion:</strong> ${esc(c.suggestion)}</div>`
        : '';
      // Evidence supersedes the plain "Scored from:" block — same citation
      // ids, richer presentation. Legacy inputs (no evidence entry) keep the
      // existing block unchanged.
      const evidence = c.id ? input.evidence?.[c.id] : undefined;
      const evidenceLine = renderEvidenceLine(evidence, { input, tier: c.tier ?? 'soft' });
      const citations =
        !evidence && c.screenshotIds && c.screenshotIds.length > 0
          ? `<div class="report-criterion-citations"><strong>Scored from:</strong> ${c.screenshotIds
              .map((id) => `<code>${esc(id)}</code>`)
              .join(', ')}</div>`
          : '';
      return `
        <div class="report-criterion-card">
          <div class="report-criterion-head">
            <span class="report-pill ${pillClass}">${esc(c.status)}</span>
            <span class="report-proven-tag report-proven-tag--judge">judged</span>
            <div class="report-criterion-desc">${esc(c.description)}</div>
          </div>
          <div class="report-criterion-reasoning">${esc(c.reasoning)}</div>
          ${evidenceLine}
          ${suggestion}
          ${citations}
        </div>
      `;
    })
    .join('');

  // When a Proven (deterministic) section precedes this one, the contrast
  // matters: those verdicts are mechanical, these are the model's read of the
  // screenshots. The blurb keeps a soft score from being mistaken for proof.
  const scoredBlurb =
    input.criterionVerdicts && input.criterionVerdicts.some((v) => v.tier !== 'soft')
      ? `<p class="report-proven-blurb">Scored by the model from the screenshots — opinion, not proof. See "Proven (deterministic)" above for mechanically verified criteria.</p>`
      : '';

  return `
    <section class="report-section report-criteria">
      <h2 class="report-section-heading">Per-criterion details</h2>
      ${scoredBlurb}
      <div class="report-criteria-list">${cards}</div>
    </section>
  `;
}

function renderFooter(input: ReportInput): string {
  // Three plain-text lines. The second is the no-server counterpart to the
  // header's dashboard up-link (which only appears when this report is served
  // over http): a reader looking at a file:// / CI copy still learns how to
  // get the big picture. Text, not a link — `validity trends` is a
  // static command chip styled like the viewCommand above it.
  //
  // The third is the zero-token receipt (2.2): a fixed, deterministic string
  // naming the mechanical lane's re-verifiability — no clock, no randomness,
  // no run-specific data, so it never perturbs byte-identical output. Placed
  // last so it sits next to the attestation block once Part 1 lands one here.
  return `
    <footer class="report-footer">
      <div class="report-footer-line">View this report locally: <code>${esc(input.viewCommand)}</code></div>
      <div class="report-footer-line">See the whole project — signals and history: <code>validity signals list</code> · <code>validity trends</code></div>
      <div class="report-footer-line report-footer-receipt">Deterministic checks re-verifiable at zero LLM cost — validity replay</div>
      ${renderAttestation(input)}
    </footer>
  `;
}

/**
 * The attestation receipt. Deliberately plain and last on the page: it proves
 * "unmodified since Validity wrote it", NOT who ran it or that anything passed
 * — so it gets no status colour, no glyph, and no headline real estate. The
 * full digest/signature/key are printed (not truncated) so the block is
 * machine-checkable by copy-paste, not just decorative.
 */
function renderAttestation(input: ReportInput): string {
  const a = input.attestation;
  if (!a) return '';
  return `
      <div class="report-attest">
        <div class="report-attest-title">Attestation — Ed25519, tamper-evident</div>
        <div class="report-attest-row"><span>digest</span><code>${esc(a.digest)}</code></div>
        <div class="report-attest-row"><span>signature</span><code>${esc(a.signature)}</code></div>
        <div class="report-attest-row"><span>public key</span><code>${esc(a.publicKey)}</code></div>
        <div class="report-attest-note">
          Covers run-meta.json (per-criterion verdicts, tiers, taints, scoring provenance),
          every screenshot's sha256, the commit, and the run timestamps — plus these report
          bytes, signed separately in attestation.json. Re-check with
          <code>validity attest verify &lt;run-dir&gt;</code>. Proves the artifacts are
          unmodified since Validity wrote them; it does not prove who ran them.
        </div>
      </div>`;
}

// ---------------------------------------------------------------------------
// CSS + JS payloads
// ---------------------------------------------------------------------------

/**
 * Surface CSS for report.html: what the shared vocabulary does not already
 * cover, and nothing that it does.
 *
 * Three rules govern this sheet:
 *   1. NO literal colours, font stacks, or radii — every value is a token
 *      (`var(--…)`) or a constant imported from @validity.ai/verify-report. Restyling the
 *      product stays a tokens.ts edit.
 *   2. The `report-*` selectors are stable hooks (the embedded JS and the test
 *      suite pin them). Where a hook is exactly a shared recipe, it is ALIASED
 *      onto `RECIPES.*` rather than re-declared, so there is still one copy of
 *      every recipe and it lives in the design package.
 *   3. Status colour is never the sole carrier: every rule that tints also has
 *      a glyph or an uppercase word beside it in the markup, and only the exact
 *      status `pass` is ever allowed to reach the green tokens.
 */
function reportCss(): string {
  return `
/* ---- document ---- */
main.v-shell{padding-top:26px;padding-bottom:80px}
code,pre,.report-diff-line{font-family:${FONT_MONO};font-size:12.5px}
pre{overflow-x:auto}
h2{font-weight:600}

/* ---- header: crumbs, run identity, commit chips ---- */
.report-header{padding-bottom:20px;border-bottom:1px solid var(--bd);margin-bottom:26px}
.report-header .v-crumbs{padding:2px 0 14px}
.report-header-row{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap}
.report-header-meta{min-width:0}
.report-header-runid{font-family:${FONT_MONO};font-size:var(--h1);font-weight:600;letter-spacing:-.02em;line-height:1.15;color:var(--tx);word-break:break-all}
.report-header-time{font-family:${FONT_MONO};font-size:11.5px;color:var(--dim);margin-top:8px}
.report-header-git{display:flex;gap:8px;flex-wrap:wrap}
.report-header-dashlink[hidden]{display:none}

/* ---- summary band: verdict hero + two lanes + sign-off ---- */
.report-summary{display:flex;align-items:stretch;gap:14px;margin-top:26px;flex-wrap:wrap}
.report-hero{display:flex;flex-direction:column;justify-content:center;padding-right:8px;min-width:0}
.report-hero-eyebrow{${RECIPES.eyebrow};margin:0}
.report-hero-verdict{display:flex;align-items:center;gap:11px;margin-top:8px;font-size:${TYPE.verdict.size};font-weight:${TYPE.verdict.weight};letter-spacing:${TYPE.verdict.tracking};line-height:1}
/* The glyph IS the shape half of the shape-doubling: ● pass · ✕ fail ·
   ▲ partial · ◌ unverified. Sized to read as the design's 13px status dot. */
.report-hero-glyph{font-size:20px;line-height:1}
.report-hero--pass .report-hero-glyph{color:var(--grn)}
.report-hero--fail .report-hero-glyph{color:var(--red)}
.report-hero--partial .report-hero-glyph{color:var(--amb)}
.report-hero--unverified .report-hero-glyph{color:var(--dim2)}
.report-hero-note{margin:10px 0 0;font-size:12px;color:var(--dim2);max-width:60ch;text-wrap:pretty}

/* Two-lane rollup (plan 1.3). Machine-checked and judged results never share a
   number, so they never share a box either: the lanes sit adjacent and are
   drawn differently on purpose — the machine lane is SOLID and filled (proof),
   the judged lane is DASHED and unfilled (house law: dashed = unproven). The
   distinction therefore survives greyscale, a screenshot, and a reader who
   cannot see the accent hues at all. */
.report-lanes{display:flex;align-items:stretch;gap:12px;min-width:0;flex-wrap:wrap}
.report-lane{min-width:0;padding:13px 17px;border-radius:${RADII.card}px}
.report-lane--machine{border:1px solid var(--bd);background:var(--panel)}
.report-lane--judged{border:1px dashed var(--bd2);background:transparent}
.report-lane .report-section-label{margin-bottom:0}
.report-lane-count{display:flex;align-items:baseline;gap:8px;margin-top:9px;font-size:${TYPE.laneNum.size};font-weight:${TYPE.laneNum.weight};letter-spacing:${TYPE.laneNum.tracking};font-variant-numeric:tabular-nums;line-height:1.1}
.report-lane-tally{white-space:nowrap}
.report-lane-total{color:var(--dim2);font-weight:400}
.report-lane-glyph{font-size:14px;line-height:1;align-self:center}
/* The status WORD, not the hue, is what a reader takes away — the color only
   confirms it (and only an all-pass lane is ever green). */
.report-lane-word{font-family:${FONT_MONO};font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dim2)}
.report-lane--pass .report-lane-glyph{color:var(--grn)}
.report-lane--fail .report-lane-glyph{color:var(--red)}
.report-lane--partial .report-lane-glyph{color:var(--amb)}
.report-lane--empty .report-lane-glyph{color:var(--dim2)}
.report-lane-note{margin-top:8px;font-size:11.5px;color:var(--dim2)}
/* The judged lane's provenance note is machine identity, so it is set in mono
   and tinted by what the attribution is worth — never green. */
.report-lane-note--amber{font-family:${FONT_MONO};color:var(--amb)}
.report-lane-note--blue{font-family:${FONT_MONO};color:var(--blu)}

/* Sign-off note — a DISPLAY-ONLY standing beside the verdict hero. An
   agent-attested sign-off rests on a judged soft pass, so it is flagged DASHED
   (house law: dashed = unproven) and the WORDS say "worth a human check"; a
   fully-mechanical sign-off is a plain note. The recipe is the shared
   .v-banner / .v-banner--attested pair, aliased so the legacy hook classes
   (pinned by tests across three packages) keep their meaning. */
.report-signoff{${RECIPES.banner};min-width:0}
.report-signoff-check{color:var(--grn);font-weight:700}
.report-signoff-note{color:var(--tx)}
.report-signoff--attested{${RECIPES.bannerAttested}}

/* Full-width block BELOW the hero/lane row — a long verdict summary owns the
   whole content column instead of sharing a row with the lanes. */
.report-summary-blurb{margin-top:20px;font-size:15px;line-height:1.65;color:var(--tx);max-width:760px;text-wrap:pretty}
/* Provenance pills claim their own line, right-aligned under the hero row. */
.report-summary-badge{flex-basis:100%;margin-left:auto;margin-top:8px}
.report-verdict-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.report-flag{${RECIPES.pill};background:var(--panel2);color:var(--dim2)}
.report-flag--neutral{background:var(--panel2);color:var(--dim2)}
.report-flag--amber{background:var(--ambbg);color:var(--amb)}
.report-flag--blue{background:var(--blubg);color:var(--blu)}
.report-flag--green{background:var(--grnbg);color:var(--grn)}
.report-temporal-note{margin-top:14px;font-size:13px;font-style:italic;color:var(--dim);max-width:760px;text-wrap:pretty}

/* Copy-failing-criteria-as-fix-prompt — the report's only ghost button.
   Ships hidden; the inline JS reveals it (scripts-disabled keeps it out). */
.report-fix-prompt{appearance:none;align-self:center;background:var(--panel);border:1px solid var(--bd);color:var(--dim);border-radius:${RADII.control}px;padding:6px 11px;font-family:${FONT_MONO};font-size:12px;cursor:pointer}
.report-fix-prompt:hover{border-color:var(--bd2);color:var(--tx)}
.report-fix-prompt[hidden]{display:none}

/* ---- section furniture ---- */
.report-section{margin-bottom:32px}
.report-section-label{${RECIPES.eyebrow};margin-bottom:4px}
.report-section-heading{font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 10px}
.report-empty{padding:24px;text-align:center;border:1px dashed var(--bd2);border-radius:${RADII.block}px;color:var(--dim2)}

/* ---- prompt + regression strip ---- */
.report-prompt{margin-bottom:24px}
.report-prompt-quote{margin:0;padding:14px 16px;border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.block}px;white-space:pre-wrap;font-size:13.5px;line-height:1.6;text-wrap:pretty}
.report-regression-strip{margin-top:16px}
.report-regression-summary{font-size:13px;color:var(--dim);margin-bottom:6px}
.report-regression-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.report-regression-row{display:flex;align-items:center;gap:8px;font-size:13px}
.report-regression-arrow{width:1em;text-align:center;font-weight:600;color:var(--dim2)}
.report-regression-row--regressed .report-regression-arrow{color:var(--red)}
.report-regression-row--improved .report-regression-arrow{color:var(--grn)}
.report-regression-id{font-family:${FONT_MONO};font-size:12.5px;font-weight:600}
.report-regression-status{color:var(--dim)}
/* A row with a prior receipt stacks the transition line above the receipt. */
.report-regression-row--has-prior{flex-direction:column;align-items:flex-start;gap:3px}
.report-regression-line{display:flex;align-items:center;gap:8px}
.report-regression-prior{display:flex;flex-wrap:wrap;gap:4px 10px;padding-left:calc(1em + 8px);font-size:12px;color:var(--dim2)}
.report-regression-scorer{font-family:${FONT_MONO}}
/* Neutral emphasis for a scorer swap — never a verdict color. */
.report-regression-scorer--changed{color:var(--tx);font-weight:600}
.report-regression-prior-note{font-style:italic}

/* ---- carousels (diff files) ---- */
.report-carousel{border:1px solid var(--bd);border-radius:${RADII.panel}px;background:var(--panel);outline:none}
.report-carousel:focus-within{border-color:var(--blu)}
.report-carousel-track{position:relative}
.report-carousel-slide{display:none;padding:18px}
.report-carousel-slide.is-active{display:block}
.report-carousel-controls{display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 12px;border-top:1px solid var(--bd)}
.report-carousel-prev,.report-carousel-next{appearance:none;background:var(--panel2);border:1px solid var(--bd);color:var(--dim);border-radius:${RADII.tag}px;width:28px;height:24px;font-size:15px;line-height:1;cursor:pointer}
.report-carousel-prev:hover,.report-carousel-next:hover{border-color:var(--bd2);color:var(--tx)}
.report-carousel-bullets{display:flex;gap:6px}
.report-carousel-bullet{appearance:none;width:7px;height:7px;padding:0;border:0;border-radius:50%;background:var(--bd2);cursor:pointer}
.report-carousel-bullet.is-active{background:var(--blu)}

/* ---- components + renders ---- */
.report-component-list{display:flex;flex-direction:column;gap:28px}
.report-component-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.report-component-id{font-size:14px;font-weight:600}
.report-component-path{color:var(--dim2);font-size:12px}
.report-scenario-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.report-scenario-tabs{display:flex;gap:4px;flex-wrap:wrap}
.report-scenario-tab{appearance:none;background:transparent;border:1px solid var(--bd);color:var(--dim);border-radius:${RADII.chip}px;padding:4px 10px;font-family:${FONT_MONO};font-size:11.5px;cursor:pointer}
.report-scenario-tab:hover{border-color:var(--bd2);color:var(--tx)}
.report-scenario-tab.is-active{background:var(--panel);border-color:var(--bd2);color:var(--tx);font-weight:600}
.report-scenario-prev,.report-scenario-next{appearance:none;background:var(--panel2);border:1px solid var(--bd);color:var(--dim);border-radius:${RADII.tag}px;width:26px;height:24px;font-size:15px;line-height:1;cursor:pointer}
.report-scenario-prev:hover,.report-scenario-next:hover{border-color:var(--bd2);color:var(--tx)}
.report-scenario-prev:disabled,.report-scenario-next:disabled{opacity:.4;cursor:default}
.report-scenario-pane{display:none}
.report-scenario-pane.is-active{display:block}
.report-stack-caption{font-size:12px;color:var(--dim);margin-bottom:8px}
.report-stack-caption code{font-family:${FONT_MONO};font-size:11.5px;background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}
/* Screenshots composite on the canvas they were captured against — see the
   --shot token: identical in both themes, because the captured page carries
   its own theme and tinting a transparent PNG would misrepresent evidence. */
.report-render-image{max-width:100%;max-height:70vh;object-fit:contain;object-position:top left;height:auto;display:block;border:1px solid var(--bd);border-radius:${RADII.block}px;background:var(--shot)}
.report-render-missing{padding:16px;border:1px dashed var(--bd2);border-radius:${RADII.block}px;color:var(--dim2);font-size:13px}
.report-render-error{background:var(--redbg);color:var(--red);border:1px solid var(--redbd);border-radius:${RADII.block}px;padding:14px}
.report-render-error pre{margin:6px 0 0;white-space:pre-wrap}
.report-render-provenance{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.report-render-unmatched{margin-top:12px;padding:12px 14px;border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.block}px;font-size:12.5px}
.report-render-unmatched-label{font-weight:600;margin-bottom:4px;color:var(--amb)}
.report-render-unmatched ul{margin:0;padding-left:20px}
.report-render-unmatched-stub{margin-top:3px}
.report-render-unmatched-stub>summary{cursor:pointer;font-size:12px;color:var(--dim)}
.report-render-unmatched-stub pre{margin:6px 0 0;padding:10px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;white-space:pre-wrap}
.report-render-empty-notice{margin-top:12px;padding:12px 14px;border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.block}px;font-size:12.5px;color:var(--tx)}
.report-render-empty-notice strong{display:block;margin-bottom:4px;color:var(--amb)}
.report-render-empty-notice pre{margin:6px 0 0;padding:10px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;color:var(--tx);white-space:pre-wrap}
.report-render-empty-notice code{font-family:${FONT_MONO};background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}
.report-render-identical-notice{margin-top:12px;padding:12px 14px;border:1px solid var(--bd);background:var(--panel2);border-radius:${RADII.block}px;font-size:12.5px;color:var(--dim)}
.report-render-identical-notice code{font-family:${FONT_MONO};color:var(--tx)}

/* ---- diagnostics ---- */
.report-render-diagnostics{margin-top:12px;padding:12px 14px;border:1px solid var(--redbd);background:var(--redbg);border-radius:${RADII.block}px;font-size:12.5px}
.report-diag-banner-label{${RECIPES.eyebrow};color:var(--red);font-weight:600;margin-bottom:6px}
.report-diag-section+.report-diag-section{margin-top:10px}
.report-diag-heading{font-weight:600;margin-bottom:2px}
.report-diag-list{margin:0;padding-left:18px}
.report-diag-list li{margin:2px 0}
.report-diag-line{word-break:break-word}
.report-diag-meta{color:var(--dim);font-size:11.5px}
.report-diag-details{margin-top:3px}
.report-diag-details>summary{cursor:pointer;color:var(--dim)}
.report-diag-details pre{margin:6px 0 0;padding:10px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;white-space:pre-wrap}
.report-render-diagnostics code{font-family:${FONT_MONO};font-size:11.5px}

/* ---- a11y ---- */
.report-render-a11y{margin-top:12px;padding:12px 14px;border-radius:${RADII.block}px;font-size:12.5px}
.report-render-a11y--critical{border:1px solid var(--redbd);background:var(--redbg)}
.report-render-a11y--serious{border:1px solid var(--ambbd);background:var(--ambbg)}
.report-a11y-banner-label{${RECIPES.eyebrow};font-weight:600;margin-bottom:6px}
.report-render-a11y--critical .report-a11y-banner-label{color:var(--red)}
.report-render-a11y--serious .report-a11y-banner-label{color:var(--amb)}
.report-a11y-list{margin:0;padding-left:0;list-style:none}
.report-a11y-list li{margin:6px 0}
.report-a11y-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.report-a11y-impact{${RECIPES.pill};${RECIPES.pillSmall}}
.report-a11y-impact--critical{background:var(--redbg);color:var(--red)}
.report-a11y-impact--serious{background:var(--ambbg);color:var(--amb)}
.report-a11y-impact--moderate,.report-a11y-impact--minor{background:var(--panel2);color:var(--dim2)}
.report-a11y-nodes{font-family:${FONT_MONO};font-size:11px;color:var(--dim)}
.report-a11y-desc{margin-top:2px;font-size:12px;color:var(--dim)}
.report-a11y-desc a{text-decoration:underline}
.report-a11y-nodes-list{margin-top:4px;padding-left:12px}
.report-a11y-node{font-size:11px;color:var(--dim2);margin:2px 0}
.report-a11y-node-html{display:block;margin:2px 0 0}
.report-render-a11y code{font-family:${FONT_MONO};font-size:11.5px}

/* ---- performance: measured, ADVISORY, never a verdict ---- */
.report-render-performance{margin-top:12px;${RECIPES.panel}}
.report-perf-banner-label{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-family:${FONT_MONO};font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600}
.report-perf-advisory-badge{font-family:${FONT_SANS};font-size:12px;color:var(--dim2);font-style:italic;letter-spacing:0;text-transform:none;font-weight:400}
.report-perf-metric-list{list-style:none;margin:12px 0 0;padding-left:0;font-size:13px}
.report-perf-metric-row{display:flex;align-items:baseline;gap:12px;padding:9px 0;border-bottom:1px solid var(--bd)}
.report-perf-metric-row:last-child{border-bottom:0}
.report-perf-metric-label{flex:1;color:var(--tx)}
.report-perf-metric-value{font-family:${FONT_MONO};font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--tx)}
.report-perf-metric-value--amber{color:var(--amb)}
.report-perf-metric-value--red{color:var(--red)}
.report-perf-hints{list-style:none;margin:12px 0 0;padding-left:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.report-perf-hint{display:flex;align-items:baseline;gap:8px;color:var(--dim)}
.report-perf-hint-sev{${RECIPES.pill};${RECIPES.pillSmall};flex:none}
.report-perf-hint-sev--warn{background:var(--ambbg);color:var(--amb)}
.report-perf-hint-sev--info{background:var(--blubg);color:var(--blu)}
.report-perf-legend{margin-top:14px;font-size:11.5px;color:var(--dim2);line-height:1.6;text-wrap:pretty}

/* ---- evidence lines ---- */
.report-evidence{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;font-size:12.5px}
.report-evidence-label{${RECIPES.eyebrow}}
.report-evidence-chip{${RECIPES.chip};${RECIPES.chipFrame}}
.report-evidence-chip--amber{border-color:var(--ambbd);background:var(--ambbg);color:var(--amb);font-weight:600}
.report-evidence-chip--blue{border-color:var(--blubd);background:var(--blubg);color:var(--blu);font-weight:600}
.report-evidence-chip--green{border-color:var(--grnbd);background:var(--grnbg);color:var(--grn);font-weight:600}
.report-evidence-thumb{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:inherit}
.report-evidence-thumb:hover{text-decoration:none;color:inherit;opacity:.8}
.report-evidence-thumb img{width:100px;height:62px;object-fit:cover;object-position:top left;display:block;border:1px solid var(--bd2);border-radius:${RADII.tag}px;background:var(--shot)}
/* Script-free degradation: the thumbnail <img> ships WITHOUT a src (the inline
   JS clones the gallery's bytes into it, so the base64 appears exactly once).
   With scripts off it stays hidden and the anchor + id label is the receipt. */
.report-evidence-thumb img:not([src]){display:none}
.report-evidence-thumb code{font-family:${FONT_MONO};font-size:12.5px;color:var(--tx)}
.report-evidence-more{font-family:${FONT_MONO};font-size:11px;color:var(--dim2)}

/* ---- criteria cards (proven + judged) ---- */
.report-criteria-list{display:flex;flex-direction:column;gap:12px}
.report-criterion-card{${RECIPES.panel};padding:18px}
.report-criterion-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.report-criterion-desc{font-family:${FONT_MONO};font-size:14px;font-weight:600;min-width:0;word-break:break-word}
.report-criterion-desc code{font-family:${FONT_MONO};font-size:14px}
.report-criterion-reasoning{margin-top:12px;color:var(--dim);font-size:13px;line-height:1.6;text-wrap:pretty}
.report-criterion-suggestion{margin-top:8px;font-size:13px}
.report-criterion-citations{margin-top:8px;font-size:12.5px;color:var(--dim)}
.report-criterion-citations code{font-family:${FONT_MONO};background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}
.report-pill{${RECIPES.pill}}
.report-pill--sm{${RECIPES.pillSmall}}
.report-pill-pass{background:var(--grnbg);color:var(--grn)}
.report-pill-fail{background:var(--redbg);color:var(--red)}
.report-pill-unverifiable{background:var(--panel2);color:var(--dim2)}
.report-proven-blurb{margin:0 0 10px;font-size:13.5px;color:var(--dim);max-width:760px;line-height:1.6;text-wrap:pretty}
.report-proven-tag{${RECIPES.pill};${RECIPES.pillSmall}}
/* Tier tone is fenced by provenTagKind(): the pass wash is reachable only when
   the mechanical verdict actually passed. */
.report-proven-tag--pass{background:var(--grnbg);color:var(--grn)}
.report-proven-tag--info{background:var(--blubg);color:var(--blu)}
.report-proven-tag--judge{background:var(--viobg);color:var(--vio)}
.report-proven-checks{list-style:none;margin:14px 0 0;padding-left:0;display:flex;flex-direction:column;gap:10px}
.report-proven-check{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.report-proven-check-detail{font-family:${FONT_MONO};font-size:12.5px;color:var(--tx);word-break:break-word}
/* Override receipt: an attempted false green, kept on the page. Amber ▲ shape-
   doubles the tint — colour is never the sole carrier. */
.report-proven-override{display:flex;align-items:baseline;gap:8px;margin-top:12px;padding:9px 12px;border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.tag}px;font-size:12.5px;color:var(--amb)}
.report-proven-override-glyph{font-weight:700}

/* ---- coverage ledger (the honest remainder) ---- */
.report-notvalidated{${RECIPES.panel};padding:22px}
.report-notvalidated .report-section-heading{font-size:16px;font-weight:600;margin-bottom:0}
.report-notvalidated-intent{font-size:13px;color:var(--dim);margin-top:10px;line-height:1.6;text-wrap:pretty}
.report-notvalidated-group{margin-top:16px}
.report-notvalidated-group-label{${RECIPES.eyebrow};color:var(--amb);margin-bottom:6px}
.report-notvalidated-list{list-style:none;margin:0;padding-left:0;display:flex;flex-direction:column;gap:6px}
.report-notvalidated-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12.5px}
.report-notvalidated-row code{font-family:${FONT_MONO};color:var(--tx)}
.report-notvalidated-detail{color:var(--dim2);word-break:break-word}
.report-notvalidated-part{margin-top:16px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.report-notvalidated-part-label{${RECIPES.eyebrow}}
.report-notvalidated-note{font-size:12px;color:var(--dim2)}
.report-notvalidated-coverage{font-size:13px;margin-top:12px}
.report-notvalidated-coverage code{font-family:${FONT_MONO}}
.report-notvalidated-empty{font-size:13px;font-style:italic;color:var(--dim);margin-top:6px}

/* ---- spec-system context panel ---- */
.report-spec-context{${RECIPES.panel}}
.report-spec-context .report-section-heading{font-size:16px;font-weight:600}
.report-spec-identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.report-spec-id{font-family:${FONT_MONO};font-size:13.5px;font-weight:600;color:var(--tx)}
.report-spec-meta{font-family:${FONT_MONO};font-size:11.5px;color:var(--dim2)}
.report-spec-pill-blue{background:var(--blubg);color:var(--blu)}
.report-spec-pill-neutral{background:var(--panel2);color:var(--dim2)}
.report-spec-cert{font-size:13px;margin-bottom:10px;color:var(--dim);line-height:1.6}
.report-spec-cert ul{margin:6px 0 0 18px;padding:0}
.report-spec-cert--met{color:var(--grn)}
.report-spec-signals{font-size:13px;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.report-spec-signals--clean{color:var(--dim2)}
.report-spec-history{font-size:13px;margin-bottom:10px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.report-spec-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim2)}
.report-spec-dot--pass{background:var(--grn)}
.report-spec-dot--fail{background:var(--red)}
.report-spec-dot--other{background:var(--amb)}
.report-spec-dot--current{outline:2px solid var(--tx);outline-offset:2px}
.report-spec-commands{font-size:12px;color:var(--dim2)}
.report-spec-commands code{font-family:${FONT_MONO};font-size:11.5px;background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}

/* ---- source + diffs ---- */
.report-source{margin-top:14px}
.report-source>summary{cursor:pointer;color:var(--dim);font-size:12.5px}
.report-source pre{margin:8px 0 0;padding:14px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.block}px;overflow-x:auto}
.report-diff-file-head{font-weight:600;margin-bottom:8px}
.report-diff-file-head code{font-family:${FONT_MONO};background:var(--panel2);padding:3px 7px;border-radius:${RADII.mark}px}
.report-file-note{margin:0 0 10px;padding:10px 14px;border-left:2px solid var(--bd2);background:var(--panel2);color:var(--dim);font-size:12.5px}
.report-diff-binary{padding:14px;background:var(--panel2);border-radius:${RADII.block}px;color:var(--dim2);font-size:12.5px}
.report-diff-hunk{border:1px solid var(--bd);border-radius:${RADII.block}px;overflow:hidden;margin-bottom:12px}
.report-diff-hunk-header{padding:7px 12px;background:var(--panel2);border-bottom:1px solid var(--bd);color:var(--dim2)}
.report-diff-hunk-header code{font-family:${FONT_MONO};font-size:11.5px}
.report-diff-hunk-body{background:var(--panel)}
.report-diff-line{display:flex;padding:0 12px;font-size:12px;line-height:1.55;white-space:pre-wrap}
.report-diff-prefix{width:1ch;flex:0 0 auto;opacity:.6}
.report-diff-text{flex:1 1 auto}
.report-diff-line-add{background:var(--grnbg);color:var(--grn)}
.report-diff-line-del{background:var(--redbg);color:var(--red)}
.report-diff-line-context{color:var(--dim)}
.report-diff-more{padding:6px 12px;border-top:1px dashed var(--bd)}
.report-diff-more>summary{cursor:pointer;color:var(--dim2);font-size:12px}

/* ---- blocked-environment banner: amber on the FULL FRAME, never green ---- */
.report-envblocked{border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.panel}px;padding:20px;color:var(--amb)}
.report-envblocked-label{font-family:${FONT_MONO};font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;color:var(--amb)}
.report-envblocked-body{margin-top:10px;font-size:13px;color:var(--tx);line-height:1.6;max-width:760px;text-wrap:pretty}
.report-envblocked-message,.report-envblocked pre{margin:10px 0 0;padding:12px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;color:var(--tx);white-space:pre-wrap;overflow-x:auto}
.report-envblocked-cause{margin-top:10px;font-size:12.5px;color:var(--tx)}
.report-envblocked-cause code{font-family:${FONT_MONO};background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}
.report-envblocked-fixlabel{${RECIPES.eyebrow};color:var(--amb);margin-top:12px}
.report-urlmode{border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.panel}px;padding:20px;color:var(--amb)}
.report-urlmode-label{font-family:${FONT_MONO};font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;color:var(--amb)}
.report-urlmode-body{margin-top:10px;font-size:13px;color:var(--tx);line-height:1.6;max-width:760px;text-wrap:pretty}

/* ---- setup health ---- */
.setup-health{${RECIPES.panel};margin-bottom:32px}
.setup-health h2{font-size:16px;font-weight:600;margin:0}
.setup-headline{margin:8px 0 0;font-size:13px;color:var(--dim)}
.setup-list{list-style:none;margin:12px 0 0;padding-left:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.setup-drift,.setup-file{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.setup-drift-category,.setup-file-action{${RECIPES.pill};${RECIPES.pillSmall};background:var(--panel2);color:var(--dim2)}
.setup-drift-field{font-family:${FONT_MONO};font-weight:600}
.setup-drift-arrow{font-family:${FONT_MONO};color:var(--dim)}
.setup-file code{font-family:${FONT_MONO}}
.setup-warning-list{color:var(--amb)}
.setup-warning-list li{list-style:disc;margin-left:18px}
.setup-manual{margin-top:12px;font-size:13px}
.setup-manual ol{margin:6px 0 0 18px;padding:0}
.setup-footer-note{margin:14px 0 0;font-size:11.5px;color:var(--dim2);text-wrap:pretty}
.setup-wrapper-fidelity{font-size:13px;margin:10px 0 0;color:var(--dim)}
.setup-wrapper-fidelity--degraded{padding:10px 14px;border:1px solid var(--ambbd);background:var(--ambbg);border-radius:${RADII.tag}px;color:var(--amb)}
.setup-app-manifest{font-size:13px;margin:10px 0 0;color:var(--dim)}
.setup-env{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.setup-env-key{${RECIPES.pill};${RECIPES.pillSmall};background:var(--panel2);color:var(--dim2);flex:none;min-width:86px;text-align:center}
.setup-env-key:empty{background:none;padding:0}
.setup-env-value{flex:1;min-width:0;font-size:12.5px;color:var(--dim);text-wrap:pretty}
.setup-env--warn .setup-env-value{color:var(--amb)}

/* ---- replay divergence (advisory, observed AFTER signing) ---- */
.report-drift{${RECIPES.panel}}
.report-drift .report-section-heading{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600}
.report-drift-headline{margin:0;font-size:13.5px;font-weight:600;color:var(--amb)}
.report-drift-note{margin:10px 0 0;font-size:12.5px;color:var(--dim);line-height:1.6;text-wrap:pretty}
.report-drift-details{margin-top:12px}
.report-drift-details summary{cursor:pointer;font-size:13px;color:var(--dim)}
.report-drift-body{margin-top:10px}
.report-drift-line{margin:4px 0;font-size:13px;color:var(--dim)}
.report-drift-line code{font-family:${FONT_MONO};font-size:11.5px;background:var(--panel2);border-radius:${RADII.mark}px;padding:1px 5px}
.report-drift-when{font-variant-numeric:tabular-nums}
.report-drift-part-label{${RECIPES.eyebrow};margin-top:12px}
.report-drift-suggestions{margin:6px 0 0 20px;padding:0;font-size:12.5px}
.report-drift-suggestions li{padding:2px 0}
.report-drift-suggestions code{font-family:${FONT_MONO}}
.report-drift-meta{margin-left:8px;color:var(--dim2);font-size:12px}
.report-drift-resume{margin:6px 0 0;padding:12px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;white-space:pre-wrap;overflow-x:auto}

/* ---- off-device captures: recorded, NEVER scored (wholly neutral tone) ---- */
.report-devevidence{${RECIPES.panel}}
.report-devevidence .report-section-heading{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600}
.report-devevidence-note{margin:0;font-size:12.5px;color:var(--dim);line-height:1.6;text-wrap:pretty}
.report-devevidence-details{margin-top:12px}
.report-devevidence-details summary{cursor:pointer;font-family:${FONT_MONO};font-size:12px;color:var(--dim2)}
.report-devevidence-body{margin-top:10px}
.report-devevidence-group+.report-devevidence-group{margin-top:14px}
.report-devevidence-file{font-size:12px;color:var(--dim2);margin-bottom:4px}
.report-devevidence-file code{font-family:${FONT_MONO}}
.report-devevidence-list{margin:0;padding:0;list-style:none}
.report-devevidence-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:7px 0;border-bottom:1px solid var(--bd);font-size:12.5px;color:var(--dim)}
.report-devevidence-row:last-child{border-bottom:0}
.report-devevidence-kind{font-family:${FONT_MONO};font-size:11.5px;color:var(--tx)}
.report-devevidence-line{word-break:break-word;flex:1}
.report-devevidence-meta{font-family:${FONT_MONO};color:var(--dim2);font-size:11.5px}

/* ---- footer + attestation ---- */
.report-footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--bd);color:var(--dim2);font-size:12px;font-family:${FONT_MONO}}
.report-footer code{color:var(--dim);background:var(--panel2);border-radius:${RADII.mark}px;padding:2px 6px}
.report-footer-line+.report-footer-line{margin-top:5px}
.report-attest{margin-top:22px;padding-top:20px;border-top:1px solid var(--bd)}
.report-attest-title{font-family:${FONT_MONO};font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;color:var(--tx)}
.report-attest-row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:9px}
.report-attest-row>span{flex:none;width:78px;font-size:11.5px;color:var(--dim2)}
.report-attest-row code{flex:1;min-width:0;font-size:11.5px;background:var(--panel2);border:1px solid var(--bd);border-radius:${RADII.tag}px;padding:5px 9px;word-break:break-all;color:var(--dim)}
/* Prose, not machine identity — so it drops out of the footer's mono. */
.report-attest-note{margin-top:16px;font-family:${FONT_SANS};font-size:11.5px;color:var(--dim2);line-height:1.65;max-width:820px;text-wrap:pretty}

@media (max-width:${BREAKPOINT_MOBILE}px){
  .report-summary{gap:12px}
  .report-hero-verdict{font-size:28px}
  .report-attest-row>span{width:auto}
  .report-evidence-thumb img{width:80px;height:50px}
}
`;
}

const JS = `
(function () {
  function activateSlide(track, idx) {
    var slides = track.querySelectorAll('.report-carousel-slide');
    if (!slides.length) return;
    if (idx < 0) idx = 0;
    if (idx >= slides.length) idx = slides.length - 1;
    for (var i = 0; i < slides.length; i++) {
      slides[i].classList.toggle('is-active', i === idx);
    }
    var carouselId = track.getAttribute('data-carousel-track');
    var bulletWrap = document.querySelector('[data-carousel-bullets="' + carouselId + '"]');
    if (bulletWrap) {
      var bullets = bulletWrap.querySelectorAll('.report-carousel-bullet');
      for (var j = 0; j < bullets.length; j++) {
        bullets[j].classList.toggle('is-active', j === idx);
      }
    }
    track.setAttribute('data-active-index', String(idx));
  }

  function currentIndex(track) {
    var attr = track.getAttribute('data-active-index');
    return attr ? parseInt(attr, 10) || 0 : 0;
  }

  function initCarousel(carousel) {
    var id = carousel.getAttribute('data-carousel-id');
    var track = carousel.querySelector('[data-carousel-track="' + id + '"]');
    if (!track) return;

    activateSlide(track, 0);

    var prev = carousel.querySelector('[data-carousel-prev="' + id + '"]');
    var next = carousel.querySelector('[data-carousel-next="' + id + '"]');
    if (prev) prev.addEventListener('click', function () { activateSlide(track, currentIndex(track) - 1); });
    if (next) next.addEventListener('click', function () { activateSlide(track, currentIndex(track) + 1); });

    var bulletWrap = carousel.querySelector('[data-carousel-bullets="' + id + '"]');
    if (bulletWrap) {
      bulletWrap.addEventListener('click', function (ev) {
        var t = ev.target;
        if (t && t.classList && t.classList.contains('report-carousel-bullet')) {
          var idx = parseInt(t.getAttribute('data-bullet-index') || '0', 10);
          activateSlide(track, idx);
        }
      });
    }

    carousel.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        activateSlide(track, currentIndex(track) - 1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        activateSlide(track, currentIndex(track) + 1);
      }
    });
  }

  function initScenarioTabs(component) {
    var tabs = component.querySelectorAll('.report-scenario-tab');
    var panes = component.querySelectorAll('.report-scenario-pane');
    var prev = component.querySelector('[data-scenario-prev]');
    var next = component.querySelector('[data-scenario-next]');
    if (!tabs.length) return;

    function indexOfActive() {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].classList.contains('is-active')) return i;
      }
      return 0;
    }

    function activateIndex(idx) {
      if (idx < 0) idx = 0;
      if (idx >= tabs.length) idx = tabs.length - 1;
      var label = tabs[idx].getAttribute('data-scenario-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('is-active', i === idx);
      }
      for (var j = 0; j < panes.length; j++) {
        panes[j].classList.toggle('is-active', panes[j].getAttribute('data-scenario-pane') === label);
      }
      // Disable boundary buttons so users see the carousel has limits.
      // No wrap-around — the user asked for explicit prev/next, not auto-cycle.
      if (prev) prev.disabled = idx === 0;
      if (next) next.disabled = idx === tabs.length - 1;
    }

    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () { activateIndex(idx); });
    });

    if (prev) prev.addEventListener('click', function () { activateIndex(indexOfActive() - 1); });
    if (next) next.addEventListener('click', function () { activateIndex(indexOfActive() + 1); });

    // Make the first tab+pane visible.
    activateIndex(0);
  }

  document.querySelectorAll('.report-carousel').forEach(initCarousel);
  document.querySelectorAll('.report-component').forEach(initScenarioTabs);

  // Evidence thumbnails: clone the PRIMARY gallery image's src so the base64
  // bytes appear exactly once in the document. Attribute-value comparison
  // (no selector construction) keeps hostile ids from injecting.
  document.querySelectorAll('img[data-shot-ref]').forEach(function (t) {
    var id = t.getAttribute('data-shot-ref');
    var src = null;
    document.querySelectorAll('img[data-shot-primary]').forEach(function (s) {
      if (!src && s.getAttribute('data-shot-primary') === id) src = s.getAttribute('src');
    });
    if (src) t.setAttribute('src', src);
    else t.removeAttribute('data-shot-ref');
  });

  // Big-picture up-link: the report is a static, self-contained artifact —
  // usually opened from file:// or unpacked from a CI artifact, where
  // "/" resolves to nothing useful. Reveal the header's up-link ONLY when
  // the document is actually served over http(s), where a root-relative "/"
  // can land on a local viewer. The markup ships hidden, so file:// / CI
  // stay inert and the output byte-deterministic.
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    document.querySelectorAll('[data-dashboard-link]').forEach(function (el) {
      el.removeAttribute('hidden');
    });
  }

  // Copy-failing-criteria-as-fix-prompt: a clipboard affordance, so it ships
  // hidden and is revealed + wired only when scripts run. The prompt text lives
  // in the button's data attribute (embedded once, at render time).
  document.querySelectorAll('button[data-fix-prompt]').forEach(function (btn) {
    btn.removeAttribute('hidden');
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-fix-prompt') || '';
      var done = btn.getAttribute('data-copy-done') || 'Copied';
      var idle = btn.textContent;
      function flash() {
        btn.textContent = done;
        setTimeout(function () { btn.textContent = idle; }, 1500);
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash(); } catch (e) { /* clipboard unavailable */ }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash, fallback);
      } else {
        fallback();
      }
    });
  });
})();
`;

/**
 * Human phrasing for a resolved sandbox toolchain. Each string states what the
 * render actually WAS, not what it approximates — `expo-web` and `next-web`
 * both compose the app onto DOM nodes through a shim layer, and a reader
 * deciding how far to trust a screenshot is entitled to know that before they
 * score it.
 */
const TARGET_VIEW: Record<string, string> = {
  web: 'web — Vite + react-dom, the app’s own runtime',
  'expo-web':
    'expo-web — react-native-web composes the app onto DOM nodes; the device is its real runtime',
  'next-web': 'next-web — Vite + react-dom with next/* stubs standing in for the framework',
};

/**
 * Whether the environment alone justifies opening the Setup panel.
 *
 * The steady state — a plain `web` target on this run's own cold Vite, with no
 * manifest and a surviving dep pre-scan — says nothing a reader needs, so it
 * stays suppressed and the report's bytes are unchanged. Everything else is a
 * fact that changes how far a screenshot can be trusted.
 *
 * `tailwindShim` is deliberately NOT a trigger: emitting the v4 shim is the
 * ordinary state of a Tailwind project. It renders inside the block when the
 * panel is open (the same way wrapper fidelity renders `ok` without forcing the
 * panel), because it is context, not a finding.
 */
function environmentIsNotable(env: ReportEnvironment | undefined): boolean {
  if (!env) return false;
  return (
    Boolean(env.depScanFailure) ||
    env.devServer !== 'cold' ||
    env.target !== 'web' ||
    Boolean(env.appManifest)
  );
}

/**
 * The environment fact list inside the Setup panel — what toolchain rendered
 * this run, who served it, what the app manifest contributed, and whether the
 * dependency pre-scan survived.
 *
 * Visual-system compliance:
 *   - no new visual language: rows reuse the panel's existing key-chip + value
 *     grid (`.setup-drift`'s recipe), and the one warning row reuses the
 *     amber token already used by `.setup-warning-list`;
 *   - hue is never the carrier — the dep-scan row's own key reads
 *     "dep pre-scan" and its value opens with the word "aborted";
 *   - deterministic: every value is a projection of the input, in a fixed row
 *     order, with no clock and no locale formatting.
 */
function renderEnvironmentFacts(env: ReportEnvironment | undefined): string {
  if (!env) return '';
  const row = (key: string, value: string, warn = false): string =>
    `<li class="setup-env${warn ? ' setup-env--warn' : ''}">` +
    `<span class="setup-env-key">${esc(key)}</span>` +
    `<span class="setup-env-value">${esc(value)}</span></li>`;

  const rows: string[] = [row('target', TARGET_VIEW[env.target] ?? env.target)];
  rows.push(
    row(
      'dev server',
      env.devServer === 'reused-browse'
        ? 'reused — served by a running `validity browse` server in another process, so its dependency pre-scan state was not observable from this run'
        : env.devServer === 'cold'
          ? 'cold — this run booted and owned its own Vite sandbox'
          : env.devServer,
    ),
  );
  if (env.tailwindShim) {
    rows.push(row('tailwind', 'v4 scan shim emitted into the sandbox'));
  }
  if (env.appManifest) {
    // The line already carries its own "mirrored: … ; recorded: …" split — the
    // whole point of which is that a reader cannot mistake what Validity READ
    // for what it ACTED ON. Rendered verbatim; the renderer adds no gloss.
    rows.push(row('app manifest', env.appManifest));
  }
  if (env.depScanFailure) {
    rows.push(
      row('dep pre-scan', `aborted — ${env.depScanFailure}`, true),
      row(
        '',
        'Dependencies were then discovered lazily, so any capture in this session may have raced a re-optimize reload. Every verdict on this page carries the demoting dep-scan taint as a result.',
        true,
      ),
    );
  }
  return `<ul class="setup-list setup-env-list">${rows.join('')}</ul>`;
}

/**
 * Setup-health panel — emitted when `input.setup` has something worth
 * surfacing, OR when the run's environment does. Suppressed in the steady
 * state to keep the report uncluttered. When shown, it lists how the run was
 * rendered, what changed (drift reasons), which files were written, and any
 * warnings (cloner fallbacks, manual-required steps). Rendered before the
 * prompt so a reviewer attributes unexpected screenshots to setup before
 * scoring.
 */
function renderSetupHealthSection(input: ReportInput): string {
  const setup = input.setup;
  const envNotable = environmentIsNotable(input.environment);
  if (!setup && !envNotable) return '';
  const interesting =
    // A notable environment is on its own reason enough — and it is the only
    // path that opens this panel for a CLI-baked report, which carries no
    // EnsureResult at all.
    envNotable ||
    (setup !== undefined &&
      (setup.bootstrapped ||
        setup.status === 'drift-resolved' ||
        setup.status === 'drift-warned' ||
        setup.status === 'manual-required' ||
        setup.warnings.length > 0 ||
        // A degraded wrapper (A1) is exactly the "screenshots look wrong for
        // setup reasons" case this panel exists for — never suppress it.
        setup.wrapperFidelity?.status === 'degraded' ||
        // An app manifest is the opposite signal — evidence the render used the
        // app's REAL env/CSS/entry rather than Validity's inference. This panel
        // is where a reader looks to decide how much to trust a screenshot, so
        // the good news belongs here just as much as the bad.
        setup.appManifest !== undefined));
  if (!interesting) return '';

  const fidelity = setup?.wrapperFidelity;
  const fidelityBlock = fidelity
    ? fidelity.status === 'degraded'
      ? `<p class="setup-wrapper-fidelity setup-wrapper-fidelity--degraded"><strong>Wrapper fidelity: degraded.</strong> ${
          fidelity.missingProviders.length > 0
            ? `Missing providers: ${esc(fidelity.missingProviders.join(', '))}.`
            : 'The render used a fallback wrapper clone.'
        } Renders may look wrong for setup reasons — evidence from them is tainted, not the component.</p>`
      : `<p class="setup-wrapper-fidelity">Wrapper fidelity: ${esc(fidelity.status)}${
          fidelity.expectedProviders.length > 0
            ? ` (${fidelity.expectedProviders.length} provider${fidelity.expectedProviders.length === 1 ? '' : 's'})`
            : ''
        }.</p>`
    : '';

  const appManifestBlock = setup?.appManifest
    ? `<p class="setup-app-manifest">${esc(setup.appManifest)}</p>`
    : '';

  // With no EnsureResult in scope (every CLI-baked report), the panel is
  // opening purely to say how the run was rendered — so the headline says that
  // rather than borrowing a setup verdict this run never produced.
  const headline = !setup
    ? 'How this run was rendered.'
    : setup.bootstrapped
      ? 'Validity auto-configured this project for you.'
      : setup.status === 'manual-required'
        ? 'Setup needs attention.'
        : setup.status === 'drift-resolved'
          ? 'Detected real-app changes since the last run; regenerated wrapper.gen.tsx.'
          : 'Setup notes.';

  const driftRows = (setup?.driftReasons ?? [])
    .filter((d) => d.severity !== 'silent')
    .map(
      (d) => `
        <li class="setup-drift">
          <span class="setup-drift-category">${esc(d.category)}</span>
          <span class="setup-drift-field">${esc(d.field)}</span>
          <span class="setup-drift-arrow">${esc(d.before ?? '∅')} → ${esc(d.after)}</span>
        </li>`,
    )
    .join('');

  const fileRows = (setup?.generatedFiles ?? [])
    .filter((f) => f.action !== 'skipped')
    .map(
      (f) => `
        <li class="setup-file">
          <span class="setup-file-action">${esc(f.action)}</span>
          <code>${esc(f.path)}</code>
        </li>`,
    )
    .join('');

  const warningRows = (setup?.warnings ?? []).map((w) => `<li>${esc(w)}</li>`).join('');

  const manualRows = setup?.manualSteps
    ? setup.manualSteps.map((s) => `<li>${esc(s)}</li>`).join('')
    : '';

  return `
    <section class="setup-health">
      <h2>Setup</h2>
      <p class="setup-headline">${esc(headline)}</p>
      ${fidelityBlock}
      ${appManifestBlock}
      ${renderEnvironmentFacts(input.environment)}
      ${driftRows ? `<ul class="setup-list setup-drift-list">${driftRows}</ul>` : ''}
      ${fileRows ? `<ul class="setup-list setup-file-list">${fileRows}</ul>` : ''}
      ${warningRows ? `<ul class="setup-list setup-warning-list">${warningRows}</ul>` : ''}
      ${manualRows ? `<div class="setup-manual"><strong>Manual steps:</strong><ol>${manualRows}</ol></div>` : ''}
      <p class="setup-footer-note">
        If the screenshots look unexpectedly different from production,
        this is the most likely cause.
      </p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Run-dir evidence sections (advisory; presence-gated)
// ---------------------------------------------------------------------------

/**
 * "Journey drift" — a later `validity replay` found the recorded on-device
 * journey no longer reaches its landmark.
 *
 * FRAMING IS THE FEATURE. This is the one section on the page that describes
 * something observed AFTER the run was signed: `replay-divergence.json` is
 * written by a command the run's key never authorized, nothing in
 * `verifyRunAttestation` reads it, and it never touched a verdict, the
 * coverage ratio, or the gate. The section says all of that in its own note, so
 * a reader who only ever sees this page cannot mistake drift for a criterion
 * result — and equally cannot mistake a green report for "the journey still
 * works".
 *
 * Visual-system compliance:
 *   - the fold is the layout's motion: an advisory section folds (`<details>`),
 *     and the summary carries the fact so the ten-second read never depends on
 *     opening it;
 *   - status is shape-doubled — `▲` (the system's advisory glyph, already used
 *     by the report hero and the override receipt) beside the WORD "diverged";
 *   - the advisory pill is the existing `.report-flag--amber`, not a new
 *     vocabulary, and the amber never reaches a full-surface frame — the
 *     environment-blocked banner stays the loudest amber on the page;
 *   - the resume handle prints VERBATIM in a `<pre>` on `--panel2`, because it
 *     is a command a human types; Validity never runs it (a resume re-enters a
 *     journey mid-flight, and judging whether the app state suits that is not
 *     Validity's call to make on someone's device);
 *   - deterministic: `observedAt` and every other value is a projection of the
 *     file, in file order; the renderer reads no clock.
 */
function renderReplayDivergenceSection(input: ReportInput): string {
  const d = input.replayDivergence;
  if (!d) return '';

  const where =
    d.step === undefined
      ? 'the recorded journey diverged'
      : `diverged at step ${d.step}${d.action ? ` (${d.action})` : ''}`;
  const summaryText = `${where}${d.kind ? ` — ${d.kind}` : ''}`;

  const detail: string[] = [];
  if (d.recording) {
    detail.push(
      `<p class="report-drift-line">Recording: <code>${esc(d.recording)}</code>${
        d.observedAt
          ? ` · observed <span class="report-drift-when">${esc(d.observedAt)}</span>`
          : ''
      }</p>`,
    );
  }
  if (d.causeMessage) {
    detail.push(
      `<p class="report-drift-line">Cause: ${esc(d.causeMessage)}${
        d.causeCode ? ` <code>${esc(d.causeCode)}</code>` : ''
      }</p>`,
    );
  }
  if (d.causeHint) detail.push(`<p class="report-drift-line">Hint: ${esc(d.causeHint)}</p>`);

  if (d.suggestions.length > 0) {
    const total = d.suggestionCount ?? d.suggestions.length;
    const extra = total > d.suggestions.length ? ` (top ${d.suggestions.length} of ${total})` : '';
    // Upstream's ranking order, preserved — an ordered list IS the ranking, so
    // the rank needs no separate column.
    const items = d.suggestions
      .map((s) => {
        const meta = [
          s.basis ? `basis ${s.basis}` : undefined,
          s.role,
          s.label ? `“${s.label}”` : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        return `<li><code>${esc(s.selector)}</code>${
          meta ? `<span class="report-drift-meta">${esc(meta)}</span>` : ''
        }</li>`;
      })
      .join('');
    detail.push(
      `<div class="report-drift-part-label">Ranked selector suggestions${esc(extra)}</div>` +
        `<ol class="report-drift-suggestions">${items}</ol>`,
    );
  } else if (d.screenUnavailableReason) {
    detail.push(
      `<p class="report-drift-line">No selector suggestions — ${esc(d.screenUnavailableReason)}</p>`,
    );
  }

  if (d.resumeCommand) {
    detail.push(
      '<div class="report-drift-part-label">Resume from the failed step</div>' +
        `<pre class="report-drift-resume">${esc(d.resumeCommand)}</pre>`,
    );
  } else if (d.resumeRefusedReason) {
    detail.push(
      `<p class="report-drift-line">Resume refused by agent-device: ${esc(d.resumeRefusedReason)}</p>`,
    );
  }

  if (d.repairHint) {
    detail.push(
      `<p class="report-drift-line">Repair hint: <code>${esc(d.repairHint)}</code> — advisory. ` +
        'Validity never heals a recording for you: a healed script is a NEW artifact and only ' +
        'becomes this spec’s evidence once a fresh verify signs it.</p>',
    );
  }

  return `
    <section class="report-section report-drift" role="note">
      <h2 class="report-section-heading">Journey drift <span class="report-flag report-flag--amber">advisory</span></h2>
      <p class="report-drift-headline"><span aria-hidden="true">▲</span> Diverged — ${esc(summaryText)}</p>
      <p class="report-drift-note">
        Observed by <code>validity replay</code> <strong>after</strong> this run was signed, so it is
        not part of the attested evidence and it changes no verdict, no coverage number, and no
        gate on this page. It is a record that the recorded on-device journey no longer holds.
      </p>
      <details class="report-drift-details">
        <summary>Divergence report</summary>
        <div class="report-drift-body">${detail.join('')}</div>
      </details>
    </section>`;
}

/** Phrasing for where in a run's life a device-evidence bundle was captured. */
const DEVICE_EVIDENCE_PHASE: Record<string, string> = {
  verify: 'captured during this run',
  replay: 'captured after a replay of this run’s recording',
};

/**
 * One compact line per record — a deliberate twin of `evidenceSummaryLine`
 * in `@validity.ai/verify-native` (the sandbox does not, and must not, depend on that
 * package; see report-run-evidence.ts on the wire-format posture).
 *
 * Its grammar is the point: the line tells a reader the evidence EXISTS and
 * where it came from. It never reports a number, a threshold, or a judgement
 * about the numbers, because none of those exist.
 */
function deviceEvidenceLine(r: ReportDeviceEvidenceRecord): string {
  if (r.status === 'captured') {
    return r.truncated
      ? `captured, payload withheld (${r.note ?? 'oversized'})`
      : `captured${r.command ? ` (${r.command})` : ''}`;
  }
  return `not captured${r.errorCode ? ` [${r.errorCode}]` : ''} — ${
    r.unavailableReason ?? 'no reason reported'
  }`;
}

/**
 * Markdown twin of {@link deviceEvidenceLine}. Same grammar, same claims — but
 * the command and the error code move into code spans, because `mdEscape`
 * backslashes the `-`/`(`/`)` characters a command line is made of and would
 * print `agent\-device perf metrics \-\-json`. Same reasoning as the
 * environment-blocked cause line above: no `mdEscape` inside a code span, the
 * backticks already suppress markdown.
 */
function mdDeviceEvidenceLine(r: ReportDeviceEvidenceRecord): string {
  if (r.status === 'captured') {
    return r.truncated
      ? `captured, payload withheld — ${mdEscape(r.note ?? 'oversized')}`
      : `captured${r.command ? ` — \`${r.command}\`` : ''}`;
  }
  return `not captured${r.errorCode ? ` \`${r.errorCode}\`` : ''} — ${mdEscape(
    r.unavailableReason ?? 'no reason reported',
  )}`;
}

/**
 * "Device evidence" — perf metrics, frame health, and network dumps captured
 * off the device.
 *
 * NEVER-FALSE-GREEN, TAKEN LITERALLY: this section renders in a wholly neutral
 * tone. No status color, no glyph from the verdict vocabulary (● ✕ ◌), no pill
 * that could read as a rollup. "captured" is not a pass and "not captured" is
 * not a failure — a device that answered nothing says nothing about the code —
 * so neither is allowed to borrow the page's verdict grammar. The producers
 * stamp `advisory-evidence-only` into every record and the section quotes that
 * posture rather than asserting it.
 *
 * Visual-system compliance: `<details>` disclosure keeps it one level down; rows are
 * a borderless hairline-separated list; the command text is monospace because
 * it is machine identity, and the prose around it is not.
 */
function renderDeviceEvidenceSection(input: ReportInput): string {
  const groups = input.deviceEvidence ?? [];
  if (groups.length === 0) return '';

  const all = groups.flatMap((g) => g.records);
  const captured = all.filter((r) => r.status === 'captured').length;
  // Tally, never a verdict: "N records · M captured" states coverage of the
  // capture attempt itself and nothing about the app.
  const summaryText = `${all.length} record${all.length === 1 ? '' : 's'} · ${captured} captured, ${
    all.length - captured
  } not captured`;

  const groupsHtml = groups
    .map((g) => {
      const rows = g.records
        .map((r) => {
          const meta = [r.platform, r.device].filter(Boolean).join(' · ');
          return (
            '<li class="report-devevidence-row">' +
            `<span class="report-devevidence-kind">${esc(r.kind)}</span>` +
            `<span class="report-devevidence-line">${esc(deviceEvidenceLine(r))}</span>` +
            (meta ? `<span class="report-devevidence-meta">${esc(meta)}</span>` : '') +
            '</li>'
          );
        })
        .join('');
      return (
        '<div class="report-devevidence-group">' +
        `<div class="report-devevidence-file"><code>${esc(g.file)}</code> — ${esc(
          DEVICE_EVIDENCE_PHASE[g.phase] ?? g.phase,
        )}</div>` +
        `<ul class="report-devevidence-list">${rows}</ul>` +
        '</div>'
      );
    })
    .join('');

  return `
    <section class="report-section report-devevidence" role="note">
      <h2 class="report-section-heading">Device evidence <span class="report-flag">advisory</span></h2>
      <p class="report-devevidence-note">
        Runtime measurements taken off the device and written down. <strong>Not scored.</strong>
        No threshold anywhere in Validity reads these numbers, nothing here decided a criterion,
        and a record that says “not captured” is not a failure — it means the device did not
        answer, which is written down rather than hidden. The files themselves carry the same
        <code>advisory-evidence-only</code> stamp.
      </p>
      <details class="report-devevidence-details">
        <summary>${esc(summaryText)}</summary>
        <div class="report-devevidence-body">${groupsHtml}</div>
      </details>
    </section>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderHtmlReport(input: ReportInput): string {
  // Section order is deliberate: the SPEC is the first-class content — when
  // the run is spec-bound, the "Part of spec" panel leads directly under the
  // verdict banner; the coverage ledger, proven verdicts, and per-criterion
  // detail come before the screenshots; the code diff reads as supporting
  // appendix, last.
  const body = `
    ${renderHeader(input)}
    ${renderEnvironmentBlockedBanner(input)}
    ${renderUrlModeDisclosure(input)}
    ${renderSpecContextSection(input)}
    ${renderNotValidatedSection(input)}
    ${renderProvenSection(input)}
    ${renderCriteriaSection(input)}
    ${renderPrompt(input)}
    ${renderSetupHealthSection(input)}
    ${renderScreenshotsSection(input)}
    ${renderReplayDivergenceSection(input)}
    ${renderDeviceEvidenceSection(input)}
    ${renderDiffSection(input)}
    ${renderFooter(input)}
  `;

  // The shared shell supplies the inlined fonts, the three-layer token CSS
  // (dark base → OS light → explicit [data-theme]), the component vocabulary,
  // and the sticky topbar with the real wordmark. `brand: 'none'` drops the
  // wordmark only — the up-link is navigation, not branding, and stays.
  // Every script below is progressive enhancement and ships its controls
  // `hidden`, so a file:// copy with scripts disabled reads identically.
  return pageShell({
    title: `Validity report ${input.runId}`,
    report: true,
    css: reportCss(),
    header: topbar({
      report: true,
      brand: input.brand === 'validity',
      nav: [DASHBOARD_NAV_ITEM],
    }),
    body,
    scripts: [JS],
  });
}

// ---------------------------------------------------------------------------
// Markdown renderer (GitHub-flavored)
// ---------------------------------------------------------------------------

/**
 * Inline-image budget. Above ~500 KB, embedding the screenshot as a base64
 * data URL makes the .md file huge AND defeats GitHub's image diffing. We
 * fall back to a relative `./screenshots/{file}.png` path which is still
 * usable in the run dir even if the .md is rendered elsewhere.
 *
 * 500 KB encoded base64 ≈ 374 KB of raw PNG, which fits a typical 1280×800
 * component screenshot but cleanly excludes long-scroll page captures.
 */
const MARKDOWN_DATA_URL_SIZE_LIMIT = 500 * 1024;

function mdEscape(text: string): string {
  // Backslash-escape the GFM-special characters that would otherwise reflow.
  // Aggressive escaping is fine — readability is the same; what matters is
  // that user prompts containing markdown-meaningful chars don't break the
  // doc structure.
  return text.replace(/([\\`*_{}[\]()#+\-!|<>])/g, '\\$1');
}

function mdImageFor(
  render: ReportRender,
  componentId: string,
  variantSlug: string,
  altText: string,
): string {
  const dataUrl = render.screenshotDataUrl;
  if (!dataUrl) return '_(no screenshot)_';

  // The dataUrl has the form `data:image/png;base64,<payload>`. Total length
  // bounds the rendered .md size — if it's too big, fall back to a relative
  // path. The relative path matches what render.ts writes to disk:
  // `<componentId>__<variantSlug>.png` inside the run dir's screenshots/ folder.
  if (dataUrl.length <= MARKDOWN_DATA_URL_SIZE_LIMIT) {
    return `![${altText}](${dataUrl})`;
  }
  const relPath = `./screenshots/${componentId}__${variantSlug}.png`;
  return `![${altText}](${relPath})`;
}

/**
 * Markdown evidence line for one criterion (parity with `renderEvidenceLine`).
 * Screenshot references link to the component's `### <id>` heading — the id
 * text is the evidence; no thumbnail duplication in markdown (data-URL bytes
 * can't be referenced twice without doubling the file).
 */
function mdEvidenceLine(
  ev: ReportEvidence | undefined,
  input: ReportInput,
  tier?: 'hard' | 'property' | 'soft',
): string {
  if (!ev) return '';
  const bits: string[] = [];
  const ids = ev.screenshotIds ?? [];
  if (ids.length > 0) {
    bits.push(`screenshots ${ids.map((id) => `[\`${id}\`](#${mdHeadingSlug(id)})`).join(', ')}`);
  }
  bits.push(`mode: ${ev.mode ?? input.mode ?? 'isolation'}`);
  for (const p of ev.dataProvenance ?? []) {
    bits.push(dataProvenanceChipFor(p).label);
  }
  if (ev.renderConfirmation === 'confirmed') bits.push('render: confirmed');
  else if (ev.renderConfirmation === 'unconfirmed') bits.push('render: UNCONFIRMED');
  if (tier === 'hard' || tier === 'property') {
    bits.push('judge: mechanical');
  } else if (ev.scoredBy) {
    let badge = '';
    if (input.scoring?.judge === 'model' && input.scoring.selfScored !== true) {
      badge = ' (model-judged)';
    } else {
      const selfScored = ev.selfScored ?? input.scoring?.selfScored;
      badge =
        selfScored === true ? ' (self-scored)' : selfScored === false ? ' (fresh-context)' : '';
    }
    bits.push(`scored by: \`${ev.scoredBy}\`${badge}`);
  }
  for (const t of ev.taints ?? []) bits.push(`tainted: ${t}`);
  return `Evidence: ${bits.join(' · ')}`;
}

/** Markdown "## Not validated" parity (same emission gate as the HTML section). */
function mdNotValidatedSection(input: ReportInput): string[] {
  const hasVerdicts = (input.criterionVerdicts?.length ?? 0) > 0;
  const notCoveredStates = input.notCovered?.dataStates ?? [];
  const notCoveredViewports = input.notCovered?.viewports ?? [];
  const hasNotCovered = notCoveredStates.length > 0 || notCoveredViewports.length > 0;
  const hasUnverifiableSoft = (input.criteria ?? []).some((c) => c.status === 'unverifiable');
  if (!hasVerdicts && !hasNotCovered && !input.coverage && !hasUnverifiableSoft) return [];

  const rows = collectUnverifiableRows(input);
  const coverageLine = coverageFloorLine(input);
  // Mirror the HTML heading: one outstanding count so an empty ledger reads
  // as "none", never as a bare "Not validated".
  const outstanding =
    rows.length +
    notCoveredStates.length +
    notCoveredViewports.length +
    (coverageLine?.breach ? 1 : 0);
  const parts: string[] = [
    `## Not validated — ${outstanding === 0 ? 'none' : `${outstanding} outstanding`}`,
    '',
    "_The run's coverage ledger: anything this run could NOT decide — unverifiable criteria, data states or viewports that never rendered — is listed here so gaps are never hidden. Not a verdict; the verdict is in the header above._",
    '',
  ];
  for (const group of groupRowsByTaint(rows)) {
    // Known labels are our own constants; unknown taint kinds pass through
    // mdEscape (they may carry arbitrary strings).
    const known =
      TAINT_GROUP_LABELS.some((t) => t.label === group.label) ||
      group.label === UNKNOWN_TAINT_GROUP;
    parts.push(`**${known ? group.label : mdEscape(group.label)}**`);
    parts.push('');
    for (const row of group.rows) {
      const excerpt = row.detail ? ` — ${mdEscape(row.detail.slice(0, 160))}` : '';
      // Textual glyph (◌ unverifiable), never an emoji verdict — this .md is
      // pasted into PRs (no emoji verdicts).
      parts.push(`- ◌ \`${row.id}\` _(unverifiable)_${excerpt}`);
    }
    parts.push('');
  }
  if (notCoveredStates.length > 0) {
    parts.push(
      `**Data states not rendered:** ${notCoveredStates.map((s) => `\`${s}\``).join(', ')} — bugs in those branches are invisible to this run.`,
    );
    parts.push('');
  }
  if (notCoveredViewports.length > 0) {
    parts.push(
      `**Viewports not covered:** ${notCoveredViewports.map((s) => `\`${s}\``).join(', ')}`,
    );
    parts.push('');
  }
  if (coverageLine) {
    const marker =
      input.coverageFloorPercent === undefined ? '' : coverageLine.breach ? ' **BREACH**' : ' ✓';
    parts.push(`**Coverage:** ${coverageLine.text}${marker}`);
    parts.push('');
  }
  if (outstanding === 0) {
    parts.push(
      '_Nothing outstanding — every criterion was decided and every planned state rendered._',
    );
    parts.push('');
  }
  return parts;
}

/**
 * Render a markdown report mirroring the HTML one. Designed to be pasted
 * into a PR description: GitHub renders inline data URLs (up to a size
 * limit), the diff section quotes file paths + notes, and acceptance
 * criteria render as a checklist.
 *
 * Mode-agnostic: handles both isolation and URL renders since they go
 * through the same `ReportComponent[]` shape.
 */
export function renderMarkdownReport(input: ReportInput): string {
  const parts: string[] = [];

  // --- Header ------------------------------------------------------------
  parts.push(`# Validity report — ${mdEscape(input.runId)}`);
  parts.push('');
  const headerBits: string[] = [`_${mdEscape(input.createdAt)}_`];
  if (input.git) {
    const branch = input.git.branch ? ` · ${mdEscape(input.git.branch)}` : '';
    const dirty = input.git.dirty ? ' · **dirty**' : '';
    headerBits.push(`\`${input.git.sha.slice(0, 7)}\`${branch}${dirty}`);
  }
  // Never-false-green parity with the HTML hero: a bare pass with no backing
  // evidence reads as Unverified, not a green Pass.
  const mdEff = effectiveVerdict(input);
  if (mdEff) {
    headerBits.push(`Verdict: **${HERO_VIEW[mdEff].word}**`);
  }
  // Presence-gated badge parity with the HTML header pill row. The blended
  // "Criteria: p/t" bit and the scoring-provenance bits are gone from this row —
  // they now live in the two-lane line below, which never blends the halves.
  const mdTaintedCount = taintedCriteriaCount(input);
  if (mdTaintedCount > 0) headerBits.push(`tainted evidence: **${mdTaintedCount}**`);
  if (input.unplanned) headerBits.push('**UNPLANNED**');
  if (input.temporalBinding === 'frozen-before-work') headerBits.push(temporalChipLabel(input));
  else if (input.temporalBinding === 'frozen-mid-work')
    headerBits.push(`**${temporalChipLabel(input)}**`);
  else if (input.temporalBinding === 'unknown') headerBits.push(temporalChipLabel(input));
  if (input.validityScore) headerBits.push(`Validity Score: **${input.validityScore.score}**`);
  parts.push(headerBits.join('  ·  '));
  parts.push('');

  // Two-lane rollup (parity with the HTML lanes — same counts, same glyphs, same
  // provenance word). Never one blended number: mechanical proof and judged
  // opinion each carry their own tally and status. Omitted on the same condition
  // the HTML lanes are.
  const mdMachine = machineLaneCounts(input);
  const mdJudged = judgedLaneCounts(input);
  if (mdMachine.total > 0 || mdJudged.total > 0 || input.scoring) {
    const m = LANE_VIEW[laneStatus(mdMachine)];
    const j = LANE_VIEW[laneStatus(mdJudged)];
    const prov = judgedProvenance(input);
    parts.push(
      `${m.glyph} Machine-verified: **${mdMachine.pass}/${mdMachine.total}** ${m.word}  ·  ` +
        `${j.glyph} Judged: **${mdJudged.pass}/${mdJudged.total}** ${j.word} _(${prov.text})_`,
    );
    parts.push('');
  }

  // Sign-off standing (parity with the HTML sign-off note). DISPLAY-ONLY; absent
  // / not-signed-off prints nothing. Same two phrasings; ✓ is a glyph, no emoji.
  if (input.signOff?.signedOff) {
    const mdModelJudged =
      input.signOff.attested &&
      input.scoring?.judge === 'model' &&
      input.scoring.selfScored !== true;
    parts.push(
      mdModelJudged
        ? '✓ signed off (model-judged) — an independent model scored the soft passes; worth a human check'
        : input.signOff.attested
          ? '✓ signed off (agent-attested) — worth a human check'
          : '✓ signed off — every blocking criterion proven mechanically',
    );
    parts.push('');
  }

  // Environment-blocked banner (parity with the HTML section under the header).
  // Presence-gated, so a healthy run's markdown is byte-identical to before.
  if (input.specError) {
    parts.push('◌ **Environment blocked — verdicts withheld**');
    parts.push('');
    parts.push(
      'This run failed before any criterion could be decided. The undecided criteria below are a consequence of the environment, not evidence about the code.',
    );
    parts.push('');
    parts.push('```');
    parts.push(input.specError.message);
    parts.push('```');
    parts.push('');
    if (input.specError.cause) {
      // No mdEscape inside a code span: the backticks already suppress markdown,
      // and mdEscape backslashes hyphens — which would print `session\-decay`.
      parts.push(`Cause: \`${input.specError.cause}\``);
      parts.push('');
    }
    if (input.specError.fixCommand) {
      parts.push('Fix:');
      parts.push('');
      parts.push('```sh');
      parts.push(input.specError.fixCommand);
      parts.push('```');
      parts.push('');
    }
  }

  // No green without receipts (parity with the HTML hero's ◌ Unverified).
  if (mdEff === 'unverified') {
    parts.push(
      '_A pass was reported, but this run recorded no criteria or proven checks to back it — treat as unverified._',
    );
    parts.push('');
  }

  // Honesty footnote for the temporal-binding badge (parity with the HTML header).
  if (input.temporalBinding) {
    const mdCaveat =
      input.temporalBinding === 'frozen-mid-work'
        ? 'The spec was frozen after work on this change began — its criteria may describe the implementation rather than the original intent.'
        : input.temporalBinding === 'unknown'
          ? 'The spec’s freeze timing could not be classified against this change.'
          : 'The spec was frozen before work on this change began.';
    const mdPartial =
      input.temporalPartial && (input.temporalUnknownSpecs?.length ?? 0) > 0
        ? ` ${input.temporalUnknownSpecs!.length} spec${input.temporalUnknownSpecs!.length === 1 ? '' : 's'} in this run could not be classified.`
        : '';
    parts.push(
      `_${mdCaveat}${mdPartial} Temporal binding is display-only provenance; it never changes a verdict._`,
    );
    parts.push('');
  }

  if (input.summary) {
    parts.push(input.summary);
    parts.push('');
  }

  // --- Spec context (parity with the HTML "Part of spec …" panel, which
  // leads directly under the verdict banner) -------------------------------
  if (input.specContext) {
    const ctx = input.specContext;
    parts.push(`## Part of spec ${mdEscape(ctx.specId)}`);
    parts.push('');
    const bits = [
      ctx.version !== undefined ? `v${ctx.version}` : '',
      ctx.status ?? '',
      ctx.maturity?.level ? `maturity: **${ctx.maturity.level}**` : '',
      ctx.cleanStreak !== undefined ? `clean streak: ${ctx.cleanStreak}` : '',
    ].filter(Boolean);
    if (bits.length > 0) parts.push(bits.join(' · '));
    parts.push('');
    const blockers = ctx.maturity?.blockers ?? [];
    if (ctx.maturity?.level !== 'certified' && blockers.length > 0) {
      parts.push('To reach **certified**:');
      for (const b of blockers) parts.push(`- ${mdEscape(b)}`);
      parts.push('');
    }
    const signals = ctx.openSignals ?? [];
    if (signals.length > 0) {
      parts.push(
        `Open signals: ${signals.map((s) => `\`${s.kind}${s.criterionId ? ` · ${s.criterionId}` : ''}\``).join(' ')}`,
      );
      parts.push('');
    }
    const history = ctx.history ?? [];
    if (history.length > 0) {
      const dots = history
        .map((h) => {
          const mark = h.verdict === 'pass' ? '✓' : h.verdict === 'fail' ? '✗' : '·';
          return h.runId === input.runId ? `**[${mark}]**` : mark;
        })
        .join(' ');
      parts.push(`Timeline (oldest → newest, this run bracketed): ${dots}`);
      parts.push('');
    }
    parts.push(
      `_Durable surfaces: \`validity spec show ${ctx.specId}\` · \`validity trends\` · \`validity verify --all\`_`,
    );
    parts.push('');
  }

  // --- Not validated (parity with the HTML section under the spec panel) --
  parts.push(...mdNotValidatedSection(input));

  // --- Prompt ------------------------------------------------------------
  parts.push('## Prompt');
  parts.push('');
  parts.push(
    input.prompt
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  );
  parts.push('');

  // --- Components / pages -----------------------------------------------
  if (input.components.length > 0) {
    parts.push('## Screenshots');
    parts.push('');
    for (const component of input.components) {
      parts.push(`### ${mdEscape(component.id)}`);
      parts.push('');
      parts.push(`\`${component.filePath}\``);
      parts.push('');

      for (const render of component.renders) {
        const label = renderLabelFor(render);
        parts.push(`**${mdEscape(label)}**`);
        parts.push('');
        if (render.renderError) {
          parts.push('Render error:');
          parts.push('');
          parts.push('```');
          parts.push(render.renderError);
          parts.push('```');
          parts.push('');
          continue;
        }
        const variantSlug =
          (render.stackedFixtureIds && render.stackedFixtureIds.length > 0
            ? 'stacked'
            : render.fixtureId && render.scenarioId
              ? `${render.scenarioId}__${render.fixtureId}`
              : (render.fixtureId ?? render.scenarioId ?? 'base')) +
          (render.viewport ? `__${render.viewport.name}` : '');
        parts.push(mdImageFor(render, component.id, variantSlug, `${component.id} — ${label}`));
        parts.push('');

        // Render provenance parity (A2/A4/A3 stamps) — display-only lines.
        const provenanceBits = (render.dataProvenance ?? [])
          .filter((p) => !(p === 'dataState-forced' && render.dataState))
          .map((p) => dataProvenanceChipFor(p).label.replace(/^data: /, ''));
        if (render.dataState) provenanceBits.unshift(`${render.dataState} (forced)`);
        if (provenanceBits.length > 0) {
          parts.push(`_Data: ${provenanceBits.join(', ')}_`);
          parts.push('');
        }
        if (render.renderConfirmation === 'unconfirmed') {
          parts.push(
            '_Render: UNCONFIRMED — the device never confirmed this render; the screenshot is not evidence._',
          );
          parts.push('');
        }

        // Diagnostics block, compact.
        const pe = render.pageErrors ?? [];
        const ce = render.consoleErrors ?? [];
        const ne = render.networkErrors ?? [];
        if (pe.length || ce.length || ne.length) {
          parts.push('<details><summary>Diagnostics</summary>');
          parts.push('');
          if (pe.length) {
            parts.push(`**Uncaught errors (${pe.length})**`);
            parts.push('');
            for (const e of pe) parts.push(`- ${mdEscape(e.message)}`);
            parts.push('');
          }
          if (ce.length) {
            parts.push(`**Console errors (${ce.length})**`);
            parts.push('');
            for (const e of ce) {
              const loc = e.url ? ` _(${e.url}${e.lineNumber ? `:${e.lineNumber}` : ''})_` : '';
              parts.push(`- ${mdEscape(e.text)}${loc}`);
            }
            parts.push('');
          }
          if (ne.length) {
            parts.push(`**Failed network responses (${ne.length})**`);
            parts.push('');
            for (const e of ne) {
              parts.push(`- \`${e.method}\` \`${e.url}\` → ${e.status}`);
            }
            parts.push('');
          }
          parts.push('</details>');
          parts.push('');
        }

        // A11y block.
        if (render.a11yViolations && render.a11yViolations.length > 0) {
          parts.push(
            `<details><summary>A11y violations (${render.a11yViolations.length})</summary>`,
          );
          parts.push('');
          for (const v of render.a11yViolations) {
            const help = v.helpUrl ? ` ([help](${v.helpUrl}))` : '';
            parts.push(
              `- **${v.impact}** \`${v.id}\` — ${mdEscape(v.description)} (${v.nodes} node${v.nodes === 1 ? '' : 's'})${help}`,
            );
            // Per-node evidence: indented selector + failure summary; the HTML
            // snippet is wrapped in backticks so Markdown renders it as text
            // (never markup) and inline HTML is escaped via mdEscape.
            for (const n of v.nodeDetails ?? []) {
              const summary = n.failureSummary ? ` — ${mdEscape(n.failureSummary)}` : '';
              parts.push(`  - \`${mdEscape(n.target)}\`${summary}`);
              if (n.html) parts.push(`    \`${mdEscape(n.html)}\``);
            }
          }
          parts.push('');
          parts.push('</details>');
          parts.push('');
        }

        // Performance metrics block (observational).
        if (render.performance) {
          const perfRows = PERF_METRIC_LABELS.filter(
            (m) => typeof render.performance![m.key] === 'number',
          );
          if (perfRows.length > 0) {
            parts.push('<details><summary>Performance</summary>');
            parts.push('');
            for (const m of perfRows) {
              const value = render.performance![m.key] as number;
              parts.push(`- ${m.label}: ${value}${m.unit ? ` ${m.unit}` : ''}`);
            }
            parts.push('');
            parts.push('</details>');
            parts.push('');
          }
        }

        // Baseline-diff line.
        if (render.baseline) {
          const px = render.baseline.mismatchedPixels ?? 0;
          if (px > 0) {
            const sha = render.baseline.sha ? ` since \`${render.baseline.sha.slice(0, 7)}\`` : '';
            parts.push(
              `_Visual regression: **${px}** pixels changed${sha}. If intended, re-baseline with \`validity accept <run-id>\`._`,
            );
            parts.push('');
          }
        }
      }
    }
  }

  // --- Code diff ---------------------------------------------------------
  if (input.diff && input.diff.files.length > 0) {
    parts.push('## Code changes');
    parts.push('');
    for (const file of input.diff.files) {
      parts.push(`### \`${file.path}\``);
      parts.push('');
      const note = input.fileNotes?.[file.path];
      if (note) {
        parts.push(`> ${note}`);
        parts.push('');
      }
      if (file.binary) {
        const kb = file.byteSize ? Math.round(file.byteSize / 1024) : 0;
        parts.push(`_Binary file changed (${kb} KB)._`);
        parts.push('');
        continue;
      }
      parts.push('```diff');
      for (const hunk of file.hunks) {
        parts.push(hunk.header);
        for (const line of hunk.lines) {
          const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          parts.push(`${prefix}${line.text}`);
        }
      }
      parts.push('```');
      parts.push('');
    }
  }

  // --- Proven (deterministic) -------------------------------------------
  // Hard/property criteria executed mechanically in the sandbox. Listed
  // separately from the soft checklist below so a proven pass never reads
  // as an LLM-scored opinion.
  const provenVerdicts = (input.criterionVerdicts ?? []).filter(
    (v) => v.tier === 'hard' || v.tier === 'property',
  );
  if (provenVerdicts.length > 0) {
    parts.push('## Proven (deterministic)');
    parts.push('');
    parts.push('_Executed mechanically in the sandbox — no LLM judgement. Authoritative._');
    parts.push('');
    for (const v of provenVerdicts) {
      // Textual glyph grammar (● pass · ✕ fail · ◌ unverifiable), never emoji —
      // this .md is pasted into PRs (no emoji verdicts).
      const glyph = v.status === 'pass' ? '●' : v.status === 'fail' ? '✕' : '◌';
      parts.push(
        `- ${glyph} \`${v.id}\` _(proven · ${v.tier})_ — **${v.status}**${
          v.detail ? `: ${mdEscape(v.detail)}` : ''
        }`,
      );
      // Override receipt (parity with the HTML proven card): surface the
      // "Mechanical verdict kept …" audit note when the agent's submitted
      // status was overridden by this mechanical verdict.
      const overrideNote = overrideNoteForProven(input, v.id);
      if (overrideNote) parts.push(`  - ▲ ${mdEscape(overrideNote)}`);
      const evidenceLine = mdEvidenceLine(
        input.evidence?.[v.id],
        input,
        v.tier === 'property' ? 'property' : 'hard',
      );
      if (evidenceLine) parts.push(`  - ${evidenceLine}`);
      for (const c of v.checks ?? []) {
        const detail = c.detail ?? JSON.stringify(c.check);
        parts.push(`  - ${c.status}: ${mdEscape(detail)}`);
      }
    }
    parts.push('');
  }

  // --- Regression vs. last run -------------------------------------------
  // DISPLAY-ONLY: hard/property deltas vs. the previous run of this spec. Lists
  // only criteria that changed status; emits nothing on first run / non-spec
  // verifies / when everything is unchanged. Never feeds the gate.
  const regressionDeltas = input.regressionDeltas ?? [];
  const changedDeltas = regressionDeltas.filter((d) => d.delta !== 'unchanged');
  if (changedDeltas.length > 0) {
    parts.push('## Regression vs. last run');
    parts.push('');
    const regressed = changedDeltas.filter((d) => d.delta === 'regressed').length;
    const improved = changedDeltas.filter((d) => d.delta === 'improved').length;
    const isNew = changedDeltas.filter((d) => d.delta === 'new').length;
    parts.push(
      `_${regressed} regressed, ${improved} improved, ${isNew} new, ${
        regressionDeltas.length - changedDeltas.length
      } unchanged._`,
    );
    parts.push('');
    for (const d of changedDeltas) {
      const glyph = d.delta === 'regressed' ? '↓' : d.delta === 'improved' ? '↑' : '+';
      const transition =
        d.delta === 'new'
          ? 'new (not in previous run)'
          : `${mdEscape(d.previousStatus ?? '—')} → ${mdEscape(d.currentStatus)}`;
      parts.push(`- ${glyph} \`${mdEscape(d.criterionId)}\` — ${transition}`);
      // Prior receipt (SOFT criteria) — mirrors the HTML strip's sub-line so a
      // reader can tell "UI regressed" from "different scorer".
      if (d.prior) {
        const currentScorer = currentScorerFor(input, d.criterionId);
        if (d.prior.scoredBy) {
          const changed = Boolean(currentScorer) && currentScorer !== d.prior.scoredBy;
          parts.push(
            changed
              ? `  - _scored by ${mdEscape(d.prior.scoredBy)} → ${mdEscape(currentScorer!)}_`
              : `  - _scored by ${mdEscape(d.prior.scoredBy)}_`,
          );
        }
        if (d.prior.reasoning) {
          parts.push(`  - _prior:_ ${mdEscape(truncatePriorNote(d.prior.reasoning))}`);
        }
      }
    }
    parts.push('');
  }

  // --- Criteria checklist ------------------------------------------------
  if (input.criteria && input.criteria.length > 0) {
    parts.push(provenVerdicts.length > 0 ? '## Scored criteria' : '## Acceptance criteria');
    parts.push('');
    for (const c of input.criteria) {
      const check = c.status === 'pass' ? '[x]' : '[ ]';
      const status = c.status === 'pass' ? '' : ` _(${c.status})_`;
      parts.push(`- ${check} ${mdEscape(c.description)}${status}`);
      if (c.reasoning) {
        parts.push(`  - ${mdEscape(c.reasoning)}`);
      }
      const evidenceLine = mdEvidenceLine(
        c.id ? input.evidence?.[c.id] : undefined,
        input,
        c.tier ?? 'soft',
      );
      if (evidenceLine) parts.push(`  - ${evidenceLine}`);
      if (c.suggestion) {
        parts.push(`  - **Suggestion:** ${mdEscape(c.suggestion)}`);
      }
    }
    parts.push('');
  }

  // --- Journey drift (parity with the HTML section) ----------------------
  // Mirrored deliberately: this .md is what gets pasted into a PR, and a
  // surface that shows a green rollup while quietly dropping the drift the HTML
  // leads with would be exactly the disagreement the provenance rule forbids.
  // Presence-gated on the same field, so a run with no divergence file is
  // byte-identical to before.
  const drift = input.replayDivergence;
  if (drift) {
    parts.push('## Journey drift _(advisory)_');
    parts.push('');
    const where =
      drift.step === undefined
        ? 'the recorded journey diverged'
        : `diverged at step ${drift.step}${drift.action ? ` (${drift.action})` : ''}`;
    parts.push(
      `▲ **Diverged** — ${mdEscape(where)}${drift.kind ? ` — ${mdEscape(drift.kind)}` : ''}`,
    );
    parts.push('');
    parts.push(
      '_Observed by `validity replay` **after** this run was signed: not part of the attested ' +
        'evidence, and it changes no verdict, coverage number, or gate on this report._',
    );
    parts.push('');
    if (drift.recording) {
      parts.push(
        `Recording: \`${drift.recording}\`${drift.observedAt ? ` · observed ${mdEscape(drift.observedAt)}` : ''}`,
      );
      parts.push('');
    }
    if (drift.causeMessage) {
      parts.push(
        `Cause: ${mdEscape(drift.causeMessage)}${drift.causeCode ? ` \`${drift.causeCode}\`` : ''}`,
      );
      parts.push('');
    }
    if (drift.causeHint) {
      parts.push(`Hint: ${mdEscape(drift.causeHint)}`);
      parts.push('');
    }
    if (drift.suggestions.length > 0) {
      const total = drift.suggestionCount ?? drift.suggestions.length;
      const extra =
        total > drift.suggestions.length ? ` (top ${drift.suggestions.length} of ${total})` : '';
      parts.push(`Ranked selector suggestions${mdEscape(extra)}:`);
      drift.suggestions.forEach((s, i) => {
        const meta = [
          s.basis ? `basis ${s.basis}` : undefined,
          s.role,
          s.label ? `“${s.label}”` : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        parts.push(`${i + 1}. \`${s.selector}\`${meta ? ` — ${mdEscape(meta)}` : ''}`);
      });
      parts.push('');
    } else if (drift.screenUnavailableReason) {
      parts.push(`No selector suggestions — ${mdEscape(drift.screenUnavailableReason)}`);
      parts.push('');
    }
    if (drift.resumeCommand) {
      parts.push('Resume from the failed step:');
      parts.push('');
      parts.push('```sh');
      // Verbatim, inside a fence: this is a command a human types, so it must
      // survive the round-trip un-escaped.
      parts.push(drift.resumeCommand);
      parts.push('```');
      parts.push('');
    } else if (drift.resumeRefusedReason) {
      parts.push(`Resume refused by agent-device: ${mdEscape(drift.resumeRefusedReason)}`);
      parts.push('');
    }
    if (drift.repairHint) {
      parts.push(
        `Repair hint: \`${drift.repairHint}\` — advisory. Validity never heals a recording for ` +
          'you; a healed script is a NEW artifact and only becomes this spec’s evidence once a ' +
          'fresh verify signs it.',
      );
      parts.push('');
    }
  }

  // --- Device evidence (parity with the HTML section) --------------------
  // Same neutral framing as the HTML: no glyph from the verdict vocabulary,
  // no bold status word, nothing a skim could read as a score.
  const evidenceGroups = input.deviceEvidence ?? [];
  if (evidenceGroups.length > 0) {
    const allRecords = evidenceGroups.flatMap((g) => g.records);
    const capturedCount = allRecords.filter((r) => r.status === 'captured').length;
    parts.push('## Device evidence _(advisory)_');
    parts.push('');
    parts.push(
      '_Runtime measurements taken off the device and written down. **Not scored** — no ' +
        'threshold in Validity reads these numbers, nothing here decided a criterion, and “not ' +
        'captured” means the device did not answer, not that anything failed._',
    );
    parts.push('');
    parts.push(
      `${allRecords.length} record${allRecords.length === 1 ? '' : 's'} · ${capturedCount} captured, ${
        allRecords.length - capturedCount
      } not captured`,
    );
    parts.push('');
    for (const g of evidenceGroups) {
      parts.push(`\`${g.file}\` — ${mdEscape(DEVICE_EVIDENCE_PHASE[g.phase] ?? g.phase)}`);
      parts.push('');
      for (const r of g.records) {
        const meta = [r.platform, r.device].filter(Boolean).join(' · ');
        parts.push(
          `- \`${r.kind}\` — ${mdDeviceEvidenceLine(r)}${meta ? ` _(${mdEscape(meta)})_` : ''}`,
        );
      }
      parts.push('');
    }
  }

  parts.push('---');
  parts.push('');
  parts.push(`_View locally: \`${input.viewCommand}\`_`);
  parts.push('');

  return parts.join('\n');
}
