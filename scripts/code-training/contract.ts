/** Compare generated declarations with an independently supplied TypeScript signature. */
import ts from 'typescript';

function typeIdentity(node: ts.TypeNode | undefined): string | null {
  if (!node) return null;
  if ([ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.UndefinedKeyword].includes(node.kind)) return ts.SyntaxKind[node.kind];
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isParenthesizedTypeNode(node)) return typeIdentity(node.type);
  if (ts.isArrayTypeNode(node)) {
    const item = typeIdentity(node.elementType);
    return item === null ? null : `array(${item})`;
  }
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map(typeIdentity);
    if (members.some(member => member === null)) return null;
    return `union(${[...new Set(members as string[])].sort().join('|')})`;
  }
  return null;
}

function declarationShape(source: string): unknown | null {
  const file = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parsed = file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  if (parsed.parseDiagnostics.length || file.statements.length !== 1) return null;
  const declaration = file.statements[0];
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body
    || declaration.typeParameters?.length || declaration.asteriskToken
    || declaration.modifiers?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword)) return null;
  const returns = typeIdentity(declaration.type);
  if (returns === null) return null;
  const parameters = [];
  for (const parameter of declaration.parameters) {
    const type = typeIdentity(parameter.type);
    if (!ts.isIdentifier(parameter.name) || type === null || parameter.initializer || parameter.modifiers?.length) return null;
    parameters.push({ name: parameter.name.text, type, optional: Boolean(parameter.questionToken), rest: Boolean(parameter.dotDotDotToken) });
  }
  return { name: declaration.name.text, parameters, returns };
}

export function matchesSignature(source: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature.trim() || signature.length > 300) return false;
  const actual = declarationShape(source);
  const expected = declarationShape(`export function ${signature} { return 0; }`);
  return actual !== null && expected !== null && JSON.stringify(actual) === JSON.stringify(expected);
}
