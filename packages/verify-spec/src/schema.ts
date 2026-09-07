import { z } from 'zod';
import { dataStateSchema } from './spec-schema.js';
import type { NativeConfig, PlayFunction } from './types.js';

export const mockHandlerSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string(),
  status: z.number().int().optional(),
  body: z.unknown().optional(),
});

export const validityMocksSchema = z.object({
  auth: z
    .object({
      user: z.record(z.unknown()),
    })
    .optional(),
  api: z.union([z.literal('auto'), z.array(mockHandlerSchema)]).optional(),
});

const stringRecordSchema = z.record(
  z.string({
    invalid_type_error:
      'Storage values must be strings — browser localStorage/sessionStorage cannot hold non-strings.',
  }),
);

export const mockHandlerResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599).optional(),
    json: z.unknown().optional(),
    text: z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .refine((v) => !(v.json !== undefined && v.text !== undefined), {
    message: 'Specify only one of `json` or `text` on a handler response.',
  });

export const mockNetworkHandlerSchema = z
  .object({
    url: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*']).optional(),
    status: z.number().int().min(100).max(599).optional(),
    json: z.unknown().optional(),
    text: z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .refine((v) => !(v.json !== undefined && v.text !== undefined), {
    message: 'Specify only one of `json` or `text` on a handler.',
  });

export const mockNetworkConfigSchema = z.object({
  // 'permissive' (default) → empty shape-correct bodies (crash-proofing);
  // 'populate' → synthetic POPULATED bodies (arrays of items, RSS for feeds) so
  // list/feed screens render content instead of their empty state; 'reject' →
  // un-mocked requests 599; or a literal MockHandlerResponse to answer every
  // un-mocked request with a fixed body.
  fallback: z
    .union([
      z.literal('permissive'),
      z.literal('populate'),
      z.literal('reject'),
      mockHandlerResponseSchema,
    ])
    .optional(),
  handlers: z.array(mockNetworkHandlerSchema).optional(),
  cookies: stringRecordSchema.optional(),
  localStorage: stringRecordSchema.optional(),
  sessionStorage: stringRecordSchema.optional(),
  /** RN playground (renderMode 'native') — seeds AsyncStorage before mount. */
  asyncStorage: stringRecordSchema.optional(),
});

/** Web-sandbox config (renderMode 'web'). See `WebConfig` in types.ts. */
export const webConfigSchema = z.object({
  // `.validity/app-manifest.json` consumption. Unset means ON when the file
  // exists — installing @validity.ai/verify-plugin-vite is the opt-in. Only an explicit
  // `false` makes the sandbox ignore a present manifest.
  useAppManifest: z.boolean().optional(),
});

/** React Native playground config (renderMode 'native'). */
export const nativeConfigSchema = z.object({
  scheme: z.string().optional(),
  target: z.enum(['ios', 'android', 'expo-go']).optional(),
  appEntry: z.string().optional(),
  fonts: z.record(z.string()).optional(),
  // Preventive companion-Metro recycle (see NativeConfig.metroRecycleAfterCaptures).
  // `false` disables it; a number overrides the platform default.
  metroRecycleAfterCaptures: z.union([z.number(), z.literal(false)]).optional(),
  // `.ad` replay recording (see NativeConfig.recordReplay). Defaults to ON;
  // resolve it through `nativeRecordReplayEnabled` so the "unset means on"
  // rule lives in exactly one place.
  recordReplay: z.boolean().optional(),
  // Remote device profile (see NativeConfig.remote). Passed through verbatim as
  // `--remote-config <path>`; Validity never parses the profile itself.
  remote: z.object({ configPath: z.string() }).optional(),
  // Device-side perf/network evidence during verify (see NativeConfig.deviceEvidence).
  // Default OFF; advisory-only — it adds an artifact and changes no verdict.
  deviceEvidence: z.boolean().optional(),
});

/**
 * Is `.ad` replay recording on for this project? Unset means ON — only an
 * explicit `false` turns it off, so a config written before the option existed
 * gets the recording rather than silently opting out of the trust artifact.
 */
export function nativeRecordReplayEnabled(native: NativeConfig | undefined): boolean {
  return native?.recordReplay !== false;
}

/**
 * Play function — `(args: { page }) => Promise<void> | void`.
 *
 * Zod doesn't validate function signatures, so we accept any function and
 * the runtime call site handles invocation safely. Non-functions are
 * rejected loudly, since a stringified function in JSON config would be a
 * common foot-gun.
 *
 * `z.custom<PlayFunction>` gives the inferred config type a proper
 * `PlayFunction | undefined` shape so downstream callers don't need to
 * cast `unknown → Function` everywhere.
 */
const playFunctionSchema = z.custom<PlayFunction>(
  (v) => typeof v === 'function',
  '`play` must be a function (no JSON or string forms allowed).',
);

/** Zod twin of `ViewportInput` — a preset name or an inline `{ width, height, name }`. */
const viewportInputSchema = z.union([
  z.enum(['mobile', 'tablet', 'desktop']),
  z.object({
    width: z.number(),
    height: z.number(),
    name: z.string(),
  }),
]);

/**
 * Back-compat tolerance for fields that gained a zod twin AFTER shipping
 * (scenario `viewports`/`native`/`dataState`, top-level `a11y`): before the
 * twin existed, loadConfig silently STRIPPED whatever users had there, so an
 * invalid value in an existing project must not become a hard loadConfig
 * failure now — that would break EVERY tool (verify, plan, watch, …) for a
 * config that loaded fine yesterday. A valid shape takes effect; an invalid
 * one degrades back to the old strip, made LOUD on stderr instead of silent.
 * New fields must NOT use this — it exists only for the back-compat window of
 * previously-ignored fields.
 */
function tolerantOptional<T extends z.ZodTypeAny>(schema: T, field: string) {
  return z
    .unknown()
    .optional()
    .transform((value): z.infer<T> | undefined => {
      if (value === undefined) return undefined;
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data as z.infer<T>;
      const issue = parsed.error.issues[0];
      process.stderr.write(
        `validity: ignoring invalid \`${field}\` in .validity/config.ts — ` +
          `${issue ? `${[field, ...issue.path].join('.')}: ${issue.message}` : 'invalid shape'} ` +
          `(this field used to be silently dropped; fix its shape for it to take effect).\n`,
      );
      return undefined;
    });
}

export const scenarioConfigSchema = z.object({
  description: z.string().optional(),
  mockNetwork: mockNetworkConfigSchema.optional(),
  play: playFunctionSchema.optional(),
  // Match the ScenarioConfig type shape — these three were silently stripped at
  // loadConfig before their zod twins existed (viewports/native/dataState), so
  // they stay TOLERANT: an invalid shape warns + drops instead of failing the
  // whole config load for existing projects (see `tolerantOptional`).
  viewports: tolerantOptional(z.array(viewportInputSchema), 'scenarios.*.viewports'),
  native: tolerantOptional(
    z.object({ context: z.record(z.unknown()).optional() }),
    'scenarios.*.native',
  ),
  dataState: tolerantOptional(dataStateSchema, 'scenarios.*.dataState'),
  // Secret-safe recordings (see ScenarioConfig.secrets). A NEW field, so it is
  // strict rather than tolerant: nothing was silently dropped here before, and
  // a mistyped secret declaration must fail loudly instead of degrading to
  // "this value is not a secret after all" — which is precisely the failure
  // mode that would publish a literal into a `.ad`.
  secrets: z
    .array(
      z.union([
        z.string().min(1),
        z.object({ name: z.string().min(1), env: z.string().min(1).optional() }),
      ]),
    )
    .optional(),
});

export const componentFixtureSchema = z.object({
  description: z.string().optional(),
  props: z.record(z.unknown()).optional(),
  play: playFunctionSchema.optional(),
});

export const reportConfigSchema = z.object({
  enabled: z.boolean().optional(),
  brand: z.enum(['validity', 'none']).optional(),
  // Issue #18: watch ticks bake a per-run report.html by default. On a 60s
  // interval that is ~1MB per run dir — this opts the WATCH bake out without
  // disabling verify/judge reports (the dashboard still bakes any run on
  // demand from run-meta). Default: true.
  watchReports: z.boolean().optional(),
});

// Zod twin of `RetentionConfig` — per-spec run-artifact retention windows.
// Counts clamp to ≥1 downstream (the newest run always keeps its artifacts);
// the schema floor of 1 makes "prune everything" unrepresentable by intent.
export const retentionConfigSchema = z.object({
  images: z.number().int().min(1).optional(),
  reports: z.number().int().min(1).optional(),
});

export const componentEntrySchema = z.object({
  props: z.record(z.unknown()).optional(),
  fixtures: z.record(componentFixtureSchema).optional(),
  scenarios: z.array(z.string()).optional(),
});

export const screenEntrySchema = z.object({
  props: z.record(z.unknown()).optional(),
  fixtures: z.record(componentFixtureSchema).optional(),
  scenarios: z.array(z.string()).optional(),
  routePath: z.string().optional(),
});

export const retryOnFailureSchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  retryOnPartial: z.boolean().optional(),
});

