/**
 * Component/screen/view catalog — the deterministic "what's in my library"
 * answer for the agent (goal #5: "show me my Button" just works).
 *
 * Composes the existing discovery primitives (`discoverComponentFiles`,
 * `discoverScreenFiles`, `buildComponentUsageMap`, `buildNavigationGraph`)
 * and merges them with the user's explicit `.validity/config.ts` entries
 * using the SAME precedence as the browse `/api/config` endpoint: explicit
 * entries win, discovered ones fill gaps, screens take precedence over
 * components on a path conflict.
 *
 * Cheap by default — one fs walk per kind plus the screen-usage parse. Prop
 * types are NOT extracted for the whole catalog (ts-morph per file is too
 * heavy for a 200-component repo); pass `includeProps` to extract them for
 * the (usually small) returned set, or call {@link extractPropsType}
 * directly for a single inspected component.
 */
import { basename, resolve } from 'node:path';
import type { ValidityConfig } from './types.js';
import { discoverComponentFiles } from './components.js';
import { discoverScreenFiles } from './screens.js';
import { buildComponentUsageMap } from './component-usage.js';
import { buildNavigationGraph, type ResolvedNavigationEdge } from './navigation.js';
import { extractPropsType, type PropTypeInfo } from './props.js';

export type CatalogKind = 'component' | 'screen' | 'view';

export interface CatalogFixture {
  name: string;
  description?: string;
  /** True when synthesized by Validity rather than authored by the user. */
  inferred?: boolean;
}

export interface CatalogEntry {
  /** Project-relative path (components/screens) or the view name (views). */
  path: string;
  /** Friendly identifier — component basename without extension, or the view name. */
  name: string;
  kind: CatalogKind;
  /** Resolved route, for screens with a Next.js / pinned route. */
  routePath?: string;
  /** True when discovered by the walker and not present in config. */
  discovered: boolean;
  /** Fixture names defined in config for this entry (empty for discovered-only). */
  fixtures: CatalogFixture[];
  /** Prop types — only populated when buildCatalog is called with includeProps. */
  props?: PropTypeInfo[];
  /** Screens that import this component (components only). */
  usedByScreens?: string[];
  /** Components this screen imports (screens only). */
  usesComponents?: string[];
}

export interface Catalog {
  entries: CatalogEntry[];
  navigation: ResolvedNavigationEdge[];
  counts: { components: number; screens: number; views: number };
}

export interface BuildCatalogOptions {
  /** Extract prop types for each returned entry (slower). Default false. */
  includeProps?: boolean;
  /** Hard cap forwarded to the discovery walkers. */
  max?: number;
}

function fileBaseName(path: string): string {
  return basename(path).replace(/\.(tsx|jsx|ts|js)$/i, '');
}

function configFixtures(
  entry: { fixtures?: Record<string, { description?: string }> } | undefined,
): CatalogFixture[] {
  if (!entry?.fixtures) return [];
  return Object.entries(entry.fixtures).map(([name, fx]) => ({
    name,
    description: fx?.description,
  }));
}

/**
 * Build the catalog for a project. `config` is the loaded `.validity/config.ts`
 * (or an empty object). Pure read — never writes the user's tree.
 */
export function buildCatalog(
  projectRoot: string,
  config: Partial<ValidityConfig> = {},
  opts: BuildCatalogOptions = {},
): Catalog {
  const max = opts.max;

  let discoveredComponents: string[] = [];
  try {
    discoveredComponents = discoverComponentFiles(projectRoot, max ? { max } : {});
  } catch {
    discoveredComponents = [];
  }

  let discoveredScreens: Array<{ path: string; routePath?: string }> = [];
  try {
    discoveredScreens = discoverScreenFiles(projectRoot, max ? { max } : {});
  } catch {
    discoveredScreens = [];
  }

  const explicitComponents = config.components ?? {};
  const explicitScreens = config.screens ?? {};

  // ---- Screens (explicit win; discovered fills gaps + routePath) ----------
  const screenEntries = new Map<string, { routePath?: string; discovered: boolean }>();
  for (const [path, entry] of Object.entries(explicitScreens)) {
    screenEntries.set(path, { routePath: entry.routePath, discovered: false });
  }
  for (const s of discoveredScreens) {
    const existing = screenEntries.get(s.path);
    if (!existing) screenEntries.set(s.path, { routePath: s.routePath, discovered: true });
    else if (!existing.routePath && s.routePath) existing.routePath = s.routePath;
  }
  const screenPaths = new Set(screenEntries.keys());

  // ---- Components (explicit + discovered, minus anything that's a screen) -
  const componentPaths = new Set<string>();
  for (const p of Object.keys(explicitComponents)) componentPaths.add(p);
  for (const p of discoveredComponents) componentPaths.add(p);
  for (const p of screenPaths) componentPaths.delete(p); // screen wins on conflict

  // ---- Usage map (which components each screen imports) -------------------
  let usage: Record<string, string[]> = {};
  try {
    usage = buildComponentUsageMap({
      projectRoot,
      screens: [...screenPaths],
      componentPaths: [...componentPaths],
    });
  } catch {
    usage = {};
  }
  // Invert for the components' usedByScreens.
  const usedBy = new Map<string, string[]>();
  for (const [screen, comps] of Object.entries(usage)) {
    for (const c of comps) {
      const arr = usedBy.get(c) ?? [];
      arr.push(screen);
      usedBy.set(c, arr);
    }
  }

  // ---- Navigation graph ---------------------------------------------------
  let navigation: ResolvedNavigationEdge[] = [];
  try {
    navigation = buildNavigationGraph(
      projectRoot,
      [...screenEntries].map(([path, e]) => ({ path, routePath: e.routePath })),
    );
  } catch {
    navigation = [];
  }

  const entries: CatalogEntry[] = [];

  for (const [path, meta] of [...screenEntries].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entry: CatalogEntry = {
      path,
      name: fileBaseName(path),
      kind: 'screen',
      routePath: meta.routePath,
      discovered: meta.discovered,
      fixtures: configFixtures(explicitScreens[path]),
      usesComponents: usage[path] ?? [],
    };
    if (opts.includeProps) entry.props = safeProps(projectRoot, path);
    entries.push(entry);
  }

  for (const path of [...componentPaths].sort((a, b) => a.localeCompare(b))) {
    const entry: CatalogEntry = {
      path,
      name: fileBaseName(path),
      kind: 'component',
      discovered: !explicitComponents[path],
      fixtures: configFixtures(explicitComponents[path]),
      usedByScreens: usedBy.get(path) ?? [],
    };
    if (opts.includeProps) entry.props = safeProps(projectRoot, path);
    entries.push(entry);
  }

  for (const [name, view] of Object.entries(config.views ?? {})) {
    entries.push({
      path: name,
      name,
      kind: 'view',
      discovered: false,
      fixtures: [],
      usesComponents: [...new Set(view.items.map((i) => i.componentPath))],
    });
  }

  return {
    entries,
    navigation,
    counts: {
      components: componentPaths.size,
      screens: screenPaths.size,
      views: Object.keys(config.views ?? {}).length,
    },
  };
}

function safeProps(projectRoot: string, relPath: string): PropTypeInfo[] | undefined {
  try {
    return extractPropsType(resolve(projectRoot, relPath)).props;
  } catch {
    return undefined;
  }
}

/** One-line human summary of an entry's props, e.g. `label: string, disabled?: boolean`. */
export function summarizeProps(props: PropTypeInfo[] | undefined, max = 6): string {
  if (!props || props.length === 0) return '';
  const shown = props
    .slice(0, max)
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ');
  return props.length > max ? `${shown}, …` : shown;
}
