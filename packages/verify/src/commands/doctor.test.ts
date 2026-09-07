/**
 * `agentStanzaCheck` (Phase A info-level doctor line) at the JS boundary:
 * present in CLAUDE.md → ok; present in both CLAUDE.md + AGENTS.md → "(AGENTS.md too)";
 * no CLAUDE.md → info; CLAUDE.md without the block → info. The check is
 * informational only — it never produces 'fail' or 'warn' across all cases.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_STANZA_BEGIN,
  AGENT_STANZA_END,
  renderAgentStanzaBlock,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import type { NativeReadiness, ReadinessStep } from '@validity.ai/verify-native';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  agentStanzaCheck,
  classifyBridgePortHolder,
  nativeReadinessChecks,
  type Check,
} from './doctor.js';
import type { McpRuntimeStamp } from '../mcp-runtime.js';

// `loadConfig` dynamically `import()`s the user's `.validity/config.ts` off
// disk — under Vitest that goes through Vite's own module graph, which
// refuses to load arbitrary tmp-dir paths outside the project root ("Does
// the file exist?" even though it does). Mocking it here follows the same
// pattern verify-all.test.ts already uses for exactly this reason: real
// project-shape detection (package.json, app.json) still runs against real
// tmp-dir fixtures below — only the config *load* is faked.
vi.mock('@validity.ai/verify-spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@validity.ai/verify-spec')>()),
  loadConfig: vi.fn(),
}));

function makeProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-doctor-stanza-'));
}

function writeBlock(path: string): void {
  const block =
    `# Notes\n\nSome user text outside the markers.\n\n` +
    renderAgentStanzaBlock() +
    `\n\nMore user text.\n`;
  writeFileSync(path, block, 'utf8');
}

describe('agentStanzaCheck', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('CLAUDE.md with the managed block → ok, detail mentions CLAUDE.md', () => {
    writeBlock(resolve(root, 'CLAUDE.md'));
    const c = agentStanzaCheck(root);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('CLAUDE.md');
    expect(c.detail).not.toContain('(AGENTS.md too)');
  });

  it('CLAUDE.md + AGENTS.md both with the block → ok, detail includes "(AGENTS.md too)"', () => {
    writeBlock(resolve(root, 'CLAUDE.md'));
    writeBlock(resolve(root, 'AGENTS.md'));
    const c = agentStanzaCheck(root);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('(AGENTS.md too)');
  });

  it('no CLAUDE.md → info', () => {
    const c = agentStanzaCheck(root);
    expect(c.status).toBe('info');
  });

  it('CLAUDE.md without the block → info', () => {
    writeFileSync(resolve(root, 'CLAUDE.md'), '# Just project notes\n', 'utf8');
    const c = agentStanzaCheck(root);
    expect(c.status).toBe('info');
  });

  it('info is representable in the Check status union at the type level', () => {
    const info: Check = { name: 'agent stanza', status: 'info', detail: 'x' };
    const ok: Check = { name: 'agent stanza', status: 'ok', detail: 'x' };
    expect(info.status).toBe('info');
    expect(ok.status).toBe('ok');
  });

  it('never returns fail or warn across all cases', () => {
    const cases: Array<() => Check> = [
      () => {
        writeBlock(resolve(root, 'CLAUDE.md'));
        return agentStanzaCheck(root);
      },
      () => {
        writeBlock(resolve(root, 'CLAUDE.md'));
        writeBlock(resolve(root, 'AGENTS.md'));
        return agentStanzaCheck(root);
      },
      () => {
        writeFileSync(resolve(root, 'CLAUDE.md'), '# notes\n', 'utf8');
        return agentStanzaCheck(root);
      },
      () => agentStanzaCheck(root),
    ];
    for (const fn of cases) {
      const c = fn();
      expect(c.status).not.toBe('fail');
      expect(c.status).not.toBe('warn');
    }
  });

  it('builds the block from the canonical markers (sanity — guards against hand-rolled test setup drift)', () => {
    const block = renderAgentStanzaBlock();
    expect(block).toContain(AGENT_STANZA_BEGIN);
    expect(block).toContain(AGENT_STANZA_END);
  });
});

/**
 * `nativeReadinessChecks` — wires `checkNativeReadiness` (packages/native)
 * into doctor's Check rows. `checkNativeReadiness` itself is injected so
 * these tests never touch a real device / agent-device CLI; only the
 * project-shape detection (native-available? web-pinned?) and config
 * loading run for real, against tmp-dir fixtures — same style as
 * app-target.test.ts.
 */
