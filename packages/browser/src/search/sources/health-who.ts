import { SearchProviderFailure } from '../providers.js';
import type { SearchQuery } from '../providers.js';
import type { PlannedProvider } from '../source-plan.js';
import { englishHealthTopic } from './health-topics.js';
import { healthEnglishQuery, healthLimit, healthPlain, isHealthQuestion, type HealthHit, type HealthRequester } from './health-utils.js';

// Official OData interface and license for public-health use, checked 2026-11-27.
// https://www.who.int/data/gho/info/gho-odata-api
// https://ghoapi.azureedge.net/robots.txt returned 404 on the check date.
const TERMS = 'https://www.who.int/about/policies/publishing/data-policy/terms-and-conditions';
const GHO_API = 'https://ghoapi.azureedge.net/api/';
const GHO_HOST = new URL(GHO_API).hostname;
const WHO = 'World Health Organization';
const INDICATOR_CODE = /^[a-z0-9_-]{1,80}$/iu;

const statsRequest = /\b(?:life expectancy|mortality|morbidity|incidence|prevalence|health (?:data|indicators?|stat(?:istic)?s))\b|(?:احصا[ءئ]يات|إحصا[ءئ]يات|وفيات|معدل الانتشار|معدل الاصابة|معدل الإصابة)/iu;
const statsDetails = /\b(?:rates?|cases|data|deaths|figures|indicators?|percent(?:age)?|stat(?:istic)?s)\b|(?:معدل|نسبة|عدد|بيانات|إحصاء|احصاء)/iu;
const queryWords = new Set('a an and are at by data find for from gho give health how in indicator indicators is latest me of on please show stat statistics stats the to up what who worldwide global'.split(' '));
// WHO's matching diabetes fact sheets use prevalence / انتشار, checked 2026-11-27.
// https://www.who.int/news-room/fact-sheets/detail/diabetes
// https://www.who.int/ar/news-room/fact-sheets/detail/diabetes
const arabicStatsTerms = [{ pattern: /معدل\s+(?:ال)?انتشار/u, english: 'prevalence' }];

function indicatorsFilter(query: SearchQuery): string | undefined {
  const english = healthEnglishQuery(query);
  if (!english) return undefined;
  const statsTerms = query.language === 'ar' ? arabicStatsTerms.filter(({ pattern }) =>
    pattern.test(query.question.replace(/\p{M}/gu, ''))).map(term => term.english) : [];
  const topicWords = english.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = [...new Set([...topicWords, ...statsTerms])]
    .filter(word => !queryWords.has(word)).slice(0, 12);
  return words.length ? words.map(word => `contains(tolower(IndicatorName),'${word}')`).join(' and ') : undefined;
}

function indicatorHits(body: string, limit: number, date: string): HealthHit[] {
  let indicators: unknown;
  try {
    indicators = (JSON.parse(body) as { value?: unknown } | null)?.value;
  } catch {
    throw new SearchProviderFailure('invalid_response');
  }
  if (!Array.isArray(indicators)) throw new SearchProviderFailure('invalid_response');

  const hits: HealthHit[] = [];
  for (const entry of indicators) {
    if (hits.length >= limit) break;
    const code: unknown = entry?.IndicatorCode;
    const name: unknown = entry?.IndicatorName;
    if (typeof code !== 'string' || typeof name !== 'string' || !INDICATOR_CODE.test(code)) {
      throw new SearchProviderFailure('invalid_response');
    }
    const title = healthPlain(name, 240);
    if (!title) throw new SearchProviderFailure('invalid_response');
    // The catalog describes the indicator and links to its observations. The
    // observation period is distinct from the catalog's access date.
    hits.push({
      url: new URL(code, GHO_API).href,
      title,
      snippet: `WHO Global Health Observatory indicator ${code}. Accessed ${date}.`,
      sourceOrganization: WHO,
    });
  }
  return hits;
}

export function createWhoGhoProvider(request: HealthRequester, now: () => number): PlannedProvider {
  return {
    name: 'WHO Global Health Observatory',
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: {
      domains: ['health'],
      languages: ['ar', 'en'],
      access: 'documented_api',
      contract: { url: TERMS, checked: '2026-11-27' },
      hosts: [GHO_HOST],
    },
    supports(query) {
      const requestedGho = query.sites.includes(GHO_HOST);
      if (query.sites.length && !requestedGho) return false;
      const mappedTopic = query.language === 'ar' ? englishHealthTopic(query.retrievalQuestion) : undefined;
      if (query.language === 'ar' && !mappedTopic) return false;
      return requestedGho || statsRequest.test(query.question)
        || (statsDetails.test(query.question) && (Boolean(mappedTopic) || isHealthQuestion(query)));
    },
    async search(query, limit, signal) {
      signal.throwIfAborted();
      const filter = indicatorsFilter(query);
      if (!filter) return [];
      const count = healthLimit(limit);
      const url = new URL('Indicator', GHO_API);
      url.searchParams.set('$filter', filter);
      url.searchParams.set('$top', String(count));
      const body = await request(url, signal, { accept: 'application/json' });
      return indicatorHits(body, count, new Date(now()).toISOString().slice(0, 10));
    },
  };
}
