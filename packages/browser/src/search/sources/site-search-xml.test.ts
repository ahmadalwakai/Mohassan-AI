import { describe, expect, it } from 'vitest';
import { compileQuery } from '../ranking.js';
import { expandOpenSearch, feedEntries, openSearchTemplates, sitemapEntries } from './site-search-xml.js';

// OpenSearch 1.1 examples and template rules, retrieved 2026-11-27.
// https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md
const openSearch = 'http://a9.com/-/spec/opensearch/1.1/';
function descriptor(urls: string, fields = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <os:OpenSearchDescription xmlns:os="${openSearch}" xmlns:ext="http://example.com/extensions/">
      <os:ShortName>Example.com</os:ShortName>${fields}${urls}
    </os:OpenSearchDescription>`;
}
const arabic = compileQuery('سلام site:example.com');
const utf8Template = '<os:Url type="application/rss+xml" template="https://example.com/?q={os:searchTerms}&amp;start={startIndex}&amp;pw={startPage?}&amp;c={ext:color?}" indexOffset="0" pageOffset="2"/>';

describe('named host XML protocols', () => {
  it('decodes XML entities before substituting offsets and declared namespace parameters', () => {
    const [template] = openSearchTemplates(descriptor(utf8Template));
    expect(new URL(expandOpenSearch(template, arabic, 5)!).searchParams).toEqual(
      new URLSearchParams({ q: arabic.question, start: '0', pw: '2', c: '' }),
    );
  });

  it('skips private, closed, suggestion and POST templates and rejects unknown required parameters', () => {
    const after = (field: string) => openSearchTemplates(descriptor(utf8Template, `<os:SyndicationRight>${field}</os:SyndicationRight>`));
    expect(after('private')).toEqual([]);
    expect(after('closed')).toEqual([]);
    expect(after('limited')).toHaveLength(1);
    expect(openSearchTemplates(descriptor(utf8Template.replace('type=', 'rel="suggestions" type=')))).toEqual([]);
    expect(openSearchTemplates(descriptor(utf8Template.replace('type=', 'method="POST" type=')))).toEqual([]);
    const [template] = openSearchTemplates(descriptor(utf8Template.replace('{ext:color?}', '{ext:color}')));
    expect(expandOpenSearch(template, arabic, 5)).toBeUndefined();
  });

  it('honors the declared Arabic request and response encoding', () => {
    // WHATWG index pointers for س ل ا م, retrieved 2026-11-27.
    // https://encoding.spec.whatwg.org/index-windows-1256.txt
    const arabicBytes = [83, 97, 71, 99].map(pointer => '%' + (pointer + 128).toString(16).toUpperCase()).join('');
    const [template] = openSearchTemplates(descriptor(
      '<os:Url type="application/atom+xml" template="https://example.com/?q={searchTerms}&amp;ie={inputEncoding}&amp;oe={outputEncoding}"/>',
      '<os:InputEncoding>windows-1256</os:InputEncoding><os:OutputEncoding>windows-1256</os:OutputEncoding>',
    ));
    expect(template.outputEncoding).toBe('windows-1256');
    expect(expandOpenSearch(template, arabic, 5)).toBe(`https://example.com/?q=${arabicBytes}&ie=windows-1256&oe=windows-1256`);
  });

  it('reads Atom XHTML and the alternate document URL under xml:base, excluding enclosures', () => {
    // Adapted from the Atom 1.0 extended example, retrieved 2026-11-27.
    // https://www.rfc-editor.org/rfc/rfc4287#section-1.1
    const source = `<?xml version="1.0" encoding="utf-8"?>
      <a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://example.org/2005/">
        <a:entry>
          <a:title>Atom draft-07 snapshot</a:title>
          <a:link rel="enclosure" type="audio/mpeg" href="/audio/ph34r_my_podcast.mp3"/>
          <a:link rel="alternate" type="text/html" href="04/02/atom"/>
          <a:content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
            <p><i>[Update: The Atom draft is finished.]</i></p>
          </div></a:content>
        </a:entry>
      </a:feed>`;
    expect(feedEntries(source, 'https://example.org/feed.atom')).toEqual([{
      title: 'Atom draft-07 snapshot', url: 'https://example.org/2005/04/02/atom', snippet: '[Update: The Atom draft is finished.]',
    }]);
    expect(feedEntries(source.replace('http://www.w3.org/2005/Atom', 'http://example.org/'), 'https://example.org/feed.atom')).toBeUndefined();
  });

  it('accepts sitemap timestamps and inert stylesheets and rejects DTDs', () => {
    // Sample sitemap index, retrieved 2026-11-27.
    // https://www.sitemaps.org/protocol.html#index
    const source = `<?xml version="1.0" encoding="UTF-8"?>
      <?xml-stylesheet type="text/xsl" href="https://www.example.com/sitemap.xsl"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>http://www.example.com/sitemap1.xml.gz</loc><lastmod>2004-10-01T18:23:17+00:00</lastmod></sitemap>
        <sitemap><loc>http://www.example.com/sitemap2.xml.gz</loc><lastmod>2005-01-01</lastmod></sitemap>
      </sitemapindex>`;
    expect(sitemapEntries(source)).toEqual({ index: true, entries: [
      { url: 'http://www.example.com/sitemap1.xml.gz', updated: Date.parse('2004-10-01T18:23:17+00:00') },
      { url: 'http://www.example.com/sitemap2.xml.gz', updated: Date.parse('2005-01-01') },
    ] });
    expect(sitemapEntries(source.replace('<sitemapindex xmlns=', '<!DOCTYPE sitemapindex><sitemapindex xmlns='))).toBeUndefined();
  });
});
