import type { SafeNetwork } from '../../network.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { parseQuranQuery } from './religion-quran-query.js';
import { religionSnippetLimit, wholeReligionQuote } from './religion-snippet.js';

const ORIGIN = 'https://hadeethenc.com';
// Official developer docs and usage terms, checked 2026-11-27.
const CONTRACT = `${ORIGIN}/en/home/developers`;
const HADITH_REQUEST = /\b(?:hadiths?|hadeeths?|ahadith|sunnah|bukhari|tirmidhi|fatwa|islamic ruling|halal|haram|(?:permissible|forbidden) in islam)\b|(?:^|[^\p{L}])(?:(?:ال)?(?:حديث|احاديث|فتوى)|السنة النبوية|هل (?:يجوز|يحل|يحرم)|ما (?:هو )?حكم|صحيح (?:البخاري|مسلم))(?=$|[^\p{L}])/iu;
const ARABIC_HADITH_PREFIX = /^\s*(?:ما (?:هو )?|اذكر |أذكر |أورد |ابحث عن )?(?:(?:نص|شرح|صحة|تخريج) )?(?:ال)?(?:حديث|[اأإآٱ]حاديث)(?:\s|[:：،])+/u;
const ARABIC_RULING_PREFIX = /^\s*(?:(?:ما (?:هو )?)?حكم(?: الشرع| الإسلام)?|هل (?:يجوز|يحل|يحرم)|(?:ال)?فتوى)(?:\s+(?:في|عن|حول|بشأن))?(?:\s|[:：،])+/u;
const ENGLISH_HADITH_PREFIX = /^\s*(?:(?:what (?:is|does)|show me|quote|find)\s+)?(?:the\s+)?(?:text of\s+(?:the\s+)?)?(?:hadith|hadeeth)(?:\s+(?:about|on))?(?:\s|:)+/iu;
const ENGLISH_RULING_PREFIX = /^\s*(?:(?:what is|give me)\s+(?:the\s+|a\s+)?)?(?:islamic ruling|fatwa)(?:\s+(?:about|on))?(?:\s|:)+/iu;
const ENGLISH_RULING_SUFFIX = /\s+(?:halal(?: or haram)?|haram(?: or halal)?|(?:permissible|forbidden) in islam)$/iu;

