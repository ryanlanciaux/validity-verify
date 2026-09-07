/**
 * Auto-mock planner — the "all the mocking happens automatically" engine.
 *
 * Validity's `wrapper-generator.ts` clones the project's REAL provider tree
 * into `.validity/wrapper.gen.tsx`. That's faithful, but it means a cloned
 * `<ConvexProvider>`, `<ApolloProvider>`, `<QueryClientProvider>`,
 * `<ClerkProvider>`, etc. will try to talk to real backends/auth at mount
 * time — exactly the thing we don't want in an isolated sandbox.
 *
 * This module scans `package.json` (and, cheaply, the entry file) for the
 * common data/auth/backend layers and produces a deterministic
 * {@link AutoMockPlan}: a set of base `mockNetwork` handlers + `logged-in`
 * / `logged-out` scenarios that make those providers resolve against mocked
 * responses, plus human-readable notes about anything that needs a provider
 * stub the network layer can't satisfy (Convex's WebSocket transport,
 * Clerk's session, etc.).
 *
 * No LLM, no network — pure static analysis, so it can run inside the
 * deterministic MCP server and on first-run bootstrap.
 *
 * The plan is consumed two ways:
 *   1. {@link renderAutoMockConfigSource} serializes it into the first-run
 *      `.validity/config.ts` (see ensure-configured.ts).
 *   2. The detection list is surfaced to the agent (a "Setup health" block)
 *      so it knows what was auto-mocked and what still needs a wrapper.user
 *      provider.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectAppTarget, detectExportAppId } from './app-target.js';

import { findEntryFile } from './wrapper-generator.js';

/** How Validity neutralizes a given library in the sandbox. */
export type MockStrategy =
  /** Pure network interception (MSW) handles it — no provider changes needed. */
  | 'network'
  /** Network mock + a seeded cookie/localStorage value so an auth gate opens. */
  | 'network+session'
  /**
   * The cloned provider can't be satisfied by HTTP mocking alone (e.g. a
   * WebSocket/realtime transport, or an auth SDK that needs a client key).
   * The agent should add a stub in `.validity/wrapper.user.tsx`. We still
   * seed best-effort network/session mocks so the common case renders.
   */
  | 'provider-stub';

export type MockKind = 'data' | 'graphql' | 'rpc' | 'auth' | 'backend';

export interface MockableLib {
  packageName: string;
  kind: MockKind;
  label: string;
  strategy: MockStrategy;
  /** One-line explanation surfaced to the agent. */
  note: string;
}

/** A serializable mock handler — mirrors `mockNetworkHandlerSchema`. */
export interface PlannedHandler {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | '*';
  status?: number;
  json?: unknown;
  comment?: string;
}

export interface PlannedScenario {
  description?: string;
  cookies?: Record<string, string>;
  localStorage?: Record<string, string>;
  handlers?: PlannedHandler[];
}

export interface AutoMockPlan {
  /** Libraries we detected and the strategy for each. */
  libs: MockableLib[];
  /** Base handlers applied to every render. */
  baseHandlers: PlannedHandler[];
  /** Named scenarios (always includes `logged-in` / `logged-out` when an auth/backend lib is present). */
  scenarios: Record<string, PlannedScenario>;
  /** Default cookies/localStorage seeded at the top level (auth tokens etc.). */
  baseCookies: Record<string, string>;
  baseLocalStorage: Record<string, string>;
  /** Strategy=='provider-stub' notes the agent should act on. */
  manualNotes: string[];
}

const MOCK_USER = { id: 'usr_mock_1', name: 'Test User', email: 'test@example.com' };

/**
 * Registry of mockable data/auth/backend layers. Each entry contributes
 * handlers/scenarios/notes to the plan when its package is present.
 *
 * `contribute` is called once per detected lib and mutates the in-progress
 * plan accumulator. Keeping the wiring data-driven (rather than a big
 * switch) makes it trivial to add a new framework: append one entry.
 */
interface RegistryEntry {
  kind: MockKind;
  label: string;
  strategy: MockStrategy;
  note: string;
  contribute?: (acc: PlanAccumulator) => void;
}

interface PlanAccumulator {
  baseHandlers: PlannedHandler[];
  loggedIn: PlannedScenario;
  loggedOut: PlannedScenario;
  baseCookies: Record<string, string>;
  baseLocalStorage: Record<string, string>;
}

