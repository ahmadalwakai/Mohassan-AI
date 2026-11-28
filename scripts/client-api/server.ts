import path, { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { MEMBER_ROUTES, PUBLIC_ROUTES, routeKey } from '../../apps/server/src/members.js';
import type { ServerRoute } from './types.js';

const appFile = 'apps/server/src/app.ts';
const membersFile = 'apps/server/src/members.ts';
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route']);

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild(child => visit(child, inspect));
}

function name(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function property(object: ts.Expression, key: string): ts.Expression | undefined {
  if (!ts.isObjectLiteralExpression(object)) return;
  const entry = object.properties.find(item => name(item.name) === key);
  if (entry && ts.isPropertyAssignment(entry)) return entry.initializer;
  if (entry && ts.isShorthandPropertyAssignment(entry)) return entry.name;
}

function lineOf(node: ts.Node) {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function routeProperties(call: ts.CallExpression, method: string) {
  const [options] = call.arguments;
  if (!options) return {};
  if (method === 'route') {
    return { methods: property(options, 'method'), paths: property(options, 'url'), handler: property(options, 'handler') };
  }
  return { paths: options, handler: call.arguments.at(-1) };
}

export function isWorkspaceSource(root: string, fileName: string, paths = path) {
  const ownPath = paths.relative(root, fileName);
  const segments = ownPath.split(paths.sep);
  return ownPath !== '' && !paths.isAbsolute(ownPath) && segments[0] !== '..' && !segments.includes('node_modules');
}

/** A workspace import can resolve through the npm workspace symlink to a source file. */
function productionFiles(program: ts.Program, root: string, entry: string) {
  const options = program.getCompilerOptions();
  const resolution = ts.createModuleResolutionCache(root, file => file, options);
  const files = new Set<ts.SourceFile>();
  function follow(fileName: string) {
    const source = program.getSourceFile(fileName);
    if (!source || files.has(source) || source.isDeclarationFile) return;
    files.add(source);
    for (const statement of source.statements) {
      const runtimeImport = ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly;
      const runtimeExport = ts.isExportDeclaration(statement) && !statement.isTypeOnly;
      if (!runtimeImport && !runtimeExport) continue;
      const moduleName = name(statement.moduleSpecifier);
      if (!moduleName) continue;
      const imported = ts.resolveModuleName(moduleName, fileName, options, ts.sys, resolution).resolvedModule?.resolvedFileName;
      if (imported && isWorkspaceSource(root, imported)) follow(imported);
    }
  }
  follow(entry);
  return files;
}

/** Resolve the finite source expressions used in paths, including for-of route families. */
function routeExpressions(checker: ts.TypeChecker) {
  const references = new Map<ts.SourceFile, ts.CallExpression[]>();

  function declaration(node: ts.Node) {
    let symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  function parameterArguments(parameter: ts.ParameterDeclaration): ts.Expression[] {
    const fn = parameter.parent;
    const named = ts.isArrowFunction(fn) && ts.isVariableDeclaration(fn.parent) ? fn.parent : fn;
    if (!named.name || !ts.isIdentifier(named.name)) return [];
    const source = fn.getSourceFile();
    if (!references.has(source)) {
      const calls: ts.CallExpression[] = [];
      visit(source, node => { if (ts.isCallExpression(node)) calls.push(node); });
      references.set(source, calls);
    }
    const index = fn.parameters.indexOf(parameter);
    return references.get(source)!.flatMap(call => declaration(call.expression) === named && call.arguments[index]
      ? [call.arguments[index]] : []);
  }

  function loopValues(variable: ts.VariableDeclaration, tupleIndex?: number): ts.Expression[] {
    const loop = variable.parent.parent;
    if (!ts.isForOfStatement(loop)) return [];
    const values = atoms(loop.expression).filter(ts.isArrayLiteralExpression).flatMap(array => [...array.elements]);
    if (tupleIndex === undefined) return values;
    return values.flatMap(value => ts.isArrayLiteralExpression(value) && value.elements[tupleIndex] ? [value.elements[tupleIndex]] : []);
  }

  function atoms(input: ts.Expression, stack = new Set<ts.Node>()): ts.Expression[] {
    const node = unwrap(input);
    if (stack.has(node)) return [];
    const next = new Set(stack).add(node);
    if (ts.isIdentifier(node)) {
      const source = declaration(node);
      if (!source) return [];
      if (ts.isVariableDeclaration(source)) return (source.initializer ? [source.initializer] : loopValues(source)).flatMap(value => atoms(value, next));
      if (ts.isParameter(source)) return parameterArguments(source).flatMap(value => atoms(value, next));
      if (ts.isBindingElement(source) && ts.isVariableDeclaration(source.parent.parent)) {
        const variable = source.parent.parent;
        if (ts.isArrayBindingPattern(source.parent)) {
          return loopValues(variable, source.parent.elements.indexOf(source)).flatMap(value => atoms(value, next));
        }
        const key = name(source.propertyName ?? source.name);
        if (variable.initializer && key) return atoms(variable.initializer, next).flatMap(object => {
          const value = property(object, key);
          return value ? atoms(value, next) : [];
        });
      }
      return [];
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : strings(node.argumentExpression, next);
      return atoms(node.expression, next).flatMap(object => keys.flatMap(key => {
        const value = property(object, key);
        return value ? atoms(value, next) : [];
      }));
    }
    return [node];
  }

  function strings(input: ts.Expression, stack = new Set<ts.Node>()): string[] {
    return atoms(input, stack).flatMap(node => {
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => strings(element, stack));
      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.reduce<string[]>((prefixes, span) =>
          prefixes.flatMap(prefix => strings(span.expression, stack).map(value => prefix + value + span.literal.text)), [node.head.text]);
      }
      return [];
    });
  }

  return strings;
}

function handlerContracts(handler: ts.Expression | undefined, checker: ts.TypeChecker) {
  const request = new Set<string>();
  const response = new Set<string>();
  if (handler) visit(handler, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { expression, name: method } = node.expression;
    if (!ts.isIdentifier(expression) || !['parse', 'safeParse'].includes(method.text)) return;
    const declaration = checker.getSymbolAtLocation(expression)?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration) || name(declaration.parent.parent.parent.moduleSpecifier) !== '@mohassan/contracts') return;
    const contract = (declaration.propertyName ?? declaration.name).text;
    let isInput = false;
    const input = node.arguments[0];
    if (input) visit(input, child => {
      if (ts.isPropertyAccessExpression(child) && ['body', 'query', 'params', 'headers'].includes(child.name.text)) isInput = true;
    });
    if (isInput) request.add(contract);
    else if (ts.isReturnStatement(node.parent) || ts.isArrowFunction(node.parent) || (ts.isCallExpression(node.parent)
      && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'send')) response.add(contract);
  });
  return { request: [...request].join(' / ') || undefined, response: [...response].join(' / ') || undefined };
}