/**
 * A View item — one component (with optional override props or fixture pick)
 * to render as a section inside a View. The "snippet" / custom-render case
 * lives outside this schema today; users compose ad-hoc layouts by listing
 * the same component multiple times with different props (e.g. `Text` with
 * each sizing token).
 */
export const viewItemSchema = z.object({
  componentPath: z.string().min(1),
  fixtureName: z.string().optional(),
  props: z.record(z.unknown()).optional(),
  label: z.string().optional(),
  /**
   * Frame group id. Items sharing a value render in one device frame; items
   * without one auto-group by componentPath. See ViewItem.frame in types.ts.
   */
  frame: z.string().optional(),
});

/**
 * A named composition of components rendered together as a single browse
 * canvas. Lives in `.validity/config.ts` under `views[name]`. Names share
 * a flat namespace with components and screens — the views API rejects
 * collisions so the palette can address everything by a single identifier.
 */
export const viewDefinitionSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  /** 'stack' (default) = vertical column. 'grid' = wrapped flex row. */
  layout: z.enum(['stack', 'grid']).optional(),
  items: z.array(viewItemSchema).min(1),
});

/** Zod twin of `A11yConfig` (types.ts). Was missing → silently stripped at load. */
export const a11yConfigSchema = z.object({
  severity: z.enum(['serious', 'critical', 'off']).optional(),
});

