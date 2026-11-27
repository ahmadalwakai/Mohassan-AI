import { resolve } from 'node:path';
import ts from 'typescript';
import * as contracts from '@mohassan/contracts';
import { BackgroundRunSchema } from '../../packages/contracts/src/background-run.js';

const root = resolve(import.meta.dirname, '../..');
const runtime = { ...contracts, BackgroundRunSchema } as Record<string, unknown>;

let compiler: ReturnType<typeof createTypeReader> | undefined;

function createTypeReader() {
  const directory = resolve(root, 'packages/contracts/src');
  const files = ts.sys.readDirectory(directory, ['.ts']);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const exports = new Map<string, ts.Symbol>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    const symbol = source && checker.getSymbolAtLocation(source);
    for (const entry of symbol ? checker.getExportsOfModule(symbol) : []) {
      const declaration = entry.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(entry) : entry;
      if (declaration.flags & ts.SymbolFlags.Type) exports.set(entry.name, declaration);
    }
  }
  return { checker, exports };
}

/** Check interface-only wire types against their current TypeScript declarations. */
function checkType(checker: ts.TypeChecker, type: ts.Type, value: unknown, path: string): string[] {
  const flags = type.flags;
  if (flags & ts.TypeFlags.Unknown) return [];
  if (flags & ts.TypeFlags.Any) throw new Error(`Unresolved or untyped contract at ${path}`);
  if (type.isUnion()) {
    return type.types.some(part => checkType(checker, part, value, path).length === 0)
      ? [] : [`${path}: expected ${checker.typeToString(type)}`];
  }
  if (type.isIntersection()) return type.types.flatMap(part => checkType(checker, part, value, path));
  if (type.isStringLiteral() || type.isNumberLiteral()) return value === type.value ? [] : [`${path}: expected ${JSON.stringify(type.value)}`];
  if (flags & ts.TypeFlags.BooleanLiteral) return String(value) === checker.typeToString(type) && typeof value === 'boolean'
    ? [] : [`${path}: expected ${checker.typeToString(type)}`];

  const primitives = [
    [ts.TypeFlags.String, 'string'], [ts.TypeFlags.Number, 'number'], [ts.TypeFlags.Boolean, 'boolean'],
    [ts.TypeFlags.Undefined | ts.TypeFlags.Void, 'undefined'],
  ] as const;
  for (const [flag, expected] of primitives) {
    if (flags & flag) return typeof value === expected ? [] : [`${path}: expected ${expected}`];
  }
  if (flags & ts.TypeFlags.Null) return value === null ? [] : [`${path}: expected null`];
  if (flags & ts.TypeFlags.Never) return [`${path}: unexpected value`];

  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    return Array.isArray(value)
      ? value.flatMap((item, i) => checkType(checker, element, item, `${path}[${i}]`))
      : [`${path}: expected an array`];
  }
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference);
    return Array.isArray(value) && value.length === elements.length
      ? elements.flatMap((element, i) => checkType(checker, element, value[i], `${path}[${i}]`))
      : [`${path}: expected a tuple of length ${elements.length}`];
  }

  if (!(flags & ts.TypeFlags.Object)) throw new Error(`Unsupported contract type at ${path}: ${checker.typeToString(type)}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected an object`];

  const object = value as Record<string, unknown>;
  const problems = checker.getPropertiesOfType(type).flatMap(property => {
    const name = property.getName();
    const child = `${path}.${name}`;
    if (!Object.hasOwn(object, name)) return property.flags & ts.SymbolFlags.Optional ? [] : [`${child}: required field missing`];
    const propertyType = checker.getTypeOfSymbol(property);
    return checkType(checker, propertyType, object[name], child);
  });
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (indexed) {
    for (const [key, entry] of Object.entries(object)) {
      if (!checker.getPropertyOfType(type, key)) problems.push(...checkType(checker, indexed, entry, `${path}.${key}`));
    }
  }
  return problems;
}

export function validateContract(name: string, body: unknown): void {
  const schema = runtime[name] ?? runtime[name + 'Schema'];
  if (schema && typeof schema === 'object' && 'parse' in schema && typeof schema.parse === 'function') {
    schema.parse(body);
    return;
  }
  const reader = compiler ??= createTypeReader();
  const symbol = reader.exports.get(name);
  if (!symbol) throw new Error(`Contract ${name} is missing from packages/contracts`);
  const problems = checkType(reader.checker, reader.checker.getDeclaredTypeOfSymbol(symbol), body, name);
  if (problems.length) throw new Error(problems.join('\n'));
}
