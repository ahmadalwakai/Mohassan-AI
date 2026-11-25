import { expect, it } from 'vitest';
import type { CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import { capabilityV2MappingVersion } from '../scripts/agent-capability-bench/v2/sealed.js';
import { wikiAttribution } from '../scripts/agent-capability-bench/v2/wiki-attribution.js';

// Structural sentinels for the attribution formatter. These cases belong to neither benchmark partition.
function example(index: number, source: string, language: 'ar' | 'en' = 'en'): CapabilityCase {
  return {
    id: `human-${index.toString(16).padStart(24, '0')}`,
    area: 'factual', language, variety: language === 'ar' ? 'unspecified' : 'english',
    provenance: { author: 'human', source: `${source}:sentinel-${index}` },
    turns: [{ text: 'PRIVATE_PROMPT_SENTINEL', expect: {
      route: ['web_search'], questionCount: 0, status: ['completed'], requiredContent: [], forbiddenContent: [], maxSteps: 1,
    } }],
  };
}

const payload = (cases: CapabilityCase[]) => JSON.stringify({ schemaVersion: 2, mappingVersion: capabilityV2MappingVersion, cases });

function withCanardTitle(index: number, title: string) {
  const item = example(index, 'canard');
  item.turns[0]!.text = `PRIVATE_PROMPT_SENTINEL\nArticle: ${title}\nSection: PRIVATE_SECTION_SENTINEL`;
  return item;
}

it('groups sealed cases by Wikipedia article, preserves multilingual URLs and produces stable bytes', () => {
  const arCase = example(4, 'tydiqa', 'ar');
  const arTitle = 'عنوان_عربي';
  const arUrl = `https://ar.wikipedia.org/wiki/${encodeURIComponent(arTitle)}`;
  arCase.fixture = { pages: [{ url: arUrl, title: arTitle, text: 'PRIVATE_PASSAGE_SENTINEL' }] };
  const first = withCanardTitle(2, 'A & B');
  const second = withCanardTitle(1, 'A & B');
  const third = withCanardTitle(3, 'Z');
  const cases = [arCase, example(5, 'mintaka'), first, third, second];
  const index = wikiAttribution(payload(cases));
  expect(index).toBe(wikiAttribution(payload([...cases].reverse())));
  expect(index.endsWith('\n')).toBe(true);
  expect(index).not.toContain('PRIVATE_');
  const { sources, licenses } = JSON.parse(index);
  expect(licenses).toEqual({
    'CC-BY-SA-3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
    'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  });
  expect(sources.canard).toMatchObject({ license: 'CC-BY-SA-4.0', excerptLicense: 'CC-BY-SA-3.0' });
  expect(sources.canard.articles).toEqual([
    { articleUrl: 'https://en.wikipedia.org/wiki/A_%26_B', historyUrl: 'https://en.wikipedia.org/w/index.php?title=A_%26_B&action=history',
      caseIds: [second.id, first.id] },
    { articleUrl: 'https://en.wikipedia.org/wiki/Z', historyUrl: 'https://en.wikipedia.org/w/index.php?title=Z&action=history', caseIds: [third.id] },
  ]);
  expect(sources.tydiqa.articles).toEqual([
    { articleUrl: arUrl, historyUrl: `https://ar.wikipedia.org/w/index.php?title=${encodeURIComponent(arTitle)}&action=history`, caseIds: [arCase.id] },
  ]);
});

it('fails on missing or invalid source links without printing sealed case text', () => {
  const arCase = example(1, 'tydiqa', 'ar');
  expect(() => wikiAttribution(payload([arCase]))).toThrow('Missing Wikipedia passage attribution');
  arCase.fixture = { pages: [{ url: 'https://en.wikipedia.org/wiki/English', title: 'English', text: 'PRIVATE_PASSAGE_SENTINEL' }] };
  expect(() => wikiAttribution(payload([arCase]))).toThrow('Expected a language-specific Wikipedia article URL');
  expect(() => wikiAttribution(payload([example(1, 'canard')]))).toThrow('Expected a language-specific Wikipedia article URL');
  expect(() => wikiAttribution(payload([withCanardTitle(1, 'Invalid#title')]))).toThrow('Invalid Wikipedia article title');
  expect(() => wikiAttribution('PRIVATE_PROMPT_SENTINEL')).toThrow(/^Wikipedia attribution requires valid sealed payload JSON\.$/u);
});
