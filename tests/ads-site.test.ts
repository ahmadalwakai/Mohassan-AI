import { describe, it, expect } from 'vitest';
import { businessName, checkSiteAds, descriptionOk, headlineOk, siteAds, siteDigest } from '../scripts/ads-training/site.js';
import { pointerToSite, renderSitePointerPrompt, siteToPointer } from '../scripts/ads-training/pointer.js';

const PAGE = [
  'Roofing Services in Holden MA | Trusted Local Roofers',
  'Skip to content', 'Home', 'Services', 'Roof Repair', 'Gutter Installation', 'Deck Builder', 'Home', 'Services', 'Roof Repair',
  'Phone :(', 'Get a Free Estimate', 'Markopoulos Roofing',
  'Keeping Your House and Business Protected with Dependable Roofing Care.',
  'When searching for a local roofer in Holden MA, Markopoulos Roofing provides expert services for home and business owners.',
  'We offer professional repairs, installations, and maintenance, delivering durable, high-quality results meant for the weather.',
  'At Markopoulos Roofing, we have the tools, experience, and dedication to resolve your roofing issues quickly and effectively.',
  'Are you looking for a roofer? We�ve got you covered.',
  'We use cookies to improve your experience.',
].join('\n');
const input = () => siteDigest('https://www.markopoulosroofing.com/', PAGE.split('\n')[0]!, PAGE);

describe('Ads from a website (ads.site.v1)', () => {
  it('drops repeated menus, banners and broken characters from the digest', () => {
    const { site, text } = input();
    expect(site).toBe('markopoulosroofing.com');
    expect(text.split('\n').filter(line => line === 'Roof Repair')).toHaveLength(1);
    expect(text).not.toMatch(/skip to content|cookies|�/i);
    expect(text).toContain("We've got you covered.");
  });

  it('finds the business name that spells the domain', () => {
    expect(businessName(input())).toBe('Markopoulos Roofing');
    expect(businessName({ site: 'example.com', title: 'Welcome', text: 'Nothing here' })).toBeNull();
  });

  it('labels only lines that are on the site, and keeps sentences whole', () => {
    const ads = siteAds(input())!;
    expect(ads).not.toBeNull();
    expect(ads.headlines).toContain('Roof Repair');
    expect(ads.headlines).not.toContain('Home');
    expect(ads.headlines).not.toContain('Phone :(');
    expect(ads.descriptions).toContain('Keeping Your House and Business Protected with Dependable Roofing Care.');
    // Cut only where a new clause starts, never inside a list, and never after "When ...".
    expect(ads.descriptions).toContain('We offer professional repairs, installations, and maintenance.');
    expect(ads.descriptions.some(text => text.startsWith('When ') || text.startsWith('At Markopoulos') || text.includes('?'))).toBe(false);
    expect(ads.keywords).toEqual(expect.arrayContaining(['Roof Repair', 'Gutter Installation']));
    expect(checkSiteAds(input(), ads)).toEqual([]);
  });

  it('rejects answers with anything the site did not say', () => {
    const ads = siteAds(input())!;
    expect(checkSiteAds(input(), { ...ads, headlines: [...ads.headlines.slice(0, 3), 'Cheapest Roofers In MA'] })).toContain('UNGROUNDED_HEADLINE');
    expect(checkSiteAds(input(), { ...ads, descriptions: [...ads.descriptions, 'We have 30 years of experience in roofing.'] })).toContain('UNGROUNDED_DESCRIPTION');
    expect(checkSiteAds(input(), { ...ads, business: 'Holden Roofing Ltd' })).toContain('UNGROUNDED_BUSINESS');
    expect(checkSiteAds(input(), { ...ads, keywords: ['solar panels'] })).toContain('UNGROUNDED_KEYWORD');
    expect(checkSiteAds(input(), { ...ads, headlines: ['Home', ...ads.headlines.slice(1)] })).toContain('NAV_HEADLINE');
    expect(checkSiteAds(input(), { ...ads, headlines: ads.headlines.slice(0, 2) })).toContain('TOO_FEW');
    expect(checkSiteAds(input(), { ...ads, extra: [] })).toEqual(['BAD_KEYS']);
  });
});

describe('Arabic website text contracts', () => {
  const title = 'تنظيف المنازل | خدمات التنظيف';
  const page = [title, 'الرئيسية', 'خدماتنا', 'تواصل معنا', 'تنظيف المنازل', 'تنظيف المكاتب', 'تنظيف السجاد',
    'نقدم خدمات تنظيف المنازل والمكاتب في جميع أحياء الرياض.',
    'يمكنك اختيار الموعد المناسب لتنظيف منزلك من خلال موقعنا.',
    'نستخدم معدات مخصصة لتنظيف السجاد والأثاث داخل منزلك.',
    'نستخدم ملفات تعريف الارتباط لتحسين تجربة المستخدم.'].join('\n');

  it('selects grounded Arabic headlines and complete descriptions without uppercase letters', () => {
    const input = siteDigest('https://cleanhome.sa', title, page);
    expect(input.text).not.toContain('ملفات تعريف الارتباط');
    expect(descriptionOk('نقدم خدمات تنظيف المنازل والمكاتب في جميع أحياء الرياض.')).toBe(true);
    expect(headlineOk('تنظيف المنازل')).toBe(true);
    expect(headlineOk('تواصل معنا')).toBe(false);
    const ads = siteAds(input);
    expect(ads).not.toBeNull();
    expect(ads!.headlines).toContain('تنظيف السجاد');
    expect(ads!.headlines).not.toContain('الرئيسية');
    expect(ads!.business).toBeNull(); // No evidence that the domain spells an Arabic business name.
    expect(checkSiteAds(input, ads)).toEqual([]);
    const pointer = siteToPointer(input, ads!);
    expect(pointer).not.toBeNull();
    expect(pointerToSite(input, pointer!)).toEqual(ads);
    expect(renderSitePointerPrompt(input, { usableOnly: true })).toContain('نقدم خدمات');
    expect(checkSiteAds(input, { ...ads!, headlines: [...ads!.headlines, 'خدمات سباكة متخصصة'] })).toContain('UNGROUNDED_HEADLINE');
  });

  it('rejects Arabic questions, menu labels and numeric keyword fragments', () => {
    expect(descriptionOk('هل ترغب في حجز خدمة تنظيف المنزل خلال الأسبوع القادم؟')).toBe(false);
    expect(headlineOk('رقم الهاتف')).toBe(false);
    expect(headlineOk('اتصل ٠١٢٣٤٥٦٧٨٩')).toBe(false);
  });
});
