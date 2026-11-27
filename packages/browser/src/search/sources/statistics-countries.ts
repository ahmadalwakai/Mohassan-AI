import { statisticsCountryNames } from './statistics-countries-data.js';

interface Country {
  iso2: string;
  iso3: string;
  ar: string;
  en: string;
}

export interface StatisticsCountry extends Country {
  matched: string;
}

function tokens(text: string) {
  return Array.from(text.matchAll(/[\p{L}\p{M}\p{N}\u200c\u200d]+/gu), match => ({
    original: match[0],
    start: match.index,
    end: match.index + match[0].length,
    key: match[0].normalize('NFKD').toLowerCase().replace(/[\p{M}\u0640\u200c\u200d]/gu, '').replaceAll('ى', 'ي'),
  })).filter(token => token.key);
}

const aliases = new Map<string, Country | null>();
let longestAlias = 0;
for (const [iso2, iso3, ar, en, ...alternateNames] of statisticsCountryNames) {
  const country = { iso2, iso3, ar, en };
  for (const name of [ar, en, ...alternateNames]) {
    const words = tokens(name);
    const key = words.map(word => word.key).join(' ');
    const existing = aliases.get(key);
    aliases.set(key, existing === undefined || existing?.iso2 === iso2 ? country : null);
    longestAlias = Math.max(longestAlias, words.length);
  }
}

function firstWordKeys(word: string): string[] {
  const keys = [word];
  if (word.startsWith('ب') || word.startsWith('ل')) keys.push(word.slice(1));
  // The initial alif of the definite article is omitted after the preposition ل.
  if (word.startsWith('لل')) keys.push(`ا${word.slice(1)}`);
  return keys;
}

export function matchStatisticsCountry(text: string): StatisticsCountry | undefined {
  const words = tokens(text);
  let matched: StatisticsCountry | undefined;
  for (let start = 0; start < words.length; start++) {
    const word = words[start];
    const firstKeys = firstWordKeys(word.key);
    for (let end = Math.min(start + longestAlias, words.length); end > start; end--) {
      const rest = words.slice(start + 1, end).map(token => ` ${token.key}`).join('');
      // The CLDR alias US is also a common pronoun in lower case.
      if (word.key === 'us' && !rest && word.original !== 'US') continue;
      const country = firstKeys.map(key => aliases.get(key + rest)).find(Boolean);
      if (!country) continue;
      if (matched && matched.iso2 !== country.iso2) return undefined;
      matched ??= { ...country, matched: text.slice(word.start, words[end - 1].end) };
      start = end - 1;
      break;
    }
  }
  return matched;
}
