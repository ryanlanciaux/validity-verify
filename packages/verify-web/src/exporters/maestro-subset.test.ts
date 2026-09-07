/**
 * The 0.20.5 Maestro-subset lint.
 *
 * Two obligations, and the second one is the load-bearing half:
 *
 *   1. POSITIVE — everything the engine refuses must warn, loudly and with a
 *      line number, at EXPORT time rather than on someone's device;
 *   2. NEGATIVE (no cry-wolf) — Validity's OWN exporter output must lint clean.
 *      Export warnings block the portable badge and `spec export --all`
 *      eligibility, so a false warning here would silently de-certify every
 *      native spec in a repo. The negative case is therefore exercised against
 *      the REAL exporter's bytes, not a hand-written fixture.
 */
import { describe, expect, it } from 'vitest';
import type { Spec } from '@validity.ai/verify-spec';
import { lintMaestroSubset, MAESTRO_SUPPORTED_COMMANDS } from './maestro-subset.js';
import { exportSpecToMaestro } from './spec-maestro.js';

const T0 = '2026-01-01T00:00:00.000Z';

/**
 * A native spec that exercises every emitter branch that produces REAL steps:
 * launch preamble (+ dev-overlay runFlow guards), a deep-link route, taps,
 * fills, positive and negative assertions, and a screenshot.
 */
function richNativeSpec(): Spec {
  return {
    id: 'spec-native1',
    version: 3,
    status: 'frozen',
    hash: 'sha256-abc',
    source: { prompt: 'the welcome screen signs a user in', createdBy: 'agent' },
    runtime: 'native',
    criteria: [
      {
        id: 'AC-1',
        text: 'signing in from the welcome screen lands on the dashboard',
        tier: 'hard',
        mocking: 'none',
        checks: [
          { navigate: { url: '/welcome' } },
          { fill: { testId: 'email', value: 'a@b.com' } },
          { click: { role: 'button', name: 'Sign in' } },
          { expect: { element: { name: 'Dashboard', state: 'visible' } } },
          { expect: { element: { name: 'Sign in', state: 'hidden' } } },
          { expect: { element: { testId: 'cta', state: 'enabled' } } },
          { expect: { screenshot: { name: 'dashboard' } } },
        ],
      },
      { id: 'AC-2', text: 'it feels calm', tier: 'soft' },
    ],
    createdAt: T0,
  };
}

/** The flow bytes the real exporter emits for {@link richNativeSpec}. */
function realExportedFlow(): string {
  return exportSpecToMaestro({
    spec: richNativeSpec(),
    appId: 'com.example.app',
    maestro: { enabled: true, routes: { '/welcome': 'myapp://welcome' } },
  }).files[0]!.contents;
}

