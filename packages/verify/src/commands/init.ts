import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  ensureValidityConfigured,
  writeAgentStanzas,
  detectAppTarget,
  loadConfig,
  type AgentStanzaFileReport,
} from '@validity.ai/verify-spec';
import {
  printPluginWiringResult,
  resolvePluginSelectionFlag,
  wirePlugins,
} from '../plugin-wiring.js';

export interface InitArgs {
  cwd?: string;
  force?: boolean;
  agentStanza?: boolean;
  /**
   * `--plugins[=web|native|all]` / `--no-plugins`. Wiring is DEFAULT-ON:
   * omitted and bare `--plugins` both resolve to 'auto' (detect the app,
   * wire the matching plugin); `--plugins=X` names a target (`web` is
   * bundler-aware: plugin-next for a Next app, plugin-vite otherwise — see
   * `resolvePluginTargets`); `--no-plugins` (`false`) is the one opt-out.
   * Every wiring step is provably-safe-or-paste-stanza and idempotent,
   * which is what makes default-on acceptable. See
   * {@link resolvePluginSelectionFlag} for the history of this default.
   */
  plugins?: string | boolean;
}

/**
 * Applies the managed CLAUDE.md / AGENTS.md agent-stanza block. Unit-testable
 * in isolation (no ensureValidityConfigured bootstrap). Returns [] immediately
 * when disabled (--no-agent-stanza); otherwise delegates to writeAgentStanzas.
 */
export function applyAgentStanza(opts: {
  cwd: string;
  enabled: boolean;
  allowAdd: boolean;
}): AgentStanzaFileReport[] {
  if (!opts.enabled) return [];
  return writeAgentStanzas(opts.cwd, { allowAdd: opts.allowAdd });
}

/**
 * `validity init` is a thin wrapper around `ensureValidityConfigured`.
 * Same code that runs at the top of every verify, just exposed as a CLI
 * command for users who want to seed the config + cloned wrapper before
 * their first verify (or to force a regen via `--force`).
 */
export async function runInit(args: InitArgs = {}): Promise<void> {
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();

  // Validate --plugins up front — an LLM-typo'd target surfaces immediately.
  const pluginSelectionResult = resolvePluginSelectionFlag(args.plugins);
  if (!pluginSelectionResult.ok) {
    process.stderr.write(pc.red(`${pluginSelectionResult.message}\n`));
    process.exitCode = 1;
    return;
  }
  const pluginSelection = pluginSelectionResult.mode;

  const result = await ensureValidityConfigured({
    projectRoot: cwd,
    force: args.force,
  });

  const out = process.stdout;
  const err = process.stderr;

  for (const f of result.generatedFiles) {
    const sym = f.action === 'wrote' ? pc.green('✓') : pc.dim('•');
    const verb = f.action === 'wrote' ? 'wrote' : f.action;
    out.write(`${sym} ${verb} ${f.path}\n`);
  }

  if (result.warnings.length > 0) {
    out.write('\n');
    for (const w of result.warnings) {
      err.write(pc.yellow(`! ${w}\n`));
    }
  }

  // First init (bootstrapped) adds the block; re-runs only update an existing
  // block in place; a user who deleted the block does NOT get it re-added
  // unless they pass --force; --no-agent-stanza skips entirely.
  const stanzaReports = applyAgentStanza({
    cwd,
    enabled: args.agentStanza !== false,
    allowAdd: result.bootstrapped || args.force === true,
  });
  const stanzaWarnings: string[] = [];
  for (const r of stanzaReports) {
    if (r.action === 'created' || r.action === 'updated') {
      out.write(`${pc.green('✓')} wrote ${r.path} (agent stanza)\n`);
    } else if (r.action === 'unchanged') {
      out.write(`${pc.dim('•')} unchanged ${r.path} (agent stanza)\n`);
    } else {
      out.write(`${pc.dim('•')} skipped ${r.path} (agent stanza)\n`);
    }
    if (r.warning) stanzaWarnings.push(r.warning);
  }
  if (stanzaWarnings.length > 0) {
    out.write('\n');
    for (const w of stanzaWarnings) {
      err.write(pc.yellow(`! ${w}\n`));
    }
  }

  if (result.manualSteps && result.manualSteps.length > 0) {
    out.write('\n' + pc.bold('Manual steps required:\n'));
    for (const step of result.manualSteps) {
      out.write(`  • ${step}\n`);
    }
  }

  // Plugin wiring — DEFAULT-ON (omitted flag → 'auto'); `--no-plugins` is
  // the opt-out. Safe as a default because every step is provably-safe-or-
  // paste-stanza and independently idempotent (a re-run on an existing
  // project reports 'unchanged' instead of re-editing). The web half is
  // bundler-aware (Next app → @validity.ai/verify-plugin-next, any other Vite-shaped
  // app including TanStack Start → @validity.ai/verify-plugin-vite); there is no
  // separate flag for it. Runs last — it never needs to precede or gate the
  // config/wrapper bootstrap above.
  const pluginResult = wirePlugins({ cwd, selection: pluginSelection, force: args.force });
  printPluginWiringResult(pluginResult, out, err);

  out.write('\n');
  out.write(pc.bold('Validity initialized.\n'));
  out.write(
    `\nNext: ${pc.cyan('validity start')} ${pc.dim('— shows your next step and stops.')}\n`,
  );
  let configFramework: string | undefined;
  const configFiles = ['.validity/config.ts', '.validity/config.mts', '.validity/config.js'];
  if (configFiles.some((c) => existsSync(resolve(cwd, c)))) {
    try {
      const { config } = await loadConfig(cwd);
      configFramework = config.framework;
    } catch {
      // Invalid config: fall back to detection (unchanged behavior)
    }
  }
  const isNative = detectAppTarget(cwd, { configFramework }).recommended === 'native';
  out.write(
    pc.dim(
      (isNative
        ? `\nNative isolation reuses .validity/wrapper.gen.tsx (cloned providers; wrapper.user.tsx composes into it when present — do not edit wrapper.gen.tsx). For native-only providers, customize .validity/wrapper.native.tsx and import gen if you still want the cloned tree.\n`
        : `\nEdit .validity/wrapper.user.tsx (create it if you want) to add providers Validity couldn't infer.\n`) +
        `Reports + screenshots write to .validity/runs/<runId>/ (auto-gitignored).\n` +
        `If you don't want teammates to see your local Validity setup, add \`.validity/\` to your project's .gitignore.\n`,
    ),
  );
  // No hint needed: wiring is default-on, so the wiring result above already
  // says what happened; `--no-plugins` users asked for silence.
}