describe('nativeReadinessChecks', () => {
  let root: string;
  const mockedLoadConfig = vi.mocked(loadConfig);

  beforeEach(() => {
    root = makeProject();
    mockedLoadConfig.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePkg(deps: Record<string, string>): void {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ dependencies: deps }), 'utf8');
  }

  function mockConfig(body: Partial<ValidityConfig>): void {
    mockedLoadConfig.mockResolvedValue({
      config: body as ValidityConfig,
      configPath: resolve(root, '.validity/config.ts'),
    });
  }

  const nativeConfig: Partial<ValidityConfig> = {
    renderMode: 'native',
    framework: 'expo-native',
    wrapper: './.validity/wrapper.gen.tsx',
  };

  function step(overrides: Partial<ReadinessStep> = {}): ReadinessStep {
    return { id: 'x', label: 'X', status: 'ok', detail: 'fine', ...overrides };
  }

  /**
   * The readiness rows only. Two rows shell out and are therefore suppressed
   * here: the control-bridge-port row (lsof/ps — its count would depend on what
   * happens to hold port 8083 on the machine running the tests) and the
   * advisory `agent-device doctor` relay (whose findings depend on whether this
   * machine has a device attached at all). Both have their own suites below,
   * driven by injected seams.
   */
  const nativeChecks = (
    root: string,
    opts: Parameters<typeof nativeReadinessChecks>[1] = {},
  ): Promise<Check[]> =>
    nativeReadinessChecks(root, {
      ...opts,
      skipBridgePort: true,
      skipAgentDeviceDoctor: true,
    });

  it('web-only project (Vite): zero rows, checkReadiness never called', async () => {
    writePkg({ vite: '6', react: '18' });
    let called = false;
    const checks = await nativeChecks(root, {
      checkReadiness: async () => {
        called = true;
        return { ready: true, steps: [] };
      },
    });
    expect(checks).toEqual([]);
    expect(called).toBe(false);
  });

  it('native project explicitly pinned to Expo Web: zero rows', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig({
      renderMode: 'web',
      framework: 'expo-web',
      wrapper: './.validity/wrapper.gen.tsx',
    });
    const checks = await nativeChecks(root, {
      checkReadiness: async () => ({ ready: true, steps: [] }),
    });
    expect(checks).toEqual([]);
  });

  it('Expo Web pin WITH a native block: readiness rows come back — the device verify will drive deserves them', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig({
      renderMode: 'web',
      framework: 'expo-web',
      wrapper: './.validity/wrapper.gen.tsx',
      native: { target: 'android' },
    } as Partial<ValidityConfig>);
    let seenPlatform: string | undefined;
    const checks = await nativeChecks(root, {
      checkReadiness: async (opts) => {
        seenPlatform = opts.platform;
        return { ready: true, steps: [step()] };
      },
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(seenPlatform).toBe('android');
  });

  it('Expo Web pin, native block without a target: rows come back on the default platform (ios)', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig({
      renderMode: 'web',
      framework: 'expo-web',
      wrapper: './.validity/wrapper.gen.tsx',
      native: { fonts: {} },
    } as Partial<ValidityConfig>);
    let seenPlatform: string | undefined;
    const checks = await nativeChecks(root, {
      checkReadiness: async (opts) => {
        seenPlatform = opts.platform;
        return { ready: true, steps: [step()] };
      },
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(seenPlatform).toBe('ios');
  });

  it('native project, config fails to load: one info row naming the load failure', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockedLoadConfig.mockRejectedValue(new Error('No validity config found — run `validity init`'));
    const checks = await nativeChecks(root, {
      checkReadiness: async () => ({ ready: true, steps: [] }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('info');
    expect(checks[0]!.name).toBe('native readiness');
    expect(checks[0]!.detail).toContain('native readiness could not be checked');
    expect(checks[0]!.detail).toContain('validity init');
  });

  it('native project, checkReadiness throws: collapses to one info row (never crashes doctor)', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig(nativeConfig);
    const checks = await nativeChecks(root, {
      checkReadiness: async () => {
        throw new Error('boom');
      },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('info');
    expect(checks[0]!.detail).toContain('boom');
  });

  it('all steps ok: one ok row per step, plus an ok summary row', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig(nativeConfig);
    const readiness: NativeReadiness = {
      ready: true,
      steps: [
        step({ id: 'agent-device', label: 'agent-device CLI', detail: 'On PATH (v0.20.5).' }),
        step({ id: 'device', label: 'Booted ios device', detail: 'Found a booted device.' }),
      ],
    };
    const checks = await nativeChecks(root, { checkReadiness: async () => readiness });
    expect(checks).toHaveLength(3); // 2 steps + summary
    expect(checks[0]).toEqual({
      name: 'native: agent-device CLI',
      status: 'ok',
      detail: 'On PATH (v0.20.5).',
    });
    expect(checks[1]!.name).toBe('native: Booted ios device');
    const summary = checks[2]!;
    expect(summary.name).toBe('native readiness');
    expect(summary.status).toBe('ok');
    expect(summary.detail).toBe('all 2 steps ready');
  });

  it('a todo step maps to warn (never fail) and carries the fix action in the detail', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig(nativeConfig);
    const todoStep = step({
      id: 'device',
      label: 'Booted ios device',
      status: 'todo',
      detail: 'No booted simulator.',
      action: 'xcrun simctl boot <device>',
    });
    const readiness: NativeReadiness = {
      ready: false,
      steps: [todoStep],
      nextAction: todoStep,
    };
    const checks = await nativeChecks(root, { checkReadiness: async () => readiness });
    expect(checks).toHaveLength(2);
    expect(checks[0]!.status).toBe('warn');
    expect(checks[0]!.status).not.toBe('fail');
    expect(checks[0]!.detail).toBe('No booted simulator. — fix: xcrun simctl boot <device>');
    const summary = checks[1]!;
    expect(summary.status).toBe('warn');
    expect(summary.detail).toContain('blocked at: Booted ios device');
    expect(summary.detail).toContain('xcrun simctl boot <device>');
  });

  it('never returns a fail status across any case', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig(nativeConfig);
    const todoStep = step({ status: 'todo', detail: 'missing', action: 'do it' });
    const checks = await nativeChecks(root, {
      checkReadiness: async () => ({ ready: false, steps: [todoStep], nextAction: todoStep }),
    });
    for (const c of checks) expect(c.status).not.toBe('fail');
  });

  // ---- the control-bridge-port row, end to end through the injected runner --
  it('adds a bridge-port row, warning when a foreign process holds it', async () => {
    writePkg({ expo: '51', 'react-native': '0.74' });
    mockConfig(nativeConfig);
    const run = async (bin: string, args: string[]) => {
      if (bin === 'lsof' && args[0] === '-ti') return { code: 0, stdout: '9182\n', stderr: '' };
      if (bin === 'ps' && args.includes('pgid=')) return { code: 0, stdout: '9182\n', stderr: '' };
      if (bin === 'ps') return { code: 0, stdout: 'node /opt/validity-mcp/mcp.js\n', stderr: '' };
      return { code: 0, stdout: 'p9182\nn/Users/dev/other-project\n', stderr: '' };
    };
    const checks = await nativeReadinessChecks(root, {
      checkReadiness: async () => ({ ready: true, steps: [] }),
      run: run as never,
    });
    const row = checks.find((c) => c.name === 'native: control bridge port')!;
    expect(row).toBeDefined();
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('9182');
    expect(row.detail).toContain('kill 9182');
  });
});

