import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { compileQuery } from '../ranking.js';
import guides from './fixtures/wikivoyage-guides.json';
import { wikivoyageProviders } from './travel-wikivoyage.js';

// Relevant wildcard directives from both projects' robots.txt (2026-11-27).
// https://en.wikivoyage.org/robots.txt and https://incubator.wikimedia.org/robots.txt
const publishedRobots = 'User-agent: *\nAllow: /w/api.php?action=mobileview&\nDisallow: /w/';
const permittedRobots = 'User-agent: *\nAllow: /w/api.php';
const signal = () => new AbortController().signal;
let clock = 10_000;

function fixture(robots = permittedRobots) {
  clock += 120_000;
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async (input, options) => {
    options?.signal?.throwIfAborted();
    await options?.beforeDispatch?.();
    const target = new URL(input);
    const contents = target.hostname === 'incubator.wikimedia.org' ? guides.ar : guides.en;
    expect(target.hostname).toBe(new URL(contents.source).hostname);
    const isRobots = target.pathname === '/robots.txt';
    if (!isRobots) expect(target.pathname).toBe('/w/api.php');
    return {
      url: input, status: 200,
      headers: { 'content-type': isRobots ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' },
      body: Buffer.from(isRobots ? robots : JSON.stringify(contents.body)),
    };
  });
  const providers = wikivoyageProviders(network, () => clock);
  return { providers, request, network, advance: (ms: number) => { clock += ms; } };
}

