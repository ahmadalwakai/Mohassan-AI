const RAW_LIMIT = 2048;
const TEXT_LIMIT = 512;

const LETTER_FORMS: Readonly<Record<string, string>> = {
  أ: 'ا', إ: 'ا', آ: 'ا', ٱ: 'ا', ى: 'ي', ی: 'ي', ئ: 'ي', ؤ: 'و', ة: 'ه', ک: 'ك',
  '’': "'", '−': '-', '؟': '?', '٪': '%', '٫': '.',
};
const ARABIZI_LETTERS: Readonly<Record<string, string>> = {
  a: '', b: 'ب', c: 'ك', d: 'د', e: '', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل',
  m: 'م', n: 'ن', o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس',
  y: 'ي', z: 'ز', 2: 'ء', 3: 'ع', 5: 'خ', 6: 'ط', 7: 'ح', 8: 'ق', 9: 'ص', "'": '',
};
const ARABIZI_PAIRS: Readonly<Record<string, string>> = {
  aa: 'ا', ay: 'اي', ee: 'ي', gh: 'غ', kh: 'خ', oo: 'و', ou: 'و', sh: 'ش', th: 'ث',
  "3'": 'غ', "6'": 'ظ', "7'": 'خ', "9'": 'ض',
};
const TOKENS = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*'?|[!?+*/=:%@.\-]/gu;
const SUPPLEMENTARY = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function prefixByCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  for (const character of text) {
    end += character.length;
    if (--limit === 0) return text.slice(0, end);
  }
  return text;
}

function foldArabizi(word: string): string {
  // Require a conventional letter digit adjacent to a vowel and at least three Latin letters.
  // Standalone numbers, multi-digit runs and short identifiers like h2o stay as written.
  if (!/^[a-z2356789']+$/u.test(word) || /[0-9]{2}/u.test(word) ||
      !/[aeiou][2356789]|[2356789]'?[aeiou]/u.test(word) || (word.match(/[a-z]/gu)?.length ?? 0) < 3) {
    return word.endsWith("'") ? word.slice(0, -1) : word;
  }
  let folded = '';
  for (let index = 0; index < word.length;) {
    const pair = ARABIZI_PAIRS[word.slice(index, index + 2)];
    if (pair !== undefined) {
      folded += pair;
      index += 2;
    } else {
      const letter = word[index];
      folded += letter === 'a' && index === 0 ? 'ا' : ARABIZI_LETTERS[letter];
      index++;
    }
  }
  return folded;
}

/** Feature normalization only. Keep this representation in sync with training/features.py. */
export function normalize(text: string): string {
  const folded = prefixByCodePoints(text, RAW_LIMIT).normalize('NFKC').toLowerCase()
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/[أإآٱىیئؤةک’−؟٪٫٠-٩۰-۹]/gu, character =>
      LETTER_FORMS[character] ?? String(character.charCodeAt(0) % 16));
  const tokens: string[] = [];
  let remaining = TEXT_LIMIT;
  for (const [token] of folded.matchAll(TOKENS)) {
    if (tokens.length) remaining--;
    if (remaining <= 0) break;
    const word = /[2356789]/u.test(token) ? foldArabizi(token) : token.replace(/'$/u, '');
    tokens.push(prefixByCodePoints(word, remaining));
    remaining -= word.length - (word.match(SUPPLEMENTARY)?.length ?? 0);
  }
  return tokens.join(' ');
}

const HASH_START = 0x811c9dc5;
const HASH_PRIME = 0x01000193;
const SPACE = 32;

function appendHash(hash: number, codePoint: number): number {
  return Math.imul(hash ^ codePoint, HASH_PRIME) >>> 0;
}

function hashWord(hash: number, word: string): number {
  for (const character of word) hash = appendHash(hash, character.codePointAt(0)!);
  return hash;
}

function addNgrams(ids: Set<number>, text: string, words: string[], size: number, charNamespace: number): void {
  const characters = Array.from(`^${text}$`, character => character.codePointAt(0)!);
  const charSeed = appendHash(HASH_START, charNamespace);
  for (let start = 0; start + 1 < characters.length; start++) {
    let hash = appendHash(charSeed, characters[start]);
    const limit = Math.min(start + 5, characters.length);
    for (let end = start + 1; end < limit; end++) {
      hash = appendHash(hash, characters[end]);
      ids.add(hash % size);
    }
  }

  const wordSeed = appendHash(HASH_START, charNamespace + 1);
  let previousHash: number | undefined;
  for (const word of words) {
    const hash = hashWord(wordSeed, word);
    ids.add(hash % size);
    if (previousHash !== undefined) ids.add(hashWord(appendHash(previousHash, SPACE), word) % size);
    previousHash = hash;
  }
}

/** Extract current features once when the caller also needs the conversation features. */
export function featureSets(text: string, size: number, previousText?: string): { current: number[]; withContext: number[] } {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Feature space must be a positive integer');
  const current = normalize(text);
  if (!current) return { current: [], withContext: [] };
  const ids = new Set<number>();
  const words = current.split(' ');
  addNgrams(ids, current, words, size, 1);
  const currentIndices = [...ids];
  const previous = previousText ? normalize(previousText) : '';
  if (!previous) return { current: currentIndices, withContext: currentIndices };
  const previousWords = previous.split(' ');
  addNgrams(ids, previous, previousWords, size, 3);
  const currentTerms = new Set(words.filter(word => /^[\p{L}\p{N}]/u.test(word)));
  const previousTerms = new Set(previousWords.filter(word => /^[\p{L}\p{N}]/u.test(word)));
  const possible = Math.min(currentTerms.size, previousTerms.size);
  if (possible > 0) {
    let shared = 0;
    for (const term of currentTerms) if (previousTerms.has(term)) shared++;
    const overlap = shared === 0 ? 0 : shared * 2 < possible ? 1 : 2;
    ids.add(appendHash(appendHash(HASH_START, 5), overlap) % size);
  }
  return { current: currentIndices, withContext: [...ids] };
}

/** Binary character 2–5 and word 1–2 features in deterministic traversal order. */
export function featureIndices(text: string, size: number, previousText?: string): number[] {
  return featureSets(text, size, previousText).withContext;
}
