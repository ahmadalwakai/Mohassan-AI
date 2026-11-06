import { describe, expect, it } from 'vitest';
import { BrowserError, PublicWebSearch, relevantHits, type SafeNetwork, type SearchHit } from '@mohassan/browser';
import { searchKey } from '../apps/server/src/assistant/brain.js';

const hit = (title: string, url: string, snippet = ''): SearchHit => ({ title, url, snippet });
const news = hit('UK | Latest News & Updates | BBC News', 'https://www.bbc.co.uk/news/uk', 'Get all the latest news and official updates');
const node = hit('Node.js — Run JavaScript Everywhere', 'https://nodejs.org/', 'Download the latest stable version');
const unrelatedNode = hit('Node (computer networking) - Wikipedia', 'https://en.wikipedia.org/wiki/Node_(computer_networking)');

function rss(hits: SearchHit[]) {
  return `<rss><channel>${hits.map((item) => `<item><title>${item.title}</title><link>${item.url}</link><description>${item.snippet}</description></item>`).join('')}</channel></rss>`;
}

/** Answers like the real engines: Bing as RSS, DuckDuckGo as result links or a block page. */
function network(bing: SearchHit[], duck: SearchHit[] = []) {
  return {
    validate: (url: string) => new URL(url),
    text: async (url: string) => ({
      url, status: 200,
      text: url.includes('bing.com') ? rss(bing) : duck.map((item) => `<a class="result__a" href="${item.url}">${item.title}</a>`).join(''),
    }),
  } as unknown as SafeNetwork;
}

describe('relevantHits', () => {
  it('drops news that shares only generic words with the query', () => {
    expect(relevantHits('latest stable Node.js version official website', [news, node])).toEqual([node]);
  });

  it('applies to Arabic queries about an English subject', () => {
    expect(relevantHits('آخر إصدار من Node.js', [news, node])).toEqual([node]);
  });

  it('needs both words of a two word subject', () => {
    expect(relevantHits('Node.js latest', [unrelatedNode, node])).toEqual([node]);
  });

  it('enforces a site limit the engine ignored', () => {
    const docs = hit('Node.js docs', 'https://docs.nodejs.org/api');
    const mirror = hit('Node.js mirror', 'https://notnodejs.org/');
    expect(relevantHits('Node.js site:nodejs.org', [mirror, docs, node])).toEqual([docs, node]);
  });

  it('matches Arabic words with or without the definite article', () => {
    const gold = hit('أسعار الذهب في السعودية', 'https://gold.example/', 'سعر الذهب');
    expect(relevantHits('الذهب في السعودية', [gold, news])).toEqual([gold]);
  });

  it('keeps every result when the query has only generic words', () => {
    expect(relevantHits('latest official version', [news])).toEqual([news]);
  });

  it('does not ask a long question to match every word', () => {
    const guide = hit('Learn programming for beginners', 'https://learn.example/', 'free course');
    expect(relevantHits('which free programming course suits beginners learning alone at home in winter', [guide])).toEqual([guide]);
  });
});

describe('PublicWebSearch', () => {
  it('returns only relevant results from the first engine', async () => {
    await expect(new PublicWebSearch(network([news, node])).search('Node.js version', 5)).resolves.toEqual([expect.objectContaining({ url: 'https://nodejs.org/' })]);
  });

  it('tries the next engine when the first answers with unrelated pages', async () => {
    const hits = await new PublicWebSearch(network([news], [node])).search('Node.js version', 5);
    expect(hits.map((item) => item.url)).toEqual(['https://nodejs.org/']);
  });

  it('fails openly when no engine has a relevant result', async () => {
    const failure = await new PublicWebSearch(network([news], [])).search('Node.js version', 5).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrowserError);
    expect((failure as BrowserError).code).toBe('RESEARCH_SEARCH_UNAVAILABLE');
  });

  it('stops at once when the request was aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped');
    const aborted = { validate: (url: string) => new URL(url), text: async () => { controller.abort(); throw reason; } } as unknown as SafeNetwork;
    await expect(new PublicWebSearch(aborted).search('Node.js', 5, controller.signal)).rejects.toBe(reason);
  });
});

describe('searchKey', () => {
  it('treats the same words in another order or case as one search', () => {
    expect(searchKey('Node.js latest  version')).toBe(searchKey('latest VERSION node.js'));
  });

  it('keeps different searches apart', () => {
    expect(searchKey('node.js version')).not.toBe(searchKey('node.js release'));
  });
});
