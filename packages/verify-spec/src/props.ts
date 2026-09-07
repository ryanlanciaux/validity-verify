import { Project, SyntaxKind } from 'ts-morph';
import type {
  ArrowFunction,
  CallExpression,
  FunctionDeclaration,
  FunctionExpression,
  ParameterDeclaration,
  SourceFile,
  Type,
} from 'ts-morph';

export interface PropTypeInfo {
  name: string;
  type: string;
  optional: boolean;
}

export interface ExtractedProps {
  componentName: string | null;
  props: PropTypeInfo[];
  raw: string;
}

// Type-alias names that pass through unexpanded — we want the friendly label
// (e.g. `React.ReactNode`) in the panel rather than the giant expanded union
// since downstream code special-cases these names.
const PASS_THROUGH_TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'true',
  'false',
  'unknown',
  'any',
  'void',
  'never',
  'React.ReactNode',
  'ReactNode',
  'React.ReactElement',
  'ReactElement',
]);

// HOC call expressions we know wrap a render function in their first
// argument. The component's props live on that render function's first
// parameter (or the call's 2nd type argument, when given explicitly).
const RENDER_FN_HOCS = new Set([
  'forwardRef',
  'React.forwardRef',
  'memo',
  'React.memo',
  'observer', // mobx-react
]);

interface Candidate {
  name: string;
  param: ParameterDeclaration;
  raw: string;
  hocTypeArgText: string | null;
}

export function extractPropsType(filePath: string): ExtractedProps {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 4 /* Preserve */ },
  });
  const sf = project.addSourceFileAtPath(filePath);

  const props: PropTypeInfo[] = [];
  const candidates: Candidate[] = [];

  let defaultExportName: string | null = null;
  const defaultExport = sf.getDefaultExportSymbol();
  if (defaultExport) {
    const decls = defaultExport.getDeclarations();
    for (const d of decls) {
      const sk = d.getKind();
      if (sk === SyntaxKind.FunctionDeclaration) {
        defaultExportName = (d as FunctionDeclaration).getName() ?? null;
      }
    }
  }

  for (const fn of sf.getFunctions()) {
    if (!fn.isDefaultExport() && !fn.isExported()) continue;
    const name = fn.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    const param = fn.getParameters()[0];
    if (!param) continue;
    candidates.push({
      name,
      param,
      raw: param.getType().getText(),
      hocTypeArgText: null,
    });
  }
  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const init = v.getInitializer();
    if (!init) continue;

    if (
      init.getKind() === SyntaxKind.ArrowFunction ||
      init.getKind() === SyntaxKind.FunctionExpression
    ) {
      const fnLike = init as ArrowFunction | FunctionExpression;
      const param = fnLike.getParameters()[0];
      if (!param) continue;
      candidates.push({
        name,
        param,
        raw: param.getType().getText(),
        hocTypeArgText: null,
      });
      continue;
    }

    // forwardRef / memo / observer pattern: the render function is the
    // first call argument. Reach in for its first parameter and grab the
    // explicit type argument when present so we can resolve aliases like
    // `BaseProps` without depending on whether React types are loaded.
    if (init.getKind() === SyntaxKind.CallExpression) {
      const call = init as CallExpression;
      const callee = call.getExpression().getText();
      if (!RENDER_FN_HOCS.has(callee)) continue;
      const renderArg = call.getArguments()[0];
      if (!renderArg) continue;
      const k = renderArg.getKind();
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue;
      const fnLike = renderArg as ArrowFunction | FunctionExpression;
      const param = fnLike.getParameters()[0];
      if (!param) continue;
      // forwardRef puts the props type at index 1: forwardRef<Ref, Props>
      // memo / observer put it at index 0.
      const typeArgs = call.getTypeArguments();
      const propsTypeArg =
        callee === 'forwardRef' || callee === 'React.forwardRef' ? typeArgs[1] : typeArgs[0];
      candidates.push({
        name,
        param,
        raw: param.getType().getText(),
        hocTypeArgText: propsTypeArg ? propsTypeArg.getText() : null,
      });
    }
  }

  // Pick the winning candidate. Preference order: default export → name
  // matching the file basename (case-insensitive) → first candidate in
  // source order. The basename rule is what makes `DashboardButton.tsx`
  // pick `DashboardButton` over a co-exported helper like `DashboardLink`,
  // and `Button.tsx` pick `Button` over a `ButtonLink` sibling.
  const baseName =
    filePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(tsx?|jsx?)$/, '') ?? '';
  const chosen =
    (defaultExportName ? candidates.find((c) => c.name === defaultExportName) : null) ??
    (baseName ? candidates.find((c) => c.name.toLowerCase() === baseName.toLowerCase()) : null) ??
    candidates[0] ??
    null;

  const componentName = chosen?.name ?? defaultExportName ?? null;
  const raw = chosen?.raw ?? '';
  const propsParam = chosen?.param ?? null;
  const hocTypeArgText = chosen?.hocTypeArgText ?? null;

  if (propsParam) {
    try {
      // Prefer an explicit same-file props interface/type alias when we can
      // find one — keeps literal-union prop types like `"primary" | "outline"`
      // that the destructured-default fallback flattens to plain `string`,
      // and lets us see through HOCs like `forwardRef<Ref, BaseProps & ...>`
      // whose intersection types we'd otherwise scrape attribute-by-attribute.
      const enriched =
        findReferencedPropsType(sf, componentName) ??
        (hocTypeArgText ? findInTypeText(sf, hocTypeArgText) : null);
      const propsType: Type = enriched ?? propsParam.getType();
      for (const prop of propsType.getProperties()) {
        const decl = prop.getDeclarations()[0];
        const t = decl ? prop.getTypeAtLocation(decl) : null;
        const rawText = t?.getText() ?? 'unknown';
        props.push({
          name: prop.getName(),
          type: t ? formatPropType(t, rawText) : 'unknown',
          optional: prop.isOptional?.() ?? false,
        });
      }
    } catch {
      // best-effort
    }
  }

  return { componentName, props, raw };
}