const MOCK_REGISTRY: Record<string, RegistryEntry> = {
  // ---- Data fetching (REST over fetch) ----------------------------------
  '@tanstack/react-query': {
    kind: 'data',
    label: 'TanStack Query',
    strategy: 'network',
    note: 'REST calls are intercepted by MSW. Add handlers for the endpoints your components read.',
  },
  swr: {
    kind: 'data',
    label: 'SWR',
    strategy: 'network',
    note: 'fetch() calls are intercepted by MSW. Add handlers for the endpoints your components read.',
  },
  axios: {
    kind: 'data',
    label: 'axios',
    strategy: 'network',
    note: 'axios uses XMLHttpRequest, which @mswjs/interceptors patches. Add handlers per endpoint.',
  },

  // ---- GraphQL ----------------------------------------------------------
  '@apollo/client': {
    kind: 'graphql',
    label: 'Apollo Client',
    strategy: 'network',
    note: 'Apollo posts to its GraphQL endpoint; the seeded /graphql handler returns an empty data object. Tailor it to the queries your components run.',
    contribute(acc) {
      acc.baseHandlers.push({
        url: '/graphql',
        method: 'POST',
        json: { data: {} },
        comment: 'Apollo/urql GraphQL — replace with the shape your queries expect.',
      });
    },
  },
  urql: {
    kind: 'graphql',
    label: 'urql',
    strategy: 'network',
    note: 'urql posts to its GraphQL endpoint; the seeded /graphql handler returns an empty data object.',
    contribute(acc) {
      if (!acc.baseHandlers.some((h) => h.url === '/graphql')) {
        acc.baseHandlers.push({
          url: '/graphql',
          method: 'POST',
          json: { data: {} },
          comment: 'GraphQL endpoint — replace with the shape your queries expect.',
        });
      }
    },
  },

  // ---- tRPC -------------------------------------------------------------
  '@trpc/client': {
    kind: 'rpc',
    label: 'tRPC',
    strategy: 'network',
    note: 'tRPC batches over /api/trpc. The seeded handler returns an empty result envelope; tailor it per procedure.',
    contribute(acc) {
      acc.baseHandlers.push({
        url: '/api/trpc',
        method: '*',
        json: [{ result: { data: null } }],
        comment: 'tRPC batch endpoint — shape depends on the procedures your component calls.',
      });
    },
  },

  // ---- Auth -------------------------------------------------------------
  '@clerk/clerk-react': {
    kind: 'auth',
    label: 'Clerk',
    strategy: 'provider-stub',
    note: "Clerk's <ClerkProvider> needs a publishable key and talks to Clerk's API. For reliable isolation, stub it in .validity/wrapper.user.tsx (e.g. mock useUser/useAuth) — network mocks alone won't fully satisfy it.",
  },
  '@clerk/nextjs': {
    kind: 'auth',
    label: 'Clerk (Next.js)',
    strategy: 'provider-stub',
    note: "Clerk's provider needs a publishable key. Stub useUser/useAuth in .validity/wrapper.user.tsx for isolation renders.",
  },
  '@auth0/auth0-react': {
    kind: 'auth',
    label: 'Auth0',
    strategy: 'network+session',
    note: 'Auth0 reads a bearer token. The logged-in scenario seeds localStorage.authToken; tailor the /userinfo handler to your claims.',
    contribute(acc) {
      acc.baseLocalStorage['authToken'] = 'mock-bearer-token';
      (acc.loggedIn.handlers ??= []).push({
        url: '/userinfo',
        json: MOCK_USER,
        comment: 'Auth0 userinfo — adjust to your token claims.',
      });
    },
  },
  'next-auth': {
    kind: 'auth',
    label: 'NextAuth',
    strategy: 'network+session',
    note: 'NextAuth reads /api/auth/session. The logged-in scenario returns a mock session; logged-out returns an empty object.',
    contribute(acc) {
      (acc.loggedIn.handlers ??= []).push({
        url: '/api/auth/session',
        json: { user: MOCK_USER, expires: '2999-01-01T00:00:00.000Z' },
        comment: 'NextAuth session.',
      });
      (acc.loggedOut.handlers ??= []).push({
        url: '/api/auth/session',
        json: {},
        comment: 'NextAuth — no active session.',
      });
    },
  },

  // ---- Backends-as-a-service -------------------------------------------
  '@supabase/supabase-js': {
    kind: 'backend',
    label: 'Supabase',
    strategy: 'network+session',
    note: 'Supabase reads auth + PostgREST over HTTP. Seeded handlers cover /auth/v1/user and a permissive /rest/v1 fallback; tailor per table.',
    contribute(acc) {
      (acc.loggedIn.handlers ??= []).push({
        url: '/auth/v1/user',
        json: MOCK_USER,
        comment: 'Supabase auth user.',
      });
      acc.baseHandlers.push({
        url: '/rest/v1',
        method: '*',
        json: [],
        comment:
          'Supabase PostgREST — returns an empty row set by default; add per-table handlers.',
      });
    },
  },
  convex: {
    kind: 'backend',
    label: 'Convex',
    strategy: 'provider-stub',
    note: "Convex's <ConvexProvider> connects over WebSocket, which MSW does NOT intercept. For isolation, render with a stubbed ConvexReactClient (or mock the useQuery/useMutation hooks) in .validity/wrapper.user.tsx.",
  },
  '@convex-dev/auth': {
    kind: 'auth',
    label: 'Convex Auth',
    strategy: 'provider-stub',
    note: 'Convex Auth rides on the Convex WebSocket transport. Pair it with a stubbed Convex client in .validity/wrapper.user.tsx; the seeded session cookie is a best-effort hint only.',
  },
  firebase: {
    kind: 'backend',
    label: 'Firebase',
    strategy: 'provider-stub',
    note: 'Firebase SDK uses long-lived gRPC/WebChannel connections that MSW does not intercept. Stub the parts your component reads in .validity/wrapper.user.tsx.',
  },
};

