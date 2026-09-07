import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ValidityConfig } from '@validity.ai/verify-spec';
import {
  DEEP_DEFAULT_PROXY_CASES,
  FEED_URL_CASES,
  PERMISSIVE_BODY_CASES,
  POPULATED_BODY_CASES,
} from '@validity.ai/verify-spec/mock-heuristics-cases';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validityDir } from './paths.js';
import { prepareSandbox } from './prepare.js';

/**
 * Shared-heuristics parity guard (web side). The permissive shape heuristic
 * (`permissiveBody`) and the deep-default `Proxy` (`makeDeepDefaultProxy`) the
 * web sandbox ships live INSIDE the load-bearing `VALIDITY_MSW_SOURCE` template
 * literal (their synchronous patch-before-import ordering is fragile by design
 * and must NOT be extracted — web is a frozen contract surface). So instead of
 * importing them, this test EXTRACTS the real shipped functions from the
 * generated `validity-msw.ts` and runs the SAME shared fixture tables the
 * native suite runs against its own ports. If either implementation drifts from
 * the shared cases, one of the two suites fails.
 */

function makeProjectRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-mockheur-test-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(
    resolve(root, '.validity/wrapper.tsx'),
    `import type { ReactNode } from 'react';\nexport default function W({ children }: { children: ReactNode }) { return <>{children}</>; }\n`,
  );
  mkdirSync(resolve(root, 'node_modules'), { recursive: true });
  return root;
}

function baseConfig(): ValidityConfig {
  return { renderMode: 'web', framework: 'vite', wrapper: './.validity/wrapper.tsx' };
}

/**
 * Pull a top-level `function NAME(...) { ... }` out of generated source by
 * balancing braces, strip its TypeScript types (the shipped source is a .ts
 * template), and evaluate it into a callable. The web heuristics are
 * self-contained (only JSON/URL/Proxy/Symbol globals), so this runs the EXACT
 * code the browser sandbox ships.
 */
function extractFunction(source: string, name: string): (...args: unknown[]) => unknown {
  const sig = `function ${name}(`;
  const start = source.indexOf(sig);
  if (start === -1) throw new Error(`function ${name} not found in generated source`);
  let depth = 0;
  let seenBrace = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      seenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`could not balance braces for function ${name}`);
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(`${js}; return ${name};`)() as (...args: unknown[]) => unknown;
}

describe('web permissive mock heuristics (shared cases, extracted from shipped source)', () => {
  let projectRoot: string;
  let mswSource: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
    prepareSandbox(projectRoot, baseConfig());
    mswSource = readFileSync(resolve(validityDir(projectRoot), 'validity-msw.ts'), 'utf-8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('permissiveBody (shared table)', () => {
    for (const c of PERMISSIVE_BODY_CASES) {
      it(`${c.method} ${c.url} → ${JSON.stringify(c.expected)} (${c.why})`, () => {
        const permissiveBody = extractFunction(mswSource, 'permissiveBody') as (
          m: string,
          u: string,
        ) => string;
        expect(JSON.parse(permissiveBody(c.method, c.url))).toEqual(c.expected);
      });
    }
  });

  describe('makeDeepDefaultProxy (shared table)', () => {
    for (const c of DEEP_DEFAULT_PROXY_CASES) {
      it(c.name, () => {
        const makeProxy = extractFunction(mswSource, 'makeDeepDefaultProxy') as () => unknown;
        expect(c.probe(makeProxy())).toEqual(c.expected);
      });
    }
  });

  describe('isFeedUrl (shared table)', () => {
    for (const c of FEED_URL_CASES) {
      it(`${c.url} → ${c.expected} (${c.why})`, () => {
        const isFeedUrl = extractFunction(mswSource, 'isFeedUrl') as (u: string) => boolean;
        expect(isFeedUrl(c.url)).toBe(c.expected);
      });
    }
  });

  describe('populatedBody / feedBody (shared table)', () => {
    for (const c of POPULATED_BODY_CASES) {
      it(`${c.method} ${c.url} → ${c.kind} (${c.why})`, () => {
        const body =
          c.kind === 'xml'
            ? (extractFunction(mswSource, 'feedBody') as (u: string) => string)(c.url)
            : (extractFunction(mswSource, 'populatedBody') as (m: string, u: string) => string)(
                c.method,
                c.url,
              );
        if (c.kind === 'xml') {
          expect(body).toMatch(/^<\?xml/);
          expect(body).toContain('<item>');
          expect(body).toContain('<title>');
        } else {
          const v = JSON.parse(body);
          if (c.kind === 'array') {
            expect(Array.isArray(v)).toBe(true);
            expect(v.length).toBeGreaterThan(0);
            expect(typeof v[0]).toBe('object');
          } else if (c.kind === 'count') {
            expect(Array.isArray(v)).toBe(false);
            expect(typeof v.count).toBe('number');
            expect(v.count).toBeGreaterThan(0);
          } else if (c.kind === 'ok') {
            expect(v).toEqual({ ok: true });
          } else {
            expect(Array.isArray(v)).toBe(false);
            expect(typeof v).toBe('object');
          }
        }
      });
    }
  });
});
