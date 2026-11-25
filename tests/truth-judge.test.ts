import { describe, expect, it, vi } from 'vitest';
import { judgeTruth } from '../apps/server/src/assistant/truth-judge.js';
import { nodeLatest, RELEASE_SOURCES, releaseLines } from '../apps/server/src/assistant/releases.js';
import { truthCases, developmentProvenance } from './fixtures/truth-checks.js';

const question = 'How many visitors attended the Rowan Fair?';
const primary = { url: 'https://fairboard.example/admission-count', quote: '8 visitors attended the Rowan Fair.' };
const independent = { url: 'https://townnews.example/report', quote: '8 visitors attended the Rowan Fair. The fair was held in the park.' };
const conflict = { url: 'https://townnews.example/report', quote: '12 visitors attended the Rowan Fair.' };
const irrelevant = { url: 'https://townnews.example/report', quote: '12 visitors attended the Willow Fair.' };
const reply = `${primary.quote}\n\n**Source:** [Fair Board](${primary.url}) · read 2026-11-25 14:30 UTC`;
const input = { question, reply, pages: [primary] };

describe('truth judge policy', () => {
  // All cases authored in this test are agent-written development cases.
  it('withholds a date or figure answering a different question even when quoted verbatim', async () => {
    const page = { url: 'https://archive.example/report', quote: 'The Berlin Wall fell on 9 November 1989. Germany reunited on 3 October 1990.' };
    const lookup = vi.fn();
    const verdict = await judgeTruth({ question: 'When did the Berlin Wall fall?', reply: 'Germany reunited on 3 October 1990.', pages: [page], lookup });
    expect(verdict).toMatchObject({ decision: 'withhold', measured: true });
    expect(verdict.replacement).toMatch(/\p{Script=Arabic}/u);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps a supported answer and removes an unsupported name or assertion', async () => {
    const book = 'Mina Clarke wrote The Copper Map.';
    const verdict = await judgeTruth({ question: 'Who wrote The Copper Map?', reply: `${book} Noel West edited the book.`,
      pages: [{ url: primary.url, quote: book }] });
    expect(verdict).toMatchObject({ decision: 'fix', repaired: true });
    expect(verdict.replacement).toContain(book);
    expect(verdict.replacement).not.toContain('Noel West');
  });

  it('omits unsafe URLs when rebuilding a reply', async () => {
    const book = 'Mina Clarke wrote The Copper Map.';
    const verdict = await judgeTruth({ question: 'Who wrote The Copper Map?', reply: `${book} Noel West edited the book.`,
      pages: [{ url: 'https://archive.example/book?session=example-placeholder', quote: book }] });
    expect(verdict).toMatchObject({ decision: 'fix', replacement: book });
  });

  it('consults a single extra independent page and cites confirmation', async () => {
    const lookup = vi.fn(async () => independent);
    const verdict = await judgeTruth({ ...input, lookup });
    expect(lookup).toHaveBeenCalledExactlyOnceWith([primary]);
    expect(verdict).toMatchObject({ decision: 'fix', source: 'confirmed', lookup: true, repaired: false });
    expect(verdict.replacement).toContain('Independent sources confirm the values');
    expect(verdict.replacement).toContain(independent.url);
  });

  it('counts genuinely independent existing evidence without fetching again', async () => {
    const lookup = vi.fn();
    const verdict = await judgeTruth({ ...input, pages: [primary, independent], lookup });
    expect(verdict).toMatchObject({ source: 'confirmed', lookup: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('declares conflict in Arabic and does not send the disputed figure', async () => {
    const verdict = await judgeTruth({ ...input, lookup: async () => conflict });
    expect(verdict).toMatchObject({ decision: 'withhold', source: 'conflict', codes: ['source_conflict'] });
    expect(verdict.replacement).toContain('وجدت قيمًا مختلفة');
    expect(verdict.replacement).toContain(conflict.url);
    expect(verdict.replacement).not.toContain('8 visitors');
  });

  it.each([null, irrelevant, { ...conflict, url: 'https://news.fairboard.example/second' }])(
    'qualifies the Arabic answer when there is no independent matching value (%j)', async extra => {
      const page = { url: primary.url, quote: 'حضر معرض الصفصاف 20 زائرًا.' };
      const oldNote = '**مصدر ثانٍ يؤكد:** [صفحة](https://copy.example/report)';
      const verdict = await judgeTruth({ question: 'كم عدد زوار معرض الصفصاف؟', reply: `${page.quote}\n\n${oldNote}`, pages: [page], lookup: async () => extra });
      expect(verdict).toMatchObject({ decision: 'fix', source: 'single_source', repaired: false });
      expect(verdict.replacement).toContain('وفق مصدر واحد');
      expect(verdict.replacement).not.toContain(oldNote);
    },
  );

  it('requires evidence from the cited page and declines a reply with a fabricated citation', async () => {
    const verdict = await judgeTruth({ ...input, pages: [independent] });
    expect(verdict).toMatchObject({ decision: 'withhold', measured: false, codes: ['evidence_unavailable'] });
  });

  it('reparses the official release entry, labels its date formatting and removes added assertions', async () => {
    const source = RELEASE_SOURCES[0]!;
    const entry = 'node-v26.13.1-linux-x64.tar.gz 11-Nov-2026 16:41';
    const [line] = releaseLines(source, nodeLatest(entry)!, 'en');
    const cited = `**Source:** [Official release](${source.page})`;
    const verdict = await judgeTruth({ question: 'What is the latest version of Node.js?',
      pages: [{ url: source.page, quote: entry }], reply: `${line}\n\n> ${entry}\n\nIt includes 17 new APIs.\n\n${cited}` });
    expect(verdict).toMatchObject({ decision: 'fix', source: 'single_source' });
    expect(verdict.replacement).toContain('Date and time converted from the quoted entry');
    expect(verdict.replacement).not.toContain('17 new APIs');
    expect((await judgeTruth({ question: 'What is the latest version of Node.js?',
      pages: [{ url: source.page, quote: entry }], reply: `${line?.replace('26.13.1', '26.14.0')}\n\n${cited}` })).decision).toBe('withhold');
    expect(await judgeTruth({ question: 'What is the latest LTS version of Node.js?',
      pages: [{ url: source.page, quote: entry }], reply: `${line}\n\n${cited}` })).toMatchObject({ decision: 'withhold', codes: ['wrong_relation'] });
    expect(await judgeTruth({ question: 'What is the latest version of Node.js?',
      pages: [{ url: source.page, quote: entry }], reply: `${line}\n\n${cited}`,
      lookup: async () => ({ url: 'https://archive.example/node-20', title: 'Archive for Node.js 20',
        quote: 'node-v20.5.1-linux-x64.tar.gz 11-Nov-2025 16:41' }) })).toMatchObject({ decision: 'fix', source: 'single_source' });
  });

  it('compares agreement alone, source attribution and the strict two-publisher requirement', async () => {
    const lookup = vi.fn(async () => { throw new Error('No readable page'); });
    expect(await judgeTruth({ ...input, lookup }, 'agreement')).toMatchObject({ decision: 'send', lookup: false });
    expect(await judgeTruth({ ...input, lookup })).toMatchObject({ decision: 'fix', source: 'single_source', lookup: true });
    expect(await judgeTruth({ ...input, lookup }, 'require_two')).toMatchObject({ decision: 'withhold', source: 'single_source', lookup: true });
  });

  it('leaves reply types outside quoted factual answers available for shadow reporting', async () => {
    expect(await judgeTruth({ question: 'When was it sent?', reply: 'Which email?', pages: [], scope: 'other' })).toMatchObject({
      decision: 'send', codes: ['outside_scope'], measured: false,
    });
    expect(await judgeTruth({ question: 'When was it sent?', reply: 'Yesterday.', pages: [], scope: 'ungrounded_fact' })).toMatchObject({
      decision: 'withhold', codes: ['evidence_unavailable'], measured: false,
    });
  });

  it('contains at least 150 uniquely labelled development cases with both outcomes in both languages', () => {
    expect(truthCases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(truthCases.map(item => item.id)).size).toBe(truthCases.length);
    expect(truthCases.every(item => item.provenance.includes(developmentProvenance) && item.pages.length && item.reply && item.question)).toBe(true);
    for (const language of ['ar', 'en']) {
      expect(new Set(truthCases.filter(item => item.language === language).map(item => item.correct))).toEqual(new Set([true, false]));
    }
  });
});