describe('lintMaestroSubset — NEGATIVE (no cry-wolf)', () => {
  it("the real exporter's own output lints clean", () => {
    expect(lintMaestroSubset(realExportedFlow())).toEqual([]);
  });

  it('lints clean with the launch preamble knobs off (no clearState, no overlay guards)', () => {
    const yaml = exportSpecToMaestro({
      spec: richNativeSpec(),
      appId: 'com.example.app',
      maestro: { enabled: true, clearState: false, dismissDevOverlays: false },
    }).files[0]!.contents;
    expect(lintMaestroSubset(yaml)).toEqual([]);
  });

  it('lints clean with a tapOn-sequence route (the other route shape)', () => {
    const yaml = exportSpecToMaestro({
      spec: richNativeSpec(),
      appId: 'com.example.app',
      maestro: {
        enabled: true,
        routes: { '/welcome': [{ tapOn: 'Get started' }, { tapOnId: 'welcome-cta' }] },
      },
    }).files[0]!.contents;
    expect(lintMaestroSubset(yaml)).toEqual([]);
  });

  it('lints clean without an appId (placeholder + inline TODO is still valid syntax)', () => {
    const yaml = exportSpecToMaestro({ spec: richNativeSpec() }).files[0]!.contents;
    expect(lintMaestroSubset(yaml)).toEqual([]);
  });

  it('the exporter only ever emits commands inside the documented subset', () => {
    const yaml = realExportedFlow();
    const emitted = [...yaml.matchAll(/^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(0);
    for (const command of emitted) expect(MAESTRO_SUPPORTED_COMMANDS).toContain(command);
  });
});

describe('lintMaestroSubset — POSITIVE (the engine would refuse)', () => {
  function flow(...steps: string[]): string {
    return ['appId: "com.example.app"', '---', '- launchApp', ...steps].join('\n') + '\n';
  }

  it('flags a command outside the subset as wont-run, with its line', () => {
    const warnings = lintMaestroSubset(flow('- assertTrue: ${output.ok}'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('wont-run');
    expect(warnings[0]!.scope).toBe('flow line 4 (assertTrue)');
    expect(warnings[0]!.message).toContain('outside the agent-device 0.20.5 Maestro subset');
    // The reason the whole flow dies must be in the message, not just the name.
    expect(warnings[0]!.message).toContain('fails loudly');
  });

  it('flags an unsupported command NESTED inside runFlow.commands', () => {
    const warnings = lintMaestroSubset(
      flow('- runFlow:', '    when:', '      visible: "Wait"', '    commands:', '      - copyText'),
    );
    expect(warnings.map((w) => w.scope)).toEqual(['flow line 8 (copyText)']);
  });

  it('flags an unsupported FIELD on a supported command', () => {
    const warnings = lintMaestroSubset(flow('- tapOn:', '    css: ".btn"'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.scope).toBe('flow line 5 (tapOn.css)');
    expect(warnings[0]!.severity).toBe('wont-run');
    expect(warnings[0]!.message).toContain('source context');
  });

  it('accepts every documented tapOn/assert field (allow-lists match the engine)', () => {
    const warnings = lintMaestroSubset(
      flow(
        '- tapOn:',
        '    id: "cta"',
        '    index: 1',
        '    optional: true',
        '- assertVisible:',
        '    text: "Done"',
        '    enabled: true',
        '- extendedWaitUntil:',
        '    visible: "Done"',
        '    timeout: 5000',
      ),
    );
    expect(warnings).toEqual([]);
  });

  it('flags repeat.while (0.20.5 supports repeat.times only)', () => {
    const warnings = lintMaestroSubset(flow('- repeat:', '    while:', '      visible: "Loading"'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('wont-run');
    expect(warnings[0]!.scope).toBe('flow line 5 (repeat.while)');
  });

  it('accepts repeat.times', () => {
    expect(
      lintMaestroSubset(flow('- repeat:', '    times: 3', '    commands:', '      - back')),
    ).toEqual([]);
  });

  it('flags a JavaScript runFlow.when.true expression but accepts the platform form', () => {
    const js = lintMaestroSubset(
      flow(
        '- runFlow:',
        '    when:',
        '      true: ${output.count > 0}',
        '    commands:',
        '      - back',
      ),
    );
    expect(js.map((w) => w.scope)).toContain('flow line 6 (runFlow.when.true)');
    expect(js.find((w) => w.scope.includes('when.true'))!.message).toContain('evalScript');

    const ok = lintMaestroSubset(
      flow(
        '- runFlow:',
        '    when:',
        '      true: maestro.platform == "ios"',
        '    commands:',
        '      - back',
      ),
    );
    expect(ok).toEqual([]);
  });

  it('flags an unknown runFlow.when condition', () => {
    const warnings = lintMaestroSubset(
      flow('- runFlow:', '    when:', '      enabled: "Go"', '    commands:', '      - back'),
    );
    expect(warnings.map((w) => w.scope)).toEqual(['flow line 6 (runFlow.when.enabled)']);
  });

  it('degrades (never wont-run) on Apple-only launch arguments', () => {
    const warnings = lintMaestroSubset(
      ['appId: "x"', '---', '- launchApp:', '    launchArguments:', '      - "-uiTest"'].join('\n'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('degraded');
    expect(warnings[0]!.message).toContain('Apple-only');
  });

  it('flags an unknown flow-config key', () => {
    const warnings = lintMaestroSubset(
      ['appId: "x"', 'retries: 3', '---', '- launchApp'].join('\n'),
    );
    expect(warnings.map((w) => w.scope)).toEqual(['flow line 2 (config key `retries`)']);
  });

  it('accepts every documented flow-config key', () => {
    const warnings = lintMaestroSubset(
      [
        'name: "sign in"',
        'appId: "x"',
        'tags:',
        '  - smoke',
        'env:',
        '  USER: a@b.com',
        'onFlowStart:',
        '  - launchApp',
        'onFlowComplete:',
        '  - stopApp',
        '---',
        '- launchApp',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
  });

  it('flags a flow with no `---` separator ONCE (not once per header line)', () => {
    const warnings = lintMaestroSubset(['appId: "x"', '- launchApp', '- tapOn: "Go"'].join('\n'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.scope).toBe('flow document');
    expect(warnings[0]!.severity).toBe('wont-run');
  });

  it('notes runScript as needs-setup (supported, but not a security sandbox)', () => {
    const warnings = lintMaestroSubset(flow('- runScript: ./seed.js'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('needs-setup');
    expect(warnings[0]!.message).toContain('not a security sandbox');
  });
});

describe('lintMaestroSubset — scanner robustness', () => {
  it('ignores comment lines, including indented ones inside a step block', () => {
    const warnings = lintMaestroSubset(
      [
        '# GENERATED — DO NOT EDIT',
        'appId: "x"',
        '---',
        '- assertVisible:',
        '    text: "Done"',
        '    # TODO (lossy): Maestro cannot assert "enabled".',
        '# ── AC-2: nope [soft]',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
  });

  it('never reads a block scalar body as flow structure', () => {
    // The script body contains lines that LOOK like unsupported commands.
    const warnings = lintMaestroSubset(
      [
        'appId: "x"',
        '---',
        '- runScript:',
        '    file: |',
        '      - assertTrue: nope',
        '      evalScript: alsoNope',
        '- back',
      ].join('\n'),
    );
    // Only the runScript trust note — nothing from inside the scalar.
    expect(warnings.map((w) => w.severity)).toEqual(['needs-setup']);
  });

  it('a value containing a colon does not become a key', () => {
    expect(lintMaestroSubset(['appId: "x"', '---', '- inputText: "a: b"'].join('\n'))).toEqual([]);
  });
});
