import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { BrowserError, SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { siteSearchProviders } from './site-search.js';
import {
  arabicPage, description, dokuWiki, exampleDescription, exampleHost, exampleRssResults, html, rfcEditor, searchLink, sitemap,
} from './site-search.fixtures.js';

type RequestOptions = NonNullable<Parameters<SafeNetwork['request']>[1]>;
type FixtureResponse = {
  body?: string | Buffer;
  wireBytes?: number;
  status?: number;
  headers?: Record<string, string>;
};
type FixtureRoute = FixtureResponse | ((options: RequestOptions) => Promise<FixtureResponse>);

const plain = (body: string): FixtureResponse => ({ body, headers: { 'content-type': 'text/plain' } });
const markup = (body: string | Buffer): FixtureResponse => ({ body, headers: { 'content-type': 'text/html' } });
const xml = (body: string, media = 'application/xml'): FixtureResponse => ({ body, headers: { 'content-type': media } });
const policy = (rules = '') => plain(`User-agent: *\n${rules}`);

class FixtureNetwork extends SafeNetwork {
  readonly requests: { url: string; time: number; maxBytes: number; bytesRead: number }[] = [];
  time = Date.parse('2026-11-27T00:00:00Z');
  readonly now = () => this.time;

  constructor(private routes: Record<string, FixtureRoute>, private elapsedPerRequest = 250) { super(); }

  override async request(input: string, options: RequestOptions = {}): Promise<SafeResponse> {
    const url = this.validate(input, options.allowedOrigins).href;
    options.signal?.throwIfAborted();
    const maxBytes = options.maxBytes;
    if (!maxBytes || maxBytes < 0) throw new Error('Fixture dispatch needs a positive byte allowance');
    const call = { url, time: this.time, maxBytes, bytesRead: 0 };
    this.requests.push(call);
    this.time += this.elapsedPerRequest;
    const route = this.routes[url];
    const reply = typeof route === 'function' ? await route(options) : route ?? { status: 404 };
    const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? '');
    const size = Math.max(body.byteLength, reply.wireBytes ?? 0);
    call.bytesRead = Math.min(size, maxBytes);
    if (size > maxBytes) throw new BrowserError('BROWSER_RESPONSE_TOO_LARGE', 'Fixture exceeds dispatch allowance');
    return { url, status: reply.status ?? 200, body, headers: reply.headers ?? {}, wireBytes: reply.wireBytes };
  }

  urls(): string[] { return this.requests.map(call => call.url); }
}

function fixture(routes: Record<string, FixtureRoute>, elapsedPerRequest?: number) {
  const network = new FixtureNetwork(routes, elapsedPerRequest);
  const [provider] = siteSearchProviders(network, network.now);
  const search = (question: string, limit = 10, signal = new AbortController().signal) =>
    provider.search(compileQuery(question), limit, signal);
  return { network, provider, search };
}

