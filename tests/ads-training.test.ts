import { describe, it, expect } from 'vitest';
import { checkOutput, generate, renderPrompt, renderTarget } from '../scripts/ads-training/lib.js';
import { CITIES, HELD_OUT_VERTICAL, VERTICALS } from '../scripts/ads-training/verticals.js';

const small = () => generate({ seed: 7, briefs: { train: 120, validation: 20, test: 20, test_unseen_vertical: 20 } });
const errors = (issues: ReturnType<typeof checkOutput>) => issues.filter(issue => issue.severity === 'error');

describe('Ads training data', () => {
  it('rebuilds the same dataset from the same seed', () => {
    expect(small().examples.map(item => item.id)).toEqual(small().examples.map(item => item.id));
  });

  it('keeps every example inside Google limits and the owner facts', () => {
    const { examples } = small();
    expect(examples.length).toBe(180 * 4);
    for (const item of examples) {
      const vertical = VERTICALS.find(entry => entry.id === item.vertical)!;
      expect(errors(checkOutput(item.capability, item.input, item.output, vertical)), item.id).toEqual([]);
    }
  });

  it('keeps held-out cities, the held-out vertical and their examples out of training', () => {
    const { examples } = small();
    const train = examples.filter(item => item.split === 'train');
    const trainIds = new Set(train.map(item => item.id));
    expect(train.some(item => item.vertical === HELD_OUT_VERTICAL)).toBe(false);
    expect(train.some(item => ([...CITIES.validation, ...CITIES.test] as string[]).includes(String(item.input.city)))).toBe(false);
    expect(examples.filter(item => item.split !== 'train').some(item => trainIds.has(item.id))).toBe(false);
    expect(examples.filter(item => item.split === 'test_unseen_vertical').every(item => item.vertical === HELD_OUT_VERTICAL)).toBe(true);
  });

  it('renders compact sorted JSON that round-trips', () => {
    const item = small().examples[0]!;
    expect(renderPrompt(item).startsWith('Ads task:\n{"capability":')).toBe(true);
    expect(JSON.parse(renderTarget(item))).toEqual(item.output);
  });

  it('rejects invented claims, unstated facts, and broken limits', () => {
    const vertical = VERTICALS.find(entry => entry.id === 'mobile-tyres')!;
    const input = { business: 'Kerbside Tyres', service: 'Mobile Tyre Fitting', city: 'Glasgow', goal: 'calls', language: 'en', facts: ['Card, contactless and Apple Pay accepted at the kerb.'] };
    const codes = (headlines: string[]) => errors(checkOutput('ads.headlines.v1', input, { headlines }, vertical)).map(issue => issue.code);
    expect(codes(['Kerbside Tyres', 'Mobile Tyres Glasgow', 'Card & Apple Pay'])).toEqual([]);
    expect(codes(['Kerbside Tyres', 'Mobile Tyres Glasgow', 'Fitted From £55'])).toContain('UNSUPPORTED_CLAIM');
    expect(codes(['Kerbside Tyres', 'Mobile Tyres Glasgow', 'Fully Stocked Vans'])).toContain('UNSTATED_FACT');
    expect(codes(['Kerbside Tyres', 'Mobile Tyres Glasgow', 'The Fastest Mobile Tyre Fitters'])).toContain('TOO_LONG');
    expect(codes(['Kerbside Tyres', 'Mobile Tyres', 'Card & Apple Pay'])).toContain('NO_LOCATION');
    const negatives = errors(checkOutput('ads.negatives.v1', { ...input, keywords: ['[mobile tyre fitting glasgow]'] }, { negatives: ['mobile'] }));
    expect(negatives.map(issue => issue.code)).toContain('NEGATIVE_BLOCKS_KEYWORD');
  });
});
