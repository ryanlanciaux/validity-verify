import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { validityConfigSchema } from './schema.js';
import type { ValidityConfig } from './types.js';

const CONFIG_NAMES = [
  '.validity/config.ts',
  '.validity/config.mts',
  '.validity/config.js',
  '.validity/config.mjs',
];

export function defineConfig(config: ValidityConfig): ValidityConfig {
  return config;
}

export function findConfigFile(projectRoot: string): string | null {
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(projectRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface LoadedConfig {
  config: ValidityConfig;
  configPath: string;
}

export async function loadConfig(projectRoot: string): Promise<LoadedConfig> {
  const configPath = findConfigFile(projectRoot);
  if (!configPath) {
    throw new Error(
      `No validity config found in ${projectRoot}. Run \`validity init\` to create one.`,
    );
  }

  let mod: unknown;
  if (configPath.endsWith('.ts') || configPath.endsWith('.mts')) {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: false,
    });
    mod = await jiti.import(configPath, { default: true });
  } else {
    mod = (await import(pathToFileURL(configPath).href)).default;
  }

  const candidate = (mod as { default?: unknown })?.default ?? mod;
  const parsed = validityConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Invalid validity config at ${configPath}:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }

  return { config: parsed.data, configPath };
}

export function defaultConfig(opts: { wrapper?: string } = {}): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'auto',
    wrapper: opts.wrapper ?? './.validity/wrapper.gen.tsx',
    mocks: {
      api: 'auto',
    },
    components: {},
  };
}
