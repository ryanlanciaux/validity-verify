import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const VALIDITY_HOME = process.env.VALIDITY_HOME ?? resolve(homedir(), '.validity');
const META_PATH = resolve(VALIDITY_HOME, 'install.json');

/**
 * On-disk shape of `~/.validity/install.json`. Older installs only carried
 * `version` / `tarballUrl` / `installedAt`; the wizard added `binaryName` +
 * wrapper paths to support PATH-conflict renames. All non-essential fields
 * are optional so legacy files round-trip without loss.
 */
export interface InstallMeta {
  version: string;
  tarballUrl?: string;
  tarballSha256?: string;
  installedAt: string;
  binaryName?: string;
  wrapperPath?: string;
  wrapperMcpPath?: string;
}

export function readInstallMeta(): InstallMeta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, 'utf-8')) as InstallMeta;
  } catch {
    return null;
  }
}

export function writeInstallMeta(meta: InstallMeta): void {
  if (!existsSync(VALIDITY_HOME)) mkdirSync(VALIDITY_HOME, { recursive: true, mode: 0o700 });
  // Atomic write — a Ctrl-C between write and rename leaves the previous
  // file intact rather than producing a half-written JSON file.
  const tmp = `${META_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
  renameSync(tmp, META_PATH);
}
