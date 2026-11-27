import type { SafeNetwork } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { SearchProviderFailure, searchRetryAfter } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { matchesSurahName, normalizeQuranText, parseQuranQuery } from './religion-quran-query.js';

// API paths and editions checked 2026-11-27: https://alquran.cloud/api
// https://api.alquran.cloud/v1/documentation/openapi/yaml
// https://api.alquran.cloud/v1/edition/format/text
const origin = 'https://api.alquran.cloud';
const uthmani = 'quran-uthmani';
const simple = 'quran-simple';
const translation = 'en.sahih';
const commentary = 'ar.muyassar';

const cacheMs = 24 * 60 * 60 * 1000;
const maxResponseBytes = 4_000_000;
type Gate = { active: boolean; starts: number[]; retryAt: number };
const gates = new WeakMap<() => number, Gate>();

type Language = 'ar' | 'en';
type Surah = { number: number; name: string; englishName: string; englishNameTranslation: string };
type Edition = { identifier: string; name: string; englishName: string };
type Verse = { surah: Surah; ayah: number; text: string; edition: Edition };
type IndexedVerse = { verse: Verse; searchText: string };

const invalid = (): never => { throw new SearchProviderFailure('invalid_response'); };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : invalid();
const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();

function readSurah(value: unknown): Surah {
  const row = object(value);
  return { number: positive(row.number), name: text(row.name), englishName: text(row.englishName),
    englishNameTranslation: text(row.englishNameTranslation) };
}
function readEdition(value: unknown, allowed: readonly string[]): Edition {
  const row = object(value);
  const identifier = text(row.identifier);
  // Search results omit the format field present on verse and chapter responses.
  if (!allowed.includes(identifier) || row.format !== undefined && row.format !== 'text') return invalid();
  return { identifier, name: text(row.name), englishName: text(row.englishName) };
}
function readVerse(value: unknown, allowed: readonly string[], surah?: Surah, edition?: Edition): Verse {
  const row = object(value);
  return { surah: surah ?? readSurah(row.surah), ayah: positive(row.numberInSurah), text: text(row.text),
    edition: edition ?? readEdition(row.edition, allowed) };
}

function preferredEditions(language: Language, tafsir: boolean): string[] {
  if (tafsir) return [commentary, uthmani];
  return language === 'en' ? [translation, uthmani] : [uthmani];
}
function verseHit(versions: Verse[], language: Language, label?: string): SearchHit {
  const [main, original] = versions;
  const reference = `${main.surah.number}:${main.ayah}`;
  const surahTitle = language === 'ar' ? main.surah.name : main.surah.englishName;
  const editionTitle = (edition: Edition) => language === 'ar' ? edition.name : edition.englishName;
  const edition = editionTitle(main.edition);
  const kind = main.edition.identifier === commentary
    ? (language === 'ar' ? 'التفسير' : 'Tafsir')
    : main.edition.identifier === translation
      ? (language === 'ar' ? 'ترجمة إنجليزية' : 'English translation')
      : undefined;
  const snippet = original && kind
    ? `${language === 'ar' ? 'نص القرآن' : 'Qur’an text'}\n${original.text}\n\n${kind} · ${edition}\n${main.text}`
    : main.text;
  return {
    title: `${label ? `${label} · ` : ''}${surahTitle} (${reference}) · ${kind ? `${kind} · ` : ''}${edition} · AlQuran Cloud`,
    url: `${origin}/v1/ayah/${reference}/${original
      ? `editions/${original.edition.identifier},${main.edition.identifier}`
      : main.edition.identifier}`,
    snippet,
  };
}

