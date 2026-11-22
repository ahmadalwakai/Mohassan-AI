import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../research.js';
import { compileQuery, excludesWikipedia, rankResults, requestsWikipedia } from './ranking.js';

const hit = (title: string, url: string, snippet = ''): SearchHit => ({ title, url, snippet });
const wiki = hit('Cedar ferry fares', 'https://en.wikipedia.org/wiki/Cedar_ferry', 'Cedar ferry fares Cedar ferry fares');
const operator = hit('Cedar ferry fares', 'https://cedar-ferry.example/fares');
const rows = [{ provider: 'Bing RSS', hits: [wiki, operator] }];

describe('query-appropriate source ordering', () => {
  it('opens a related topic site before an encyclopedia even when the encyclopedia has more matches', () => {
    expect(rankResults(compileQuery('Cedar ferry fares'), rows, 5).map(item => item.url)).toEqual([operator.url, wiki.url]);
  });

  it('keeps the same preference for Arabic questions and results', () => {
    const encyclopedia = hit('أسعار عبارة الأرز', 'https://ar.wikipedia.org/wiki/Ferry', 'أسعار عبارة الأرز أسعار عبارة الأرز');
    const service = hit('أسعار عبارة الأرز', 'https://ferry.example/prices');
    expect(rankResults(compileQuery('أسعار عبارة الأرز'), [{ provider: 'web', hits: [encyclopedia, service] }], 5)[0]?.url).toBe(service.url);
  });

  it('keeps Wikipedia available when it is the only related source', () => {
    const unrelated = hit('Cedar garden plants', 'https://garden.example/');
    expect(rankResults(compileQuery('Cedar ferry fares'), [{ provider: 'web', hits: [unrelated, wiki] }], 5).map(item => item.url)).toEqual([wiki.url]);
  });

  it('honours an explicitly requested Wikipedia source in English or Arabic', () => {
    const competing = hit('Cedar ferry Wikipedia guide', 'https://guide.example/', 'Cedar ferry Wikipedia Cedar ferry Wikipedia');
    expect(rankResults(compileQuery('Cedar ferry Wikipedia'), [{ provider: 'web', hits: [competing, wiki] }], 5)[0]?.url).toBe(wiki.url);
    expect(rankResults(compileQuery('ويكيبيديا Cedar ferry'), [{ provider: 'web', hits: [operator, wiki] }], 5)[0]?.url).toBe(wiki.url);
    expect(rankResults(compileQuery('Cedar ferry site:en.wikipedia.org'), rows, 5).map(item => item.url)).toEqual([wiki.url]);
  });

  it.each(['ويكيبيديا سوريا', 'سوريا ويكيبيديا', 'ابحث عن سوريا في ويكيبيديا', 'ويكبيديا سوريا'])(
    'matches the Arabic subject without requiring the requested source name: %s', question => {
      const syria = hit('سوريا', 'https://ar.wikipedia.org/wiki/Syria', 'سوريا دولة في غرب آسيا');
      const unrelated = hit('ويكيبيديا مصر', 'https://ar.wikipedia.org/wiki/Egypt', 'مصر دولة في شمال أفريقيا');
      expect(rankResults(compileQuery(question), [{ provider: 'Wikipedia', hits: [unrelated, syria] }], 5).map(item => item.url)).toEqual([syria.url]);
    },
  );

  it('does not treat an unrelated site using Wikipedia in its hostname as the encyclopedia', () => {
    const lookalike = hit('Cedar ferry fares', 'https://wikipedia.org.example/');
    expect(rankResults(compileQuery('Cedar ferry fares'), [{ provider: 'web', hits: [wiki, lookalike] }], 5)[0]?.url).toBe(lookalike.url);
  });

  it('preserves subject and quoted-phrase filters before applying source preferences', () => {
    const near = hit('Cedar seasonal ferry fares', 'https://cedar.example/');
    expect(rankResults(compileQuery('"Cedar ferry" fares'), [{ provider: 'web', hits: [near, wiki] }], 5).map(item => item.url)).toEqual([wiki.url]);
    expect(rankResults(compileQuery('Cedar ferry site:cedar-ferry.example'), rows, 5).map(item => item.url)).toEqual([operator.url]);
  });

  it('shares the encyclopedia host cap across language subdomains', () => {
    const hits = ['en', 'ar', 'fr', 'de'].map(lang => hit('Cedar ferry fares', `https://${lang}.wikipedia.org/wiki/Cedar_ferry`));
    expect(rankResults(compileQuery('Cedar ferry fares'), [{ provider: 'web', hits }], 10)).toHaveLength(3);
  });

  it('keeps actual web destinations ahead of keyword-rich supplementary technical articles', () => {
    const ownPages = [hit('Node.js — Download', 'https://nodejs.org/en/download', 'Download the latest version of Node.js'), hit('Node.js — Run JavaScript Everywhere', 'https://nodejs.org/', 'The JavaScript runtime')];
    const stories = Array.from({ length: 6 }, (_, index) => hit('Node.js version version version', `https://stories-${index}.example/node`, 'Node.js version version version'));
    const ranked = rankResults(compileQuery('Node.js latest version'), [
      { provider: 'Bing RSS', hits: ownPages }, { provider: 'Hacker News', hits: stories },
    ], 5);
    expect(ranked.slice(0, 2).map(item => item.url).sort()).toEqual(ownPages.map(item => item.url).sort());
  });

  it('retains a named subject domain ahead of third-party tutorials returned by the same web engine', () => {
    const download = hit('Node.js — Download', 'https://nodejs.org/en/download', 'Download Node.js');
    const tutorials = [
      hit('Node.js latest version using npm', 'https://npmjs.com/node', 'Node.js version version'),
      hit('Node.js latest version for VS Code', 'https://code.visualstudio.com/docs/nodejs', 'Node.js version version'),
      hit('Node.js latest version project', 'https://github.com/example/nodejs', 'Node.js version version'),
      hit('Node.js latest version', 'https://nodejs.org.example/download', 'Node.js version version'),
      hit('Node.js latest version', 'https://evilnodejs.example/download', 'Node.js version version'),
    ];
    const ranked = rankResults(compileQuery('Node.js latest version'), [{ provider: 'Bing RSS', hits: [...tutorials, download] }], 3);
    expect(ranked[0]?.url).toBe(download.url);
  });

  it('does not give tiny topic tokens a host preference', () => {
    const rows = [{ provider: 'Bing RSS', hits: [
      hit('JS API JS API', 'https://docs.example/reference', 'JS API'),
      hit('JS API', 'https://js.example/', ''),
    ] }];
    expect(rankResults(compileQuery('JS API'), rows, 5)[0]?.url).toBe('https://docs.example/reference');
  });

  it('retains English destination pages for mixed Arabic stable-version requests', () => {
    const question='ما هو آخر إصدار مستقر من Node.js';
    const query=compileQuery(question);
    const download=hit('Node.js — Download', 'https://nodejs.org/en/download', 'Download Node.js');
    expect(query).toMatchObject({question,retrievalQuestion:'Node.js latest stable version',timeSensitive:true,tokens:['node','js','version']});
    expect(compileQuery('ما هو آخر إصدار من Node.js')).toMatchObject({question:'ما هو آخر إصدار من Node.js',retrievalQuestion:'Node.js latest version'});
    expect(compileQuery('ما هو أحدث إصدار مستقر من Node.js').retrievalQuestion).toBe('Node.js latest stable version');
    expect(compileQuery('شرح أمان SQL').retrievalQuestion).toBe('أمان SQL');
    expect(compileQuery('ما هو آخر إصدار أمان SQL').retrievalQuestion).toBe('latest version أمان SQL');
    expect(compileQuery('"آخر إصدار" Node.js').retrievalQuestion).toBe('"آخر إصدار" Node.js');
    expect(rankResults(query,[{provider:'Bing RSS',hits:[download]}],5)[0]?.url).toBe(download.url);
    expect(compileQuery('latest stable Node.js version').tokens).toEqual(['node','js','version']);
    expect(compileQuery('Stable Diffusion latest version').tokens).toContain('stable');
    expect(compileQuery('"stable version" Node.js').tokens).toContain('stable');
  });

  it('recognizes normalized Arabic latest-release instructions as time-sensitive', () => {
    expect(compileQuery('أَحْدَث إصدار Node.js').timeSensitive).toBe(true);
    expect(compileQuery('ما هو آخَر إصدار Node.js').timeSensitive).toBe(true);
  });

  it('removes تعلم only when it is a leading instruction before a technical subject', () => {
    expect(compileQuery('تعلم Python')).toMatchObject({question:'تعلم Python',retrievalQuestion:'Python',tokens:['python']});
    expect(compileQuery('Python تعلم الآلة')).toMatchObject({question:'Python تعلم الآلة',retrievalQuestion:'Python تعلم الآلة',tokens:['python','تعلم','الة']});
    expect(compileQuery('تعلم الآلة Python').retrievalQuestion).toBe('تعلم الآلة Python');
    expect(compileQuery('"تعلم" Python').retrievalQuestion).toBe('"تعلم" Python');
  });

  it('does not let a generic two-word overlap answer a longer specific service question', () => {
    const unrelated = hit('UK visa renewal fees', 'https://example.org/visa', 'Visa renewal fees in the UK');
    const passport = hit('UK passport renewal fees', 'https://service.example/passport', 'Passport renewal fees in the UK');
    expect(rankResults(compileQuery('UK passport renewal fees'), [{ provider: 'Bing RSS', hits: [unrelated, passport] }], 5).map(item => item.url)).toEqual([passport.url]);
  });

  it('requires Arabic subject words instead of treating request and temporal words as relevance', () => {
    const unrelated = hit('كم مرة حدث هذا اليوم', 'https://example.org/unrelated', 'اليوم حدث تاريخي');
    const gold = hit('سعر الذهب', 'https://market.example/gold', 'سعر الذهب للغرام');
    const query = compileQuery('كم سعر الذهب اليوم');
    expect(query.tokens).toEqual(['سعر', 'ذهب']);
    expect(rankResults(query, [{ provider: 'Bing RSS', hits: [unrelated, gold] }], 5).map(item => item.url)).toEqual([gold.url]);
  });

  it.each(['passport renewal fees', 'Cedar ferry fares', 'museum opening hours', 'تكلفة جواز السفر', 'رسوم تجديد الجواز', 'مواعيد المتحف', 'أسعار الذهب'])(
    'recognizes changing service information: %s', question => {
      expect(compileQuery(question).timeSensitive).toBe(true);
    },
  );

  it.each(['Node.js documentation not Wikipedia', 'Node.js documentation without Wikipedia', 'شرح Node.js بدون ويكيبيديا', 'شرح Node.js لا تستخدم ويكيبيديا', 'Node.js -site:wikipedia.org'])(
    'honours excluded Wikipedia sources: %s', question => {
      const query = compileQuery(question);
      const source = hit('Node.js documentation', 'https://nodejs.org/docs', 'Node.js reference');
      const encyclopedia = hit('Node.js documentation', 'https://en.wikipedia.org/wiki/Node.js', 'Node.js reference');
      expect(excludesWikipedia(query)).toBe(true);
      expect(requestsWikipedia(query)).toBe(false);
      expect(rankResults(query, [{ provider: 'Bing RSS', hits: [encyclopedia, source] }], 5).map(item => item.url)).toEqual([source.url]);
    },
  );

  it('honours an explicit Wikipedia site scope when natural-language source preferences conflict', () => {
    const query = compileQuery('Cedar ferry without Wikipedia site:en.wikipedia.org');
    expect(excludesWikipedia(query)).toBe(false);
    expect(requestsWikipedia(query)).toBe(true);
    expect(rankResults(query, rows, 5).map(item => item.url)).toEqual([wiki.url]);
  });
});