/** Zod twin of `JudgeModelConfig` (A6) — the automated LLM judge provider. */
export const judgeModelConfigSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'openai-compatible']),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
  })
  .refine((c) => c.provider !== 'openai-compatible' || Boolean(c.baseUrl), {
    message: "provider 'openai-compatible' requires a baseUrl (the OpenAI-shaped endpoint)",
    path: ['baseUrl'],
  });

/** Zod twin of `ScoringConfig` (A6). */
export const scoringConfigSchema = z.object({
  judge: z.enum(['self', 'fresh-context', 'human', 'model']).optional(),
  judgeModel: judgeModelConfigSchema.optional(),
});

/** Zod twin of `OnSignalHookConfig` — the watch actuation hook. */
export const onSignalHookConfigSchema = z.object({
  command: z.string().min(1),
  kinds: z
    .array(
      z.enum([
        'regression',
        'unverifiable',
        'coverage-drop',
        'spec-changed',
        'needs-scoring',
        'needs-rescoring',
        'perf-drift',
        'needs-review',
        'recovered',
        'maturity-drop',
        'hardening-candidate',
        'judge-gap',
        'replay-divergence',
      ]),
    )
    .optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
});

/** Zod twin of `WatchConfig`. */
export const watchConfigSchema = z.object({
  onSignal: onSignalHookConfigSchema.optional(),
});

/** Zod twin of `MaestroRouteStep` (types.ts) — one navigation-preamble step. */
export const maestroRouteStepSchema = z.union([
  z.object({ tapOn: z.string().min(1) }).strict(),
  z.object({ tapOnId: z.string().min(1) }).strict(),
]);

/**
 * Zod twin of `MaestroRunConfig` (types.ts) — DEFAULTS for `spec export --run`.
 * Explicit CLI flags always win; this only fills what the command line omitted.
 */
export const maestroRunConfigSchema = z.object({
  platform: z.enum(['ios', 'android']).optional(),
  device: z.string().min(1).optional(),
});

/** Zod twin of `MaestroExportConfig` (types.ts) — Maestro exporter knobs. */
export const maestroExportConfigSchema = z.object({
  /** Preview opt-in — Maestro export is parked off by default (see types.ts). */
  enabled: z.boolean().optional(),
  clearState: z.boolean().optional(),
  dismissDevOverlays: z.boolean().optional(),
  routes: z
    .record(
      z.union([
        // A string route is a deep link — require a scheme so a bare path
        // ('/welcome') fails loudly instead of exporting a broken openLink.
        z.string().refine((s) => s.includes('://'), {
          message:
            "string routes must be deep links (contain '://'); use a tapOn/tapOnId step array for tap navigation",
        }),
        z.array(maestroRouteStepSchema).min(1),
      ]),
    )
    .optional(),
  // Default `--run` target binding. Not an exporter input (it changes no
  // exported bytes), so it never participates in the manifest's inputsHash.
  run: maestroRunConfigSchema.optional(),
});

/** Zod twin of `ExportConfig` (types.ts) — deterministic exporter inputs. */
export const exportConfigSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
  maestro: maestroExportConfigSchema.optional(),
});