export function quranProvider(network: SafeNetwork, now: () => number): PlannedProvider {
  const robots = new RobotsPolicy(network, now);
  let gate = gates.get(now);
  if (!gate) {
    gate = { active: false, starts: [], retryAt: 0 };
    gates.set(now, gate);
  }
  const admission = gate;
  let catalog: { until: number; rows: Surah[] } | undefined;
  let corpus: { until: number; rows: IndexedVerse[] } | undefined;

  async function api(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const started = now();
    admission.starts = admission.starts.filter(time => time > started - 1000);
    if (admission.retryAt > started) throw new SearchProviderFailure('rate_limited', admission.retryAt - started);
    // The API advertised 12 requests per second on 2026-11-27. Leave room for robots and network jitter.
    if (admission.active || admission.starts.length >= 8) {
      throw new SearchProviderFailure('rate_limited', admission.active ? 1000 : admission.starts[0] + 1000 - started);
    }
    admission.active = true;
    const url = `${origin}/v1/${path}`;
    try {
      await robots.assertAllowed(url, signal, network.policy.userAgent?.split('/')[0].split(/\s/, 1)[0]);
      admission.starts.push(now());
      const response = await network.request(url, {
        allowedOrigins: [origin], headers: { accept: 'application/json' }, maxBytes: maxResponseBytes, signal,
      });
      signal.throwIfAborted();
      const retry = response.headers['retry-after'];
      if (response.status === 429 || (response.status === 503 && retry !== undefined)) {
        const received = now();
        const delay = searchRetryAfter(retry, received);
        admission.retryAt = received + delay;
        throw new SearchProviderFailure(response.status === 429 ? 'rate_limited' : 'unavailable', delay);
      }
      if (![200, 404].includes(response.status)) throw new SearchProviderFailure('unavailable');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) return invalid();

      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
      catch { return invalid(); }
      const document = object(payload);
      if (document.code !== response.status) return invalid();
      if (response.status === 404) {
        // Documented no-match response (search) or a reference absent from this edition.
        if (['NOT FOUND', 'RESOURCE_NOT_FOUND'].includes(String(document.status))) return undefined;
        return invalid();
      }
      if (!Object.hasOwn(document, 'data')) return invalid();
      return document.data;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SearchProviderFailure) throw error;
      throw new SearchProviderFailure('unavailable');
    } finally {
      admission.active = false;
    }
  }

  async function verse(surah: number, ayah: number, editions: string[], language: Language, signal: AbortSignal, label?: string) {
    const result = await api(`ayah/${surah}:${ayah}/${editionPath(editions)}`, signal);
    if (result === undefined) return [];
    const versions = (editions.length === 1 ? [result] : array(result)).map(value => readVerse(value, editions));
    if (versions.some(one => one.surah.number !== surah || one.ayah !== ayah)) return invalid();
    const ordered = orderEditions(versions, editions);
    return [verseHit(ordered, language, label)];
  }

  async function chapter(surah: number, editions: string[], language: Language, limit: number, signal: AbortSignal) {
    const result = await api(`surah/${surah}/${editionPath(editions)}?offset=0&limit=${limit}`, signal);
    if (result === undefined) return [];
    const chapters = (editions.length === 1 ? [result] : array(result)).map(value => {
      const row = object(value);
      const info = readSurah(row);
      if (info.number !== surah) return invalid();
      const edition = readEdition(row.edition, editions);
      return { edition, verses: array(row.ayahs).map(value => readVerse(value, editions, info, edition)) };
    });
    const [main, original] = orderEditions(chapters, editions);
    if (original && original.verses.length !== main.verses.length) return invalid();
    return main.verses.slice(0, limit).map((one, index) => {
      if (one.ayah !== index + 1 || original && original.verses[index].ayah !== one.ayah) return invalid();
      return verseHit(original ? [one, original.verses[index]] : [one], language);
    });
  }

  async function surahs(signal: AbortSignal) {
    if (catalog && catalog.until > now()) return catalog.rows;
    const rows = array(await api('surah', signal)).map(readSurah);
    catalog = { until: now() + cacheMs, rows };
    return rows;
  }

  async function arabicMatches(words: string, limit: number, signal: AbortSignal) {
    const phrase = normalizeQuranText(words);
    if (!phrase) return [];
    if (!corpus || corpus.until <= now()) {
      const document = object(await api(`quran/${simple}`, signal));
      const edition = readEdition(document.edition, [simple]);
      const verses = array(document.surahs).flatMap(value => {
        const row = object(value);
        const surah = readSurah(row);
        return array(row.ayahs).map(value => readVerse(value, [simple], surah, edition));
      });
      // In this edition the source prefixes most surahs' first ayah with the basmala.
      // Exclude that prefix from matching while preserving the API's display text.
      const opening = verses.find(verse => verse.surah.number === 1 && verse.ayah === 1);
      const preface = opening ? `${normalizeQuranText(opening.text)} ` : '';
      const rows = verses.map(verse => {
        let matchText = normalizeQuranText(verse.text);
        if (preface && verse.surah.number !== 1 && verse.ayah === 1 && matchText.startsWith(preface)) {
          matchText = matchText.slice(preface.length);
        }
        return { verse, searchText: ` ${matchText} ` };
      });
      corpus = { until: now() + cacheMs, rows };
    }
    const matches: Verse[] = [];
    for (const row of corpus.rows) {
      if (row.searchText.includes(` ${phrase} `)) matches.push(row.verse);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async function englishMatches(words: string, limit: number, signal: AbortSignal) {
    const word = encodeURIComponent(words);
    if (!word || /^\.{1,2}$/.test(word) || word.length > 2000) return [];
    const result = await api(`search/${word}/all/${translation}?limit=${limit}`, signal);
    if (result === undefined) return [];
    return array(object(result).matches).slice(0, limit).map(item => readVerse(item, [translation]));
  }

  return {
    name: 'AlQuran Cloud',
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: { domains: ['religion'], languages: ['ar', 'en'], access: 'documented_api',
      contract: { url: 'https://alquran.cloud/terms-and-conditions', checked: '2026-11-27' },
      hosts: ['alquran.cloud', 'api.alquran.cloud'] },
    supports: query => parseQuranQuery(query.question,
      query.sites.some(site => site === 'alquran.cloud' || site === 'api.alquran.cloud')) !== undefined,
    cooldownMs: () => Math.max(0, admission.retryAt - now()),
    async search(query, requestedLimit, signal) {
      signal.throwIfAborted();
      const target = parseQuranQuery(query.question, true);
      if (!target) return [];
      const limit = Math.max(1, Math.min(20, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 5));
      const { language, tafsir } = target;
      const editions = preferredEditions(language, tafsir);
      if (target.kind === 'reference') return verse(target.surah, target.ayah, editions, language, signal, target.label);
      if (target.kind === 'name') {
        if (/^\d+$/u.test(target.name) && target.ayah === undefined) {
          return chapter(Number(target.name), editions, language, limit, signal);
        }
        const surah = (await surahs(signal)).find(info => matchesSurahName(target.name, info));
        if (!surah) return [];
        return target.ayah === undefined ? chapter(surah.number, editions, language, limit, signal)
          : verse(surah.number, target.ayah, editions, language, signal);
      }
      if (target.tryName) {
        const surah = (await surahs(signal)).find(info => matchesSurahName(target.words, info));
        if (surah) return chapter(surah.number, editions, language, limit, signal);
      }
      // Tafsir by phrase uses the first few matching verse references rather than searching commentary wording.
      const matchLimit = tafsir ? Math.min(limit, 3) : limit;
      const matches = /\p{Script=Arabic}/u.test(target.words)
        ? await arabicMatches(target.words, matchLimit, signal)
        : await englishMatches(target.words, matchLimit, signal);
      if (!tafsir) return matches.map(match => verseHit([match], language));
      const hits: SearchHit[] = [];
      for (const match of matches) hits.push(...await verse(match.surah.number, match.ayah, editions, language, signal));
      return hits;
    },
  };
}

function editionPath(editions: string[]): string {
  return editions.length === 1 ? editions[0] : `editions/${[...editions].reverse().join(',')}`;
}

function orderEditions<T extends { edition: Edition }>(items: T[], editionIds: readonly string[]): T[] {
  if (items.length !== editionIds.length) return invalid();
  return editionIds.map(id => items.find(item => item.edition.identifier === id) ?? invalid());
}
