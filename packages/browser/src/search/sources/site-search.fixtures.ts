export const html = (head = '', body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

// The OpenSearch 1.1 examples (retrieved 2026-11-27, CC BY-SA 4.0):
// https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md
// The sample responses below retain the example search and result. HTTPS and a
// same-host mirror of the example result exercise the provider's host boundary.
export const exampleHost = 'https://example.com';
export const searchLink = (href: string) => `<link rel="search" type="application/opensearchdescription+xml" href="${href}">`;
export const description = (templates: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Web Search</ShortName>
  <Description>Use Example.com to search the Web.</Description>
  ${extra}
  ${templates}
</OpenSearchDescription>`;
export const exampleDescription = description(`
  <Url type="text/html" template="https://example.com/?q={searchTerms}&amp;pw={startPage?}"/>
  <Url type="application/rss+xml" template="https://example.com/?q={searchTerms}&amp;pw={startPage?}&amp;format=rss"/>`);
export const exampleRssResults = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <channel>
    <title>Example.com Search: New York history</title>
    <link>https://example.com/New+York+history</link>
    <description>Search results for "New York history" at Example.com</description>
    <opensearch:totalResults>2</opensearch:totalResults>
    <item>
      <title>New York History</title>
      <link>https://example.com/new-york-history</link>
      <description>A virtual tour and information on businesses.</description>
    </item>
    <item>
      <title>New York History</title>
      <link>https://www.columbia.edu/cu/lweb/eguids/amerihist/nyc.html</link>
      <description>A virtual tour and information on businesses.</description>
    </item>
  </channel>
</rss>`;

// DokuWiki response excerpts, retrieved 2026-11-27, CC BY-SA 4.0 for wiki content.
// https://www.dokuwiki.org/ and https://www.dokuwiki.org/robots.txt
// https://www.dokuwiki.org/lib/exe/opensearch.php
// https://www.dokuwiki.org/doku.php?do=search&id=syntax
// https://www.dokuwiki.org/syntax?do=search&q=syntax
export const dokuWiki = {
  origin: 'https://www.dokuwiki.org',
  robots: `User-agent: JobSpider
Disallow: /

User-agent: JobSpider_BA
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: *
Crawl-delay: 5
`,
  home: html('<link rel="search" type="application/opensearchdescription+xml" href="/lib/exe/opensearch.php" title="DokuWiki"/>'),
  descriptor: `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>DokuWiki</ShortName>
  <Image width="16" height="16" type="image/x-icon">https://www.dokuwiki.org/lib/tpl/dokuwiki/images/favicon.ico</Image>
  <Url type="text/html" template="https://www.dokuwiki.org/doku.php?do=search&amp;id={searchTerms}" />
  <Url type="application/x-suggestions+json" template="https://www.dokuwiki.org/lib/exe/ajax.php?call=suggestions&amp;q={searchTerms}" />
</OpenSearchDescription>`,
  results: html('<title>Search [DokuWiki]</title>', `
<dl class="search_results"><div class="search_fullpage_result">
  <dt><a href="/de:features?s[]=syntax" class="wikilink1" title="de:features" data-wiki-id="de:features">features</a> <a href="/syntax?do=search&amp;sf=1&amp;q=syntax%20%40de">@de</a></dt>
  <dd class="meta"><span class="hits">3990840912 Hits</span></dd>
  <dd class="snippet">===== Grundlegendes =====
    * Einfache [[de:wiki:<strong class="search_hit">syntax</strong>|<strong class="search_hit">Syntax</strong>]]!</dd>
</div></dl>`),
};

// RFC Editor response excerpts, retrieved 2026-11-27. The Atom excerpt retains
// two entries with abridged summaries to exercise local query matching.
// https://www.rfc-editor.org/ and https://www.rfc-editor.org/robots.txt
// https://www.rfc-editor.org/rfcatom.xml
// https://www.rfc-editor.org/sitemap.xml and https://www.rfc-editor.org/sitemap-1.xml
// https://www.rfc-editor.org/authors/rfc-style-guide/
export const rfcEditor = {
  origin: 'https://www.rfc-editor.org',
  robots: `User-agent: *
Disallow: /rfc/authors/
Disallow: /rfc/rerendered/
Disallow: /rfc/v3test/
Sitemap: https://www.rfc-editor.org/sitemap.xml
`,
  homeWithFeeds: html(`<link rel="alternate" type="application/rss+xml" title="RFC RSS Feed" href="https://www.rfc-editor.org/rfcrss.xml">
<link rel="alternate" type="application/atom+xml" title="RFC ATOM Feed" href="https://www.rfc-editor.org/rfcatom.xml">`),
  atom: `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://www.rfc-editor.org</id>
  <title>Recent RFCs</title>
  <updated>2026-11-26T20:15:07.899Z</updated>
  <entry>
    <title type="html"><![CDATA[RFC 10090: BGP Usage for Software-Defined WAN (SD-WAN) Overlay Networks]]></title>
    <id>https://www.rfc-editor.org/info/rfc10090/</id>
    <link href="https://www.rfc-editor.org/info/rfc10090/"/>
    <updated>2026-11-23T00:00:00.000Z</updated>
    <summary type="html"><![CDATA[This document illustrates how a BGP-based control plane can be used to manage large-scale Software-Defined WAN (SD-WAN) overlay networks]]></summary>
  </entry>
  <entry>
    <title type="html"><![CDATA[RFC 10021: Group Object Security for Constrained RESTful Environments (Group OSCORE)]]></title>
    <id>https://www.rfc-editor.org/info/rfc10021/</id>
    <link href="https://www.rfc-editor.org/info/rfc10021/"/>
    <updated>2026-11-19T00:00:00.000Z</updated>
    <summary type="html"><![CDATA[This document defines the security protocol Group Object Security for Constrained RESTful Environments (Group OSCORE)]]></summary>
  </entry>
</feed>`,
  index: sitemap('sitemapindex', ['https://www.rfc-editor.org/sitemap-1.xml', 'https://www.rfc-editor.org/sitemap-2.xml']),
  sitemap: sitemap('urlset', ['https://www.rfc-editor.org/authors/rfc-how-to/', 'https://www.rfc-editor.org/authors/rfc-style-guide/']),
  styleGuide: html('<title>Style Guide | RFC Editor</title>', '<main><h1>Style Guide</h1><p>RFC 7322, "RFC Style Guide"</p></main>'),
};

// Sitemap structure and lastmod values follow the protocol examples (retrieved 2026-11-27).
// https://www.sitemaps.org/protocol.html
export function sitemap(type: 'urlset' | 'sitemapindex', urls: string[], dates: string[] = []): string {
  const row = type === 'urlset' ? 'url' : 'sitemap';
  return `<?xml version="1.0" encoding="UTF-8"?>
<${type} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url, i) =>
  `<${row}><loc>${url}</loc>${dates[i] ? `<lastmod>${dates[i]}</lastmod>` : ''}</${row}>`).join('')}</${type}>`;
}

// W3C Arabic examples served with real windows-1256 bytes computed by
// iconv -f UTF-8 -t WINDOWS-1256. Sources retrieved 2026-11-27.
// https://www.w3.org/International/articles/inline-bidi-markup/
// https://encoding.spec.whatwg.org/index-windows-1256.txt
export const arabicPage = Buffer.concat([
  Buffer.from('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="windows-1256"><title>'),
  Buffer.from('e3cfcee120c5e1ec', 'hex'), // مدخل إلى
  Buffer.from(' C++</title></head><body><main><p>'),
  Buffer.from('c7cac8da20e5d0e520c7e1d1e6c7c8d820c8c7e1cad1caedc8', 'hex'), // اتبع هذه الروابط بالترتيب
  Buffer.from('</p></main></body></html>'),
]);
