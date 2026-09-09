import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runInstallBrowser } from './install-browser.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('install-browser', () => {
  it.each([false, true])('uses the installed Playwright CLI (withDeps=%s)', (withDeps) => {
    runInstallBrowser({ withDeps });
    const [node, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(node).toBe(process.execPath);
    expect(existsSync(args![0])).toBe(true);
    expect(args!.slice(1)).toEqual(['install', 'chromium', ...(withDeps ? ['--with-deps'] : [])]);
    expect(options).toEqual({ stdio: 'inherit' });
  });
});
