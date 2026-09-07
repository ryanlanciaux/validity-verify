/**
 * Drift-checked exports (spec-export-manifest.ts) — the Phase B gate. The
 * load-bearing invariants:
 *   - exporters are byte-deterministic (double export + env perturbation);
 *   - `--check` compares RECOMPILED bytes (a poisoned manifest can't fake
 *     freshness) and classifies every mismatch with an explainable cause
 *     (hand-edit vs stale-spec vs toolchain vs config);
 *   - superseded/deleted specs prune under `--fix`; an empty manifest passes
 *     trivially; CRLF checkouts never false-drift;
 *   - `specArtifactCheck` (certification property 4) agrees with `--check`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freezeSpec,
  hash,
  updateSpec,
  writeSpec,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  checkSpecExports,
  compileSpecExport,
  exportsManifestPath,
  loadExportsManifest,
  specArtifactCheck,
  specExportsDir,
  SPEC_EXPORTER_VERSION,
  writeSpecExport,
} from './spec-export-manifest.js';
import { assessSpecMaturity } from './spec-maturity.js';
import { assessSpecPortability } from './spec-portability.js';
import { exportSpecToMaestro } from './spec-maestro.js';

const T0 = '2026-01-01T00:00:00.000Z';

function webSpec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-web1',
    version: 2,
    status: 'frozen',
    hash: 'sha256-webhash',
    source: { prompt: 'contact form posts', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      {
        id: 'AC-1',
        text: 'the Send button is visible',
        tier: 'hard',
        checks: [{ expect: { element: { role: 'button', name: 'Send', state: 'visible' } } }],
      },
    ],
    createdAt: T0,
    ...over,
  };
}

function nativeSpec(over: Partial<Spec> = {}): Spec {
  // The canonical native fixture shape (element + tap→modal, spec-e221 style).
  return {
    id: 'spec-e221',
    version: 1,
    status: 'frozen',
    hash: 'sha256-nativehash',
    source: { prompt: 'tapping More Info opens the modal', createdBy: 'agent' },
    runtime: 'native',
    criteria: [
      {
        id: 'AC-1',
        text: 'More Info opens the modal',
        tier: 'hard',
        checks: [
          { click: { role: 'button', name: 'More Info' } },
          { expect: { element: { role: 'dialog', name: 'Details', state: 'visible' } } },
        ],
      },
    ],
    createdAt: T0,
    ...over,
  };
}

const CONFIG: ValidityConfig = {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.tsx',
  export: { baseUrl: 'http://localhost:3000', appId: 'com.example.real' },
};

describe('determinism (plan §B2)', () => {
  it('double export is byte-identical, with NO timestamps in artifact bytes', () => {
    const a = compileSpecExport(webSpec(), CONFIG);
    const b = compileSpecExport(webSpec(), CONFIG);
    expect(a.files).toEqual(b.files);
    for (const f of a.files) {
      expect(f.contents).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO stamps
    }
  });

  it('export under a different TZ/locale env is byte-identical', () => {
    const before = compileSpecExport(nativeSpec(), CONFIG);
    const savedTz = process.env.TZ;
    const savedLang = process.env.LANG;
    try {
      process.env.TZ = 'Pacific/Chatham';
      process.env.LANG = 'tr_TR.UTF-8';
      const after = compileSpecExport(nativeSpec(), CONFIG);
      expect(after.files).toEqual(before.files);
    } finally {
      process.env.TZ = savedTz;
      process.env.LANG = savedLang;
    }
  });

  it('snapshot: a fully-certifiable web spec compiles with zero warnings + canonical header', () => {
    const compiled = compileSpecExport(webSpec(), CONFIG);
    expect(compiled.warnings).toEqual([]);
    expect(compiled.files).toHaveLength(1);
    expect(compiled.files[0]!.path).toBe('playwright/spec-web1.v2.spec.ts');
    expect(compiled.files[0]!.contents).toContain(
      '// GENERATED from spec-web1@v2 (sha256-webhash) — DO NOT EDIT;',
    );
  });

  it('snapshot: the native fixture stamps the configured appId and warns without one', () => {
    const withAppId = exportSpecToMaestro({ spec: nativeSpec(), appId: 'com.example.real' });
    expect(withAppId.files[0]!.path).toBe('spec-e221.v1.flow.yaml');
    expect(withAppId.files[0]!.contents).toContain('appId: "com.example.real"');
    expect(withAppId.files[0]!.contents).not.toContain('com.example.app');
    expect(withAppId.warnings).toEqual([]);

    const without = exportSpecToMaestro({ spec: nativeSpec() });
    expect(without.files[0]!.contents).toContain('appId: com.example.app # TODO');
    expect(without.warnings).toMatchObject([{ scope: 'appId', severity: 'needs-setup' }]);
  });

  it('a maestro config (routes) change moves the native inputsHash', () => {
    // export.maestro is a byte-affecting input, so a change to it must move the
    // inputsHash — that is what makes a routes/clearState edit classify as
    // config drift in `--check`, never as a hand edit.
    const base = compileSpecExport(nativeSpec(), CONFIG);
    const withRoutes: ValidityConfig = {
      ...CONFIG,
      export: { ...CONFIG.export, maestro: { routes: { '/welcome': 'myapp://welcome' } } },
    };
    expect(compileSpecExport(nativeSpec(), withRoutes).inputsHash).not.toBe(base.inputsHash);
  });

  it('adding export.maestro.run does NOT move the inputsHash (it changes no exported byte)', () => {
    // `run` is the `spec export --run` device binding: it says which device the
    // flows are handed to, never what they contain. Hashing it would make a CI
    // job adding `--platform` to its config read as an export that drifted and
    // demand a re-export of files that did not change.
    const base = compileSpecExport(nativeSpec(), CONFIG);
    const withRun: ValidityConfig = {
      ...CONFIG,
      export: {
        ...CONFIG.export,
        maestro: {
          ...CONFIG.export?.maestro,
          run: { platform: 'android', device: 'emulator-5554' },
        },
      },
    };
    const after = compileSpecExport(nativeSpec(), withRun);
    expect(after.inputsHash).toBe(base.inputsHash);
    // And the bytes are untouched too — the two claims are independent.
    expect(after.files.map((f) => f.contents)).toEqual(base.files.map((f) => f.contents));
  });

  it('a run binding as the ONLY maestro config hashes like no maestro config at all', () => {
    // Otherwise the first project to add a device default would see its very
    // first `--check` fail with "config changed" over a file that is identical.
    const noMaestro: ValidityConfig = { ...CONFIG, export: { appId: 'com.example.app' } };
    const runOnly: ValidityConfig = {
      ...CONFIG,
      export: { appId: 'com.example.app', maestro: { run: { platform: 'ios' } } },
    };
    expect(compileSpecExport(nativeSpec(), runOnly).inputsHash).toBe(
      compileSpecExport(nativeSpec(), noMaestro).inputsHash,
    );
  });
});

describe('writeSpecExport + checkSpecExports', () => {
  let root: string;
  let frozen: Spec;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-exports-'));
    // A REAL frozen spec on disk so checkSpecExports can re-read it.
    writeSpec(root, webSpec({ status: 'draft', hash: undefined, version: 1 }));
    frozen = freezeSpec({ projectRoot: root, specId: 'spec-web1', gitBinding: null }).spec;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the canonical layout: artifact + manifest row + eol=lf .gitattributes', () => {
    const result = writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const artifact = resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`);
    expect(existsSync(artifact)).toBe(true);
    expect(result.warnings).toEqual([]);

    const manifest = loadExportsManifest(root);
    const entry = manifest.entries['spec-web1']!;
    expect(entry).toMatchObject({
      specId: 'spec-web1',
      version: 1,
      specHash: frozen.hash,
      runtime: 'web',
      exporterVersion: SPEC_EXPORTER_VERSION,
      baseUrl: 'http://localhost:3000',
      generatedAt: T0,
    });
    expect(entry.files).toHaveLength(1);
    expect(existsSync(exportsManifestPath(root))).toBe(true);
    expect(readFileSync(resolve(specExportsDir(root), '.gitattributes'), 'utf-8')).toContain(
      '* text eol=lf',
    );
  });

  it('a repo with zero exported specs passes --check trivially', () => {
    expect(checkSpecExports(root, { config: CONFIG })).toEqual({ ok: true, findings: [] });
  });

  it('clean export passes --check; CRLF-converted checkout does NOT false-drift', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);

    // Simulate a Windows checkout: CRLF the committed artifact.
    const artifact = resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`);
    writeFileSync(artifact, readFileSync(artifact, 'utf-8').replace(/\n/g, '\r\n'));
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);
  });

  it('hand-editing one byte fails with the hand-edit message', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const artifact = resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`);
    writeFileSync(artifact, readFileSync(artifact, 'utf-8') + '// sneaky\n');

    const { ok, findings } = checkSpecExports(root, { config: CONFIG });
    expect(ok).toBe(false);
    expect(findings).toMatchObject([{ specId: 'spec-web1', status: 'hand-edit' }]);
    expect(findings[0]!.detail).toContain('edit the spec, not the test');

    // --fix regenerates in place.
    const fixed = checkSpecExports(root, { config: CONFIG, fix: true, now: T0 });
    expect(fixed.ok).toBe(true);
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);
  });

  it('a poisoned manifest cannot fake freshness — recompiled bytes are the truth source', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const artifact = resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`);
    const tampered = readFileSync(artifact, 'utf-8') + '// sneaky\n';
    writeFileSync(artifact, tampered);
    // Attacker also updates the manifest sha to match the tampered file.
    const manifest = loadExportsManifest(root);
    manifest.entries['spec-web1']!.files[0]!.sha256 = hash(tampered);
    writeFileSync(exportsManifestPath(root), JSON.stringify(manifest, null, 2));

    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(false);
  });

  it('version bump fails --check (unfrozen) until re-freeze + re-export; then stale-spec until re-export', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });

    // Bump: frozen → draft v2.
    updateSpec({
      projectRoot: root,
      specId: 'spec-web1',
      patch: { criteria: [...frozen.criteria, { id: 'AC-2', text: 'extra', tier: 'soft' }] },
    });
    let res = checkSpecExports(root, { config: CONFIG });
    expect(res.ok).toBe(false);
    expect(res.findings).toMatchObject([{ specId: 'spec-web1', status: 'unfrozen' }]);

    // Re-freeze v2 — the manifest still pins v1's hash → stale-spec.
    const refrozen = freezeSpec({ projectRoot: root, specId: 'spec-web1', gitBinding: null }).spec;
    res = checkSpecExports(root, { config: CONFIG });
    expect(res.ok).toBe(false);
    expect(res.findings).toMatchObject([{ specId: 'spec-web1', status: 'stale-spec' }]);
    expect(res.findings[0]!.detail).toContain('re-run');

    // Re-export: v2 artifact replaces v1 (old version pruned), --check green.
    writeSpecExport(root, refrozen, CONFIG, { now: T0 });
    expect(existsSync(resolve(specExportsDir(root), 'playwright/spec-web1.v1.spec.ts'))).toBe(
      false,
    );
    expect(existsSync(resolve(specExportsDir(root), 'playwright/spec-web1.v2.spec.ts'))).toBe(true);
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);
  });

  it('an exporterVersion bump classifies as toolchain change', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const manifest = loadExportsManifest(root);
    manifest.entries['spec-web1']!.exporterVersion = '0-legacy';
    writeFileSync(exportsManifestPath(root), JSON.stringify(manifest, null, 2));

    const { ok, findings } = checkSpecExports(root, { config: CONFIG });
    expect(ok).toBe(false);
    expect(findings).toMatchObject([{ specId: 'spec-web1', status: 'toolchain' }]);
    expect(findings[0]!.detail).toContain('review the diff');
  });

  it('a moved export input (baseUrl) classifies as config, not hand-edit', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const movedConfig: ValidityConfig = {
      ...CONFIG,
      export: { ...CONFIG.export, baseUrl: 'https://staging.example.com' },
    };
    const { ok, findings } = checkSpecExports(root, { config: movedConfig });
    expect(ok).toBe(false);
    expect(findings).toMatchObject([{ specId: 'spec-web1', status: 'config' }]);
  });

  it('a moved export.maestro (routes) classifies as config drift on a native spec, not hand-edit', () => {
    // A native spec whose navigate needs a route to reach the screen — so adding
    // a route mapping genuinely changes the emitted flow bytes (a real openLink
    // step replaces the TODO comment).
    writeSpec(
      root,
      nativeSpec({
        id: 'spec-nav1',
        status: 'draft',
        hash: undefined,
        criteria: [
          {
            id: 'AC-1',
            text: 'the welcome tagline shows',
            tier: 'hard',
            checks: [
              { navigate: { url: '/welcome' } },
              { expect: { element: { testId: 'tagline', state: 'visible' } } },
            ],
          },
        ],
      }),
    );
    const frozenNav = freezeSpec({ projectRoot: root, specId: 'spec-nav1', gitBinding: null }).spec;
    writeSpecExport(root, frozenNav, CONFIG, { now: T0 });
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);

    const routed: ValidityConfig = {
      ...CONFIG,
      export: { ...CONFIG.export, maestro: { routes: { '/welcome': 'myapp://welcome' } } },
    };
    const { ok, findings } = checkSpecExports(root, { config: routed });
    expect(ok).toBe(false);
    expect(findings).toMatchObject([{ specId: 'spec-nav1', status: 'config' }]);
  });

  it('deleting the artifact file fails as missing-file', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    rmSync(resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`));
    const { ok, findings } = checkSpecExports(root, { config: CONFIG });
    expect(ok).toBe(false);
    expect(findings).toMatchObject([{ specId: 'spec-web1', status: 'missing-file' }]);
  });

  it('a superseded spec prunes (row + files) under --fix', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    updateSpec({ projectRoot: root, specId: 'spec-web1', patch: {} }); // bump to draft v2
    updateSpec({ projectRoot: root, specId: 'spec-web1', patch: { status: 'superseded' } });

    const bare = checkSpecExports(root, { config: CONFIG });
    expect(bare.ok).toBe(false);
    expect(bare.findings).toMatchObject([{ specId: 'spec-web1', status: 'superseded' }]);

    const fixed = checkSpecExports(root, { config: CONFIG, fix: true });
    expect(fixed.ok).toBe(true);
    expect(loadExportsManifest(root).entries['spec-web1']).toBeUndefined();
    expect(existsSync(resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`))).toBe(
      false,
    );
  });

  it('SECURITY: a traversal path in a poisoned manifest is never followed by prune', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    // The victim file OUTSIDE .validity/exports/ that a crafted entry targets.
    const victim = resolve(root, 'victim.env');
    writeFileSync(victim, 'SECRET=1\n');
    const manifest = loadExportsManifest(root);
    manifest.entries['spec-evil'] = {
      specId: 'spec-evil', // no such spec on disk → prune branch under --fix
      version: 1,
      specHash: 'sha256-x',
      runtime: 'web',
      exporterVersion: SPEC_EXPORTER_VERSION,
      inputsHash: 'sha256-x',
      files: [{ path: '../../victim.env', sha256: 'x' }],
      generatedAt: T0,
    };
    writeFileSync(exportsManifestPath(root), JSON.stringify(manifest, null, 2));

    const fixed = checkSpecExports(root, { config: CONFIG, fix: true });
    expect(fixed.findings.some((f) => f.specId === 'spec-evil' && f.fixed)).toBe(true);
    expect(existsSync(victim)).toBe(true); // never deleted
    expect(loadExportsManifest(root).entries['spec-evil']).toBeUndefined(); // row still pruned
  });

  it('--fix with BOTH a prune and a re-export persists the fresh entry (no stale-manifest clobber)', () => {
    // Entry A: will be superseded (prune). Entry B: will go stale (re-export).
    writeSpecExport(root, frozen, CONFIG, { now: T0 }); // spec-web1 v1
    writeSpec(root, webSpec({ id: 'spec-web2', version: 1, status: 'draft', hash: undefined }));
    const frozen2 = freezeSpec({ projectRoot: root, specId: 'spec-web2', gitBinding: null }).spec;
    writeSpecExport(root, frozen2, CONFIG, { now: T0 });

    // A → superseded; B → version bump + re-freeze (stale-spec).
    updateSpec({ projectRoot: root, specId: 'spec-web1', patch: {} });
    updateSpec({ projectRoot: root, specId: 'spec-web1', patch: { status: 'superseded' } });
    updateSpec({
      projectRoot: root,
      specId: 'spec-web2',
      patch: {
        criteria: [
          ...frozen2.criteria,
          { id: 'AC-2', text: 'still looks calm', tier: 'soft', severity: 'advisory' },
        ],
      },
    });
    freezeSpec({ projectRoot: root, specId: 'spec-web2', gitBinding: null });

    const fixed = checkSpecExports(root, { config: CONFIG, fix: true, now: T0 });
    expect(fixed.ok).toBe(true);

    // The fresh v2 entry survived the final manifest save (the old bug wrote
    // the load-time snapshot back, resurrecting v1 and dropping the re-export).
    const after = loadExportsManifest(root);
    expect(after.entries['spec-web1']).toBeUndefined();
    expect(after.entries['spec-web2']).toMatchObject({ version: 2 });
    // The freshly re-exported v2 artifact was NOT eaten by the orphan scan.
    expect(existsSync(resolve(specExportsDir(root), 'playwright/spec-web2.v2.spec.ts'))).toBe(true);
    // And a follow-up bare --check is clean.
    expect(checkSpecExports(root, { config: CONFIG }).ok).toBe(true);
  });

  it('a deleted spec prunes under --fix; an orphaned artifact file is flagged + pruned', () => {
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    rmSync(resolve(root, '.validity/specs/spec-web1'), { recursive: true, force: true });

    const bare = checkSpecExports(root, { config: CONFIG });
    expect(bare.ok).toBe(false);
    expect(bare.findings).toMatchObject([{ specId: 'spec-web1', status: 'spec-missing' }]);

    const fixed = checkSpecExports(root, { config: CONFIG, fix: true });
    expect(fixed.ok).toBe(true);

    // Drop a stray artifact nobody references.
    writeFileSync(resolve(specExportsDir(root), 'playwright/spec-stray.v9.spec.ts'), '// stray\n');
    const orphan = checkSpecExports(root, { config: CONFIG });
    expect(orphan.ok).toBe(false);
    expect(orphan.findings).toMatchObject([
      { status: 'orphaned-file', path: 'playwright/spec-stray.v9.spec.ts' },
    ]);
    expect(checkSpecExports(root, { config: CONFIG, fix: true }).ok).toBe(true);
    expect(existsSync(resolve(specExportsDir(root), 'playwright/spec-stray.v9.spec.ts'))).toBe(
      false,
    );
  });
});

describe('specArtifactCheck + assessSpecPortability (the portability badge, end to end)', () => {
  let root: string;
  let frozen: Spec;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-artifact-'));
    writeSpec(root, webSpec({ status: 'draft', hash: undefined, version: 1 }));
    frozen = freezeSpec({ projectRoot: root, specId: 'spec-web1', gitBinding: null }).spec;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks blocked(artifact missing) → portable → blocked(artifact drift) with real IO', () => {
    // Zero warnings but no artifacts ⇒ blocked on the missing artifacts.
    let badge = assessSpecPortability(root, frozen, CONFIG);
    expect(badge.status).toBe('blocked');
    expect(badge.warnings).toEqual([]);
    expect(badge.artifact).toMatchObject({ status: 'missing' });

    // Export ⇒ portable.
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    badge = assessSpecPortability(root, frozen, CONFIG);
    expect(badge.status).toBe('portable');
    expect(badge.artifact).toMatchObject({ status: 'ok' });

    // Hand-edit ⇒ blocked again with artifact drift.
    const artifact = resolve(specExportsDir(root), `playwright/${frozen.id}.v1.spec.ts`);
    writeFileSync(artifact, readFileSync(artifact, 'utf-8') + '// edit\n');
    badge = assessSpecPortability(root, frozen, CONFIG);
    expect(badge.status).toBe('blocked');
    expect(badge.artifact).toMatchObject({ status: 'drift' });
    expect(specArtifactCheck(root, frozen, CONFIG)).toMatchObject({ status: 'drift' });
  });

  it('no export stanza ⇒ unconfigured (the badge is hidden, never a complaint)', () => {
    const badge = assessSpecPortability(root, frozen, { ...CONFIG, export: undefined });
    // `run: null` too — nothing was assessed, so there is no run standing to
    // report either. An unconfigured badge asserts NOTHING, in every field.
    expect(badge).toEqual({ status: 'unconfigured', warnings: [], artifact: null, run: null });
  });

  it('a native spec is unconfigured until the Maestro preview opt-in, then walks appId-blocked → portable', () => {
    writeSpec(root, { ...nativeSpec(), status: 'draft', hash: undefined });
    const frozenNative = freezeSpec({
      projectRoot: root,
      specId: 'spec-e221',
      gitBinding: null,
    }).spec;

    // Maestro export is parked: without `export.maestro.enabled` the badge is
    // hidden for native specs even though an export stanza exists.
    expect(assessSpecPortability(root, frozenNative, CONFIG).status).toBe('unconfigured');

    const optIn: ValidityConfig = {
      ...CONFIG,
      export: { ...CONFIG.export, maestro: { enabled: true } },
    };
    const noAppId: ValidityConfig = { ...CONFIG, export: { maestro: { enabled: true } } };
    let badge = assessSpecPortability(root, frozenNative, noAppId);
    expect(badge.status).toBe('blocked');
    expect(badge.warnings[0]!.message).toContain('appId');

    writeSpecExport(root, frozenNative, optIn, { now: T0 });
    badge = assessSpecPortability(root, frozenNative, optIn);
    expect(badge.status).toBe('portable');
  });

  it('DECOUPLING: export state never moves maturity — the level reads evidence, not artifacts', () => {
    // No exports, no evidence ⇒ team on never-verified (not artifact-missing).
    const before = assessSpecMaturity(root, frozen, CONFIG);
    expect(before.level).toBe('team');
    expect(before.blockers).toMatchObject([{ kind: 'never-verified' }]);

    // Exporting changes the badge, not the level or its blockers.
    writeSpecExport(root, frozen, CONFIG, { now: T0 });
    const after = assessSpecMaturity(root, frozen, CONFIG);
    expect(after).toEqual(before);
  });
});