describe('Wikivoyage Action API travel guides', () => {
  it('links each English guide section and credits the licensed excerpts', async () => {
    const { providers: [english], request } = fixture();
    const query = compileQuery('travel guide to Paris');
    expect(english.supports(query)).toBe(true);
    expect(english.supports(compileQuery('where is Paris?'))).toBe(false);
    expect(english.supports(compileQuery('Paris programming API'))).toBe(false);
    expect(english.supports(compileQuery('travel guide to Paris site:example.com'))).toBe(false);
    expect(english.planned).toMatchObject({ domains: ['travel'], languages: ['en'], access: 'documented_api' });

    const hits = await english.search(query, 1, signal());
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit).toMatchObject({ title: guides.en.body.parse.title, url: guides.en.source });
    const sections = guides.en.body.parse.tocdata.sections;
    const lines = hit.snippet.split('\n');
    expect(lines).toHaveLength(sections.length + 1);
    for (const [index, section] of sections.entries()) {
      expect(lines[index]).toContain(`${section.line} “`);
      expect(lines[index]).toContain(`${guides.en.source}#${section.anchor}`);
      const quote = /“(.+?)”/u.exec(lines[index])?.[1]?.replace(/…$/u, '');
      expect(guides.en.body.parse.wikitext).toContain(quote);
    }
    expect(lines.at(-1)).toBe(`Excerpt from ${guides.rights}`);
    expect(hit.snippet.length).toBeLessThanOrEqual(2000);

    const target = new URL(request.mock.calls[1][0]);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      action: 'parse', page: guides.en.body.parse.title, prop: 'wikitext|tocdata', redirects: '1', format: 'json', formatversion: '2',
    });
    expect(request.mock.calls.map(([, options]) => options?.headers?.['accept-encoding'])).toEqual(['gzip', 'gzip']);
  });

  it('uses the incubator project and source spellings for an Arabic question', async () => {
    const { providers: [english, arabic], request } = fixture();
    const query = compileQuery('كيف أصل إلى مصر من المطار؟');
    expect(arabic.supports(query)).toBe(true);
    expect(english.supports(query)).toBe(false);
    expect(arabic.planned).toMatchObject({ domains: ['travel'], languages: ['ar'], hosts: ['incubator.wikimedia.org', 'ar.wikivoyage.org'] });
    const section = guides.ar.body.parse.tocdata.sections.find(section => section.anchor === 'الوصول_إلى_مصر')!;
    const quote = guides.ar.body.parse.wikitext.slice(section.codepointOffset).split('\n')[1];
    expect(await arabic.search(query, 5, signal())).toEqual([{
      title: guides.ar.body.parse.title.split('/').at(-1),
      url: new URL(guides.ar.source).href,
      snippet: `${section.line} “${quote}” (${new URL(guides.ar.source).href}#${encodeURIComponent(section.anchor)})\nمقتطف من مساهمي ويكي رحلات, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)`,
    }]);
    expect(new URL(request.mock.calls[1][0]).searchParams.get('page')).toBe(guides.ar.body.parse.title);
  });

  it('accepts a Latin-script destination in an Arabic sightseeing question', async () => {
    const { providers: [english], request } = fixture();
    const query = compileQuery('ما أفضل الأماكن السياحية في Paris؟');
    expect(english.supports(query)).toBe(true);
    const [guide] = await english.search(query, 1, signal());
    const sections = guides.en.body.parse.tocdata.sections;
    const sightseeing = sections.filter(section => ['See', 'Do'].includes(section.line));
    for (const section of sightseeing) expect(guide.snippet).toContain(`${guides.en.source}#${section.anchor}`);
    for (const section of sections.filter(section => !sightseeing.includes(section))) expect(guide.snippet).not.toContain(`${guides.en.source}#${section.anchor}`);
    expect(new URL(request.mock.calls[1][0]).searchParams.get('page')).toBe(guides.en.body.parse.title);
  });

  it.each(['en', 'ar'] as const)('stops at the published %s robots directives', async language => {
    const { providers, request } = fixture(publishedRobots);
    const provider = providers.find(candidate => candidate.planned.languages[0] === language)!;
    const query = compileQuery(language === 'ar' ? 'دليل سياحي في مصر' : 'travel guide to Paris');
    await expect(provider.search(query, 5, signal())).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    expect(request.mock.calls.map(([input]) => new URL(input).pathname)).toEqual(['/robots.txt']);
  });

  it('checks robots against the product from the configured SafeNetwork User-Agent', async () => {
    const policy = 'User-agent: *\nDisallow: /w/\nUser-agent: MohassanTravel\nAllow: /w/api.php';
    const { request } = fixture(policy);
    const network = new SafeNetwork({ userAgent: ' MohassanTravel/1.0 (+https://www.mohassansy.com)' });
    vi.spyOn(network, 'request').mockImplementation(request);
    const [english] = wikivoyageProviders(network, () => clock);
    await expect(english.search(compileQuery('travel guide to Paris'), 1, signal())).resolves.toHaveLength(1);
  });

  it('only dispatches recognized guide questions or explicit guide-site searches', async () => {
    const { providers: [english], request } = fixture();
    await expect(english.search(compileQuery('Paris programming API'), 1, signal())).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    const explicit = compileQuery('Paris site:en.wikivoyage.org');
    expect(english.supports(explicit)).toBe(true);
    await expect(english.search(explicit, 1, signal())).resolves.toHaveLength(1);
  });

  it('observes Retry-After in English and Arabic without making another request during cooldown', async () => {
    const { providers: [english], network, request, advance } = fixture();
    const [, arabic] = wikivoyageProviders(network, () => clock);
    const existing = request.getMockImplementation()!;
    const waitSeconds = 7;
    request.mockImplementation(async (input, options) => {
      if (new URL(input).pathname === '/robots.txt') return existing(input, options);
      await options?.beforeDispatch?.();
      return { url: input, status: 429, headers: { 'retry-after': String(waitSeconds) }, body: Buffer.alloc(0) };
    });
    await expect(english.search(compileQuery('things to do in Paris'), 5, signal()))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: waitSeconds * 1000 });
    advance(2000);
    const query = compileQuery('دليل سياحي في مصر');
    await expect(arabic.search(query, 5, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: waitSeconds * 1000 - 2000 });
    expect(request).toHaveBeenCalledTimes(2);
    advance(waitSeconds * 1000 - 2000);
    request.mockImplementation(existing);
    await expect(arabic.search(query, 5, signal())).resolves.toHaveLength(1);
  });

  it('observes Retry-After from a robots response before sending any Action API request', async () => {
    const { providers: [english], request } = fixture();
    const waitSeconds = 7;
    request.mockImplementation(async input => ({
      url: input, status: 503, headers: { 'retry-after': String(waitSeconds) }, body: Buffer.alloc(0),
    }));
    const query = compileQuery('travel guide to Paris');
    await expect(english.search(query, 1, signal())).rejects.toMatchObject({ kind: 'unavailable', retryAfterMs: waitSeconds * 1000 });
    await expect(english.search(query, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: waitSeconds * 1000 });
    expect(request.mock.calls.map(([input]) => new URL(input).pathname)).toEqual(['/robots.txt']);
  });
});
