import { describe, it, expect } from 'vitest';
import { generate } from '../scripts/ads-training/lib.js';
import { gate, gateIssues, knownVertical } from '../scripts/ads-training/gate.js';

const codes = (issues: ReturnType<typeof gateIssues>) => issues.map(issue => issue.code);
const brief = { business: 'Kerbside Tyres', service: 'Mobile Tyre Fitting', city: 'Wigan', goal: 'calls', language: 'en', facts: ['Card, contactless and Apple Pay accepted at the kerb.'] };

describe('Ads checker gate', () => {
  it('accepts the correct reference answers for held-out cities', () => {
    const { examples } = generate({ seed: 99, briefs: { train: 1, validation: 1, test: 60, test_unseen_vertical: 1 } });
    const test = examples.filter(item => item.split === 'test');
    const rejected = test.filter(item => gateIssues(item.capability, item.input, item.output).length);
    expect(rejected.length / test.length).toBeLessThan(0.05);
  });

  it('refuses a fact from another business type', () => {
    expect(codes(gateIssues('ads.descriptions.v1', brief, { descriptions: ['Mobile Tyre Fitting across Wigan from Kerbside Tyres.', 'Over 10 years experience moving homes and offices.'] }))).toContain('UNGROUNDED_WORD');
    expect(codes(gateIssues('ads.headlines.v1', brief, { headlines: ['Kerbside Tyres', 'Mobile Tyres Wigan', 'Fully Stocked Vans'] }))).toContain('LEAKED_FACT');
  });

  it('refuses keywords for the wrong city', () => {
    expect(codes(gateIssues('ads.keywords.v1', brief, { keywords: ['[mobile tyre fitting wigan]', '[mobile tyre fitting reading]'] }))).toContain('KEYWORD_NO_LOCATION');
  });

  it('takes the first passing candidate and refuses when none pass', () => {
    const good = JSON.stringify({ keywords: ['[mobile tyre fitting wigan]', '"mobile tyres wigan"'] });
    const decision = gate('ads.keywords.v1', brief, ['{"keywords":["[tyres', JSON.stringify({ keywords: ['[tyres reading]'] }), good]);
    expect(decision).toMatchObject({ accepted: true, candidate: 2 });
    expect(gate('ads.keywords.v1', brief, ['not json'])).toEqual({ accepted: false, reasons: { UNPARSABLE: 1 } });
  });

  it('never borrows wording from the held-out business type', () => {
    expect(knownVertical({ service: 'Emergency Plumber' })).toBeUndefined();
    expect(knownVertical({ service: 'Mobile Tyre Fitting' })?.id).toBe('mobile-tyres');
  });
});

describe('Ads checker gate names', () => {
  it('refuses a cut or invented business name', () => {
    const lead = (name: string) => ({ descriptions: [`Mobile Tyre Fitting across Wigan from ${name}.`, 'Card, contactless and Apple Pay accepted at the kerb.'] });
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('Kerbside')))).toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('H Table Online')))).toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('Kerbside 24 Co')))).toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('Kerbside tyres')))).toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('Kerbside, Wigan from Kerbside')))).toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', brief, lead('Kerbside Tyres')))).not.toContain('BUSINESS_NAME');
    expect(codes(gateIssues('ads.descriptions.v1', { ...brief, facts: ['Fully fitted prices from £55.'] }, { descriptions: ['Mobile Tyre Fitting across Wigan from Kerbside Tyres.', 'Fully fitted prices from £55.'] }))).not.toContain('BUSINESS_NAME');
  });

  it('refuses a stray letter inside a headline', () => {
    expect(codes(gateIssues('ads.headlines.v1', brief, { headlines: ['Kerbside Tyres', 'Mobile Tyre Fitting W Wigan', 'Mobile Tyres Wigan'] }))).toContain('STRAY_LETTER');
  });

  it('keeps prices, routes and real lone letters that are not names', () => {
    const issues = codes(gateIssues('ads.descriptions.v1', brief, { descriptions: ['Mobile Tyre Fitting across Wigan from Kerbside Tyres.', 'Fitted prices from GBP55 with budget tyres.', 'Fully fitted prices from GBP55.','Vans run from Kerbside Tyres to the West End.', 'Run-flats across Wigan G postcodes.'] }));
    expect(issues).not.toContain('BUSINESS_NAME');
    expect(issues).not.toContain('STRAY_LETTER');
  });
});

describe('Ads checker gate sentences', () => {
  it('refuses description fragments but keeps stated facts', () => {
    const input = { ...brief, facts: ['Open 24/7.'] };
    expect(codes(gateIssues('ads.descriptions.v1', input, { descriptions: ['Mobile Tyre Fitting across Wigan from Kerbside Tyres.', 'Boiler.'] }))).toContain('FRAGMENT');
    expect(codes(gateIssues('ads.descriptions.v1', input, { descriptions: ['Mobile Tyre Fitting across Wigan from Kerbside Tyres.', 'Open 24/7.'] }))).not.toContain('FRAGMENT');
  });
});
