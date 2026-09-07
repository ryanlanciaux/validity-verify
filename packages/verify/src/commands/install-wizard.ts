import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';
import pc from 'picocolors';
import { readInstallMeta, writeInstallMeta, type InstallMeta } from '../install-meta.js';

// ---------------------------------------------------------------------------
// Helpers — environment introspection
// ---------------------------------------------------------------------------

interface HostDetections {
  claude: boolean;
  cursor: boolean;
  opencode: boolean;
  codex: boolean;
}

function detectHosts(): HostDetections {
  const home = homedir();
  return {
    claude: cmdExists('claude'),
    cursor: existsSync(resolve(home, '.cursor')),
    opencode:
      existsSync(resolve(home, '.config/opencode')) ||
      existsSync(resolve(home, '.config/opencode/opencode.json')),
    codex: existsSync(resolve(home, '.codex')),
  };
}

function cmdExists(cmd: string): boolean {
  // POSIX `command -v` returns 0 if found. We avoid `which` (not on every distro).
  const r = spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Returns the directory that holds the running `validity` script — i.e. npm's
 * global bin dir. validity-mcp lives next to it.
 */
function validityBinDir(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error('process.argv[1] missing — cannot resolve validity bin dir');
  return dirname(argv1);
}

/**
 * Locate any other `validity` on PATH that ISN'T the one we just installed.
 * Used to warn before letting the user keep the default name. Compares
 * realpath so npm's bin-symlink + the package file aren't flagged as a clash.
 */
function detectBinConflict(installedValidityPath: string): string | null {
  const PATH = process.env.PATH ?? '';
  let installedReal: string;
  try {
    installedReal = realpathSync(installedValidityPath);
  } catch {
    installedReal = installedValidityPath;
  }
  for (const dir of PATH.split(':')) {
    if (!dir) continue;
    const candidate = resolve(dir, 'validity');
    if (!existsSync(candidate)) continue;
    let candidateReal: string;
    try {
      candidateReal = realpathSync(candidate);
    } catch {
      candidateReal = candidate;
    }
    if (candidateReal !== installedReal) return candidate;
  }
  return null;
}

/**
 * Walk a small set of likely SKILL.md locations: bundled-next-to-cli (the
 * shipped tarball layout), repo-relative (local dev via `pnpm build`), and
 * `npm root -g` as a last resort.
 */
function findSkillSource(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(here, 'skill/validity/SKILL.md'),
    resolve(here, '../skill/validity/SKILL.md'),
    resolve(here, '../../skill/validity/SKILL.md'),
    resolve(here, '../../../packages/skill/validity/SKILL.md'),
    resolve(here, '../../../packages/verify-skill/SKILL.md'),
    resolve(here, '../../../packages/verify/skill/validity/SKILL.md'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const p = resolve(npmRoot, 'validity/skill/validity/SKILL.md');
    if (existsSync(p)) return p;
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wiring helpers — port of mcp-wizard.sh's wire_* functions to TS
// ---------------------------------------------------------------------------

interface WireContext {
  binName: string;
  mcpCmd: string;
  scope: 'user' | 'project';
  projectDir?: string;
  /** Home dir root for profile-wide config writes. Defaults to os.homedir();
   *  injected by the non-interactive sync path so it can be exercised in tests
   *  without touching the real ~/.cursor / ~/.config. */
  home?: string;
}

function wireClaude(ctx: WireContext): { ok: boolean; message: string } {
  if (!cmdExists('claude')) {
    return {
      ok: false,
      message:
        `claude CLI not found. Install Claude Code, then run:\n  ` +
        (ctx.scope === 'user'
          ? `claude mcp add --scope user ${ctx.binName} ${ctx.mcpCmd}`
          : `cd <project-dir> && claude mcp add ${ctx.binName} ${ctx.mcpCmd}`),
    };
  }
  if (ctx.scope === 'user') {
    spawnSync('claude', ['mcp', 'remove', '-s', 'user', ctx.binName], { stdio: 'ignore' });
    const r = spawnSync('claude', ['mcp', 'add', '-s', 'user', ctx.binName, ctx.mcpCmd], {
      stdio: 'ignore',
    });
    if (r.status === 0) {
      return { ok: true, message: `Claude Code: registered \`${ctx.binName}\` (user scope)` };
    }
    return {
      ok: false,
      message: `claude mcp add failed. Run manually:\n  claude mcp add --scope user ${ctx.binName} ${ctx.mcpCmd}`,
    };
  }
  // project scope
  const cwd = ctx.projectDir;
  if (!cwd) return { ok: false, message: 'Project scope chosen but no project dir provided.' };
  spawnSync('claude', ['mcp', 'remove', '-s', 'project', ctx.binName], { cwd, stdio: 'ignore' });
  spawnSync('claude', ['mcp', 'remove', ctx.binName], { cwd, stdio: 'ignore' });
  const r = spawnSync('claude', ['mcp', 'add', ctx.binName, ctx.mcpCmd], { cwd, stdio: 'ignore' });
  if (r.status === 0) {
    return {
      ok: true,
      message: `Claude Code: registered \`${ctx.binName}\` in ${cwd}`,
    };
  }
  return {
    ok: false,
    message: `claude mcp add failed. Run manually:\n  cd ${cwd} && claude mcp add ${ctx.binName} ${ctx.mcpCmd}`,
  };
}

function mergeJsonFile(
  path: string,
  mutate: (cfg: Record<string, unknown>) => void,
): { ok: boolean; message: string } {
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  mutate(cfg);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    renameSync(tmp, path);
    return { ok: true, message: `Wrote ${path}` };
  } catch (err) {
    return { ok: false, message: `Failed to write ${path}: ${(err as Error).message}` };
  }
}

function wireCursor(ctx: WireContext): { ok: boolean; message: string } {
  const target = resolve(ctx.home ?? homedir(), '.cursor/mcp.json');
  return mergeJsonFile(target, (cfg) => {
    const servers = (cfg.mcpServers ??= {} as Record<string, unknown>);
    (servers as Record<string, unknown>)[ctx.binName] = { command: ctx.mcpCmd };
  });
}

function wireOpenCode(ctx: WireContext): { ok: boolean; message: string } {
  const target = resolve(ctx.home ?? homedir(), '.config/opencode/opencode.json');
  return mergeJsonFile(target, (cfg) => {
    const mcp = (cfg.mcp ??= {} as Record<string, unknown>);
    (mcp as Record<string, unknown>)[ctx.binName] = {
      type: 'local',
      command: [ctx.mcpCmd],
      enabled: true,
    };
  });
}

function codexHint(ctx: WireContext): string {
  return (
    `Codex CLI uses TOML — add this block to ~/.codex/config.toml ` +
    `(or use its MCP UI):\n` +
    `  [mcp_servers.${ctx.binName}]\n  command = "${ctx.mcpCmd}"`
  );
}

function installSkill(targetDir: string, skillSrc: string): { ok: boolean; message: string } {
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    copyFileSync(skillSrc, resolve(targetDir, 'SKILL.md'));
    // HELP.md is the offline fallback the skill reads when `validity` isn't on
    // PATH. Ship it next to SKILL.md if the source build included it.
    const helpSrc = resolve(dirname(skillSrc), 'HELP.md');
    if (existsSync(helpSrc)) {
      copyFileSync(helpSrc, resolve(targetDir, 'HELP.md'));
    }
    return { ok: true, message: `Installed skill at ${targetDir}/SKILL.md` };
  } catch (err) {
    return { ok: false, message: `Skill install failed (${targetDir}): ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Manual-config snippet (printed when the user wants snippets for unsupported
// editors, or when nothing was selected for auto-wiring).
// ---------------------------------------------------------------------------

function manualConfigsSnippet(ctx: WireContext): string {
  return [
    pc.bold('Manual MCP configuration snippets'),
    `Use the command below in any host that speaks local stdio MCP.`,
    `Resolved binary on this machine: ${pc.cyan(ctx.mcpCmd)}`,
    '',
    pc.bold('Claude Code'),
    `  claude mcp add --scope user ${ctx.binName} ${ctx.mcpCmd}`,
    `  # or, for a single project:`,
    `  cd <project> && claude mcp add ${ctx.binName} ${ctx.mcpCmd}`,
    '',
    pc.bold('Cursor (~/.cursor/mcp.json — merge into mcpServers)'),
    `  "${ctx.binName}": { "command": "${ctx.mcpCmd}" }`,
    '',
    pc.bold('OpenCode (~/.config/opencode/opencode.json — merge into mcp)'),
    `  "${ctx.binName}": {`,
    `    "type": "local",`,
    `    "command": ["${ctx.mcpCmd}"],`,
    `    "enabled": true`,
    `  }`,
    '',
    pc.bold('OpenAI Codex CLI (~/.codex/config.toml)'),
    `  [mcp_servers.${ctx.binName}]`,
    `  command = "${ctx.mcpCmd}"`,
    '',
    pc.bold('Generic'),
    `  Transport: stdio. Command: ${ctx.mcpCmd} (no arguments).`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Wrapper installation for renamed binaries
// ---------------------------------------------------------------------------

interface WrapperResult {
  binName: string;
  wrapperPath: string;
  wrapperMcpPath: string;
  mcpCmd: string;
}

function installWrappers(
  binName: string,
  installedValidityPath: string,
  installedMcpPath: string,
): WrapperResult {
  const userBinDir = resolve(homedir(), '.local/bin');
  if (!existsSync(userBinDir)) mkdirSync(userBinDir, { recursive: true });
  const wrapperPath = resolve(userBinDir, binName);
  const wrapperMcpPath = resolve(userBinDir, `${binName}-mcp`);
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${shEscape(installedValidityPath)} "$@"\n`);
  chmodSync(wrapperPath, 0o755);
  writeFileSync(wrapperMcpPath, `#!/bin/sh\nexec ${shEscape(installedMcpPath)} "$@"\n`);
  chmodSync(wrapperMcpPath, 0o755);
  return { binName, wrapperPath, wrapperMcpPath, mcpCmd: wrapperMcpPath };
}

function shEscape(s: string): string {
  // Single-quote escape: ' → '\''
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function pathContains(dir: string): boolean {
  const PATH = process.env.PATH ?? '';
  return PATH.split(':').some((p) => p === dir);
}

// ---------------------------------------------------------------------------
// Non-interactive sync — refresh already-wired hosts without any prompts
// ---------------------------------------------------------------------------

export interface WiredHosts {
  claude: boolean;
  cursor: boolean;
  opencode: boolean;
  codex: boolean;
}

/** The user-scope skill directory each host reads. The skill dir name is always
 *  literally `validity`, independent of a renamed binary. */
const HOST_SKILL_DIR: Record<keyof WiredHosts, string> = {
  claude: '.claude/skills/validity',
  cursor: '.cursor/skills/validity',
  opencode: '.config/opencode/skills/validity',
  codex: '.codex/skills/validity',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if the JSON config at `path` has `<section>.<key>` defined. Tolerant of
 *  a missing / unparseable file (returns false). */
function jsonConfigHasKey(path: string, section: string, key: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const sec = cfg[section];
    return !!sec && typeof sec === 'object' && key in (sec as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** Default probe for `claude mcp list` stdout. Returns null when the `claude`
 *  CLI is absent or the command fails — both mean "not registered here". */
function defaultClaudeMcpList(): string | null {
  if (!cmdExists('claude')) return null;
  const r = spawnSync('claude', ['mcp', 'list'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) return null;
  return r.stdout ?? '';
}

export interface DetectWiredEnv {
  /** Home dir root. Defaults to os.homedir(); injected for tests. */
  home?: string;
  /** Returns `claude mcp list` stdout, or null if unavailable. Injected for tests. */
  claudeMcpList?: () => string | null;
}

/**
 * Which hosts already have Validity wired in — i.e. an MCP registration under
 * `binName` OR the host's skill dir present. Pure aside from the injected
 * filesystem/exec seams, so it can be exercised against a fake home in tests.
 */
export function detectWiredHosts(binName: string, env: DetectWiredEnv = {}): WiredHosts {
  const home = env.home ?? homedir();
  const claudeMcpList = env.claudeMcpList ?? defaultClaudeMcpList;
  const hasSkill = (host: keyof WiredHosts) =>
    existsSync(resolve(home, HOST_SKILL_DIR[host], 'SKILL.md'));

  const mcpList = claudeMcpList();
  const claudeMcpRegistered =
    mcpList != null && new RegExp('^' + escapeRegExp(binName) + '\\b', 'm').test(mcpList);

  return {
    claude: claudeMcpRegistered || hasSkill('claude'),
    cursor:
      jsonConfigHasKey(resolve(home, '.cursor/mcp.json'), 'mcpServers', binName) ||
      hasSkill('cursor'),
    opencode:
      jsonConfigHasKey(resolve(home, '.config/opencode/opencode.json'), 'mcp', binName) ||
      hasSkill('opencode'),
    // Codex config is TOML (not parsed here); skill presence is the only signal.
    codex: hasSkill('codex'),
  };
}

export interface SyncKnownHostsDeps {
  installedValidity: string;
  installedMcp: string;
  /** Previous install metadata. Defaults to readInstallMeta(). */
  prevMeta?: InstallMeta | null;
  /** Home dir root. Defaults to os.homedir(); injected for tests. */
  home?: string;
  /** SKILL.md source path (null = not found). Defaults to findSkillSource(). */
  skillSrc?: string | null;
  /** `claude mcp list` probe. Defaults to the real CLI call. */
  claudeMcpList?: () => string | null;
  /** Line sink for the summary. Defaults to stdout. */
  write?: (line: string) => void;
  /** Persist install metadata at the end. Defaults to writeInstallMeta. */
  persistMeta?: (meta: InstallMeta) => void;
}

export interface SyncKnownHostsResult {
  binName: string;
  refreshed: Array<keyof WiredHosts>;
  skillErrors: string[];
}

/**
 * The prompt-free half of the install wizard. Re-runs the mechanical wiring +
 * skill copy for every host that is already wired for Validity, so a headless
 * reinstall (`install-wizard --non-interactive`) refreshes stale skills instead
 * of leaving them untouched. Never invokes a clack prompt / spinner.
 */
export function syncKnownHosts(deps: SyncKnownHostsDeps): SyncKnownHostsResult {
  const home = deps.home ?? homedir();
  const prevMeta = deps.prevMeta !== undefined ? deps.prevMeta : readInstallMeta();
  const binName = prevMeta?.binaryName ?? 'validity';
  // A renamed binary wires MCP via its wrapper; the default name points straight
  // at the installed validity-mcp.
  const mcpCmd =
    binName !== 'validity' && prevMeta?.wrapperMcpPath
      ? prevMeta.wrapperMcpPath
      : deps.installedMcp;
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const persistMeta = deps.persistMeta ?? writeInstallMeta;
  const skillSrc = deps.skillSrc !== undefined ? deps.skillSrc : findSkillSource();

  const wired = detectWiredHosts(binName, { home, claudeMcpList: deps.claudeMcpList });
  const ctx: WireContext = { binName, mcpCmd, scope: 'user', home };

  const refreshed: Array<keyof WiredHosts> = [];
  const skillErrors: string[] = [];

  const refreshSkill = (host: keyof WiredHosts) => {
    if (skillSrc === null) return;
    const r = installSkill(resolve(home, HOST_SKILL_DIR[host]), skillSrc);
    if (!r.ok) skillErrors.push(r.message);
  };

  if (wired.claude) {
    // wireClaude does remove+add, so it's idempotent; a missing `claude` CLI
    // just returns ok:false and writes nothing — no throw, no prompt.
    wireClaude(ctx);
    refreshSkill('claude');
    refreshed.push('claude');
  }
  if (wired.cursor) {
    wireCursor(ctx);
    refreshSkill('cursor');
    refreshed.push('cursor');
  }
  if (wired.opencode) {
    wireOpenCode(ctx);
    refreshSkill('opencode');
    refreshed.push('opencode');
  }
  if (wired.codex) {
    // Codex has no auto-wire (TOML); refresh its skill only.
    refreshSkill('codex');
    refreshed.push('codex');
  }

  if (refreshed.length === 0) {
    write(
      pc.dim(
        'Non-interactive install — nothing to refresh; ' +
          'run `validity install-wizard` to wire up hosts.\n',
      ),
    );
  } else {
    write(
      pc.dim(
        `Non-interactive install — refreshed skill + MCP registration for: ${refreshed.join(', ')}.\n` +
          'Run `validity install-wizard` to add more hosts.\n',
      ),
    );
  }
  if (skillSrc === null && refreshed.length > 0) {
    write(
      pc.yellow(
        '! Could not locate SKILL.md — MCP registration refreshed but skills were not. ' +
          'Reinstall the validity package.\n',
      ),
    );
  }
  for (const msg of skillErrors) write(pc.yellow(`! ${msg}\n`));

  // Persist metadata like the interactive path — preserves version / installedAt
  // and the (unchanged) binaryName + wrapper paths.
  const now = new Date().toISOString();
  persistMeta({
    version: prevMeta?.version ?? 'unknown',
    tarballUrl: prevMeta?.tarballUrl,
    tarballSha256: prevMeta?.tarballSha256,
    installedAt: prevMeta?.installedAt ?? now,
    binaryName: binName,
    wrapperPath: prevMeta?.wrapperPath ?? '',
    wrapperMcpPath: prevMeta?.wrapperMcpPath ?? '',
  });

  return { binName, refreshed, skillErrors };
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export interface InstallWizardArgs {
  /** When set, print manual configs and exit 0 — used by CI / curl|sh-no-tty. */
  nonInteractive?: boolean;
  /** When a parent installer already showed the ASCII banner, skip ours so
   *  it is not printed twice. */
  skipBanner?: boolean;
}

const VALID_BIN_RE = /^[a-z][a-z0-9-]{0,31}$/;

export async function runInstallWizard(args: InstallWizardArgs = {}): Promise<void> {
  const installedValidity = process.argv[1] ?? '';
  // Override hook: VALIDITY_MCP_PATH points at validity-mcp when it is not
  // a sibling of argv[1] (the typical npm-global layout).
  const installedMcp = process.env.VALIDITY_MCP_PATH ?? resolve(validityBinDir(), 'validity-mcp');
  if (!existsSync(installedValidity) || !existsSync(installedMcp)) {
    process.stderr.write(
      pc.red(
        `validity / validity-mcp not found (looked next to ${installedValidity}). ` +
          `Re-run \`npm install -g validity\`, or set VALIDITY_MCP_PATH explicitly.\n`,
      ),
    );
    process.exit(1);
  }

  if (args.nonInteractive) {
    // No prompts on this path — only the mechanical, already-decided work:
    // refresh skills + MCP registration for hosts already wired for Validity.
    // The interactive host picker is the only thing we skip.
    syncKnownHosts({ installedValidity, installedMcp });
    return;
  }

  if (!args.skipBanner) {
    intro(pc.bold('Validity setup'));
  } else {
    log.message(pc.bold('Validity setup'));
  }

  // 1. Bin-name conflict resolution.
  const prevMeta = readInstallMeta();
  let binName = prevMeta?.binaryName ?? 'validity';
  let wrapperPath: string | undefined = prevMeta?.wrapperPath || undefined;
  let wrapperMcpPath: string | undefined = prevMeta?.wrapperMcpPath || undefined;
  let mcpCmd = installedMcp;

  const conflict = detectBinConflict(installedValidity);

  if (conflict && !prevMeta) {
    log.warn(`Another \`validity\` already exists on PATH at: ${conflict}`);
    log.message(
      `Pick a custom name for the Validity command, or hit Enter to keep \`validity\`\n` +
        pc.dim(`(PATH order will decide which one wins; the other tool may shadow ours).`),
    );
    const chosen = await text({
      message: 'Validity command name',
      placeholder: 'validity',
      defaultValue: 'validity',
      validate: (val) => {
        const v = val.trim() || 'validity';
        if (!VALID_BIN_RE.test(v)) {
          return 'Must be 1–32 chars, lowercase letters/digits/hyphens, starting with a letter.';
        }
        if (v !== 'validity' && cmdExists(v)) {
          return `\`${v}\` already exists on PATH. Pick another.`;
        }
        if (v !== 'validity' && cmdExists(`${v}-mcp`)) {
          return `\`${v}-mcp\` already exists on PATH. Pick another.`;
        }
        return undefined;
      },
    });
    if (isCancel(chosen)) {
      cancel('Setup cancelled. Run `validity install-wizard` later to finish.');
      return;
    }
    binName = (chosen as string).trim() || 'validity';
  } else if (conflict && prevMeta?.binaryName && prevMeta.binaryName !== 'validity') {
    log.info(`Existing install detected — preserving custom name \`${binName}\`.`);
  }

  if (binName !== 'validity') {
    const wrapper = installWrappers(binName, installedValidity, installedMcp);
    wrapperPath = wrapper.wrapperPath;
    wrapperMcpPath = wrapper.wrapperMcpPath;
    mcpCmd = wrapper.mcpCmd;
    log.success(`Wrappers installed: ${wrapperPath}, ${wrapperMcpPath}`);
    if (!pathContains(dirname(wrapperPath))) {
      log.warn(
        `${dirname(wrapperPath)} is NOT on your PATH.\n` +
          `Add to ~/.bashrc or ~/.zshrc:\n` +
          `  export PATH="$HOME/.local/bin:$PATH"`,
      );
    }
  }

  // 2. Scope.
  const scope = await select<'user' | 'project'>({
    message: 'Where should Validity be available?',
    options: [
      { value: 'user', label: 'All projects on this machine', hint: 'recommended' },
      { value: 'project', label: 'A single project only' },
    ],
    initialValue: 'user',
  });
  if (isCancel(scope)) {
    cancel('Setup cancelled. Run `validity install-wizard` later to finish.');
    return;
  }

  let projectDir: string | undefined;
  if (scope === 'project') {
    const cwd = process.cwd();
    const dir = await text({
      message: 'Project directory',
      placeholder: cwd,
      defaultValue: cwd,
      validate: (val) => {
        const v = val.trim() || cwd;
        if (!existsSync(v)) return `Not a directory: ${v}`;
        return undefined;
      },
    });
    if (isCancel(dir)) {
      cancel('Setup cancelled. Run `validity install-wizard` later to finish.');
      return;
    }
    projectDir = resolve((dir as string).trim() || cwd);
    log.warn(
      `Cursor / OpenCode / Codex configs are profile-wide on this wizard path — ` +
        `only Claude Code can be wired for a single project here.`,
    );
  }

  // 3. Host multiselect.
  const hosts = detectHosts();
  type HostId = 'claude' | 'cursor' | 'opencode' | 'codex' | 'manual';
  const options: Array<{ value: HostId; label: string; hint: string; selected?: boolean }> = [
    {
      value: 'claude',
      label: 'Claude Code',
      hint: hosts.claude ? 'detected' : 'not installed',
      selected: hosts.claude,
    },
  ];
  if (scope === 'user') {
    options.push(
      {
        value: 'cursor',
        label: 'Cursor',
        hint: hosts.cursor ? 'detected' : 'no ~/.cursor',
        selected: hosts.cursor,
      },
      {
        value: 'opencode',
        label: 'OpenCode',
        hint: hosts.opencode ? 'detected' : 'no ~/.config/opencode',
        selected: hosts.opencode,
      },
      {
        value: 'codex',
        label: 'OpenAI Codex CLI',
        hint: hosts.codex ? 'detected' : 'no ~/.codex',
        selected: hosts.codex,
      },
    );
  }
  options.push({
    value: 'manual',
    label: 'Show manual configs for other / unsupported editors',
    hint: 'no auto-write',
  });

  const picks = await multiselect<HostId>({
    message:
      scope === 'user'
        ? 'Which agents should we configure for Validity?'
        : 'Which agents should we configure (single-project)?',
    options,
    required: false,
  });
  if (isCancel(picks)) {
    cancel('Setup cancelled. Run `validity install-wizard` later to finish.');
    return;
  }

  const selected = new Set(picks as HostId[]);
  const ctx: WireContext = {
    binName,
    mcpCmd,
    scope: scope as 'user' | 'project',
    projectDir,
  };
  const skillSrc = findSkillSource();

  // 4. Apply each selection.
  if (selected.size === 0 || (selected.size === 1 && selected.has('manual'))) {
    log.warn('No hosts selected for auto-wiring.');
    note(manualConfigsSnippet(ctx));
  } else {
    if (selected.has('claude')) {
      const s = spinner();
      s.start('Wiring Claude Code…');
      const r = wireClaude(ctx);
      if (r.ok) s.stop(pc.green('✓ ') + r.message);
      else s.stop(pc.yellow('! ') + r.message);
    }
    if (selected.has('cursor')) {
      const s = spinner();
      s.start('Writing ~/.cursor/mcp.json…');
      const r = wireCursor(ctx);
      if (r.ok) s.stop(pc.green('✓ ') + `Cursor: ${r.message}`);
      else s.stop(pc.yellow('! ') + `Cursor: ${r.message}`);
    }
    if (selected.has('opencode')) {
      const s = spinner();
      s.start('Writing ~/.config/opencode/opencode.json…');
      const r = wireOpenCode(ctx);
      if (r.ok) s.stop(pc.green('✓ ') + `OpenCode: ${r.message}`);
      else s.stop(pc.yellow('! ') + `OpenCode: ${r.message}`);
    }
    if (selected.has('codex')) {
      log.warn(codexHint(ctx));
    }
    if (selected.has('manual')) {
      note(manualConfigsSnippet(ctx));
    }

    // 5. Skills — only for hosts that were selected for MCP wiring (they're
    //    the agents the user actually intends to use).
    if (skillSrc) {
      const skillTargets: Array<{ host: HostId; dir: string }> = [];
      if (selected.has('claude')) {
        const claudeSkillBase =
          scope === 'project' && projectDir
            ? resolve(projectDir, '.claude/skills/validity')
            : resolve(homedir(), '.claude/skills/validity');
        skillTargets.push({ host: 'claude', dir: claudeSkillBase });
      }
      if (selected.has('cursor'))
        skillTargets.push({ host: 'cursor', dir: resolve(homedir(), '.cursor/skills/validity') });
      if (selected.has('opencode'))
        skillTargets.push({
          host: 'opencode',
          dir: resolve(homedir(), '.config/opencode/skills/validity'),
        });
      if (selected.has('codex'))
        skillTargets.push({ host: 'codex', dir: resolve(homedir(), '.codex/skills/validity') });
      for (const { dir } of skillTargets) {
        const r = installSkill(dir, skillSrc);
        if (r.ok) log.success(r.message);
        else log.warn(r.message);
      }
    } else {
      log.warn(
        'Could not locate SKILL.md — skipped skill installs. Reinstall the validity package.',
      );
    }
  }

  // 6. Persist install metadata. Preserve fields a previous install
  //    populated (version / tarballUrl / sha256) — the wizard only touches
  //    binaryName + wrapper paths.
  const now = new Date().toISOString();
  const meta: InstallMeta = {
    version: prevMeta?.version ?? 'unknown',
    tarballUrl: prevMeta?.tarballUrl,
    tarballSha256: prevMeta?.tarballSha256,
    installedAt: prevMeta?.installedAt ?? now,
    binaryName: binName,
    wrapperPath: wrapperPath ?? '',
    wrapperMcpPath: wrapperMcpPath ?? '',
  };
  writeInstallMeta(meta);

  // The wizard ends where onboarding begins: point at the checklist rather
  // than at `doctor`. `doctor` answers "is anything broken?", which is the
  // wrong question for someone who has not run anything yet.
  outro(
    pc.bold('Setup finished.') +
      `\n\nNext: ${pc.cyan('cd')} into your project, then run ${pc.cyan(`${binName} start`)}` +
      pc.dim(' — it walks you through the rest, one step at a time.') +
      '\n' +
      pc.dim(`Or let your agent do it: ${binName} start --prompt`) +
      '\n' +
      pc.dim(
        `Heads up: the first verify in a project takes ~10–30s ` +
          `(Vite pre-bundles deps once into node_modules/.validity/.vite-cache); ` +
          `every later run is a few seconds.`,
      ),
  );
}
