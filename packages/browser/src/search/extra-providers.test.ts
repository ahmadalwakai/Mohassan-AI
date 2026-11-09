import { createServer, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import { compileQuery } from './ranking.js';
import { extraDocumentedProviders } from './extra-providers.js';

const ATOM = 'http://www.w3.org/2005/Atom';
const atom = (entries = '<entry><id>http://arxiv.org/abs/2401.12345v2</id><title>Research &amp; science</title><summary>Electron study &#x3b1; results.</summary></entry>', total = entries ? 1 : 0) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="${ATOM}" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><id>http://arxiv.org/api/query/result</id><title>arXiv query</title><updated>2026-11-08T00:00:00Z</updated><opensearch:totalResults>${total}</opensearch:totalResults>${entries}</feed>`;
const hn = () => JSON.stringify({ hits: [{ objectID: '123', title: 'Node &amp; API', url: 'https://nodejs.org/docs', story_text: '<p>Programming docs</p><script>ignore this</script>' }] });
let responseBody: string | Buffer = '', contentType = '', status = 200, retryAfter = '', hold = false;
let origin = '', held: ServerResponse[] = [];
const received: { path: string; accept: string | undefined }[] = [];
const server = createServer((request, response) => {
  received.push({ path: request.url!, accept: request.headers.accept });
  response.writeHead(status, { 'content-type': contentType, ...(retryAfter ? { 'retry-after': retryAfter } : {}) });
  if (hold) held.push(response); else response.end(responseBody);
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { responseBody = hn(); contentType = 'application/json; charset=utf-8'; status = 200; retryAfter = ''; hold = false; held = []; received.length = 0; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function fixture(now: () => number = () => 1_000_000) {
  const network = new SafeNetwork({ testOrigins: [origin] }), request = network.request.bind(network);
  const dispatch = vi.spyOn(network, 'request').mockImplementation((url, options) => {
    const remote = new URL(url);
    return request(origin + remote.pathname + remote.search, options);
  });
  return { network, dispatch, providers: extraDocumentedProviders(network, now) };
}
const signal = () => new AbortController().signal;
const tech = () => compileQuery('Node API programming');
const science = () => compileQuery('electron research paper');

describe('documented Hacker News and arXiv provider contracts', () => {
  it('uses the bounded HN story API and preserves metadata without HTML execution', async () => {
    const { providers, dispatch } = fixture();
    expect(providers[0].supports(tech())).toBe(true); expect(providers[0].supports(science())).toBe(false);
    expect(await providers[0].search(tech(), 900, signal())).toEqual([{ title: 'Node & API', url: 'https://nodejs.org/docs', snippet: 'Programming docs' }]);
    const target = new URL(dispatch.mock.calls[0][0]);
    expect(target.origin + target.pathname).toBe('https://hn.algolia.com/api/v1/search');
    expect(Object.fromEntries(target.searchParams)).toEqual({ query: 'Node API programming', tags: 'story', hitsPerPage: '20', page: '0' });
    expect(dispatch.mock.calls[0][1]?.maxBytes).toBe(512000);
    expect(received[0].accept).toBe('application/json');
  });

  it('uses a public discussion URL for text stories and unsafe external destinations', async () => {
    responseBody = JSON.stringify({ hits: [{ objectID: '17', title: 'Ask HN: Node API', url: null, story_text: 'Node API question' }, { objectID: '18', title: 'Node API', url: 'https://127.0.0.1/private' }, { objectID: '19', title: 'Node API', url: 'https://example.com/?token=private' }] });
    const { providers } = fixture();
    expect((await providers[0].search(tech(), 5, signal())).map(hit => hit.url)).toEqual(['https://news.ycombinator.com/item?id=17', 'https://news.ycombinator.com/item?id=18', 'https://news.ycombinator.com/item?id=19']);
    expect(received).toHaveLength(1);
  });

  it('reads documented Atom metadata and builds literal field terms rather than query operators', async () => {
    responseBody = atom(); contentType = 'application/atom+xml; charset=UTF-8';
    const { providers, dispatch } = fixture();
    expect(providers[1].supports(science())).toBe(true); expect(providers[1].supports(tech())).toBe(false);
    expect(await providers[1].search(compileQuery('electron research OR id:2401.00001'), 3, signal())).toEqual([{ title: 'Research & science', url: 'https://arxiv.org/abs/2401.12345v2', snippet: 'Electron study α results.' }]);
    const target = new URL(dispatch.mock.calls[0][0]);
    expect(target.origin + target.pathname).toBe('https://export.arxiv.org/api/query');
    expect(target.searchParams.get('search_query')).toBe('all:"electron" AND all:"research" AND all:"id" AND all:"2401" AND all:"00001"');
    expect(target.searchParams.get('max_results')).toBe('3');
    expect(target.searchParams.get('sortBy')).toBe('relevance');
    expect(received[0].accept).toBe('application/atom+xml');
  });

  it('accepts prefixed Atom, CDATA, old arXiv identifiers and a genuine empty result', async () => {
    responseBody = atom('<entry><id>https://arxiv.org/abs/hep-th/9901001v1</id><title><![CDATA[Research <b>paper</b>]]></title><summary>Old research summary</summary></entry>')
      .replace(`xmlns="${ATOM}"`, `xmlns:a="${ATOM}"`).replace(/<(\/?)(feed|entry|id|title|updated|summary)(?=[\s>])/g, '<$1a:$2');
    contentType = 'application/atom+xml';
    const first = fixture();
    expect((await first.providers[1].search(science(), 4, signal()))[0]).toMatchObject({ title: 'Research paper', url: 'https://arxiv.org/abs/hep-th/9901001v1' });
    responseBody = atom('');
    expect(await fixture().providers[1].search(science(), 4, signal())).toEqual([]);
  });

  it('shares the arXiv connection and three-second admission boundary across factories', async () => {
    let clock = 1_000_000; const now = () => clock, one = fixture(now), two = extraDocumentedProviders(one.network, now);
    contentType = 'application/atom+xml'; responseBody = atom(); hold = true;
    const pending = one.providers[1].search(science(), 3, signal());
    await expect.poll(() => received.length).toBe(1);
    clock += 5000;
    await expect(two[1].search(science(), 3, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
    expect(received).toHaveLength(1);
    hold = false; held[0].end(responseBody); await pending;
    clock += 2999;
    await expect(two[1].search(science(), 3, signal())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(received).toHaveLength(1);
    clock++;
    await expect(two[1].search(science(), 3, signal())).resolves.toHaveLength(1);
    expect(received).toHaveLength(2);
  });

  it.each([0, 1])('honors HTTP 429 and Retry-After without repeating provider %i', async index => {
    const { providers } = fixture(); status = 429; retryAfter = '40';
    await expect(providers[index].search(index ? science() : tech(), 3, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40000 });
    await expect(providers[index].search(index ? science() : tech(), 3, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40000 });
    expect(received).toHaveLength(1);
  });

  it('cancels before dispatch and during the actual HTTP request', async () => {
    const { providers } = fixture(), controller = new AbortController(); controller.abort();
    await expect(providers[0].search(tech(), 3, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toHaveLength(0);
    const active = new AbortController(); hold = true;
    const pending = providers[0].search(tech(), 3, active.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => received.length).toBe(1); active.abort(); await rejected;
    held[0].end(responseBody);
  });

  it.each(['Node API password=private-value', 'Node API password%3Dprivate-value', 'Node API password%3Dprivate-value 50%', 'Node API https://example.com/?token%3Dprivate 50%', 'Node API https://example.com/?token=private', 'research sk-abcdefghijklmnopqrstuv'])('rejects recognizable query credentials before dispatch: %s', async text => {
    const { providers } = fixture();
    for (const provider of providers) await expect(provider.search(compileQuery(text), 3, signal())).rejects.toMatchObject({ code: 'RESEARCH_QUERY_SECRET' });
    expect(received).toHaveLength(0);
  });

  it.each(['null', '{"hits":"invalid"}', '{"hits":[{"objectID":"../private","title":"Node API"}]}', '{"hits":[{"objectID":"1","title":"Node API","story_text":{}}]}'])('rejects malformed HN metadata', async body => {
    responseBody = body;
    await expect(fixture().providers[0].search(tech(), 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it.each([
    atom().replace('</feed>', '</invalid>'),
    atom().replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns="urn:fake"'),
    atom().replace('2401.12345v2', '../private'),
    atom().replace('Research &amp; science', 'Research &unknown; science'),
    atom().replace('Research &amp; science', 'Research &#0; science'),
    atom().replace('<feed ', '<feed xmlns:dup="first" xmlns:dup="second" '),
    atom().replace('<entry>', '<entry><title>Duplicate title</title>'),
    atom().replace('http://arxiv.org/abs/2401.12345v2', 'http://arxiv.org/api/errors#incorrect_query'),
    `<!DOCTYPE feed [<!ENTITY exfil SYSTEM "file:///private">]>${atom()}`,
    `<!DOCTYPE feed [<!ENTITY a "&a;&a;">]>${atom()}`,
    `<feed xmlns="${ATOM}"><error>upstream failed</error></feed>`,
    atom().replace('<entry>', '<entry>' + '<nest>'.repeat(30)).replace('</entry>', '</nest>'.repeat(30) + '</entry>'),
  ])('rejects malformed, entity-bearing or non-contract Atom responses', async body => {
    responseBody = body; contentType = 'application/atom+xml';
    await expect(fixture().providers[1].search(science(), 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects unsupported charsets, invalid UTF-8 and oversized bodies', async () => {
    contentType = 'application/json; charset=iso-8859-1';
    await expect(fixture().providers[0].search(tech(), 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
    contentType = 'application/json'; responseBody = Buffer.from([0xc3, 0x28]);
    await expect(fixture().providers[0].search(tech(), 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
    responseBody = ' '.repeat(512001);
    await expect(fixture().providers[0].search(tech(), 3, signal())).rejects.toMatchObject({ kind: 'unavailable' });
    contentType = 'text/html'; responseBody = '<html>Challenge</html>';
    await expect(fixture().providers[1].search(science(), 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
