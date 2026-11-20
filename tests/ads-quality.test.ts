import { describe, expect, it } from 'vitest';
import { mergeAds, namesSite, refineAds } from '../apps/server/src/assistant/ads-quality.js';

const page = {
  site: 'dukestreettyres.com',
  title: 'Mobile Tyre Fitting Glasgow, Edinburgh & Dundee | 24/7 Emergency | Duke Street Tyres',
  text: [
    'Duke Street Tyres', 'Emergency Tyre Fitting', 'Fully insured', 'Terms & Conditions', 'Back to Top', 'Mary T', 'Business Hours',
    'Indian Tyres in', 'Quality', 'GRI.png', 'Check out', 'Apple Pay', 'Budget Tyres', 'Puncture Repair',
    'We fit new tyres at your kerb across Glasgow, day or night.', 'Mobile tyre fitting with no call-out charge for Glasgow drivers.',
    'Our vans carry budget and premium tyres for most cars.', 'Puncture repair from £25 while you wait at home.',
  ].join('\n'),
};
const model = {
  business: 'Duke Street Tyres',
  headlines: ['Duke Street Tyres', 'Terms & Conditions', 'Back to Top', 'Mary T', 'Business Hours', 'Indian Tyres in', 'Quality', 'GRI.png', 'Check out', 'Apple Pay', 'Most popular', 'Mid-range', 'Puncture Repair', 'Emergency Tyre Fitting', 'Fully insured'],
  descriptions: ['We fit new tyres at your kerb across Glasgow, day or night.', 'Mobile tyre fitting with no call-out charge for Glasgow drivers.'],
  keywords: ['Terms & Conditions', 'Back to Top', 'Apple Pay', 'Emergency Tyre Fitting', 'Puncture Repair', 'Check out'],
};

