import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNativeReadiness,
  ensureCompanionMetro,
  writeBuildMarker,
  writeMetroContentMarker,
} from '@validity.ai/verify-native';
import { runBrowse } from './browse.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@validity.ai/verify-spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@validity.ai/verify-spec')>()),
  ensureValidityConfigured: vi.fn(async () => ({})),
  loadConfig: vi.fn(async () => ({ config: {} })),
}));
vi.mock('@validity.ai/verify-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@validity.ai/verify-native')>()),
  checkNativeReadiness: vi.fn(),
  detectNativePlugin: vi.fn(async () => 'unknown'),
  isCompanionAppInstalled: vi.fn(async () => true),
  isCompanionMetroUp: vi.fn(async () => true),
  ensureCompanionMetro: vi.fn(),
  writeBuildMarker: vi.fn(),
  writeMetroContentMarker: vi.fn(),
}));

let root: string;
let stdout: string;
let stderr: string;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'validity-browse-failure-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '51' } }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  stdout = '';
  stderr = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    stdout += String(text);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    stderr += String(text);
    return true;
  });
  vi.mocked(checkNativeReadiness).mockResolvedValue({ ready: true, steps: [] });
  vi.mocked(ensureCompanionMetro).mockResolvedValue({ started: false, up: true });
});

afterEach(() => {
  process.exitCode = priorExitCode;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function needsBuild() {
  const step = {
    id: 'companion-app',
    label: 'Build companion',
    status: 'todo' as const,
    detail: 'Not built',
  };
  vi.mocked(checkNativeReadiness).mockResolvedValue({
    ready: false,
    steps: [step],
    nextAction: step,
  });
}

function spawnEmitting(event: string, ...args: unknown[]) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => child.emit(event, ...args));
  return child as unknown as ReturnType<typeof spawn>;
}

function expectBlocked() {
  expect(process.exitCode).not.toBeUndefined();
  expect(process.exitCode).not.toBe(0);
  expect(stdout).not.toContain('Ready. Open a component');
  expect(writeBuildMarker).not.toHaveBeenCalled();
  expect(writeMetroContentMarker).not.toHaveBeenCalled();
}

describe('native browse setup failures', () => {
  it('exits nonzero when a prerequisite is missing', async () => {
    const step = {
      id: 'device',
      label: 'Boot a device',
      status: 'todo' as const,
      detail: 'No booted device',
    };
    vi.mocked(checkNativeReadiness).mockResolvedValue({
      ready: false,
      steps: [step],
      nextAction: step,
    });
    await runBrowse({ cwd: root, native: true });
    expectBlocked();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([1, 7, null])(
    'propagates failed or signaled install (%s), without prebuilding',
    async (code) => {
      needsBuild();
      vi.mocked(spawn).mockImplementation(() =>
        spawnEmitting('close', code, code === null ? 'SIGTERM' : null),
      );
      await runBrowse({ cwd: root, native: true });
      expectBlocked();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(stderr).toContain('pnpm install');
    },
  );

  it('reports a missing install executable as a failure', async () => {
    needsBuild();
    vi.mocked(spawn).mockImplementation(() => spawnEmitting('error', new Error('ENOENT')));
    await runBrowse({ cwd: root, native: true });
    expectBlocked();
    expect(process.exitCode).toBe(127);
  });

  it.each(['close', 'error'])(
    'does not mark a failed expo launch successful even when an old app/Metro is up (%s)',
    async (event) => {
      needsBuild();
      vi.mocked(spawn).mockImplementation((_bin, args) => {
        const launching = (args as string[]).some((arg) => arg.startsWith('run:'));
        return launching
          ? spawnEmitting(event, event === 'error' ? new Error('ENOENT') : 1)
          : spawnEmitting('close', 0);
      });
      await runBrowse({ cwd: root, native: true });
      expectBlocked();
      expect(stderr).toContain('Step "expo run:ios" exited');
    },
  );

  it.each([
    { started: true, up: false, earlyExitCode: 1, logPath: '/tmp/metro.log' },
    { started: true, up: false, logPath: '/tmp/metro.log' },
    { started: true, up: true, ownershipUnconfirmed: true, logPath: '/tmp/metro.log' },
  ])('does not print Ready after Metro failure/unconfirmed ownership: %j', async (metro) => {
    vi.mocked(ensureCompanionMetro).mockResolvedValue(metro);
    await runBrowse({ cwd: root, native: true });
    expectBlocked();
    expect(stdout).toContain('/tmp/metro.log');
  });

  it('records a successful build and prints Ready', async () => {
    needsBuild();
    vi.mocked(spawn).mockImplementation(() => spawnEmitting('close', 0));
    await runBrowse({ cwd: root, native: true });
    expect(process.exitCode).toBeUndefined();
    expect(writeBuildMarker).toHaveBeenCalledOnce();
    expect(ensureCompanionMetro).toHaveBeenCalledOnce();
    expect(stdout).toContain('Ready. Open a component');
  });

  it('waits for Android build/install even while an old app and Metro are already up', async () => {
    needsBuild();
    const building = new EventEmitter();
    vi.mocked(spawn).mockImplementation((_bin, args) =>
      (args as string[]).includes('run:android')
        ? (building as unknown as ReturnType<typeof spawn>)
        : spawnEmitting('close', 0),
    );
    const run = runBrowse({ cwd: root, native: true, platform: 'android' });
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['run:android', '--no-bundler']),
        expect.anything(),
      ),
    );
    expect(writeBuildMarker).not.toHaveBeenCalled();
    expect(ensureCompanionMetro).not.toHaveBeenCalled();
    expect(stdout).not.toContain('Ready. Open a component');
    building.emit('close', 0);
    await run;
    expect(writeBuildMarker).toHaveBeenCalledWith(
      expect.stringContaining('.validity-build.android'),
      expect.any(String),
      expect.any(Object),
    );
    expect(stdout).toContain('Ready. Open a component');
  });
});
