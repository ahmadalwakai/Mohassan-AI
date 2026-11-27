import ts from 'typescript';

export interface CouncilCase {
  id: string;
  text: string;
  expected: RegExp;
  language: 'ar' | 'en';
}

/** Read the published QUESTIONS declaration without executing its live runner. */
export function readCouncilCases(source: string): CouncilCase[] {
  const file = ts.createSourceFile('council-questions.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations]);
  const matches = declarations.filter(item => ts.isIdentifier(item.name) && item.name.text === 'QUESTIONS');
  const list = matches.length === 1 ? matches[0]?.initializer : undefined;
  if (!list || !ts.isArrayLiteralExpression(list) || !list.elements.length) throw new Error('Expected one literal council QUESTIONS array.');
  const ids = new Set<string>();
  return list.elements.map(item => {
    if (!ts.isObjectLiteralExpression(item)) throw new Error('Expected a literal council case.');
    const fields = new Map<string, ts.Expression>();
    for (const property of item.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || fields.has(property.name.text)) {
        throw new Error('Expected unique explicit council case fields.');
      }
      fields.set(property.name.text, property.initializer);
    }
    const id = fields.get('id'), text = fields.get('text'), expected = fields.get('expected');
    if (!id || !ts.isStringLiteral(id) || !id.text || ids.has(id.text) || !text || !ts.isStringLiteral(text)
      || !text.text.trim() || !expected || !ts.isRegularExpressionLiteral(expected)) {
      throw new Error('Invalid council case ID, text or expectation.');
    }
    ids.add(id.text);
    const literal = expected.getText(file);
    const closingSlash = literal.lastIndexOf('/');
    return {
      id: id.text,
      text: text.text,
      expected: new RegExp(literal.slice(1, closingSlash), literal.slice(closingSlash + 1)),
      language: /\p{Script=Arabic}/u.test(text.text) ? 'ar' : 'en',
    };
  });
}

/** Use the same first visible answer line as scripts/quality/council-questions.ts. */
export function councilCorrect(expected: RegExp, answer: string | null): boolean {
  const first = answer?.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  expected.lastIndex = 0;
  return expected.test(first);
}
