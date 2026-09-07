export {
  BREAKPOINT_MOBILE,
  COLOR_TOKENS,
  FONT_MONO,
  FONT_SANS,
  GLYPHS,
  LAYOUT_TOKENS,
  RADII,
  SHELL,
  TYPE,
  statusTone,
  tokenCss,
  toneVars,
} from './tokens.js';
export type { StatusTone, TokenPair } from './tokens.js';
export { FONT_FACE_CSS } from './fonts.js';
export { WORDMARK_DARK_DATA_URI, WORDMARK_LIGHT_DATA_URI } from './wordmark-data.js';
export { esc, escAttr } from './html.js';
export {
  RECIPES,
  actionCard,
  baseCss,
  componentCss,
  barRow,
  chip,
  crumbs,
  dotStatus,
  historyStrip,
  jumpTiles,
  kvRows,
  legendRows,
  metaStrip,
  pill,
  ratioBar,
  signalCard,
  statCard,
  statGrid,
  statusPillKind,
  steps,
  verdictHero,
} from './components.js';
export type {
  Crumb,
  JumpTile,
  LegendEntry,
  PillKind,
  RatioSegment,
  StatCard,
  Step,
  Tone,
  VerdictHeroOptions,
} from './components.js';
export {
  THEME_STORAGE_KEY,
  chromeCss,
  pageShell,
  revealServedLinksScript,
  themeBootScript,
  themeToggleScript,
  topbar,
  wordmark,
} from './chrome.js';
export type { NavItem, PageShellOptions, TopbarOptions } from './chrome.js';
export { CHART_CSS, lineChart, sparkline, verdictStepLine } from './charts.js';
export type { LineChartOptions, RunVerdict, SparklineOptions, VerdictStepPoint } from './charts.js';
export {
  renderHtmlReport,
  renderMarkdownReport,
  type ReportInput,
  type ReportComponent,
  type ReportRender,
  type ReportDiff,
  type ReportDiffFile,
  type ReportDiffHunk,
  type ReportDiffLine,
  type ReportCriterion,
  type ReportRegressionDelta,
  type ReportConsoleError,
  type ReportPageError,
  type ReportNetworkError,
  type ReportA11yViolation,
  type ReportGitInfo,
  type ReportEvidence,
  type ReportEvidenceTaint,
  type ReportDataProvenance,
  type ReportSetupHealth,
  type ReportEnvironment,
} from './report.js';
export { buildEvidenceMap, type BuildEvidenceMapArgs } from './report-evidence.js';
export {
  readRunEvidence,
  toReportDivergence,
  toReportDeviceEvidence,
  REPLAY_DIVERGENCE_EVIDENCE_FILE,
  VERIFY_DEVICE_EVIDENCE_FILE,
  REPLAY_DEVICE_EVIDENCE_FILE,
  type ReportRunEvidence,
  type ReportReplayDivergence,
  type ReportDivergenceSuggestion,
  type ReportDeviceEvidenceRecord,
  type ReportDeviceEvidenceGroup,
} from './report-run-evidence.js';
