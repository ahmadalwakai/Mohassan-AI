import { describe, expect, it } from 'vitest';
import { CodeIndex } from '../packages/code-knowledge/src/indexer.ts';
import { glossaryTerms } from '../packages/code-knowledge/src/glossary.ts';
import { extractErrorSignatures, hasErrorMessage, isOperatorToken, splitIdentifier, tokenize, tokenizeQuery } from '../packages/code-knowledge/src/tokens.ts';
import type { Passage } from '../packages/code-knowledge/src/types.ts';

function passage(id: string, title: string, text: string, code: string = ''): Passage {
  return { id, sourceId: 'fixture', url: 'https://example.com/' + id, title, text, tags: [], code: code ? [{ text: code }] : [] };
}

describe('code-knowledge indexing', () => {
  it('separates acronym, camelCase, snake_case and dotted identifier components', () => {
    expect(splitIdentifier('XMLHttpRequest.read_file2')).toEqual(['xml', 'http', 'request', 'read', 'file2']);
    expect(tokenize('readFile read_file')).toEqual(['readfil', 'read', 'file', 'read_file', 'read', 'file']);
  });

  it('preserves literal programming operators with the longest recognized match taking priority', () => {
    expect(tokenizeQuery('== vs ===')).toEqual(['==', '===']);
    expect(tokenize('!== != ?? ?. := => && || <> <= >=')).toEqual(['!==', '!=', '??', '?.', ':=', '=>', '&&', '||', '<>', '<=', '>=']);
    expect(isOperatorToken('===')).toBe(true);
    expect(isOperatorToken('=== comparison')).toBe(false);
    const index = new CodeIndex([
      passage('strict', 'Strict equality (===)', 'Strict equality checks types first.'),
      passage('comparison', 'Equality comparison', 'The == and === comparison operators differ in type coercion.'),
    ]);
    expect(index.search('== vs ===')[0]).toMatchObject({ passage: { id: 'comparison' }, lexicalMatches: 2 });
  });

  it('uses reviewed Arabic terms and prefers a phrase over its individual words', () => {
    expect(glossaryTerms('ما الفرق بين متغيّر البيئة والمتغيّر؟')).toEqual(['environment variable', 'variable']);
    expect(glossaryTerms('ما هي المصفوفات والدوال السهمية؟')).toEqual(['array', 'arrow function']);
    expect(glossaryTerms('متغير Python بيئة')).toEqual(['variable']);
    expect(tokenizeQuery('كيف أستخدم مصفوفة في جافاسكربت؟')).toEqual(tokenizeQuery('array JavaScript'));
    const index = new CodeIndex([passage('array', 'Array basics', 'An array contains elements.')]);
    expect(index.search('مصفوفة')[0]?.passage.id).toBe('array');
    expect(index.search('غدًا الطقس')).toEqual([]);
  });

  it('ranks a documented symbol ahead of more frequent incidental occurrences', () => {
    const index = new CodeIndex([
      passage('alternative', 'Array.prototype.flatMap()', 'The related Array.flat method creates an array. Array.flat is another method.'),
      passage('exact', 'Array.prototype.flat()', 'Flattens nested subarrays up to the specified depth.'),
    ]);
    expect(index.search('How do I use Array.flat()?')[0]).toMatchObject({
      passage: { id: 'exact' }, exactSymbols: ['Array.flat'],
    });
    expect(index.search('flat()')[0]?.passage.id).toBe('exact');
    expect(index.search('Array.Flat()')[0]?.exactSymbols).toEqual([]);
    expect(index.search('Array.flatMap()', 1)).toHaveLength(1);
    expect(index.search('Array.flat()', 0)).toEqual([]);
  });

  it('folds one unambiguous qualified symbol while preserving literal spelling priority', () => {
    const documented = passage('promise', 'Promise.all()', 'Waits for all promises.');
    const index = new CodeIndex([documented]);
    const literal = index.search('Promise.all()')[0];
    const folded = index.search('promise.all()')[0];
    expect(literal.exactSymbols).toEqual(['Promise.all']);
    expect(literal.foldedSymbols).toEqual([]);
    expect(folded.exactSymbols).toEqual([]);
    expect(folded.foldedSymbols).toEqual(['Promise.all']);
    expect(folded.score).toBeLessThan(literal.score);
    expect(index.search('ALL()')).toEqual([]);

    const ambiguous = new CodeIndex([documented, passage('other', 'promise.ALL()', 'A case-sensitive method.')]);
    expect(ambiguous.search('promise.all()').every(hit => hit.foldedSymbols.length === 0)).toBe(true);
  });

  it('indexes exact declared identifiers and namespaces even when a symbol is a common word', () => {
    const index = new CodeIndex([
      { ...passage('getter', 'Accessor methods', 'An accessor gets a value.'), symbols: ['get'] },
      { ...passage('node', 'File system', 'The file system module.'), symbols: ['node:fs'] },
    ]);
    expect(index.search('Please use get()')[0]?.exactSymbols).toEqual(['get']);
    expect(index.search('node:fs')[0]?.exactSymbols).toEqual(['node:fs']);
  });

  it('ranks lexical matches with BM25 and leaves an unmatched query empty', () => {
    const index = new CodeIndex([
      passage('format', 'Formatting data', 'Indentation and whitespace can make serialized data more readable and easier to inspect.'),
      passage('indent', 'JSON indentation', 'Set indentation for JSON formatting.'),
    ]);
    expect(index.search('JSON indentation')[0]).toMatchObject({ passage: { id: 'indent' }, lexicalMatches: 2, queryTermCount: 2 });
    expect(index.search('JSON indentation', 1, item => item.id === 'format')[0]?.passage.id).toBe('format');
    expect(index.search('phonograph')).toEqual([]);
    expect(new CodeIndex([]).search('string')).toEqual([]);
  });

  it('keeps diagnostic signatures stable across values and stack frame locations', () => {
    const first = 'TypeError: Cannot read properties of undefined (reading \'map\')\n    at ArrayRenderer.render (/workspace/app.js:127:11)';
    const second = 'TypeError: Cannot read properties of undefined (reading \'filter\')\n    at ArrayRenderer.render (C:\\app.js:25:7)';
    expect(extractErrorSignatures(first)).toEqual(extractErrorSignatures(second));
    expect(extractErrorSignatures(first)).toContain('frame:ArrayRenderer.render');
    expect(extractErrorSignatures('File "/home/user/fixture.py", line 93, in load_config')).toEqual(['frame:load_config']);
    expect(extractErrorSignatures('error TS2322: Type mismatch')).toContain('code:TS2322');
    expect(extractErrorSignatures('SQLSTATE[23505]')).toContain('code:SQLSTATE:23505');
    expect(extractErrorSignatures("Cannot read property 'map' of undefined")).toContain('message:cannot read properties of undefined');
    expect(extractErrorSignatures('UnhandledPromiseRejectionWarning: TypeError: Assignment to constant variable.')).toContain(
      'diagnostic:typeerror:assignment to constant variable',
    );
    expect(extractErrorSignatures('RuntimeError: dictionary changed size during iteration')).toContain(
      'message:dictionary changed size during iteration',
    );
    expect(hasErrorMessage('bash: gist: command not found')).toBe(true);
    expect(hasErrorMessage('What is a TypeError?')).toBe(false);
  });

  it('uses a shared frame as evidence only when the query has no other diagnostic', () => {
    const indexed = 'TypeError: A value is invalid\n    at App.readConfig (/path/to/app.js:34:15)';
    const frame = '    at App.readConfig (/deployed/app.js:17:3)';
    const index = new CodeIndex([passage('config', 'Read configuration', 'Check the value.', indexed)]);
    expect(index.search(frame)[0]?.matchedError).toBe(true);
    expect(index.search('RangeError: A value is out of range\n' + frame)[0]?.matchedError).toBe(false);
  });

  it('distinguishes similar error cases using their message and diagnostic code', () => {
    const index = new CodeIndex([
      passage('undefined', 'TypeError: Cannot read properties of undefined', 'Check whether the value is undefined.'),
      passage('null', 'TypeError: Cannot read properties of null', 'Check whether the value is null.'),
      passage('address', 'EADDRINUSE', 'The requested address is already in use.'),
      passage('missing', 'ENOENT', 'The named file does not exist.'),
    ]);
    expect(index.search('TypeError: Cannot read properties of null (reading \'map\')')[0]).toMatchObject({
      passage: { id: 'null' }, matchedError: true,
    });
    expect(index.search('Error: listen EADDRINUSE: address already in use :::3000')[0]).toMatchObject({
      passage: { id: 'address' }, matchedError: true,
    });
    expect(index.search('TypeError: quantum adapter stalled').some(hit => hit.matchedError)).toBe(false);
  });
});