/**
 * Look at the component's variable-declaration type annotation and pull out a
 * same-file interface or type alias to use as the props source of truth. We
 * only handle simple cases: `React.FC<X>`, `FC<X>`, `FunctionComponent<X>`,
 * `React.ForwardRefExoticComponent<X>`, or a bare type-reference `: X`.
 * Returns null when no annotation matches or the referenced symbol isn't
 * declared in this file.
 */
function findReferencedPropsType(sf: SourceFile, componentName: string | null): Type | null {
  if (!componentName) return null;
  const varDecl = sf.getVariableDeclaration(componentName);
  if (!varDecl) return null;
  const typeNode = varDecl.getTypeNode();
  if (!typeNode) return null;
  return findInTypeText(sf, typeNode.getText());
}

/**
 * Scan a type expression for the first identifier that resolves to a
 * same-file interface or type alias. Handles intersections (`A & B`) and
 * generics (`React.FC<X>`, `Omit<Y, "..." | "...">`) by taking the first
 * hit — which is conventionally the user-authored props type rather than
 * the React/DOM scaffolding it composes with.
 */
function findInTypeText(sf: SourceFile, text: string): Type | null {
  // Tokenize identifiers in order of appearance. Skip keywords + names we
  // know aren't user-defined props types.
  const SKIP = new Set([
    'React',
    'FC',
    'FunctionComponent',
    'ComponentType',
    'VoidFunctionComponent',
    'PropsWithChildren',
    'Omit',
    'Pick',
    'Partial',
    'Required',
    'Readonly',
    'Exclude',
    'Extract',
    'ButtonHTMLAttributes',
    'HTMLAttributes',
    'AnchorHTMLAttributes',
    'InputHTMLAttributes',
    'TextareaHTMLAttributes',
    'SelectHTMLAttributes',
    'DetailedHTMLProps',
    'HTMLButtonElement',
    'HTMLDivElement',
    'HTMLInputElement',
    'HTMLAnchorElement',
    'HTMLElement',
    'string',
    'number',
    'boolean',
    'undefined',
    'null',
    'void',
    'never',
    'unknown',
    'any',
  ]);
  const idents = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const ident of idents) {
    if (SKIP.has(ident)) continue;
    const iface = sf.getInterface(ident);
    if (iface) return iface.getType();
    const alias = sf.getTypeAlias(ident);
    if (alias) return alias.getType();
  }
  return null;
}

/**
 * Render a prop's type into something the browse UI's `describePropField`
 * can read: keep recognised primitive / React names, but expand
 * single-identifier aliases that resolve to a union of literals (so
 * `DashVariant` becomes `"gold" | "ghost" | "quiet" | "destructive"` and
 * actually renders as a select instead of falling into the "complex" bucket).
 */
function formatPropType(t: Type, rawText: string): string {
  if (PASS_THROUGH_TYPE_NAMES.has(rawText)) return rawText;
  // Already a literal-union written out (e.g. `"a" | "b"`): keep it.
  if (/^(['"]).*\1(\s*\|\s*(['"]).*\3)*$/.test(rawText)) return rawText;
  // Single identifier (`DashVariant`, `MyAlias`) — try to expand.
  const isSingleIdent = /^[A-Za-z_$][\w$.]*$/.test(rawText);
  if (!isSingleIdent) return rawText;
  if (!t.isUnion?.()) return rawText;
  const members = (t.getUnionTypes?.() ?? []).filter((u) => {
    const tx = u.getText();
    return tx !== 'undefined' && tx !== 'null';
  });
  if (members.length === 0) return rawText;
  const allLiterals = members.every(
    (u) => u.isStringLiteral?.() || u.isNumberLiteral?.() || u.isBooleanLiteral?.(),
  );
  if (!allLiterals) return rawText;
  return members.map((u) => u.getText()).join(' | ');
}

// Mock-prop generation used to be LLM-driven. With Validity now agent-driven
// (the host's LLM scores the rendered output, no internal LLM calls), the
// callers either pass props explicitly (from .validity/config.ts) or get an
// empty object and the component renders with whatever defaults it declares.
// `extractPropsType` above remains useful as a hint to surface to the agent.
