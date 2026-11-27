import { describe, expect, it } from 'vitest';
import type { SafeResponse } from '../../network.js';
import { decodeSiteText, homepageLinks, htmlSearchEntries, htmlSource, requiresAccount } from './site-search-html.js';
import { arabicPage, exampleHost, html, searchLink } from './site-search.fixtures.js';

describe('named site HTML parsing', () => {
  it('resolves advertised links against the HTML base and ignores feed-like stylesheets', () => {
    // The first base href is the document base. HTML Standard, checked 2026-11-27.
    // https://html.spec.whatwg.org/multipage/semantics.html#the-base-element
    const base = new URL('/docs/', exampleHost);
    const page = html(`<base href="${base.pathname}"><base href="/ignored/">
      ${searchLink('opensearch.xml')}
      <link rel="alternate" type="application/atom+xml" href="atom.xml">
      <link rel="stylesheet" href="/rss/site.css">`);
    expect(homepageLinks(page, exampleHost)).toEqual({
      descriptions: [new URL('opensearch.xml', base).href],
      feeds: [new URL('atom.xml', base).href],
    });
  });

  it('keeps visible results and the surrounding text while excluding pagination and nav', () => {
    const base = new URL('/docs/', exampleHost);
    const title = ['New', 'York History'].join(' ');
    const snippet = 'A virtual tour and information on businesses.';
    // OpenSearch 1.1 RSS example, retrieved 2026-11-27.
    // https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md
    const page = html(`<base href="${base.pathname}">`, `<main id="search-results">
      <nav><h2><a href="nav">Navigation</a></h2></nav>
      <div><a href="history"><em>New</em> York History</a><p>${snippet}</p></div>
      <div class="pagination"><a href="next">Next</a></div>
      <div hidden><a href="hidden">Hidden</a></div>
    </main>`);
    expect(htmlSearchEntries(page, exampleHost)).toEqual([{ title, url: new URL('history', base).href, snippet }]);
  });

  it('honors BOM and HTTP charset precedence and rejects invalid declared UTF-8', () => {
    const decoded = new TextDecoder('windows-1256').decode(arabicPage);
    const response = (body: Buffer, type: string): SafeResponse => ({
      status: 200, url: exampleHost, headers: { 'content-type': type }, body,
    });
    // The BOM wins over the HTTP and meta declarations. Encoding Standard, checked 2026-11-27.
    // https://encoding.spec.whatwg.org/#decode
    expect(decodeSiteText(response(Buffer.from('\uFEFF' + decoded), 'text/html; charset=windows-1256'))).toBe(decoded);
    expect(decodeSiteText(response(arabicPage, 'text/html; charset=utf-8'))).toBeUndefined();
  });

  it('omits main-page snippets on an explicit zero-length directive', () => {
    const page = html('<meta name="robots" content="max-snippet: 0">', '<main><h1>New York History</h1></main>');
    expect(htmlSource(page)).toMatchObject({ title: 'New York History', indexable: true, snippetAllowed: false });
  });

  it('ignores header widgets and results whose title contains a search for login', () => {
    const form = '<form><input type="password"></form>';
    expect(requiresAccount(html('<title>Sign in</title>', `<header>${form}</header><main>Public article</main>`))).toBe(false);
    expect(requiresAccount(html('<title>Search for login</title>', `<main>${form}</main>`))).toBe(false);
  });
});