describe('named-host search', () => {
  it('prefers the published RSS search template, preserves source snippets and keeps results on the named site', async () => {
    const result = exampleHost + '/?q=New%20York%20history&pw=1&format=rss';
    const { network, provider, search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: markup(html(searchLink('/opensearchdescription.xml'))),
      [exampleHost + '/opensearchdescription.xml']: xml(exampleDescription, 'application/opensearchdescription+xml'),
      [result]: xml(exampleRssResults, 'application/rss+xml'),
    });
    expect(provider.supports(compileQuery('New York history'))).toBe(false);
    expect(provider.supports(compileQuery('New York history site:example.com'))).toBe(true);
    expect(provider.planned).toMatchObject({ domains: [], hosts: [], access: 'opensearch' });
    await expect(search('New York history')).resolves.toEqual([]);
    expect(network.urls()).toEqual([]);
    await expect(search('New York history site:example.com')).resolves.toEqual([{
      title: 'New York History',
      url: exampleHost + '/new-york-history',
      snippet: 'A virtual tour and information on businesses.',
    }]);
    expect(network.urls()).toEqual([
      exampleHost + '/robots.txt', exampleHost + '/', exampleHost + '/opensearchdescription.xml', result,
    ]);
    await search('New York history site:example.com');
    expect(network.urls().slice(4)).toEqual([result]);
  });

  it('parses real HTML result markup through the permitted DokuWiki redirect', async () => {
    const { origin } = dokuWiki;
    const searchUrl = origin + '/doku.php?do=search&id=syntax';
    const redirect = origin + '/syntax?do=search&q=syntax';
    const { network, search } = fixture({
      [origin + '/robots.txt']: plain(dokuWiki.robots),
      [origin + '/']: markup(dokuWiki.home),
      [origin + '/lib/exe/opensearch.php']: xml(dokuWiki.descriptor, 'application/opensearchdescription+xml'),
      [searchUrl]: { status: 302, headers: { location: redirect } },
      [redirect]: markup(dokuWiki.results),
    }, 5000);
    const hits = await search('syntax site:www.dokuwiki.org');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: 'features',
      url: origin + '/de:features?s[]=syntax',
      snippet: expect.stringContaining('Einfache [[de:wiki:syntax|Syntax]]!'),
    });
    expect(network.urls()).toEqual([origin + '/robots.txt', origin + '/', origin + '/lib/exe/opensearch.php', searchUrl, redirect]);
  });

  it.each([
    ['typed feed discovery', rfcEditor.homeWithFeeds, '/rfcatom.xml'],
    ['a linked common feed path', html('', '<a href="/atom.xml">Recent RFCs</a>'), '/atom.xml'],
  ])('matches recent Atom entries by summary via %s and reuses feed discovery', async (_example, homepage, feedPath) => {
    const { origin } = rfcEditor;
    const feedUrl = origin + feedPath;
    const { network, search } = fixture({
      [origin + '/robots.txt']: plain(rfcEditor.robots),
      [origin + '/']: markup(homepage),
      [feedUrl]: xml(rfcEditor.atom, 'application/atom+xml'),
    });
    const question = '"control plane" site:www.rfc-editor.org';
    await expect(search(question)).resolves.toEqual([{
      title: 'RFC 10090: BGP Usage for Software-Defined WAN (SD-WAN) Overlay Networks',
      url: origin + '/info/rfc10090/',
      snippet: expect.stringContaining('a BGP-based control plane'),
    }]);
    expect(network.urls()).toContain(feedUrl);
    expect(network.urls()).not.toContain(origin + '/sitemap.xml');
    await search(question);
    expect(network.urls().filter(url => url === origin + '/')).toHaveLength(1);
    expect(network.urls().filter(url => url === origin + '/robots.txt')).toHaveLength(1);
  });

  it('starts from the robots sitemap index, ranks URL words and reuses discovery', async () => {
    const { origin } = rfcEditor;
    const article = origin + '/authors/rfc-style-guide/';
    const { network, search } = fixture({
      [origin + '/robots.txt']: plain(rfcEditor.robots.replace('/sitemap.xml', '/maps.xml')),
      [origin + '/']: markup(html()),
      [origin + '/maps.xml']: xml(rfcEditor.index),
      [origin + '/sitemap-1.xml']: xml(rfcEditor.sitemap),
      [article]: markup(rfcEditor.styleGuide),
    });
    const question = '"style guide" site:www.rfc-editor.org';
    await expect(search(question, 1)).resolves.toEqual([{
      title: 'Style Guide | RFC Editor', url: article, snippet: expect.stringContaining('RFC 7322'),
    }]);
    expect(network.urls()).toContain(origin + '/maps.xml');
    expect(network.urls()).toContain(origin + '/sitemap-1.xml');
    expect(network.urls().filter(url => url.startsWith(origin + '/authors/'))[0]).toBe(article);
    await search(question, 1);
    for (const path of ['/robots.txt', '/', '/maps.xml', '/sitemap-1.xml']) {
      expect(network.urls().filter(url => url === origin + path)).toHaveLength(1);
    }
    network.time += 24 * 60 * 60 * 1000;
    await search(question, 1);
    expect(network.urls().filter(url => url === origin + '/robots.txt')).toHaveLength(2);
    expect(network.urls().filter(url => url === origin + '/maps.xml')).toHaveLength(2);
  });

  it('breaks sitemap URL-score ties by lastmod and checks robots before dispatching page candidates', async () => {
    const older = exampleHost + '/a/style-guide';
    const newer = exampleHost + '/b/style-guide';
    const forbidden = exampleHost + '/private/style-guide';
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy('Disallow: /private/'),
      [exampleHost + '/']: markup(html()),
      [exampleHost + '/sitemap.xml']: xml(sitemap('urlset', [older, newer, forbidden], ['2004-11-23', '2005-01-01', '2005-02-21'])),
      [newer]: markup(rfcEditor.styleGuide),
      [older]: markup(rfcEditor.styleGuide),
    });
    const hits = await search('"style guide" site:example.com', 1);
    expect(hits.map(hit => hit.url)).toEqual([newer]);
    expect(network.urls()).not.toContain(forbidden);
    expect(network.urls().filter(url => url.endsWith('/style-guide'))[0]).toBe(newer);
  });

  it('reads a gzip sitemap published in robots.txt', async () => {
    // Compressed sitemaps are defined at https://www.sitemaps.org/protocol.html (checked 2026-11-27).
    const listing = exampleHost + '/map.xml.gz';
    const article = exampleHost + '/style-guide';
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy(`Sitemap: ${listing}`),
      [exampleHost + '/']: markup(html()),
      [listing]: { body: gzipSync(sitemap('urlset', [article])), headers: { 'content-type': 'application/gzip' } },
      [article]: markup(rfcEditor.styleGuide),
    });
    await expect(search('style guide site:example.com', 1)).resolves.toMatchObject([{ url: article }]);
    expect(network.urls()).toContain(listing);
    expect(network.urls()).not.toContain(exampleHost + '/sitemap.xml');
  });

  it.each(['search=no', 'search=yes, ai-input=no'])('honors an operator Content-Signal of %s', async signal => {
    // https://contentsignals.org/ (checked 2026-11-27).
    const { network, search } = fixture({ [exampleHost + '/robots.txt']: policy(`Content-Signal: ${signal}`) });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'forbidden_by_robots' });
    expect(network.urls()).toEqual([exampleHost + '/robots.txt']);
  });

  it('fails closed when the robots endpoint returns an HTML page with status 200', async () => {
    const { network, search } = fixture({ [exampleHost + '/robots.txt']: markup(html('<title>Page unavailable</title>')) });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(network.urls()).toEqual([exampleHost + '/robots.txt']);
  });

  it.each([false, true])('decodes windows-1256 and normalizes Arabic query matching (HTTP charset: %s)', async withHttpCharset => {
    const url = exampleHost + '/arabic';
    const body = withHttpCharset ? Buffer.from(arabicPage.toString('latin1').replace('<meta charset="windows-1256">', ''), 'latin1') : arabicPage;
    const { search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: markup(html()),
      [exampleHost + '/sitemap.xml']: xml(sitemap('urlset', [url])),
      [url]: withHttpCharset ? { body, headers: { 'content-type': 'text/html; charset=windows-1256' } } : markup(body),
    });
    await expect(search('"مدخل الى" C++ site:example.com')).resolves.toEqual([{
      title: 'مدخل إلى C++', url, snippet: expect.stringContaining('اتبع هذه الروابط بالترتيب'),
    }]);
  });

  it.each([false, true])('explains a robots denial and never dispatches the forbidden URL (redirect: %s)', async redirected => {
    const forbidden = exampleHost + '/forbidden?q=history';
    const start = exampleHost + '/search?q=history';
    const template = redirected ? 'search' : 'forbidden';
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy('Disallow: /forbidden'),
      [exampleHost + '/']: markup(html(searchLink('/osd.xml'))),
      [exampleHost + '/osd.xml']: xml(description(`<Url type="text/html" template="${exampleHost}/${template}?q={searchTerms}"/>`)),
      [start]: { status: 302, headers: { location: forbidden } },
    });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'forbidden_by_robots' });
    expect(network.urls()).not.toContain(forbidden);
    expect(network.urls().includes(start)).toBe(redirected);
  });

  it.each([
    [200, 'no_search_method'], [401, 'needs_account'], [500, 'unavailable'],
  ])('reports explicit failure when homepage status is %i and no method succeeds', async (status, kind) => {
    const { search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: { ...markup(html()), status },
    });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind });
  });

  it('recognizes a login wall on a published search endpoint', async () => {
    const result = exampleHost + '/search?q=history';
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: markup(html(searchLink('/osd.xml'))),
      [exampleHost + '/osd.xml']: xml(description(`<Url type="text/html" template="${exampleHost}/search?q={searchTerms}"/>`)),
      [result]: markup(html('<title>Sign in</title>', '<main><h1>Sign in</h1><form><input type="password"></form></main>')),
    });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'needs_account' });
    expect(network.urls()).toContain(result);
  });

  it('respects page noindex and nosnippet directives during sitemap retrieval', async () => {
    // Robots meta tag and X-Robots-Tag examples, checked 2026-11-27:
    // https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
    const hidden = exampleHost + '/history/hidden';
    const titleOnly = exampleHost + '/history/title-only';
    const { search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: markup(html()),
      [exampleHost + '/sitemap.xml']: xml(sitemap('urlset', [hidden, titleOnly])),
      [hidden]: markup(html('<title>History</title><meta name="robots" content="noindex">', '<p>New York History</p>')),
      [titleOnly]: { body: html('<title>History</title>', '<p>New York History</p>'),
        headers: { 'content-type': 'text/html', 'x-robots-tag': 'nosnippet' } },
    });
    await expect(search('history site:example.com')).resolves.toEqual([{ title: 'History', url: titleOnly, snippet: '' }]);
  });

  it('backs off the limited host across its root and www aliases while allowing a different named host', async () => {
    const other = rfcEditor.origin;
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: { status: 429, headers: { 'retry-after': '40' } },
      [other + '/robots.txt']: plain(rfcEditor.robots),
      [other + '/']: markup(rfcEditor.homeWithFeeds),
      [other + '/rfcatom.xml']: xml(rfcEditor.atom, 'application/atom+xml'),
    });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    await expect(search('history site:www.example.com')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    await expect(search('control plane site:example.com site:www.rfc-editor.org')).resolves.toHaveLength(1);
    expect(network.urls().filter(url => new URL(url).hostname.endsWith('example.com'))).toEqual([exampleHost + '/robots.txt']);
  });

  it('shares active admission between root and www aliases', async () => {
    let dispatch: () => void;
    const entered = new Promise<void>(resolve => { dispatch = resolve; });
    let complete: ((reply: FixtureResponse) => void) | undefined;
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: () => new Promise(resolve => { complete = resolve; dispatch(); }),
    });
    const initial = search('history site:example.com');
    const initialRejection = expect(initial).rejects.toMatchObject({ kind: 'forbidden_by_robots' });
    try {
      await entered;
      await expect(search('history site:www.example.com')).rejects.toMatchObject({ kind: 'rate_limited' });
      expect(network.urls()).toEqual([exampleHost + '/robots.txt']);
    } finally {
      complete?.(policy('Disallow: /'));
      await initialRejection;
    }
  });

  it('counts every request against the eight-fetch per-host budget', async () => {
    const urls = Array.from({ length: 12 }, (_, index) => exampleHost + '/history/' + index);
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: markup(html()),
      [exampleHost + '/sitemap.xml']: xml(sitemap('urlset', urls)),
      ...Object.fromEntries(urls.map(url => [url, markup(html('<title>History</title>', '<p>History</p>'))])),
    });
    await expect(search('history site:example.com')).resolves.toHaveLength(5);
    expect(network.requests).toHaveLength(8);
  });

  it.each([false, true])('shares four million bytes across discovery and pages (larger wire size: %s)', async countWire => {
    const article = exampleHost + '/history';
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: policy(),
      [exampleHost + '/']: countWire ? { ...markup(html()), wireBytes: 3_800_000 } : markup(html('', 'x'.repeat(3_800_000))),
      [exampleHost + '/sitemap.xml']: xml(sitemap('urlset', [article, exampleHost + '/not-reached'])),
      [article]: markup(html('<title>History</title>', 'x'.repeat(300_000))),
    });
    await expect(search('history site:example.com')).rejects.toMatchObject({ kind: 'unavailable' });
    const chunks = network.requests.map(request => request.bytesRead);
    expect(network.urls().at(-1)).toBe(article);
    expect(chunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(4_000_000);
    expect(network.requests.at(-1)?.maxBytes).toBe(4_000_000 - chunks.slice(0, -1).reduce((sum, bytes) => sum + bytes, 0));
  });

  it('cancels the transport and stops dispatch when the caller aborts', async () => {
    const controller = new AbortController();
    let inFlight: AbortSignal | undefined;
    const { network, search } = fixture({
      [exampleHost + '/robots.txt']: async options => {
        inFlight = options.signal;
        controller.abort();
        options.signal?.throwIfAborted();
        throw new Error('Fixture signal did not abort');
      },
    });
    await expect(search('history site:example.com', 10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(inFlight?.aborted).toBe(true);
    expect(network.urls()).toEqual([exampleHost + '/robots.txt']);
  });

  it('enforces the query time budget even when a transport ignores the abort signal', async () => {
    vi.useFakeTimers();
    let complete: ((reply: FixtureResponse) => void) | undefined;
    let inFlight: AbortSignal | undefined;
    try {
      const { network, search } = fixture({
        [exampleHost + '/robots.txt']: options => new Promise(resolve => {
          inFlight = options.signal;
          complete = resolve;
        }),
      });
      const pending = search('history site:example.com');
      const rejected = expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(inFlight?.aborted).toBe(true);
      expect(network.urls()).toEqual([exampleHost + '/robots.txt']);
    } finally {
      complete?.(policy());
      vi.useRealTimers();
    }
  });
});
