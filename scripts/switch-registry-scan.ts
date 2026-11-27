import { relative, resolve } from 'node:path';
import ts from 'typescript';

export type SwitchReads = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;

const manager = 'packages/model-relations/src/manager.ts';
const modelRegistry = 'packages/model-relations/src/registry.ts';
const consoleProjection = 'apps/server/src/activation-console/runtime.ts';

// These bracket reads take their names from the corresponding declarations in
// the same source file. Parse the declarations so additions reach the census.
const modelRegistryFields: Readonly<Record<string, string>> = {
  'item.env': 'env', 'item.childDirEnv': 'childDirEnv', 'entry.activationFlag': 'activationFlag',
};

function dynamicKeys(file: ts.SourceFile, module: string, key: string): string[] | undefined {
  const arbiter = module === manager && (key === 'flag' || key === '`${flag}_KILL`');
  const field = module === modelRegistry ? modelRegistryFields[key] : undefined;
  if (!arbiter && !field) return;
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer)) {
      const name = node.name.getText(file);
      if (arbiter && ts.isObjectLiteralExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) &&
          node.parent.parent.name.getText(file) === 'arbiterFlags') {
        names.add(node.initializer.text + (key === 'flag' ? '' : '_KILL'));
      }
      if (field && name === field) names.add(node.initializer.text);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  if (!names.size) throw new Error(`No declared keys for computed environment read in ${module}`);
  return [...names];
}

function isWrite(node: ts.Node): boolean {
  return (ts.isBinaryExpression(node.parent) && node.parent.left === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ts.isDeleteExpression(node.parent);
}

function parseContext(node: ts.Node, file: ts.SourceFile): string {
  let last = node;
  for (let current = node.parent; ts.isExpression(current); current = current.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
        ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) break;
    last = current;
  }
  const context = [last.getText(file)];
  // A small parser can normalize an aliased input in a later statement or a
  // helper. Include that parser body in the review fingerprint. Large callers
  // such as buildApp contribute only the expression that uses the setting.
  let caller: ts.Node = last.parent;
  while (!ts.isSourceFile(caller) && !ts.isFunctionLike(caller)) caller = caller.parent;
  if (ts.isFunctionLike(caller) && caller.end - caller.getStart(file) <= 2_000) {
    context.push(caller.getText(file));
  }
  return context.join('\n').replace(/\s+/g, ' ');
}

export function scanSwitchReads(root: string, paths?: readonly string[]): SwitchReads {
  const files = paths?.map(path => resolve(root, path)) ?? ts.sys.readDirectory(root,
    ['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'], [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts',
    ], ['apps/server/src/**/*', 'apps/worker/src/**/*', 'packages/*/src/**/*']);
  const options: ts.CompilerOptions = {
    allowJs: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext, strict: true, types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const cache = ts.createModuleResolutionCache(root, host.getCanonicalFileName, options);
  // Environment aliases travel through first-party modules. External package
  // declarations are unrelated to the census and make this check much heavier.
  host.resolveModuleNames = (names, containingFile) => names.map(name =>
    name.startsWith('.') || name.startsWith('@mohassan/')
      ? ts.resolveModuleName(name, containingFile, options, host, cache).resolvedModule
      : undefined);
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const keyFromType = (node: ts.Expression): string[] => {
    const type = checker.getTypeAtLocation(node);
    const members = type.isUnion() ? type.types : [type];
    return members.every(member => member.isStringLiteral())
      ? members.map(member => (member as ts.StringLiteralType).value) : [];
  };
  const typedEnvironment = (type: ts.Type): boolean => type.isUnion()
    ? type.types.some(typedEnvironment) : type.symbol?.name === 'ProcessEnv';
  function isEnvironment(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : keyFromType(node.argumentExpression)[0];
      if (key === 'env' && node.expression.getText() === 'process') return true;
    }
    if (typedEnvironment(checker.getTypeAtLocation(node))) return true;
    if (ts.isIdentifier(node)) {
      // Also follow aliases whose explicit type erased the ProcessEnv name.
      return checker.getSymbolAtLocation(node)?.declarations?.some(declaration =>
        ts.isVariableDeclaration(declaration) && !!declaration.initializer && isEnvironment(declaration.initializer, seen)
      ) ?? false;
    }
    return ts.isParenthesizedExpression(node) && isEnvironment(node.expression, seen);
  }

  const reads = new Map<string, Map<string, Set<string>>>();
  const projectedKeys = new Set<string>();
  for (const path of files) {
    const file = program.getSourceFile(path);
    if (!file) throw new Error(`Cannot read module ${relative(root, path)}`);
    const module = relative(root, path).replaceAll('\\', '/');
    const add = (name: string, expression: string) => {
      const readers = reads.get(name) ?? new Map();
      const expressions = readers.get(module) ?? new Set<string>();
      expressions.add(expression);
      readers.set(module, expressions);
      reads.set(name, readers);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'Reflect.get' &&
          node.arguments.length >= 2 && isEnvironment(node.arguments[0])) {
        const key = node.arguments[1];
        const names = keyFromType(key);
        if (module === consoleProjection) {
          // The console looks up names from the generated inventory itself.
          // Literal overrides must already be production consumers.
          if (!names.length && key.getText(file) !== 'name') {
            throw new Error(`Unknown computed environment switch in ${module}`);
          }
          for (const name of names) projectedKeys.add(name);
        } else {
          if (!names.length) throw new Error(`Unknown computed environment switch in ${module}`);
          for (const name of names) add(name, parseContext(node, file));
        }
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          !isWrite(node) && isEnvironment(node.expression)) {
        const expression = parseContext(node, file);
        if (ts.isPropertyAccessExpression(node)) add(node.name.text, expression);
        else {
          const key = node.argumentExpression;
          const names = keyFromType(key);
          const resolved = names.length ? names : dynamicKeys(file, module, key.getText(file));
          if (!resolved) throw new Error(`Unknown computed environment switch in ${module}`);
          for (const name of resolved) add(name, expression);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
          node.initializer && isEnvironment(node.initializer)) {
        for (const binding of node.name.elements) {
          const key = binding.propertyName ?? binding.name;
          if (binding.dotDotDotToken) continue;
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) add(key.text, binding.getText(file));
          else if (ts.isComputedPropertyName(key) && keyFromType(key.expression).length)
            for (const name of keyFromType(key.expression)) add(name, binding.getText(file));
          else throw new Error(`Unknown destructured environment switch in ${module}`);
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  for (const name of projectedKeys) {
    if (!reads.has(name)) throw new Error(`Unknown environment switch reader: ${consoleProjection} reads ${name}`);
  }
  return reads;
}