export const validityConfigSchema = z.object({
  renderMode: z.enum(['web', 'native']),
  framework: z.enum(['vite', 'next', 'next-web', 'expo-web', 'expo-native', 'auto']),
  wrapper: z.string(),
  /** @deprecated kept for back-compat — wrapper-side context mocks. Prefer mockNetwork. */
  mocks: validityMocksSchema.optional(),
  mockNetwork: mockNetworkConfigSchema.optional(),
  // Theme axis: render every target under each listed scheme (light/dark).
  // Omitted (default) auto-enables BOTH when the spec has a theme criterion,
  // else a single render; an explicit [] forces the axis off; a list forces
  // those themes on every target.
  colorSchemes: z.array(z.enum(['light', 'dark'])).optional(),
  scenarios: z.record(scenarioConfigSchema).optional(),
  report: z.union([z.boolean(), reportConfigSchema]).optional(),
  retention: retentionConfigSchema.optional(),
  components: z.record(componentEntrySchema).optional(),
  screens: z.record(screenEntrySchema).optional(),
  views: z.record(viewDefinitionSchema).optional(),
  retryOnFailure: retryOnFailureSchema.optional(),
  native: nativeConfigSchema.optional(),
  web: webConfigSchema.optional(),
  /** Spec-freeze approval gate. See ValidityConfig.specApproval. Default 'auto'. */
  specApproval: z.enum(['always', 'never', 'auto']).optional(),
  /** Coverage floor gate for `verify --all`. See ValidityConfig.coverageFloorPercent. */
  coverageFloorPercent: z.number().int().min(0).max(100).optional(),
  /**
   * A11y config. Was missing → silently stripped at load (BUG FIX); tolerant
   * so an existing project's invalid value warns + drops instead of turning
   * every loadConfig into a hard failure (see `tolerantOptional`).
   */
  a11y: tolerantOptional(a11yConfigSchema, 'a11y'),
  /** Data-population axis (A2). undefined=auto, []=off, list=forced. */
  dataStates: z.array(dataStateSchema).optional(),
  /** Named commands for `expect.command` checks (A5). */
  commands: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string().min(1)).optional(),
  /** Command execution timeout in ms (A5). Max 600_000. */
  commandTimeoutMs: z.number().int().positive().max(600_000).optional(),
  /** Scoring config (A6). */
  scoring: scoringConfigSchema.optional(),
  /** Enforcement posture (B1). Default advisory by absence. */
  enforcement: z.enum(['advisory', 'strict']).optional(),
  /**
   * Opt-in strict knob (A6/1.5): a self-scored soft pass does not satisfy
   * `computeSignedOff`. Default OFF (`undefined`/`false`). See
   * `ValidityConfig.requireFreshJudge`.
   */
  requireFreshJudge: z.boolean().optional(),
  /** Gates all `.validity/history/` writes (F1/F2). Default off. */
  historyCommitted: z.boolean().optional(),
  /** Continuous-watch config: the on-signal actuation hook. */
  watch: watchConfigSchema.optional(),
  /** Exported-test inputs (maturity Phase B): baseUrl (Playwright), appId (Maestro). */
  export: exportConfigSchema.optional(),
  /** Advisory maturity floor (maturity Phase D): verify --all warns, never fails. */
  minimumMaturity: z.enum(['dev', 'team', 'certified']).optional(),
});

/** Resolve a user-provided `report` config (boolean or object) to a strict ReportConfig. */
export function resolveReportConfig(
  raw: boolean | { enabled?: boolean; brand?: 'validity' | 'none' } | undefined,
): { enabled: boolean; brand: 'validity' | 'none' } {
  if (raw === false) return { enabled: false, brand: 'validity' };
  if (raw === true || raw === undefined) return { enabled: true, brand: 'validity' };
  return {
    enabled: raw.enabled ?? true,
    brand: raw.brand ?? 'validity',
  };
}

export const criterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['pass', 'fail', 'unverifiable']),
  evidence: z
    .object({
      componentId: z.string(),
      screenshotPath: z.string(),
      reasoning: z.string(),
    })
    .optional(),
  suggestion: z.string().optional(),
});

export const componentRenderSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  screenshotPath: z.string(),
  videoPath: z.string().optional(),
  renderError: z.string().optional(),
});

export const validityReportSchema = z.object({
  runId: z.string(),
  prompt: z.string(),
  taskId: z.string().optional(),
  criteria: z.array(criterionSchema),
  components: z.array(componentRenderSchema),
  verdict: z.enum(['pass', 'fail', 'partial']),
  createdAt: z.string(),
});

export const lockedTaskSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  criteria: z.array(criterionSchema),
  createdAt: z.string(),
});
