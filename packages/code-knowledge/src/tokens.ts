import { englishStem, STEM_STOP_WORDS } from '@mohassan/skills';
import { glossaryTerms } from './glossary.js';

const LATIN_WORD = /[a-z0-9_$]+/giu;
const IDENTIFIER = /(?<![\p{L}\p{N}_$./#-])[a-z_$][a-z0-9_$]*(?:(?:[.#:]|::)[a-z_$][a-z0-9_$]*)*(?![\p{L}\p{N}_$])/giu;
const QUESTION_WORDS = new Set(['use', 'using', 'difference', 'vs', 'versus', 'example', 'question', 'explain', 'fix', 'getting', 'solve', 'problem']);

const OPERATOR_PATTERN = '!==|===|==|!=|\\?\\?|\\?\\.|&&|\\|\\||:=|=>|<>|<=|>=';
const OPERATORS = new RegExp(OPERATOR_PATTERN, 'gu');
const ONE_OPERATOR = new RegExp('^(?:' + OPERATOR_PATTERN + ')$', 'u');

export function isOperatorToken(term: string): boolean {
  return ONE_OPERATOR.test(term);
}

export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/gi)
    .filter(Boolean)
    .map(part => part.toLowerCase());
}

export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const normalized = text.normalize('NFKC');
  for (const [word] of normalized.matchAll(LATIN_WORD)) {
    const parts = new Set([word.toLowerCase(), ...splitIdentifier(word)]);
    for (const part of parts) {
      if (part.length < 2 || /^\d+$/.test(part) || STEM_STOP_WORDS.has(part) || QUESTION_WORDS.has(part)) continue;
      terms.push(/^[a-z]+$/.test(part) ? englishStem(part) : part);
    }
  }
  for (const [operator] of normalized.matchAll(OPERATORS)) terms.push(operator);
  return terms;
}

export function tokenizeQuery(text: string): string[] {
  return [...new Set(tokenize([text, ...glossaryTerms(text)].join(' ')))];
}

const CODE_MARKER = '\x60';

/** Preserve identifier case and boundaries, including dotted paths and Python's snake_case. */
export function extractSymbols(text: string, includeOrdinaryWords = false): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const symbol = match[0];
    const end = match.index + symbol.length;
    const explicit = text[match.index - 1] === CODE_MARKER || /^\s*\(/.test(text.slice(end, end + 12));
    const shaped = /[.#:_$]|[a-z][A-Z]/.test(symbol);
    const plain = includeOrdinaryWords && !STEM_STOP_WORDS.has(symbol.toLowerCase()) && !QUESTION_WORDS.has(symbol.toLowerCase());
    if (explicit || shaped || plain) found.add(symbol);
  }
  return [...found];
}

const NAMED_DIAGNOSTIC = /\b([A-Za-z]*Error|[A-Za-z]*Exception|[A-Za-z]*Warning)[ \t]*:[ \t]*/g;
const DIAGNOSTIC_CODES = /\b(?:ERR_[A-Z][A-Z_0-9]+|TS\d{4,5}|FST_ERR_[A-Z][A-Z_0-9]+|EACCES|EADDRINUSE|ECONNABORTED|ECONNREFUSED|ECONNRESET|EEXIST|EISDIR|EMFILE|ENOENT|ENOSPC|ENOTDIR|ENOTFOUND|EPIPE|EPERM|ETIMEDOUT)\b/g;
const LEGACY_PROPERTY_ERROR = /\bcannot read property\s+['"\x60][^'"\x60\r\n]+['"\x60]\s+of (null|undefined)\b/gi;
const SQLSTATE = /\bSQLSTATE\b\W{0,5}([0-9A-Z]{5})\b/gi;
const STABLE_MESSAGES = [
  /\bcannot read propert(?:y|ies) of (?:null|undefined)\b/gi,
  /\bcannot set properties of (?:null|undefined)\b/gi,
  /\bis not a function\b/gi,
  /\bcannot find module\b/gi,
  /\bmodule not found\b/gi,
  /\bfailed to fetch\b/gi,
  /\bcommand not found\b/gi,
  /\bpermission denied\b/gi,
  /\bno such file or directory\b/gi,
  /\bsyntax error near unexpected token\b/gi,
  /\bunbound variable\b/gi,
  /\b(division|modulo) by zero\b/gi,
  /\blist index out of range\b/gi,
  /\bassignment to constant variable\b/gi,
  /\bdictionary changed size during iteration\b/gi,
  /\bno module named\b/gi,
  /\bmaximum recursion depth exceeded\b/gi,
  /\bduplicate key value violates unique constraint\b/gi,
  /\bviolates not-null constraint\b/gi,
] as const;

const V8_FRAME = /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w.$]*)\s+\((?:[^)\n]+):\d+:\d+\)/gm;
const PYTHON_FRAME = /^\s*File\s+"[^"\n]+",\s*line\s+\d+,\s*in\s+([A-Za-z_]\w*)/gm;
const GENERIC_FRAMES = new Set(['main', 'run', 'start', 'Object.main', 'Module._compile', 'Module._load', 'Module.load']);

function diagnosticDetail(detail: string): string {
  return detail
    .replace(/(['"\x60])[^'"\x60\r\n]*\1/g, ' <value> ')
    .replace(/\b\d+\b/g, ' <n> ')
    .replace(/[\s.?!]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function extractErrorSignatures(text: string): string[] {
  const signatures = new Set<string>();
  for (const [code] of text.matchAll(DIAGNOSTIC_CODES)) signatures.add('code:' + code);
  for (const [, code] of text.matchAll(SQLSTATE)) signatures.add('code:SQLSTATE:' + code.toUpperCase());
  for (const { 0: header, 1: name, index } of text.matchAll(NAMED_DIAGNOSTIC)) {
    const start = index + header.length;
    const detail = text.slice(start, start + 300).split(/[\r\n]/u, 1)[0];
    const normalized = diagnosticDetail(detail);
    if (normalized) signatures.add('diagnostic:' + name.toLowerCase() + ':' + normalized);
  }
  for (const [, value] of text.matchAll(LEGACY_PROPERTY_ERROR)) {
    signatures.add('message:cannot read properties of ' + value.toLowerCase());
  }
  for (const pattern of STABLE_MESSAGES) {
    for (const [message] of text.matchAll(pattern)) signatures.add('message:' + message.toLowerCase());
  }
  for (const framePattern of [V8_FRAME, PYTHON_FRAME]) {
    for (const [, frame] of text.matchAll(framePattern)) {
      if (!GENERIC_FRAMES.has(frame)) signatures.add('frame:' + frame);
    }
  }
  return [...signatures];
}

export function hasErrorMessage(text: string): boolean {
  return extractErrorSignatures(text).length > 0 || /(?:^|\n)\s*Traceback \(most recent call last\):/u.test(text);
}
