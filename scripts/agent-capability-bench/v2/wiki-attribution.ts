import { capabilityV2PayloadSchema } from './sealed.js';

const articlePath = '/wiki/';
const license30 = 'https://creativecommons.org/licenses/by-sa/3.0/';
const license40 = 'https://creativecommons.org/licenses/by-sa/4.0/';
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

type Sources = 'tydiqa' | 'canard';
type Article = { articleUrl: string; historyUrl: string; caseIds: string[] };

function articleSource(url: URL | null, language: 'ar' | 'en'): Omit<Article, 'caseIds'> {
  if (!url || url.origin !== `https://${language}.wikipedia.org` || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith(articlePath)) {
    throw new Error('Expected a language-specific Wikipedia article URL for attribution.');
  }
  const title = decodeURIComponent(url.pathname.slice(articlePath.length));
  if (!title.trim() || /[#<>\[\]|{}\p{Cc}]/u.test(title)) throw new Error('Invalid Wikipedia article title for attribution.');
  const history = new URL('/w/index.php', url.origin);
  history.searchParams.set('title', title);
  history.searchParams.set('action', 'history');
  return { articleUrl: url.href, historyUrl: history.href };
}

function canardArticle(firstTurn: string): URL | null {
  const [, article, section] = firstTurn.split('\n', 3);
  const title = /^Article: (.+)$/u.exec(article ?? '')?.[1]?.trim();
  if (!title || !section?.startsWith('Section: ')) return null;
  return URL.parse(`https://en.wikipedia.org${articlePath}${encodeURIComponent(title.replace(/ /gu, '_'))}`);
}

/** Builds per-article credits from the unchanged, already pinned corpus. */
export function wikiAttribution(payload: string): string {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new Error('Wikipedia attribution requires valid sealed payload JSON.');
  }
  const parsed = capabilityV2PayloadSchema.safeParse(json);
  if (!parsed.success) throw new Error('Wikipedia attribution requires the sealed payload schema.');
  const articles = { canard: new Map<string, Article>(), tydiqa: new Map<string, Article>() };
  function credit(source: Sources, links: Omit<Article, 'caseIds'>, id: string) {
    const existing = articles[source].get(links.articleUrl);
    if (existing) existing.caseIds.push(id);
    else articles[source].set(links.articleUrl, { ...links, caseIds: [id] });
  }
  for (const item of parsed.data.cases) {
    if (item.provenance.source.startsWith('tydiqa:')) {
      const pages = item.fixture?.pages ?? [];
      if (!pages.length) throw new Error('Missing Wikipedia passage attribution in a TyDiQA-GoldP case.');
      for (const page of pages) credit('tydiqa', articleSource(URL.parse(page.url), item.language), item.id);
    } else if (item.provenance.source.startsWith('canard:')) {
      credit('canard', articleSource(canardArticle(item.turns[0]!.text), 'en'), item.id);
    }
  }
  const sorted = (source: Sources) => [...articles[source].values()].sort((left, right) => compare(left.articleUrl, right.articleUrl))
    .map(article => ({ ...article, caseIds: article.caseIds.sort(compare) }));
  return JSON.stringify({
    schemaVersion: 1,
    attribution: 'Wikipedia contributors credited through the article and its author history.',
    terms: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content',
    historicalLinks: 'Article titles come from the source release. Current links can redirect after a page move.',
    licenses: { 'CC-BY-SA-3.0': license30, 'CC-BY-SA-4.0': license40 },
    sources: {
      canard: {
        source: 'English Wikipedia excerpts carried by QuAC into CANARD.',
        license: 'CC-BY-SA-4.0',
        excerptLicense: 'CC-BY-SA-3.0',
        changes: 'The benchmark reused excerpts from earlier turns as labeled dialogue history.',
        linkMethod: 'Derived from the source article title. The dataset does not identify a specific Wikipedia revision.',
        articles: sorted('canard'),
      },
      tydiqa: {
        source: 'Wikipedia article excerpts from the TyDiQA-GoldP v1.1 development split.',
        license: 'CC-BY-SA-3.0',
        changes: 'The benchmark replays the archived passage from the source release and annotates the scored answer separately.',
        linkMethod: 'The archived passage keeps the article URL derived from its title and language. The dataset does not identify a specific Wikipedia revision.',
        articles: sorted('tydiqa'),
      },
    },
  }, null, 2) + '\n';
}