export function serverRoutes(workspace: string): ServerRoute[] {
  const root = resolve(workspace);
  const entry = resolve(root, appFile);
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true, types: [], skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const strings = routeExpressions(checker);
  const result: ServerRoute[] = [];
  const members = program.getSourceFile(resolve(root, membersFile))!;
  const memberSet = members.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(item => name(item.name) === 'MEMBER_ROUTES'))!;
  const publicSet = members.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(item => name(item.name) === 'PUBLIC_ROUTES'))!;
  const gateLine = program.getSourceFile(entry)!.text.split('\n').findIndex(line => line.includes('!MEMBER_ROUTES.has(key)')) + 1;

  for (const source of productionFiles(program, root, entry)) visit(source, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { expression: receiver, name: { text: verb } } = node.expression;
    if (!methods.has(verb) || name(receiver) !== 'app') return;
    const file = relative(root, source.fileName).split(sep).join('/');
    const line = lineOf(node);
    const options = routeProperties(node, verb);
    const paths = options.paths ? strings(options.paths) : [];
    const verbs = options.methods ? strings(options.methods) : [verb.toUpperCase()];
    if (!paths.length || !verbs.length) throw new Error(`Cannot resolve Fastify route at ${file}:${line}`);
    const contracts = handlerContracts(options.handler, checker);

    for (const method of verbs) for (const path of paths) {
      const key = routeKey(method, path)!;
      const auth = PUBLIC_ROUTES.has(key) ? 'anonymous' : MEMBER_ROUTES.has(key) ? 'member' : 'owner';
      const authFile = auth === 'owner' ? appFile : membersFile;
      const authLine = auth === 'owner' ? gateLine : lineOf(auth === 'member' ? memberSet : publicSet);
      const route = { method, path, auth, file, line, authFile, authLine, ...contracts } satisfies ServerRoute;
      if (path === '/api/auth/*' && options.handler) {
        // Better Auth has a wildcard registration, but the application grants only its explicit allowlist.
        visit(options.handler, child => {
          if (!ts.isVariableDeclaration(child) || name(child.name) !== 'allowed' || !child.initializer || !ts.isNewExpression(child.initializer)) return;
          const entries = child.initializer.arguments?.[0];
          for (const entry of entries ? strings(entries) : []) {
            const [allowedMethod, allowedPath] = entry.split(' ');
            if (allowedMethod === method) result.push({ ...route, path: allowedPath!, registrationPath: path, line: lineOf(child) });
          }
        });
      } else {
        const note = path === '/api/windows/companion/pair' ? 'Owner-issued pairing code'
          : path === '/api/windows/companion/poll' ? 'Paired-device bearer credential'
          : path.startsWith('/api/chat/monitors') ? 'Requires monitor rollout for the account (apps/server/src/monitors/routes.ts:24–31, apps/server/src/monitors-phase1/rollout.ts:6–21).'
          : path === '/api/member-data/deletion' && method === 'POST' ? 'Only member accounts can request deletion (apps/server/src/member-deletion.ts:158–160).'
          : path.endsWith('/share/preview') || path.endsWith('/share') ? 'Members need the owner to enable conversation sharing (apps/server/src/conversation-share.ts:55–56).'
          : undefined;
        result.push({ ...route, note });
      }
    }
  });
  return result;
}
