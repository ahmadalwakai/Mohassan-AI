import { normalizeLookupKey } from './normalize.ts';
import type { Language } from './types.ts';

interface NameForm {
  key: string;
  phones: string;
}

const ARABIC_PHONES: Readonly<Record<string, string>> = {
  ا: 'a', ب: 'b', ت: 't', ث: 't', ج: 'j', ح: 'h', خ: 'ḫ', د: 'd', ذ: 'd', ر: 'r',
  ز: 'z', س: 's', ش: 'š', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: '', غ: 'g', ف: 'f',
  ق: 'k', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ء: '', پ: 'b', چ: 'š', ژ: 'z', گ: 'j',
  ک: 'k', ی: 'i', ڤ: 'f',
};

const LATIN_DIGRAPHS: Readonly<Record<string, string>> = {
  sh: 'š', ch: 'š', kh: 'ḫ', gh: 'g', ph: 'f', th: 't', dh: 'd', zh: 'z',
};

const LATIN_PHONES: Readonly<Record<string, string>> = {
  c: 'k', e: 'i', g: 'j', o: 'u', p: 'b', q: 'k', v: 'f', x: 'ks',
};

function arabicPhones(word: string): string {
  return [...word].map((letter, index) => {
    if (letter === 'و') return index === 0 ? 'w' : 'u';
    if (letter === 'ي') return index === 0 ? 'y' : 'i';
    return ARABIC_PHONES[letter] ?? letter;
  }).join('');
}

function latinPhones(word: string): string {
  return word.replace(/sh|ch|kh|gh|ph|th|dh|zh|c(?=[eiy])|[a-z]/gu, (letters, index: number) => {
    if (letters === 'c' && /[eiy]/u.test(word[index + 1] ?? '')) return 's';
    if (letters === 'w') return index === 0 ? 'w' : 'u';
    if (letters === 'y') return index === 0 ? 'y' : 'i';
    return LATIN_DIGRAPHS[letters] ?? LATIN_PHONES[letters] ?? letters;
  });
}

function withoutArticle(key: string, script: Language): string {
  if (script === 'en') return key.replace(/(?:^| )(?:(?:al|el) )/gu, ' ').trim();
  return key.split(' ').map(word => word.startsWith('ال') && word.length > 4 ? word.slice(2) : word).join(' ');
}

export function transliterationForms(text: string): { script: Language; forms: NameForm[] } | undefined {
  const key = normalizeLookupKey(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  const script = /^[a-z0-9 ]+$/u.test(key) && /[a-z]/u.test(key) ? 'en' :
    /^[\p{Script=Arabic}0-9 ]+$/u.test(key) && /\p{Script=Arabic}/u.test(key) ? 'ar' : undefined;
  if (!script) return undefined;
  const spellings = new Set([key, withoutArticle(key, script)]);
  if (script === 'ar' && text.includes('ة')) {
    const finalVowel = normalizeLookupKey(text.replace(/ة/gu, 'ا'));
    spellings.add(finalVowel);
    spellings.add(withoutArticle(finalVowel, script));
  }
  const phonesOf = script === 'ar' ? arabicPhones : latinPhones;
  const forms = [...spellings].flatMap(spelling => {
    const phones = spelling.split(' ').map(phonesOf).join('').replace(/([a-zšḫ])\1+/gu, '$1');
    const consonants = phones.replace(/[aiu]/gu, '').replace(/([a-zšḫ])\1+/gu, '$1');
    const consonantCount = consonants.replace(/[0-9]/gu, '').length;
    return consonantCount >= 2 ? [{ key: consonants, phones }] : [];
  });
  return forms.length ? { script, forms } : undefined;
}

/** The Latin spelling may supply short vowels omitted by Arabic orthography. */
export function compatibleTransliteration(arabic: string, latin: string): boolean {
  const consonantCount = arabic.replace(/[aiu0-9]/gu, '').replace(/(.)\1+/gu, '$1').length;
  if (consonantCount < 3 && !/[aiu]/u.test(arabic)) return false;
  let index = 0;
  for (const phone of latin) if (arabic[index] === phone) index++;
  return index === arabic.length;
}

const ROMAN_PHONES: Readonly<Record<string, string>> = { g: 'gh', š: 'sh', ḫ: 'kh' };
const ARABIC_LETTERS: Readonly<Record<string, string>> = {
  a: 'ا', b: 'ب', d: 'د', f: 'ف', g: 'غ', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن',
  r: 'ر', s: 'س', t: 'ت', u: 'و', w: 'و', y: 'ي', z: 'ز', š: 'ش', ḫ: 'خ',
};

/** Point lookups for stores built before the cross-script index existed. */
export function reverseTransliterationKeys(name: NonNullable<ReturnType<typeof transliterationForms>>): string[] {
  const letters = name.script === 'ar' ? ROMAN_PHONES : ARABIC_LETTERS;
  return name.forms.map(form => [...form.phones].map(phone => letters[phone] ?? phone).join(''));
}