/**
 * The native control-bridge port row (2026-07-29). See
 * `classifyBridgePortHolder`'s doc comment for the session this came from: a
 * validity-mcp from a previous day held 8083 with an Android device attached
 * while an iOS run delegated through it, and doctor said nothing at all.
 */
describe('classifyBridgePortHolder', () => {
  const projectRoot = '/Users/dev/my-app';
  const stamp = (pid: number): McpRuntimeStamp => ({
    version: '1.2.3',
    pid,
    startedAt: '2026-07-29T10:00:00.000Z',
  });

  it('a free port is ok', () => {
    const c = classifyBridgePortHolder({ holders: [], mcpStamp: null, projectRoot });
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('free');
  });

  it('the RUNNING MCP holding it is ok — that is the expected owner', () => {
    const c = classifyBridgePortHolder({
      holders: [{ pid: 777, command: 'node validity-mcp' }],
      mcpStamp: stamp(777),
      projectRoot,
      isAlive: () => true,
    });
    expect(c.status).toBe('ok');
  });

  it('a process whose cwd is inside this project is ok (the CLI driving a browse)', () => {
    const c = classifyBridgePortHolder({
      holders: [{ pid: 888, command: 'node validity', cwd: `${projectRoot}/packages/app` }],
      mcpStamp: null,
      projectRoot,
      isAlive: () => true,
    });
    expect(c.status).toBe('ok');
  });

  it('a STALE validity-mcp (pid ≠ the running stamp) warns, with the kill hint', () => {
    const c = classifyBridgePortHolder({
      holders: [{ pid: 4242, command: 'node /opt/validity-mcp/mcp.js', cwd: '/Users/dev/other' }],
      mcpStamp: stamp(777),
      projectRoot,
      isAlive: () => true,
    });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('another session or another project');
    expect(c.detail).toContain('kill 4242');
    expect(c.detail).toContain('restart your MCP host');
    expect(c.detail).toContain('misroutes');
  });

  it('a DEAD stamp cannot vouch for a holder — the pid was recycled', () => {
    const c = classifyBridgePortHolder({
      holders: [{ pid: 777, command: 'node something-else' }],
      mcpStamp: stamp(777),
      projectRoot,
      isAlive: () => false,
    });
    expect(c.status).toBe('warn');
  });

  it('an unidentifiable holder is suspect, not waved through', () => {
    const c = classifyBridgePortHolder({
      holders: [{ pid: 5150 }],
      mcpStamp: null,
      projectRoot,
      isAlive: () => true,
    });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('a process Validity did not start');
    expect(c.detail).toContain('kill 5150');
  });

  it('never fails — doctor must not exit(1) over a held port', () => {
    for (const holders of [[], [{ pid: 1 }], [{ pid: 1, command: 'node validity-mcp' }]]) {
      const c = classifyBridgePortHolder({ holders, mcpStamp: null, projectRoot });
      expect(c.status).not.toBe('fail');
    }
  });
});

