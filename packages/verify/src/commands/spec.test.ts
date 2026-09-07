/**
 * Unit tests for the PURE pieces of `validity spec`. The export path-traversal
 * guard (`resolveWithin`) is the security-relevant one: it must refuse any
 * exporter-supplied `file.path` that escapes the output dir.
 */
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWithin } from './spec.js';

describe('resolveWithin', () => {
  const outDir = '/tmp/project/tests/e2e';

  it('resolves a plain relative path inside the output dir', () => {
    expect(resolveWithin(outDir, 'login.spec.ts')).toBe(resolve(outDir, 'login.spec.ts'));
  });

  it('resolves a nested subdir path inside the output dir', () => {
    expect(resolveWithin(outDir, 'auth/login.spec.ts')).toBe(resolve(outDir, 'auth/login.spec.ts'));
  });

  it('refuses a `../` traversal that escapes the output dir', () => {
    expect(resolveWithin(outDir, '../../etc/passwd')).toBeNull();
  });

  it('refuses a path that climbs out and back into a sibling dir', () => {
    // A sibling like `/tmp/project/tests/e2e-evil/x` shares a string prefix but
    // is NOT contained — the `+ sep` boundary check must reject it.
    expect(resolveWithin(outDir, `..${sep}e2e-evil${sep}x.spec.ts`)).toBeNull();
  });

  it('allows the output dir itself (degenerate empty path)', () => {
    expect(resolveWithin(outDir, '.')).toBe(resolve(outDir));
  });
});
