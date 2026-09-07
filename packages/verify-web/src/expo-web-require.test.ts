/**
 * Unit tests for the expo-web require→import rewrite plugin, including the
 * two-tier classification: unconditional module-scope requires get an eager
 * static `import * as` hoist (Tier A), while guarded / function-scoped
 * requires get a crash-proof top-level-await `try { await import } catch {}`
 * binding (Tier B) so native-only modules that throw at import time can't
 * red-screen the whole file.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { expoWebRequirePlugin } from './expo-web-require.js';

const ROOT = '/fake/project';

function run(code: string, id = `${ROOT}/app/x.ts`): string | null {
  const plugin = expoWebRequirePlugin(ROOT);
  const result = (plugin.transform as (code: string, id: string) => unknown).call({}, code, id) as {
    code: string;
  } | null;
  return result ? result.code : null;
}

describe('expoWebRequirePlugin', () => {
  it('hoists a top-level require to a static import with CJS/ESM interop (Tier A)', () => {
    const out = run(`const systemui = require("expo-system-ui")\nexport {}`);
    expect(out).not.toBeNull();
    expect(out).toContain('import * as __validityRequireNs$0 from "expo-system-ui";');
    expect(out).toContain(
      'const __validityRequire$0 = __validityRequireNs$0?.default ?? __validityRequireNs$0;',
    );
    expect(out).toContain('const systemui = __validityRequire$0');
    expect(out).not.toContain('require("expo-system-ui")');
    expect(out).not.toContain('await import');
  });

  it('keeps top-level object-literal asset requires on the static path (Tier A)', () => {
    // Icon.tsx-style registry: evaluated at module scope even though the
    // require sits inside a nested expression position.
    const out = run(
      `export const iconRegistry = {\n  back: require("@assets/icons/back.png"),\n  bell: require("@assets/icons/bell.png"),\n}\n`,
    );
    expect(out).not.toBeNull();
    expect(out).toContain('import * as __validityRequireNs$0 from "@assets/icons/back.png";');
    expect(out).toContain('import * as __validityRequireNs$1 from "@assets/icons/bell.png";');
    expect(out).toContain('back: __validityRequire$0');
    expect(out).toContain('bell: __validityRequire$1');
    expect(out).not.toContain('await import');
  });

  it('keeps top-level member-expression requires static (Tier A)', () => {
    // ReactotronConfig.ts-style: require("../../package.json").name
    const out = run(`const name = require("../../package.json").name\nexport {}`);
    expect(out).toContain('import * as __validityRequireNs$0 from "../../package.json";');
    expect(out).toContain('const name = __validityRequire$0.name');
  });

  it('rewrites an if-guarded require to a caught top-level await (Tier B)', () => {
    const out = run(`if (__DEV__) {\n  require("./devtools/ReactotronConfig.ts")\n}\nexport {}`);
    expect(out).not.toBeNull();
    // No eager static import for the guarded module…
    expect(out).not.toContain('import * as');
    // …but a crash-proof TLA binding, with the call site spliced.
    expect(out).toContain('let __validityRequire$0;');
    expect(out).toContain(
      'try { const __validityRequireNs$0 = await import("./devtools/ReactotronConfig.ts"); ' +
        '__validityRequire$0 = __validityRequireNs$0?.default ?? __validityRequireNs$0; } catch {}',
    );
    expect(out).toContain('if (__DEV__) {\n  __validityRequire$0\n}');
  });

  it('rewrites function-scoped requires to the TLA form (Tier B)', () => {
    // formatDate.ts-style: locale requires inside switch-cases inside a
    // function — must still resolve to a usable binding when the fn runs.
    const out = run(
      `export function getLocale(l: string) {\n` +
        `  switch (l) {\n` +
        `    case "ar": return require("date-fns/locale/ar")\n` +
        `    default: return require("date-fns/locale/en-US")\n` +
        `  }\n` +
        `}\n`,
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain('import * as');
    expect(out).toContain('await import("date-fns/locale/ar")');
    expect(out).toContain('await import("date-fns/locale/en-US")');
    expect(out).toContain('case "ar": return __validityRequire$0');
    expect(out).toContain('default: return __validityRequire$1');
  });

  it('treats ternary / logical-right / try positions as guarded (Tier B)', () => {
    const out = run(
      `const a = flag ? require("mod-a") : null\n` +
        `const b = flag && require("mod-b")\n` +
        `try { require("mod-c") } catch {}\n` +
        `export {}`,
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain('import * as');
    for (const mod of ['mod-a', 'mod-b', 'mod-c']) {
      expect(out).toContain(`await import("${mod}")`);
    }
  });

  it('uses one static import when the same spec is both top-level and guarded', () => {
    const out = run(
      `const eager = require("shared-mod")\n` +
        `export function later() { return require("shared-mod") }\n`,
    );
    expect(out).not.toBeNull();
    expect(out).toContain('import * as __validityRequireNs$0 from "shared-mod";');
    expect(out).not.toContain('await import');
    expect(out).toContain('const eager = __validityRequire$0');
    expect(out).toContain('return __validityRequire$0');
  });

  it('leaves shadowed require and dynamic require(expr) untouched', () => {
    const code =
      `function withShadow(require: (s: string) => unknown) { return require("x") }\n` +
      `const dyn = "y"\n` +
      `declare const require: (s: string) => unknown\n` +
      `export {}`;
    // Shadowed-only file: no rewrites at all → null (plugin declines).
    expect(run(code)).toBeNull();

    const dynamic = run(`const m = require(someExpr)\nexport {}`);
    expect(dynamic).toBeNull();
  });

  it('returns null when there is nothing to rewrite', () => {
    expect(run(`export const x = 1\n`)).toBeNull();
    // Contains "require(" but only via require.resolve (member callee).
    expect(run(`const p = require.resolve("x")\nexport {}`)).toBeNull();
  });

  it('skips node_modules and .validity paths', () => {
    const code = `const m = require("x")\nexport {}`;
    expect(run(code, `${ROOT}/node_modules/dep/index.js`)).toBeNull();
    expect(run(code, `${ROOT}/.validity/wrapper.gen.tsx`)).toBeNull();
    expect(run(code, `/outside/app/x.ts`)).toBeNull();
  });
});

describe('expoWebRequirePlugin — Tier B runtime semantics (Node evaluation)', () => {
  // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var) and the
  // plugin's startsWith(projectRoot) check compares literal paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'validity-require-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function transformInto(name: string, source: string): void {
    const srcPath = join(dir, name);
    const plugin = expoWebRequirePlugin(dir);
    const out = (plugin.transform as (code: string, id: string) => unknown).call(
      {},
      source,
      srcPath,
    ) as { code: string } | null;
    expect(out).not.toBeNull();
    writeFileSync(srcPath, out!.code);
  }

  // Evaluate in a real Node subprocess: vitest's own dynamic import goes
  // through Vite's transform pipeline, which can't see files created mid-run.
  function evalDriver(name: string, driverSource: string): string {
    const driverPath = join(dir, name);
    writeFileSync(driverPath, driverSource);
    return execFileSync(process.execPath, [driverPath], { encoding: 'utf8' }).trim();
  }

  it('function-scoped require binding resolves before callers can run (formatDate case)', () => {
    writeFileSync(join(dir, 'locale.mjs'), `export default { code: "en-US" }\n`);
    transformInto(
      'uses-locale.mjs',
      `export function getLocale() { return require("./locale.mjs") }\n`,
    );
    const stdout = evalDriver(
      'driver-locale.mjs',
      `import { getLocale } from './uses-locale.mjs'\nconsole.log(JSON.stringify(getLocale()))\n`,
    );
    expect(JSON.parse(stdout)).toEqual({ code: 'en-US' });
  });

  it('a guarded module that throws at import no longer red-screens the file', () => {
    writeFileSync(
      join(dir, 'native-only.mjs'),
      `throw new Error("TurboModuleRegistry.getEnforcing: 'SourceCode' could not be found")\n`,
    );
    transformInto(
      'guarded.mjs',
      `if (globalThis.__validityNeverTrue) { require("./native-only.mjs") }\nexport const survived = true\n`,
    );
    // Before the two-tier split this was a static import → the whole module
    // threw at load. Now the throw is contained by the TLA try/catch.
    const stdout = evalDriver(
      'driver-guarded.mjs',
      `import { survived } from './guarded.mjs'\nconsole.log(JSON.stringify({ survived }))\n`,
    );
    expect(JSON.parse(stdout)).toEqual({ survived: true });
  });
});
