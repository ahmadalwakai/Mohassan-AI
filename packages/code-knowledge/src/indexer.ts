import { extractErrorSignatures, extractSymbols, tokenize, tokenizeQuery } from './tokens.js';
import type { Passage } from './types.js';

interface Posting {
  document: number;
  frequency: number;
}

interface SymbolPosting {
  document: number;
  primary: boolean;
}

export interface SearchHit {
  passage: Passage;
  score: number;
  lexicalMatches: number;
  queryTermCount: number;
  exactSymbols: readonly string[];
  foldedSymbols: readonly string[];
  matchedError: boolean;
}

interface HitScore {
  score: number;
  lexicalMatches: number;
  exactSymbols: Set<string>;
  foldedSymbols: Set<string>;
  matchedError: boolean;
}

const TERM_SATURATION = 1.2;
const LENGTH_NORMALIZATION = 0.75;
const MAX_QUERY_CHARS = 16_384;

function addPosting<T>(index: Map<string, T[]>, key: string, posting: T): void {
  const postings = index.get(key);
  if (postings) postings.push(posting);
  else index.set(key, [posting]);
}

function symbolAliases(symbol: string): string[] {
  const aliases = [symbol, symbol.replace('.prototype.', '.'), symbol.replace('#', '.')];
  const member = symbol.split(/[.#:]+/u).at(-1);
  if (member) aliases.push(member);
  return aliases;
}

function passageSymbols(passage: Passage, code: string): Map<string, boolean> {
  const symbols = new Map<string, boolean>();
  for (const symbol of extractSymbols(passage.text + '\n' + code)) symbols.set(symbol, false);
  const headings = extractSymbols(passage.title);
  if (/^[A-Za-z_$][\w$]*$/u.test(passage.title)) headings.push(passage.title);
  const declared = (passage.symbols ?? []).flatMap(name => extractSymbols('\x60' + name + '\x60'));
  for (const symbol of [...headings, ...declared]) {
    for (const alias of symbolAliases(symbol)) symbols.set(alias, true);
  }
  return symbols;
}

function signatureWeight(signature: string): number {
  if (signature.startsWith('frame:')) return 5;
  if (signature.startsWith('message:')) return 10;
  return 16;
}

/** The corpus is indexed entirely in memory. Search only scores documents found in postings. */
export class CodeIndex {
  private readonly passages: readonly Passage[];
  private readonly terms = new Map<string, Posting[]>();
  private readonly symbols = new Map<string, SymbolPosting[]>();
  private readonly qualifiedSpellings = new Map<string, string | null>();
  private readonly errors = new Map<string, number[]>();
  private readonly lengths: number[] = [];
  private readonly averageLength: number;

  constructor(passages: readonly Passage[]) {
    this.passages = [...passages];
    let totalLength = 0;
    this.passages.forEach((passage, document) => {
      const code = passage.code.map(block => block.text).join('\n');
      const title = tokenize(passage.title);
      const terms = [...title, ...title, ...tokenize(passage.tags.join(' ') + '\n' + passage.text + '\n' + code)];
      totalLength += terms.length;
      this.lengths.push(terms.length);
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      for (const [term, frequency] of frequencies) addPosting(this.terms, term, { document, frequency });

      for (const [symbol, primary] of passageSymbols(passage, code)) {
        addPosting(this.symbols, symbol, { document, primary });
        if (primary && /[.:#]/u.test(symbol)) {
          const folded = symbol.toLowerCase();
          const previous = this.qualifiedSpellings.get(folded);
          this.qualifiedSpellings.set(folded, previous === undefined || previous === symbol ? symbol : null);
        }
      }
      for (const signature of extractErrorSignatures(passage.title + '\n' + passage.text + '\n' + code)) {
        addPosting(this.errors, signature, document);
      }
    });
    this.averageLength = totalLength / Math.max(1, this.passages.length) || 1;
  }

  search(query: string, limit = 8, accepts?: (passage: Passage) => boolean): readonly SearchHit[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const input = query.slice(0, MAX_QUERY_CHARS);
    const queryTerms = tokenizeQuery(input);
    const scores = new Map<number, HitScore>();
    const scoreFor = (document: number): HitScore => {
      const current = scores.get(document);
      if (current) return current;
      const created = {
        score: 0, lexicalMatches: 0, exactSymbols: new Set<string>(), foldedSymbols: new Set<string>(), matchedError: false,
      };
      scores.set(document, created);
      return created;
    };

    for (const term of queryTerms) {
      const postings = this.terms.get(term);
      if (!postings) continue;
      const inverseFrequency = Math.log(1 + (this.passages.length - postings.length + 0.5) / (postings.length + 0.5));
      for (const { document, frequency } of postings) {
        const normalization = 1 - LENGTH_NORMALIZATION + LENGTH_NORMALIZATION * this.lengths[document] / this.averageLength;
        const score = scoreFor(document);
        score.score += inverseFrequency * frequency * (TERM_SATURATION + 1) / (frequency + TERM_SATURATION * normalization);
        score.lexicalMatches++;
      }
    }
    const querySymbols = new Set(extractSymbols(input, true));
    for (const symbol of querySymbols) {
      for (const { document, primary } of this.symbols.get(symbol) ?? []) {
        const score = scoreFor(document);
        score.score += primary ? 8 : 1.5;
        if (primary) score.exactSymbols.add(symbol);
      }
      const canonical = this.qualifiedSpellings.get(symbol.toLowerCase());
      if (canonical && !querySymbols.has(canonical)) {
        for (const { document, primary } of this.symbols.get(canonical) ?? []) {
          if (!primary) continue;
          const score = scoreFor(document);
          if (!score.foldedSymbols.has(canonical)) score.score += 4;
          score.foldedSymbols.add(canonical);
        }
      }
    }
    const signatures = extractErrorSignatures(input);
    const hasDiagnostic = signatures.some(signature => !signature.startsWith('frame:'));
    for (const signature of signatures) {
      for (const document of this.errors.get(signature) ?? []) {
        const score = scoreFor(document);
        score.score += signatureWeight(signature);
        // A shared function name alone cannot corroborate a different diagnostic message.
        if (!hasDiagnostic || !signature.startsWith('frame:')) score.matchedError = true;
      }
    }

    return [...scores.entries()]
      .filter(([document]) => !accepts || accepts(this.passages[document]))
      .sort(([a, left], [b, right]) => right.score - left.score || a - b)
      .slice(0, limit)
      .map(([document, score]) => ({
        ...score,
        passage: this.passages[document],
        exactSymbols: [...score.exactSymbols],
        foldedSymbols: [...score.foldedSymbols],
        queryTermCount: queryTerms.length,
      }));
  }
}
