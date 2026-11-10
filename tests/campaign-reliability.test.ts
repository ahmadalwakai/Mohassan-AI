import { describe, expect, it } from 'vitest';
import { CLAIM, correctAdText, validateAdText, type TextInput } from '@mohassan/google-ads';

/**
 * Reliability set for campaign text generation: 10 fixed defective drafts, run one after
 * another. A trial passes only when the independent validator accepts the final text,
 * the corrector added no claim absent from the evidence, and valid lines are untouched.
 * Local and deterministic; the "model" is a scripted stand-in that tries to invent offers.
 * This is NOT a measurement of a real model or of Google Ads.
 */
const evidence = 'MA Removals. House removals in Glasgow. We offer free quotes. Careful local movers.';
const ok = { headlines: ['Glasgow House Removals', 'Local Movers Glasgow', 'Book Your Move'], descriptions: ['Careful house removals across Glasgow.', 'Book your move online in minutes.'], paths: ['removals'], keywords: ['"house removals glasgow"'], negativeKeywords: ['jobs'] } satisfies TextInput;
const withHeadlines = (...extra: string[]): TextInput => ({ ...ok, headlines: [...ok.headlines, ...extra] });
const inventing = async () => JSON.stringify({ replacements: [{ id: 'headline 4', text: 'Cheapest Moves 24/7' }, { id: 'headline 5', text: 'Save 30% Today' }] });

const TRIALS: { name: string; input: TextInput; expectClean: boolean }[] = [
  { name: 'exclamation mark', input: { ...ok, headlines: ['Glasgow House Removals!', ...ok.headlines.slice(1)] }, expectClean: true },
  { name: 'overlong extra headline', input: withHeadlines('Glasgow House Removals And Man Vans Today'), expectClean: true },
  { name: 'unsupported discount', input: withHeadlines('Save 50% On Removals'), expectClean: true },
  { name: 'unsupported guarantee', input: withHeadlines('Guaranteed Lowest Price'), expectClean: true },
  { name: 'emoji', input: withHeadlines('Glasgow Movers 🚚'), expectClean: true },
  { name: 'duplicate headline', input: withHeadlines('glasgow house removals'), expectClean: true },
  { name: 'repeated punctuation', input: { ...ok, descriptions: ['Careful house removals across Glasgow!!', ok.descriptions[1]!] }, expectClean: true },
  { name: 'broad match modifier keyword', input: { ...ok, keywords: ['+house +removals glasgow'] }, expectClean: true },
  { name: 'phone number in description', input: { ...ok, descriptions: [...ok.descriptions, 'Call us on 0141 555 0199 for a quote today'] }, expectClean: true },
  { name: 'required headline overlong (cannot be dropped)', input: { ...ok, headlines: ['Glasgow House Removals And Man Vans Today', ...ok.headlines.slice(1)] }, expectClean: false },
];

describe('campaign text reliability set', () => {
  const validate = (input: TextInput) => validateAdText(input, evidence, 'en');
  TRIALS.forEach((trial, index) => it(`trial ${index + 1}: ${trial.name}`, async () => {
    const result = await correctAdText(trial.input, { validate, evidence, rewrite: inventing });
    expect(result.status === 'unresolved').toBe(!trial.expectClean);
    if (trial.expectClean) expect(validate(result.input).filter(issue => issue.severity === 'error')).toEqual([]);
    const text = [...result.input.headlines, ...result.input.descriptions].join(' ');
    for (const claim of text.matchAll(CLAIM)) expect(evidence.toLowerCase()).toContain(claim[0].toLowerCase());
    for (const line of ok.headlines.slice(1)) expect(result.input.headlines).toContain(line);
  }));
});
