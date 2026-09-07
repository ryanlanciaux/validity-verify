/**
 * Can't-false-green: a held verify lock must return a tool error and mint
 * neither a verdict nor a runId — same posture as the strict-enforcement
 * redirect. Two overlapping verifies must not interleave sandbox files.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireVerifyLock } from '@validity.ai/verify-spec';
import { handleVerify } from './server.js';

describe('handleVerify — verify lock', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-vlock-'));
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('held lock returns a tool error and mints no runId/verdict', async () => {
    const lock = acquireVerifyLock(projectRoot, { owner: 'verify-all' });
    try {
      const res = await handleVerify({ prompt: 'make the button blue', projectRoot });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(text).toContain('A verify is already running');
      expect(text).toContain('verify-all');
      expect(text).toContain(`pid ${process.pid}`);
      expect(text).toContain('node_modules/.validity/.verify.lock');
      expect(res.structuredContent).toBeUndefined();
      expect(existsSync(resolve(projectRoot, '.validity', 'runs'))).toBe(false);
    } finally {
      lock.release();
    }
  });
});
