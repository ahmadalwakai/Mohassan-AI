import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Html } from 'parse5';
import type { SearchHit } from '../../research.js';
import { safeResumeUrl } from '../../session-state.js';
import { SearchProviderFailure } from '../providers.js';
import type { PlannedProvider } from '../source-plan.js';
import { englishHealthTopic } from './health-topics.js';
import { healthEnglishQuery, healthLimit, healthPlain, isHealthQuestion, type HealthRequester } from './health-utils.js';

// NLM Web Service acceptable use and format, checked 2026-11-27.
const API_DOC = 'https://medlineplus.gov/about/developers/webservices/';
const API_URL = 'https://wsearch.nlm.nih.gov/ws/query';
const TOPIC_HOST = 'medlineplus.gov';
// NLM's requested attribution for reuse of health-topic summaries, checked 2026-11-27.
// https://medlineplus.gov/about/using/usingcontent/
const CREDIT = 'MedlinePlus, National Library of Medicine';

function elements(parent: Html.ParentNode, tag: string): Html.Element[] {
  return parent.childNodes.filter((node): node is Html.Element => 'tagName' in node && node.tagName === tag);
}

function field(element: Html.Element | undefined): string {
  // The XML service puts escaped HTML in title and summary fields. Reading
  // text nodes makes that markup available to the HTML-to-text step once.
  return element?.childNodes.map(node => 'value' in node ? node.value : 'tagName' in node ? serializeOuter(node) : '').join('') ?? '';
}

function topicHits(body: string, limit: number): SearchHit[] {
  const markup = body.replace(/^\uFEFF?\s*<\?xml\s+[^?]*\?>/u, '');
  if (/<[!?]/u.test(markup)) throw new SearchProviderFailure('invalid_response');
  const fragment = parseFragment(markup, { sourceCodeLocationInfo: true });
  const [root, duplicateRoot] = elements(fragment, 'nlmsearchresult');
  if (!root?.sourceCodeLocation?.endTag || duplicateRoot || elements(root, 'error').length) {
    throw new SearchProviderFailure('invalid_response');
  }
  const count = field(elements(root, 'count')[0]).trim();
  if (!/^\d+$/u.test(count)) throw new SearchProviderFailure('invalid_response');
  if (count === '0') return [];
  const list = elements(root, 'list')[0];
  const documents = list?.sourceCodeLocation?.endTag ? elements(list, 'document') : [];
  if (!documents.length) throw new SearchProviderFailure('invalid_response');

  return documents.slice(0, limit).flatMap(document => {
    const url = safeResumeUrl(document.attrs.find(attribute => attribute.name === 'url')?.value ?? '');
    if (!document.sourceCodeLocation?.endTag || !url || new URL(url).origin !== `https://${TOPIC_HOST}`) return [];
    const contents = elements(document, 'content');
    const text = (name: string) => field(contents.find(content => content.attrs.some(attribute => attribute.name === 'name' && attribute.value.toLowerCase() === name)));
    const title = healthPlain(text('title'), 240);
    const snippet = healthPlain(text('fullsummary')) || healthPlain(text('snippet'));
    // Brief results supply no review or publication date. The full topic XML
    // exposes date-created, which identifies the topic record rather than a review.
    return title && snippet ? [{ title, url, snippet: `${CREDIT} — ${snippet}` }] : [];
  });
}

export function createMedlinePlusProvider(request: HealthRequester): PlannedProvider {
  return {
    name: 'MedlinePlus',
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: {
      domains: ['health'],
      languages: ['ar', 'en'],
      access: 'documented_api',
      contract: { url: API_DOC, checked: '2026-11-27' },
      hosts: [TOPIC_HOST, new URL(API_URL).hostname],
    },
    supports(query) {
      if (query.sites.length && !query.sites.includes(TOPIC_HOST)) return false;
      if (query.language === 'ar' && !englishHealthTopic(query.retrievalQuestion)) return false;
      return query.sites.length > 0 || isHealthQuestion(query);
    },
    async search(query, limit, signal) {
      signal.throwIfAborted();
      const term = healthEnglishQuery(query);
      if (!term) return [];
      const count = healthLimit(limit);
      const url = new URL(API_URL);
      url.search = new URLSearchParams({ db: 'healthTopics', term, retmax: String(count), rettype: 'brief', tool: 'MohassanAI' }).toString();
      // Admission in the shared requester limits requests to below NLM's cap.
      // Avoid shared caching of terms that may contain private health details.
      const response = await request(url, signal, { accept: 'application/xml, text/xml' });
      return topicHits(response, count);
    },
  };
}
