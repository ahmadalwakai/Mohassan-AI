import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importWikipedia, openWikipediaIndex, parseWikipediaLead, type WikipediaInput } from '../packages/knowledge-base/src/wikipedia.ts';

function fixture(language: WikipediaInput['language']): WikipediaInput {
  return {
    inputPath: fileURLToPath(new URL(`./fixtures/knowledge-base/wikipedia-${language}.fixture.xml`, import.meta.url)),
    language,
    source: `fixture:hand-built-wikipedia-${language}`,
    dumpDate: '2025-01-01',
  };
}

describe('offline bilingual Wikipedia index', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-wikipedia-'));
    databasePath = join(directory, 'articles.sqlite');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('streams current-edition XML, records input fingerprints, and searches only leads with BM25', async () => {
    const en = fixture('en');
    const raw = await readFile(en.inputPath);
    const compressed = join(directory, 'en.xml.gz');
    await writeFile(compressed, gzipSync(raw));
    const card = await importWikipedia({ databasePath, inputs: [{ ...en, inputPath: compressed }, fixture('ar')] });
    expect(card).toEqual(expect.objectContaining({
      license: 'CC-BY-SA-4.0', fingerprintOf: 'decompressed XML bytes', storeBytes: (await stat(databasePath)).size,
    }));
    expect(card.sources).toEqual([
      expect.objectContaining({
        source: en.source, dumpDate: en.dumpDate, pages: 4, articles: 2, leads: 2, facts: 4,
        inputBytes: raw.length, fingerprint: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      }),
      expect.objectContaining({ language: 'ar', pages: 2, articles: 2, leads: 2, facts: 3 }),
    ]);

    const index = openWikipediaIndex(databasePath);
    try {
      expect(index.card).toEqual(card);
      const hits = index.searchLeads('Amber Point', { language: 'en' });
      expect(hits.map(hit => hit.attribution.title)).toEqual(['Amber Point', 'Ochre Point']);
      expect(hits[0].bm25).toBeLessThan(hits[1].bm25);
      expect(hits[0].lead).toContain('Amber Point is a coastal fixture near the harbor. A & B are locations');
      expect(index.searchLeads('lighthouse')).toEqual([]);
      expect(index.searchLeads('fictional')).toEqual([]);
      expect(index.searchLeads('أرض العنبر', { language: 'ar' })[0].attribution.pageId).toBe('41');
      expect(index.searchLeads('أرض العنبر', { language: 'en' })).toEqual([]);
      expect(index.searchLeads('”*:"-')).toEqual([]);
      expect(index.searchLeads('Amber', { limit: 0 })).toEqual([]);
    } finally {
      index.close();
    }
  });

  it('keeps nested wikitext fields intact and attributes every field and hit to a specific revision', async () => {
    const en = fixture('en');
    await importWikipedia({ databasePath, inputs: [en, fixture('ar')] });
    const index = openWikipediaIndex(databasePath);
    try {
      const attribution = {
        source: 'Wikipedia', dumpSource: en.source, dumpDate: en.dumpDate,
        title: 'Amber Point', pageId: '41', language: 'en', revisionId: '105', revisionDate: '2024-03-01T12:13:14Z',
        revisionUrl: 'https://en.wikipedia.org/w/index.php?oldid=105',
        author: 'Wikipedia contributors', historyUrl: 'https://en.wikipedia.org/w/index.php?title=Amber_Point&action=history',
        license: 'CC-BY-SA-4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      };
      const lead = index.searchLeads('Amber')[0];
      expect(lead.attribution).toEqual({ ...attribution, changes: expect.stringContaining('Lead extracted') });
      const facts = index.infobox('en', '41');
      expect(facts.map(fact => [fact.key, fact.wikitext])).toEqual([
        ['name', 'Amber Point'],
        ['population', '1800<ref name="fixture">A fake source | reference_only = fictional</ref>'],
        ['location', '[[Fixture County#Locations|Fixture County]]'],
        ['area_total', '{{convert|10|km2|abbr=on}}'],
      ]);
      for (const fact of facts) {
        expect(fact.template).toBe('Infobox settlement');
        expect(fact.attribution).toEqual({ ...attribution, changes: expect.stringContaining('unexpanded') });
      }
      expect(index.infobox('ar', '41')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'تعداد_السكان', wikitext: '١٨٠٠',
          attribution: expect.objectContaining({ revisionUrl: 'https://ar.wikipedia.org/w/index.php?oldid=511', revisionDate: '2024-06-02T09:10:11Z' }),
        }),
      ]));
      expect(index.infobox('en', '43')).toEqual([]);
    } finally {
      index.close();
    }
  });

  it('rejects the wrong edition and incomplete XML and leaves no partial index', async () => {
    await expect(importWikipedia({ databasePath, inputs: [{ ...fixture('en'), language: 'ar' }] })).rejects.toThrow(/edition/);
    expect(await readdir(directory)).toEqual([]);
    const inputPath = join(directory, 'broken.xml');
    const raw = await readFile(fixture('en').inputPath, 'utf8');
    await writeFile(inputPath, raw.replace('</mediawiki>', ''));
    await expect(importWikipedia({ databasePath, inputs: [{ ...fixture('en'), inputPath }] })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['broken.xml']);
  });

  it('rejects a truncated gzip stream even when its XML is complete', async () => {
    const en = fixture('en');
    const inputPath = join(directory, 'truncated.xml.gz');
    const data = gzipSync(await readFile(en.inputPath));
    await writeFile(inputPath, data.subarray(0, -8));
    await expect(importWikipedia({ databasePath, inputs: [{ ...en, inputPath }] })).rejects.toThrow(/unexpected end/);
    expect(await readdir(directory)).toEqual(['truncated.xml.gz']);
  });

  it('leaves an existing snapshot intact when asked to reuse its path', async () => {
    const card = await importWikipedia({ databasePath, inputs: [fixture('en')] });
    await expect(importWikipedia({ databasePath, inputs: [fixture('ar')] })).rejects.toThrow(/already exists/);
    const index = openWikipediaIndex(databasePath);
    try {
      expect(index.card).toEqual(card);
    } finally {
      index.close();
    }
  });

  it('counts articles above the text limit and continues to index following pages', async () => {
    const inputPath = join(directory, 'bounded.xml');
    const en = fixture('en');
    const raw = await readFile(en.inputPath, 'utf8');
    await writeFile(inputPath, raw.replace('{{Short description', 'oversized '.repeat(450_000) + '{{Short description'));
    const card = await importWikipedia({ databasePath, inputs: [{ ...en, inputPath }] });
    expect(card.sources[0]).toEqual(expect.objectContaining({ pages: 4, articles: 1, leads: 1, skippedOversizedPages: 1 }));
    const index = openWikipediaIndex(databasePath);
    try {
      expect(index.searchLeads('Point').map(hit => hit.attribution.title)).toEqual(['Ochre Point']);
      expect(index.infobox('en', '41')).toEqual([]);
    } finally {
      index.close();
    }
  });

  it('rejects a DTD rather than accepting externally defined XML entities', async () => {
    const inputPath = join(directory, 'doctype.xml');
    const en = fixture('en');
    await writeFile(inputPath, '<!DOCTYPE mediawiki [<!ENTITY example SYSTEM "file:///unreadable">]><mediawiki />');
    await expect(importWikipedia({ databasePath, inputs: [{ ...en, inputPath }] })).rejects.toThrow(/doctype/);
    expect(await readdir(directory)).toEqual(['doctype.xml']);
  });

  it('excludes headings inside templates, inline tags, and post-lead fields from the result', () => {
    const sample = `{{Infobox test
| example = {{lang|en|[[Article|literal pipe]]}}
== Template heading ==
| formula = <nowiki>x|y=z</nowiki>
}}
Lead text. [https://example.test label]
{| class="wikitable"
| a table
|}
== Section ==
{{Infobox body|ignored=no}}`;
    expect(parseWikipediaLead(sample)).toEqual({
      lead: 'Lead text. label',
      fields: [
        { template: 'Infobox test', key: 'example', wikitext: '{{lang|en|[[Article|literal pipe]]}}\n== Template heading ==' },
        { template: 'Infobox test', key: 'formula', wikitext: '<nowiki>x|y=z</nowiki>' },
      ],
    });
  });
});