describe('brain quality pass over the Ads model picks', () => {
  it('keeps relevant Arabic copy while rejecting navigation and dangling phrases', () => {
    const arabic = {
      business: null,
      headlines: ['تنظيف المنازل', 'تنظيف السجاد', 'تنظيف النوافذ', 'سياسة الخصوصية', 'تنظيف المنازل في'],
      descriptions: ['نقدم خدمات تنظيف المنازل والسجاد بمواعيد تناسب احتياجاتك.', 'فريقنا متخصص في تنظيف النوافذ والمنازل بعناية كاملة.'],
      keywords: ['تنظيف المنازل', 'تنظيف السجاد', 'تواصل معنا اليوم'],
    };
    const arPage = { site: 'clean.example', title: 'تنظيف المنازل | تنظيف السجاد | تنظيف النوافذ', text: [...arabic.headlines, ...arabic.descriptions].join('\n') };
    const out = refineAds(arabic, arPage, { service: 'تنظيف المنازل', locations: ['الرياض'] });
    expect(out).not.toBeNull();
    expect(new Set(out?.headlines)).toEqual(new Set(['تنظيف المنازل', 'تنظيف السجاد', 'تنظيف النوافذ']));
    expect(out?.keywords).toContain('تنظيف المنازل الرياض');
    expect(out?.keywords).not.toContain('تواصل معنا اليوم');
  });

  it('drops site furniture, names, fragments, files and filler, and puts the business and the offer first', () => {
    const out = refineAds(model, page, { service: null, locations: ['Glasgow'] })!;
    expect(out.headlines[0]).toBe('Duke Street Tyres');
    expect(out.headlines).toEqual(expect.arrayContaining(['Emergency Tyre Fitting', 'Puncture Repair']));
    for (const bad of ['Terms & Conditions', 'Back to Top', 'Mary T', 'Business Hours', 'Indian Tyres in', 'Quality', 'GRI.png', 'Check out', 'Apple Pay', 'Most popular', 'Mid-range']) expect(out.headlines).not.toContain(bad);
    // Title words (tyre, fitting, emergency) rank above a line the title does not name.
    expect(out.headlines.indexOf('Emergency Tyre Fitting')).toBeLessThan(out.headlines.indexOf('Puncture Repair'));
  });

  it('keeps only search phrases as keywords and adds the owner’s own service and places', () => {
    const out = refineAds(model, page, { service: 'mobile tyre fitting', locations: ['Glasgow', 'Dundee'] })!;
    expect(out.keywords.slice(0, 3)).toEqual(['mobile tyre fitting', 'mobile tyre fitting glasgow', 'mobile tyre fitting dundee']);
    expect(out.keywords).toEqual(expect.arrayContaining(['emergency tyre fitting', 'puncture repair']));
    for (const bad of ['terms & conditions', 'back to top', 'apple pay', 'check out']) expect(out.keywords).not.toContain(bad);
  });

  it('refuses a business name that does not name the site', () => {
    expect(namesSite('مركز النور', 'مركزالنور.example')).toBe(true);
    expect(namesSite('مركز النور', new URL('https://مركزالنور.example').hostname)).toBe(true);
    expect(namesSite('Duke Street Tyres', 'dukestreettyres.com')).toBe(true);
    expect(namesSite('Indian Restaurant in', 'royalkingofspicerestaurant.co.uk')).toBe(false);
    const out = refineAds({ ...model, business: 'Indian Tyres in' }, page, null)!;
    expect(out.business).toBeNull();
    expect(out.headlines).not.toContain('Indian Tyres in');
  });

  it('returns null when too few strong headlines are left, so the chat can say so', () => {
    expect(refineAds({ ...model, headlines: ['Duke Street Tyres', 'Terms & Conditions', 'Back to Top', 'Quality'] }, page, null)).toBeNull();
  });

  it('drops headlines that are only a piece of a longer one, and keeps one "from" price, the lowest', () => {
    const pricedPage = { ...page, text: `${page.text}\nFrom £55 fitted\nFrom £75 fitted\nDuke Street\nDuke` };
    const out = refineAds({ ...model, headlines: ['Duke Street Tyres', 'Duke Street', 'Duke', 'Emergency Tyre Fitting', 'From £75 fitted', 'Puncture Repair', 'From £55 fitted'] }, pricedPage, { service: 'mobile tyre fitting', locations: ['Glasgow'] })!;
    expect(out.headlines).toContain('Duke Street Tyres');
    for (const fragment of ['Duke Street', 'Duke']) expect(out.headlines).not.toContain(fragment);
    expect(out.headlines).toContain('From £55 fitted');
    expect(out.headlines).not.toContain('From £75 fitted');
    // "Tyre" is not a piece of "Tyres": whole words only.
    expect(refineAds({ ...model, headlines: ['Budget Tyres', 'Budget Tyre', 'Emergency Tyre Fitting', 'Puncture Repair'] }, page, null)!.headlines).toEqual(expect.arrayContaining(['Budget Tyres', 'Budget Tyre']));
  });

  it('adds the site’s own search phrases as keywords, alone and in the owner’s first place', () => {
    const out = refineAds(model, page, { service: 'mobile tyre fitting', locations: ['Glasgow', 'Dundee'], services: ['flat tyre', 'emergency mobile tyre fitting', 'apple pay', 'call now'] })!;
    expect(out.keywords).toEqual(expect.arrayContaining(['flat tyre', 'flat tyre glasgow', 'emergency mobile tyre fitting', 'emergency mobile tyre fitting glasgow']));
    expect(out.keywords).not.toContain('flat tyre dundee');
    for (const bad of ['apple pay', 'call now']) expect(out.keywords).not.toContain(bad);
  });

  it('merges several checked answers without repeats', () => {
    const merged = mergeAds([{ ...model, headlines: ['A Tyres', 'B Tyres'] }, { ...model, headlines: ['b tyres', 'C Tyres'] }])!;
    expect(merged.headlines).toEqual(['A Tyres', 'B Tyres', 'C Tyres']);
    expect(mergeAds([])).toBeNull();
  });
});