function hasHadithIntent(query: SearchQuery): boolean {
  const framing = query.question.replace(/["«“]([^"»”]+)["»”]/gu, ' ')
    .replace(/\p{M}/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/\s+/gu, ' ');
  return query.sites.includes('hadeethenc.com') || HADITH_REQUEST.test(framing);
}

function searchPhrase(query: SearchQuery): string {
  const question = query.retrievalQuestion;
  const quoted = /["«“]([^"»”]+)["»”]/u.exec(question)?.[1];
  if (quoted) return quoted.trim();
  const phrase = question.replace(/[?؟.!]+$/u, '').replace(/\s+/gu, ' ').trim();
  if (query.language === 'ar') {
    return phrase.replace(/\p{M}/gu, '').replace(ARABIC_HADITH_PREFIX, '').replace(ARABIC_RULING_PREFIX, '');
  }
  const subject = phrase.replace(ENGLISH_HADITH_PREFIX, '').replace(ENGLISH_RULING_PREFIX, '');
  if (ENGLISH_RULING_SUFFIX.test(subject)) {
    return subject.replace(/^(?:is|are)\s+/iu, '').replace(ENGLISH_RULING_SUFFIX, '');
  }
  return phrase === subject ? subject : subject.replace(/\s+say$/iu, '');
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function shortenMetadata(line: string, limit: number): string {
  if (line.length <= limit) return line;
  if (limit <= 1) return '';
  const lastLineEnd = line.lastIndexOf('\n', limit);
  if (lastLineEnd > 0) {
    const completeLines = line.slice(0, lastLineEnd).trimEnd();
    return completeLines.length < limit ? `${completeLines}…` : completeLines;
  }
  const prefix = line.slice(0, limit - 1);
  const wordEnd = prefix.search(/\s+\S*$/u);
  return wordEnd > 0 ? `${prefix.slice(0, wordEnd)}…` : '';
}

function formatSnippet(quote: string, narrator: string, grade: string, reference: string) {
  const fullSnippet = [quote, narrator, grade, reference].filter(Boolean).join('\n\n');
  if (fullSnippet.length <= religionSnippetLimit) return { snippet: fullSnippet, referenceInTitle: '' };

  const firstReference = reference.split('\n', 1)[0];
  const metadataBudget = religionSnippetLimit - quote.length - 2;
  const fitGrade = metadataBudget >= grade.length &&
    (firstReference.length > metadataBudget || firstReference.length + grade.length + 2 <= metadataBudget);
  const referenceBudget = metadataBudget - (fitGrade ? grade.length + 2 : 0);
  const shortReference = referenceBudget >= firstReference.length ? shortenMetadata(reference, referenceBudget) : '';
  const narratorBudget = referenceBudget - (shortReference ? shortReference.length + 2 : 0);
  const shortNarrator = shortenMetadata(narrator, narratorBudget);
  const snippet = [quote, shortNarrator, fitGrade ? grade : '', shortReference].filter(Boolean).join('\n\n');
  return { snippet, referenceInTitle: shortReference ? '' : shortenMetadata(firstReference, 120) };
}

export function hadithProvider(network: SafeNetwork, now: () => number): PlannedProvider {
  const robots = new RobotsPolicy(network, now);
  let cooldownUntil = 0;
  let searching = false;

  async function request(endpoint: 'search' | 'multiple', params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const cooldown = cooldownUntil - now();
    if (cooldown > 0) throw new SearchProviderFailure('rate_limited', cooldown);
    const url = new URL(`/api/v1/hadeeths/${endpoint}/`, ORIGIN);
    url.search = new URLSearchParams(params).toString();
    await robots.assertAllowed(url.href, signal);
    const response = await network.request(url.href, {
      signal,
      allowedOrigins: [ORIGIN],
      headers: { accept: 'application/json' },
    });
    const retryAfter = response.headers['retry-after'];
    if (response.status === 429 || (response.status === 503 && retryAfter !== undefined)) {
      const receivedAt = now();
      const retryMs = searchRetryAfter(retryAfter, receivedAt);
      cooldownUntil = Math.max(cooldownUntil, receivedAt + retryMs);
      throw new SearchProviderFailure(response.status === 429 ? 'rate_limited' : 'unavailable', retryMs);
    }
    if (response.status !== 200) throw new SearchProviderFailure('unavailable');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) as unknown;
    } catch {
      throw new SearchProviderFailure('invalid_response');
    }
  }

  async function search(query: SearchQuery, limit: number, signal: AbortSignal) {
    if (!hasHadithIntent(query) && parseQuranQuery(query.question)) return [];
    const phrase = searchPhrase(query);
    const count = Math.min(Math.floor(limit), 20);
    if (!phrase || !(count > 0)) return [];
    const found = await request('search', { phrase, language: query.language }, signal);
    // An unsuccessful search returns a suggestions object instead of an array of matches.
    if (!Array.isArray(found)) {
      if (record(found)?.suggestions !== undefined) return [];
      throw new SearchProviderFailure('invalid_response');
    }
    const titles = new Map<string, string>();
    for (const value of found) {
      const item = record(value);
      if (typeof item?.id === 'string' && /^\d+$/u.test(item.id) && present(item.title)) {
        if (!titles.has(item.id)) titles.set(item.id, item.title);
        if (titles.size >= count) break;
      }
    }
    if (titles.size === 0) return [];

    // Arabic details carry the full text with the narrator, the grading and the references.
    const details = await request('multiple', { language: 'ar', ids: [...titles.keys()].join(',') }, signal);
    if (!Array.isArray(details)) throw new SearchProviderFailure('invalid_response');
    const byId = new Map<string, Record<string, unknown>>();
    for (const value of details) {
      const item = record(value);
      if (typeof item?.id === 'string') byId.set(item.id, item);
    }
    const labels = query.language === 'ar'
      ? { narrator: 'الراوي', grade: 'درجة الحديث', reference: 'المراجع' }
      : { narrator: 'Narrator', grade: 'Grade', reference: 'References' };
    return [...titles].flatMap(([id, title]) => {
      const item = byId.get(id);
      if (!item || !present(item.hadeeth) || !present(item.grade) || !present(item.reference)) return [];
      const url = `${ORIGIN}/ar/browse/hadith/${id}`;
      const quote = wholeReligionQuote(item.hadeeth);
      const reference = `${labels.reference}: ${item.reference}`;
      if (!quote) {
        return [{
          title: `${query.language === 'ar' ? 'حديث' : 'Hadith'} (${id}) — HadeethEnc.com`,
          url,
          snippet: shortenMetadata(reference, religionSnippetLimit),
        }];
      }
      const narrator = present(item.hadeeth_intro) ? `${labels.narrator}: ${item.hadeeth_intro}` : '';
      const { snippet, referenceInTitle } = formatSnippet(quote, narrator, `${labels.grade}: ${item.grade}`, reference);
      return [{
        title: [referenceInTitle, `${title} — HadeethEnc.com`].filter(Boolean).join(' · '),
        url,
        snippet,
      }];
    });
  }

  return {
    name: 'HadeethEnc.com',
    coverage: 'scholarly',
    accessBasis: 'documented_api',
    planned: {
      domains: ['religion'],
      languages: ['ar', 'en'],
      access: 'documented_api',
      contract: { url: CONTRACT, checked: '2026-11-27' },
      hosts: ['hadeethenc.com'],
    },
    supports: hasHadithIntent,
    cooldownMs: () => Math.max(0, cooldownUntil - now()),
    async search(query, limit, signal) {
      signal.throwIfAborted();
      if (searching) throw new SearchProviderFailure('rate_limited');
      searching = true;
      try {
        return await search(query, limit, signal);
      } finally {
        searching = false;
      }
    },
  };
}