function readDeps(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/**
 * Heuristic: does the project authenticate via cookie or bearer token?
 * Drives which session value the logged-in scenario seeds. Soft signal —
 * seeding both is harmless, but biasing correctly means the auth gate opens
 * on the first render more often.
 */
function detectAuthTransport(
  projectRoot: string,
  deps: Record<string, string>,
): 'cookie' | 'bearer' {
  const entryCandidates = [
    'src/main.tsx',
    'src/main.jsx',
    'src/index.tsx',
    'app/_layout.tsx',
    'App.tsx',
  ];
  // The wrapper generator's discovery also covers package.json `main` and
  // root index.* entries (Ignite) — append it so those projects get scanned.
  const discovered = findEntryFile(projectRoot);
  if (discovered && !entryCandidates.includes(discovered)) entryCandidates.push(discovered);
  for (const rel of entryCandidates) {
    const abs = resolve(projectRoot, rel);
    if (!existsSync(abs)) continue;
    let text = '';
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (/document\.cookie|js-cookie|cookies-next/.test(text)) return 'cookie';
    if (/localStorage\s*\.\s*(getItem|setItem)\(/.test(text)) return 'bearer';
    break;
  }
  if (deps['next-auth'] || deps['@clerk/clerk-react'] || deps['@clerk/nextjs']) return 'cookie';
  if (deps['@auth0/auth0-react']) return 'bearer';
  return 'cookie';
}

/**
 * Build the auto-mock plan for a project. Deterministic and side-effect
 * free — reads package.json + (optionally) the entry file, returns data.
 */
export function planAutoMock(projectRoot: string): AutoMockPlan {
  const deps = readDeps(projectRoot);
  const libs: MockableLib[] = [];

  const acc: PlanAccumulator = {
    baseHandlers: [],
    loggedIn: { description: 'An authenticated user is signed in.' },
    loggedOut: { description: 'No user is signed in.' },
    baseCookies: {},
    baseLocalStorage: {},
  };

  for (const [pkg, entry] of Object.entries(MOCK_REGISTRY)) {
    if (!deps[pkg]) continue;
    libs.push({
      packageName: pkg,
      kind: entry.kind,
      label: entry.label,
      strategy: entry.strategy,
      note: entry.note,
    });
    entry.contribute?.(acc);
  }

  const hasAuthLike = libs.some((l) => l.kind === 'auth' || l.kind === 'backend');

  // Seed the canonical session signal for the auth transport in use, so a
  // gate reading a cookie/localStorage on mount opens in the logged-in
  // scenario and stays closed in logged-out.
  if (hasAuthLike) {
    const transport = detectAuthTransport(projectRoot, deps);
    if (transport === 'cookie') {
      (acc.loggedIn.cookies ??= {}).session = 'mock-session';
    } else {
      (acc.loggedIn.localStorage ??= {}).authToken = 'mock-bearer-token';
    }
    // A generic /api/me 200 vs 401 covers hand-rolled auth that neither
    // NextAuth/Supabase/Auth0 handlers above matched.
    if (!(acc.loggedIn.handlers ?? []).some((h) => h.url === '/api/me')) {
      (acc.loggedIn.handlers ??= []).push({
        url: '/api/me',
        json: MOCK_USER,
        comment: 'Generic current-user endpoint.',
      });
    }
    (acc.loggedOut.handlers ??= []).push({
      url: '/api/me',
      status: 401,
      comment: 'Generic current-user endpoint — unauthenticated.',
    });
  }

  const scenarios: Record<string, PlannedScenario> = {};
  if (hasAuthLike) {
    scenarios['logged-in'] = acc.loggedIn;
    scenarios['logged-out'] = acc.loggedOut;
  }

  const manualNotes = libs
    .filter((l) => l.strategy === 'provider-stub')
    .map((l) => `${l.label}: ${l.note}`);

  return {
    libs,
    baseHandlers: acc.baseHandlers,
    scenarios,
    baseCookies: acc.baseCookies,
    baseLocalStorage: acc.baseLocalStorage,
    manualNotes,
  };
}

/* ------------------------------------------------------------------ */
/* Serialization → .validity/config.ts source                          */
/* ------------------------------------------------------------------ */

function jsonInline(value: unknown): string {
  // Deterministic, compact JSON for embedding in generated TS. Object keys
  // keep their insertion order (V8 guarantee for string keys), which keeps
  // generated config diffs stable across runs.
  return JSON.stringify(value);
}

function renderHandler(h: PlannedHandler, indent: string): string {
  const parts: string[] = [`url: ${jsonInline(h.url)}`];
  if (h.method && h.method !== 'GET') parts.push(`method: ${jsonInline(h.method)}`);
  if (h.status !== undefined) parts.push(`status: ${h.status}`);
  if (h.json !== undefined) parts.push(`json: ${jsonInline(h.json)}`);
  const comment = h.comment ? ` // ${h.comment}` : '';
  return `${indent}{ ${parts.join(', ')} },${comment}`;
}

function renderRecord(rec: Record<string, string>): string {
  const entries = Object.entries(rec).map(([k, v]) => `${jsonInline(k)}: ${jsonInline(v)}`);
  return `{ ${entries.join(', ')} }`;
}

function renderScenario(name: string, s: PlannedScenario, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}${jsonInline(name)}: {`);
  if (s.description) lines.push(`${indent}  description: ${jsonInline(s.description)},`);
  const net: string[] = [];
  if (s.cookies && Object.keys(s.cookies).length)
    net.push(`${indent}    cookies: ${renderRecord(s.cookies)},`);
  if (s.localStorage && Object.keys(s.localStorage).length)
    net.push(`${indent}    localStorage: ${renderRecord(s.localStorage)},`);
  if (s.handlers && s.handlers.length) {
    net.push(`${indent}    handlers: [`);
    for (const h of s.handlers) net.push(renderHandler(h, `${indent}      `));
    net.push(`${indent}    ],`);
  }
  if (net.length) {
    lines.push(`${indent}  mockNetwork: {`);
    lines.push(...net);
    lines.push(`${indent}  },`);
  }
  lines.push(`${indent}},`);
  return lines.join('\n');
}

/**
 * Render a complete `.validity/config.ts` source string tailored to the
 * project's detected stack. Replaces the old static `defaultConfigSource()`
 * — when nothing is detected it degrades to the same minimal-but-helpful
 * config (permissive fallback, commented example handler, logged-in /
 * logged-out scaffolding).
 */
export function renderAutoMockConfigSource(projectRoot: string): string {
  const plan = planAutoMock(projectRoot);
  const detected = plan.libs.map((l) => l.label);
  // Seed `commands.typecheck` for TypeScript projects so `expect.command`
  // (and the plan-time repo-typecheck auto-attach) works out of the box.
  // First-run generation only — existing configs are never overwritten.
  const seedTypecheck =
    existsSync(resolve(projectRoot, 'tsconfig.json')) &&
    Boolean(readDeps(projectRoot)['typescript']);

  const header: string[] = [
    '// .validity/config.ts — generated by Validity on first run.',
    '// Edit freely. Validity preserves this file across regens.',
  ];
  if (detected.length) {
    header.push(`// Auto-detected: ${detected.join(', ')}.`);
    header.push('// Validity seeded mocks/scenarios below so these render in isolation.');
  }
  if (plan.manualNotes.length) {
    header.push('//');
    header.push('// Needs a manual stub in .validity/wrapper.user.tsx:');
    for (const n of plan.manualNotes) header.push(`//   • ${n}`);
  }

  // React Native / Expo projects are pinned to the DEVICE, not to the
  // `react-native-web` proxy. Writing the target explicitly here (rather than
  // leaving `'auto'` to guess) is what keeps a mobile app from being quietly
  // validated in a browser: `'auto'` refuses Expo on purpose, and a config
  // that says `expo-native` can never drift into a web render. Switching to
  // Expo Web is a two-line edit the comment spells out.
  const appTarget = detectAppTarget(projectRoot);
  const isNativeProject = appTarget.nativeAvailable && !appTarget.webTargetExplicit;

  const out: string[] = [...header, 'export default {'];
  if (isNativeProject) {
    out.push('  // React Native app — validated on a simulator/emulator, the runtime it ships on.');
    out.push('  // To validate through the react-native-web proxy instead (no device, faster, but');
    out.push("  // a DIFFERENT runtime than your users get), set renderMode: 'web' and");
    out.push("  // framework: 'expo-web' here.");
    out.push("  renderMode: 'native' as const,");
    out.push("  framework: 'expo-native' as const,");
  } else {
    out.push("  renderMode: 'web' as const,");
    out.push("  framework: 'auto' as const,");
  }
  out.push("  wrapper: './.validity/wrapper.gen.tsx',");

  // mockNetwork
  out.push('  mockNetwork: {');
  out.push("    fallback: 'permissive' as const,");
  if (Object.keys(plan.baseCookies).length)
    out.push(`    cookies: ${renderRecord(plan.baseCookies)},`);
  if (Object.keys(plan.baseLocalStorage).length)
    out.push(`    localStorage: ${renderRecord(plan.baseLocalStorage)},`);
  out.push('    handlers: [');
  if (plan.baseHandlers.length) {
    for (const h of plan.baseHandlers) out.push(renderHandler(h, '      '));
  } else {
    out.push("      // { url: '/api/me', json: { id: '1', name: 'Test User' } },");
  }
  out.push('    ],');
  out.push('  },');

  // scenarios
  const scenarioNames = Object.keys(plan.scenarios);
  if (scenarioNames.length) {
    out.push('  scenarios: {');
    for (const name of scenarioNames) out.push(renderScenario(name, plan.scenarios[name]!, '    '));
    out.push('  },');
  } else {
    // No auth/backend detected — still scaffold the canonical pair so the
    // agent has a template to fill in.
    out.push('  scenarios: {');
    out.push("    'logged-in': {");
    out.push('      mockNetwork: {');
    out.push("        cookies: { session: 'mock-session' },");
    out.push("        handlers: [{ url: '/api/me', json: { id: '1', name: 'Test User' } }],");
    out.push('      },');
    out.push('    },');
    out.push("    'logged-out': {");
    out.push('      mockNetwork: {');
    out.push("        handlers: [{ url: '/api/me', status: 401 }],");
    out.push('      },');
    out.push('    },');
    out.push('  },');
  }

  // commands — named shell commands `expect.command` checks may reference
  // (specs carry only the NAME; the shell string lives here).
  if (seedTypecheck) {
    out.push('  commands: {');
    out.push("    typecheck: 'tsc --noEmit', // referenced by expect.command { run: 'typecheck' }");
    out.push('  },');
  }

  // export.appId — the id an exported Maestro flow launches (`launchApp`).
  // Scaffolded from the Expo/RN app config so the first export doesn't silently
  // fall back to the `com.example.app` placeholder. Native project with no id
  // found → leave a visible TODO; pure-web → nothing.
  const appId = detectExportAppId(projectRoot);
  if (appId) {
    out.push('  // Stamped into exported Maestro flows (`launchApp`) and drift-tracked.');
    out.push(`  export: { appId: '${appId}' },`);
  } else if (appTarget.nativeAvailable) {
    out.push('  // TODO(validity): set export.appId to your app id (Android package /');
    out.push('  //   iOS bundle id) — stamped into exported Maestro flows, drift-tracked.');
    out.push("  // export: { appId: 'com.example.app' },");
  }

  out.push('  components: {},');
  out.push('};');
  out.push('');
  return out.join('\n');
}
