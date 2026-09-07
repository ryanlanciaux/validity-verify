export { detectFramework, assertSupportedFramework } from './detect.js';
export { prepareSandbox, writePropsFile, writeSharedSandboxAssets } from './prepare.js';
export { prepareExpoWeb } from './prepare-expo-web.js';
export { buildExpoWebViteOverrides, type ExpoWebViteOverrides } from './expo-web-aliases.js';
export { buildNextWebViteOverrides, type NextWebViteOverrides } from './next-web-aliases.js';
export { startDevServer, type DevServer } from './server.js';
export { type BridgeHandle, type BridgeMessage } from './browse/bridge.js';
export {
  launchBrowser,
  captureComponent,
  type BrowserSession,
  type CaptureArgs,
  type CaptureResult,
} from './capture.js';
export {
  renderComponents,
  buildRunEnvironment,
  projectRelative,
  absoluteFromProject,
  resolveTarget,
  type RenderRequest,
  type RenderRunArgs,
} from './render.js';
export {
  captureUrls,
  detectDevServerBaseUrl,
  type UrlCaptureRequest,
  type UrlCaptureResult,
  type CaptureUrlsArgs,
} from './url-capture.js';
export {
  combineMockNetwork,
  matchUrl,
  methodMatches,
  resolveResponse,
  type ResolvedResponse,
} from './network-matcher.js';
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
  buildEvidenceMap,
  type BuildEvidenceMapArgs,
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
  WORDMARK_DARK_DATA_URI,
  WORDMARK_LIGHT_DATA_URI,
} from '@validity.ai/verify-report';
export {
  baselinesDir,
  baselinePath,
  diffPathFor,
  diffAgainstBaseline,
  confirmBaseline,
  promoteBaseline,
  listBaselineKeys,
  planBaselineLifecycle,
  sweepBaselineLifecycle,
  formatBaselineLifecycleAdvisory,
  BASELINE_RENAME_SIMILARITY,
  type BaselineLifecyclePlan,
  type BaselineRename,
} from './baselines.js';
export { runAxe, formatA11yBlock, toNodeDetails, type A11ySeverity } from './a11y.js';
export {
  validityDir,
  entryFile,
  indexHtml,
  propsDir,
  propsFile,
  relFromValidity,
} from './paths.js';
export {
  attachDiagnostics,
  formatDiagnosticsBlock,
  hasDiagnostics,
  type ConsoleErrorEntry,
  type Diagnostics,
  type DiagnosticsHandle,
  type NetworkErrorEntry,
  type PageErrorEntry,
} from './diagnostics.js';
export {
  browseLockPath,
  readBrowseLock,
  writeBrowseLock,
  deleteBrowseLock,
  readLiveBrowseLock,
  type BrowseLock,
} from './browse/lock.js';
export {
  writeFixtureToConfig,
  writeComponentScenariosToConfig,
  writeViewToConfig,
  deleteViewFromConfig,
  type WriteFixtureArgs,
  type WriteFixtureResult,
  type WriteFixtureMode,
  type WriteComponentScenariosArgs,
  type WriteViewArgs,
  type WriteViewItem,
  type DeleteViewArgs,
} from './browse/fixture-writer.js';
export {
  exportPlaywright,
  loadReportCriteria,
  type ExportArgs,
  type ExportResult,
  type ExportCriterion,
} from './exporters/playwright.js';
export {
  executeChecks,
  runCriterionChecks,
  statusMatches,
  urlMatches,
  locatorFor,
  evaluateScreenshotExpects,
  refoldAfterScreenshot,
} from './check-executor.js';
export {
  exportSpecToPlaywright,
  computeHasFixtures,
  playwrightSpecFileName,
  playwrightFixturesFileName,
  type ExportSpecPlaywrightArgs,
  type ExportSpecPlaywrightResult,
  // `ExportedFile` is also declared in spec-maestro.ts (identical shape); we
  // re-export it from exactly one module to avoid a duplicate-export error.
  type ExportedFile,
} from './exporters/spec-playwright.js';
export {
  exportSpecToMaestro,
  maestroFlowFileName,
  type ExportSpecMaestroArgs,
  type ExportSpecMaestroResult,
} from './exporters/spec-maestro.js';
export {
  collectPlaywrightWarnings,
  collectMaestroWarnings,
  type ExportWarning,
  type ExportWarningSeverity,
  type CollectPlaywrightWarningsArgs,
  type CollectMaestroWarningsArgs,
} from './exporters/spec-export-warnings.js';
export { lintMaestroSubset, MAESTRO_SUPPORTED_COMMANDS } from './exporters/maestro-subset.js';
export {
  SPEC_EXPORTER_VERSION,
  specExportsDir,
  exportsManifestPath,
  loadExportsManifest,
  saveExportsManifest,
  ensureExportsGitattributes,
  exportTargetDir,
  compileSpecExport,
  writeSpecExport,
  checkSpecExports,
  specArtifactCheck,
  recordExportRun,
  exportRunStanding,
  type ExportRunRecord,
  type ExportRunStanding,
  type ExportRunStandingStatus,
  type ExportManifestEntry,
  type ExportsManifest,
  type CompiledSpecExport,
  type WriteSpecExportResult,
  type ExportCheckStatus,
  type ExportCheckFinding,
  type ExportCheckResult,
} from './exporters/spec-export-manifest.js';
export { assessSpecMaturity } from './exporters/spec-maturity.js';
export {
  collectRuntimeExportWarnings,
  collectExportGateWarnings,
  assessSpecPortability,
  type PortabilityAssessment,
  type PortabilityStatus,
} from './exporters/spec-portability.js';
