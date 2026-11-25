import { readableSource } from '@mohassan/browser';
import { describe, expect, it } from 'vitest';
import { createPageCache } from '../apps/server/src/assistant/page-cache.js';
import { collectPageStructure, pageStructure, rememberPageStructure, type SelectionBlock } from '../apps/server/src/assistant/selection/page-structure.js';
import { quoteCandidates, rankAnswer, type SelectionPage } from '../apps/server/src/assistant/selection/ranker.js';

const page = (title: string, text: string, url = 'https://en.wikipedia.org/wiki/Test'): SelectionPage => ({ title, text, url });

describe('answer selection candidates', () => {
  it('retains source order, titles, the lead, headings, list items and row cells', () => {
    const source = page('Telephone', 'The telephone transmits sound. It serves many homes.\n## Methods\n- Using an electric signal\nInventor | Alexander Graham Bell');
    expect(quoteCandidates(source).map(({ text, kind, heading, cells }) => [text, kind, heading, cells])).toEqual([
      ['Telephone', 'title', undefined, undefined],
      ['The telephone transmits sound.', 'lead', undefined, undefined],
      ['It serves many homes.', 'sentence', undefined, undefined],
      ['- Using an electric signal', 'list', 'Methods', undefined],
      ['Inventor | Alexander Graham Bell', 'table', 'Methods', ['Inventor', 'Alexander Graham Bell']],
    ]);
  });

  it('retains HTML structure from the cache using the same flat text visible to existing callers', () => {
    const url = 'https://example.com/water';
    const html = '<title>Water</title><nav><p>Menu item</p></nav><article><h1>Water</h1><p>Water is an inorganic compound.</p><h2>Preparation</h2><ol><li>Use clean water</li></ol><table><tr><th>Boiling point</th><td>99.98 °C</td></tr></table><p hidden>Hidden content</p></article>';
    let blocks: SelectionBlock[] | undefined;
    const basic = readableSource(html, url);
    const source = readableSource(html, url, body => { blocks = collectPageStructure(body); });
    expect(source).toEqual(basic);
    const cache = createPageCache();
    cache.put({ ...source, url, status: 200, blocks });
    const observed = page(source.title, source.text, url);
    rememberPageStructure(observed, cache.get(url)?.blocks);
    expect(pageStructure(observed)).toEqual([
      { kind: 'paragraph', text: 'Water is an inorganic compound.', heading: 'Water' },
      { kind: 'list', text: 'Use clean water', heading: 'Preparation' },
      { kind: 'table', text: 'Boiling point 99.98 °C', heading: 'Preparation', cells: ['Boiling point', '99.98 °C'] },
    ]);
    for (const candidate of quoteCandidates(observed).filter(candidate => candidate.kind !== 'title')) {
      expect(source.text).toContain(candidate.text);
    }
  });
});

describe('deterministic answer selection', () => {
  it('chooses related person evidence over a different invention and explains the score', () => {
    const taylor = 'Captain John Taylor invented a device for speaking between sailing ships, long before the telephone.';
    const bell = 'Alexander Graham Bell invented the first practical telephone.';
    const source = page('Telephone', `${taylor} ${bell}`);
    const decision = rankAnswer('Who invented the telephone?', [source]);
    expect(decision.selected?.text).toBe(bell);
    expect(decision.selected?.reasons.map(reason => reason.split(':')[0])).toEqual(['type', 'entity', 'stem-overlap', 'position', 'source-quality']);
    expect(decision.ranked.find(candidate => candidate.text === taylor)?.eligible).toBe(false);
    expect(rankAnswer('Who invented the telephone?', [source])).toEqual(decision);
  });

  it('abstains on a wrong subject or below threshold even with a replacement scorer', () => {
    const source = page('Telephone', 'Thomas Edison invented the phonograph.');
    expect(rankAnswer('Who invented the telephone?', [source], () => ({ score: 100, reasons: [] })).reason).toBe('no-evidence');
    const water = page('Water', 'Water is an inorganic compound.');
    expect(rankAnswer('What is water?', [water], () => ({ score: 1, reasons: [] })).reason).toBe('below-threshold');
    expect(rankAnswer('What is water?', [water]).selected?.text).toBe('Water is an inorganic compound.');
  });

  it('uses a modest source-quality prior and stable input order for tied candidates', () => {
    const text = 'Water is an inorganic compound.';
    const first = page('Water', text, 'https://one.example/water');
    const second = page('Water', text, 'https://two.example/water');
    const institutional = page('Water', text, 'https://example.gov/water');
    expect(rankAnswer('What is water?', [first, second]).selected?.url).toBe(first.url);
    expect(rankAnswer('What is water?', [first, second, institutional]).selected?.url).toBe(institutional.url);
  });
});
