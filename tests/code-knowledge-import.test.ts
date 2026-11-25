import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validateCorpus } from '../packages/code-knowledge/src/corpus.js';
import { importOfficial } from '../packages/code-knowledge/src/import/official.js';
import { htmlSection, markdownSections, pythonSections } from '../packages/code-knowledge/src/import/snippets.js';
import { importStackExchange } from '../packages/code-knowledge/src/import/stack-exchange.js';

describe('official programming documentation extraction', () => {
  it('renders prose formatting while preserving every character of fenced code', () => {
    const markdown = [
      '---', 'title: Example API', 'slug: Web/API/Example', '---', '',
      'The _return value_ is stored in `snake_case` as `Array<number>`.', '', '## Examples', '',
      '```js example-bad', '  value = "";  ', '', '```', '',
      '```js example-good', '  value = "<tag>";', '```',
    ].join('\r\n');
    const { frontmatter, sections } = markdownSections(markdown, code => code);
    expect(frontmatter.slug).toBe('Web/API/Example');
    expect(sections[0].text).toBe('The return value is stored in snake_case as Array<number>.');
    expect(sections[1]).toMatchObject({ anchor: 'examples', code: [
      { language: 'js', role: 'failure', text: '  value = "";  \r\n\r\n' },
      { language: 'js', role: 'fix', text: '  value = "<tag>";\r\n' },
    ] });
  });

  it('decodes rendered HTML code exactly and retains Python API citation anchors', () => {
    const html = '<div class="body" role="main"><h1>API</h1><nav class="contents"><p>Contents</p></nav>'
      + '<dt class="sig sig-object py" id="sample.get">sample.get</dt><dd><p>Returns a string.</p>'
      + '<pre><span></span>  value = &quot;&lt;tag&gt;&amp;field&quot;\n\n</pre></dd>'
      + '<div class="sphinxsidebar"><p>Sidebar</p></div>';
    expect(pythonSections(html, { license: '0BSD' })).toEqual([
      { title: 'sample.get', anchor: 'sample.get', text: 'Returns a string.', code: [
        { text: '  value = "<tag>&field"\n\n', language: 'python', license: '0BSD' },
      ] },
    ]);
    expect(htmlSection('<p>Readable <code>&lt;tag&gt;</code>.</p><pre>&unrecognized;</pre>')).toEqual({
      text: 'Readable <tag>.', code: [],
    });
  });

  it('checks the upstream license before importing any documents', async () => {
    const urls: string[] = [];
    const invalidLicense = async (url: string) => { urls.push(url); return 'unexpected license'; };
    await expect(importOfficial('mdn', invalidLicense)).rejects.toThrow('License check failed');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/LICENSE.md');
  });

  it('checks MDN code provenance per block and fingerprints the input bytes', async () => {
    function content(mark: string) {
      return async (url: string) => url.endsWith('/LICENSE.md') ? 'CC-BY-SA 2.5' : [
        '---', 'title: Page', 'slug: Web/API/Page', '---', '',
        'A paragraph ' + mark + '.', '', '## Return value', '',
        '```js', 'Promise.all(values);', '```', '',
        '```js', 'old_examples();', '```',
      ].join('\n');
    }
    const one = await importOfficial('mdn', content('one'));
    const two = await importOfficial('mdn', content('two'));
    expect(one.sources[0].fingerprint).toMatch(/^sha256:[a-f\d]{64}$/);
    expect(one.sources[0].fingerprint).not.toBe(two.sources[0].fingerprint);
    expect(one.passages).toContainEqual(expect.objectContaining({
      symbols: ['Promise.all'],
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/Page#return_value',
      code: [{ text: 'Promise.all(values);\n', language: 'js', role: undefined,
        license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' }],
    }));
    expect(one.passages.filter(passage => passage.symbols?.includes('Array.prototype.map')).every(passage => !passage.code.length)).toBe(true);
    expect(one.passages.flatMap(passage => passage.code).some(code => code.text.includes('old_examples'))).toBe(false);
  });
});

describe('Stack Exchange dump import', () => {
  // Inputs model the official XML serialization, including both tag encodings and multiline attributes.
  const body = '&lt;p&gt;Original prose.&lt;/p&gt;&lt;pre&gt;&lt;code&gt;&amp;lt;tag&amp;gt;&#xA;&lt;/code&gt;&lt;/pre&gt;';
  const posts = [
    '<?xml version="1.0" encoding="utf-8"?>', '<posts>',
    '<row Id="1" PostTypeId="1" AcceptedAnswerId="3" OwnerUserId="10" Tags="|typescript|unrelated|" Title="Original question" ContentLicense="CC BY-SA 4.0" LastEditDate="2020-01-01" />',
    '<row Id="2" PostTypeId="1" Tags="&lt;sql&gt;" OwnerUserId="10" Title="Other question" ContentLicense="CC BY-SA 2.5" />',
    '<row Id="3" PostTypeId="2" ParentId="1" OwnerUserId="11" LastEditorUserId="12" LastEditDate="2023-01-01" ContentLicense="CC BY-SA 4.0" Score="1" Body="' + body + '" />',
    '<row Id="4" PostTypeId="2" ParentId="1" OwnerUserId="11" ContentLicense="CC BY-SA 4.0" Score="2" Body="' + body + '" />',
    '<row Id="5" PostTypeId="2" ParentId="2" OwnerDisplayName="Anonymous &amp; public" ContentLicense="CC BY-SA 3.0" Score="22" Body="' + body + '" />',
    '<row Id="6" PostTypeId="2" ParentId="1" OwnerUserId="11" Score="25" Body="' + body + '" />',
    '<row Id="7" PostTypeId="1" Tags="|unrelated|" OwnerUserId="10" Title="Unrelated" ContentLicense="CC BY-SA 4.0" />',
    '<row Id="8" PostTypeId="2" ParentId="7" OwnerUserId="11" ContentLicense="CC BY-SA 4.0" Score="35" Body="' + body + '" />',
    '</posts>',
  ].join('\n');
  const users = '<users>\n<row Id="10" DisplayName="Question author" AboutMe="Line one\nLine two" />\n'
    + '<row Id="11" DisplayName="Author &amp; Co" />\n<row Id="12" DisplayName="Editor" />\n</users>';
  const stream = (text: string) => () => {
    const bytes = Buffer.from(text);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 27) chunks.push(bytes.subarray(offset, offset + 27));
    return Readable.from(chunks);
  };
  const input = { site: 'stackoverflow' as const, version: 'test snapshot', posts: stream(posts), users: stream(users) };

  it('imports accepted or high-score programming answers with exact code and per-post attribution', async () => {
    const corpus = validateCorpus(await importStackExchange(input));
    expect(corpus.passages.map(passage => passage.id)).toEqual(['stack-exchange:stackoverflow:3', 'stack-exchange:stackoverflow:5']);
    expect(corpus.passages[0]).toMatchObject({
      title: 'Original question', questionUrl: 'https://stackoverflow.com/questions/1', url: 'https://stackoverflow.com/a/3',
      license: 'CC-BY-SA-4.0', tags: ['typescript'], text: 'Original prose.', code: [{ text: '<tag>\n' }],
      attribution: [
        { name: 'Author & Co', url: 'https://stackoverflow.com/users/11' },
        { name: 'Editor', url: 'https://stackoverflow.com/users/12' },
        { name: 'Answer revision history', url: 'https://stackoverflow.com/posts/3/revisions' },
        { name: 'Question author', url: 'https://stackoverflow.com/users/10' },
        { name: 'Question revision history', url: 'https://stackoverflow.com/posts/1/revisions' },
      ],
    });
    expect(corpus.passages[1]).toMatchObject({
      title: 'Stack Overflow answer #5', license: 'CC-BY-SA-3.0', tags: ['sql'], attribution: [{ name: 'Anonymous & public' }],
    });
    const bounded = await importStackExchange({ ...input, maxAnswers: 1 });
    expect(bounded.passages.map(passage => passage.id)).toEqual(['stack-exchange:stackoverflow:5']);
    expect(bounded.sources[0].fingerprint).toBe(corpus.sources[0].fingerprint);
  });

  it('rejects an incomplete dump and changes to the post stream between scans', async () => {
    await expect(importStackExchange({ ...input, users: stream('<users>\n') })).rejects.toThrow('Incomplete Stack Exchange users XML');
    let first = true;
    await expect(importStackExchange({ ...input, posts: () => {
      const source = first ? posts : posts + '\n';
      first = false;
      return stream(source)();
    } })).rejects.toThrow('Posts.xml changed');
  });
});