/**
 * The advisory `agent-device doctor` relay. Upstream checks a surface Validity
 * cannot see (RN/Expo toolchain, Metro reachability from cwd, the iOS runner
 * cache), so its findings are worth printing — but they are UPSTREAM's
 * judgement, so they may never fail `validity doctor`.
 */
describe('nativeReadinessChecks — `agent-device doctor` advisory rows', () => {
  let root: string;
  const mockedLoadConfig = vi.mocked(loadConfig);

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-doctor-advisory-'));
    mockedLoadConfig.mockReset();
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ dependencies: { expo: '51', 'react-native': '0.74' } }),
      'utf8',
    );
    mockedLoadConfig.mockResolvedValue({
      config: {
        renderMode: 'native',
        framework: 'expo-native',
        wrapper: './.validity/wrapper.gen.tsx',
      } as ValidityConfig,
      configPath: resolve(root, '.validity/config.ts'),
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (
    probeDoctor: NonNullable<Parameters<typeof nativeReadinessChecks>[1]>['probeDoctor'],
  ) =>
    nativeReadinessChecks(root, {
      skipBridgePort: true,
      checkReadiness: async () => ({ ready: true, steps: [] }),
      probeDoctor,
    });

  it('relays warn/fail findings as advisory rows, and NEVER as a fail', async () => {
    const checks = await run(async () => ({
      status: 'warn',
      summary: 'Some checks need attention',
      kind: 'expo',
      checks: [
        { id: 'metro-reachability', status: 'warn', summary: 'Metro not reachable on 8081' },
        { id: 'ios-runner', status: 'fail', summary: 'Runner build missing', command: 'x' },
        { id: 'adb', status: 'pass', summary: 'adb on PATH' },
      ],
    }));
    const rows = checks.filter((c) => c.name.startsWith('agent-device: '));
    expect(rows.map((r) => r.name)).toEqual([
      'agent-device: metro-reachability',
      'agent-device: ios-runner',
    ]);
    // A `fail` from upstream is a WARN here: `validity doctor` exits 1 only on
    // judgements Validity itself made.
    expect(rows.map((r) => r.status)).toEqual(['info', 'warn']);
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
    expect(rows[1]!.detail).toContain('fix: x');
    expect(rows[0]!.detail).toContain('advisory');
  });

  it('prints NOTHING when upstream is clean — a happy doctor is not a guarantee', async () => {
    const checks = await run(async () => ({
      status: 'pass',
      summary: 'All good',
      checks: [{ id: 'adb', status: 'pass', summary: 'adb on PATH' }],
    }));
    expect(checks.filter((c) => c.name.startsWith('agent-device: '))).toEqual([]);
  });

  it('prints nothing when the probe cannot answer or throws', async () => {
    expect(
      (await run(async () => undefined)).filter((c) => c.name.startsWith('agent-device: ')),
    ).toEqual([]);
    const thrown = await run(async () => {
      throw new Error('agent-device not installed');
    });
    expect(thrown.filter((c) => c.name.startsWith('agent-device: '))).toEqual([]);
    // …and the readiness summary row still made it out.
    expect(thrown.some((c) => c.name === 'native readiness')).toBe(true);
  });
});
