import { describe, expect, it } from 'vitest';
import { detectCity, detectKind, detectName, detectRequests, isSiteRequest, siteSentence } from '@mohassan/sites';
import { SCENARIOS } from '../packages/sites/fixtures/scenarios.ts';

describe('site request recogniser', () => {
  it('recognises every fixture sentence', () => {
    for (const scenario of SCENARIOS) expect(isSiteRequest(scenario.sentence), scenario.id).toBe(true);
  });
  it('recognises plain Arabic and English requests', () => {
    for (const text of [
      'ابن لي موقع', 'أريد موقعاً لمطعمي', 'بدي ويب سايت لمحلي', 'اعمل لي صفحة هبوط لدورة', 'ممكن تصمم لي موقع إلكتروني بسيط؟', 'موقع لشركة مقاولات في الرياض',
      'build me a website', 'I need a landing page for my course', 'can you create a site for my bakery', 'make a portfolio website', 'set up an online store for my products',
    ]) expect(isSiteRequest(text), text).toBe(true);
  });
  it('leaves browser, search, writing and editing requests alone', () => {
    for (const text of [
      'افتح موقع ويكيبيديا', 'ادخل على موقع البنك', 'ابحث في موقعي القديم عن الأسعار', 'اكتب لي رسالة اعتذار', 'عدّل موقعي الحالي', 'ما أفضل موقع لتعلم البرمجة؟', 'لخص لي هذا الموقع',
      'open the website of the BBC', 'search the site for jobs', 'visit my website and tell me what is wrong', 'update our existing website', 'what is the best site for weather', 'translate this web page',
    ]) expect(isSiteRequest(text), text).toBe(false);
  });
  it('detects the kind from Arabic and English words', () => {
    expect(detectKind('موقع لمطعم شاورما')?.kind).toBe('restaurant');
    expect(detectKind('موقع لعيادة أسنان')?.kind).toBe('clinic');
    expect(detectKind('متجر لبيع العطور')?.kind).toBe('catalogue');
    expect(detectKind('موقع لأعمالي كمصور')?.kind).toBe('portfolio');
    expect(detectKind('صفحة هبوط لدورة')?.kind).toBe('landing');
    expect(detectKind('موقع لشركة سباكة')?.kind).toBe('services');
    expect(detectKind('a site for my coffee shop')?.kind).toBe('restaurant');
    expect(detectKind('website for a law firm')?.kind).toBe('services');
    expect(detectKind('a website')).toBeNull();
  });
  it('takes the name only when the sentence states it', () => {
    expect(detectName('أريد موقعاً لشركة تنظيف اسمها «لمعة» في الرياض')).toBe('لمعة');
    expect(detectName('ابن لي موقع لمطعم بيت الشام في دمشق')).toBe('بيت الشام');
    expect(detectName('Build me a website for my plumbing business Swift Plumbing in Manchester')).toBe('Swift Plumbing');
    expect(detectName('Create a site for Bright Dental clinic in Birmingham')).toBe('Bright Dental');
    expect(detectName('I want a website for my café called Nook Coffee in Leeds')).toBe('Nook Coffee');
    expect(detectName('Build an online catalogue for my shop Linen & Co in Dublin')).toBe('Linen & Co');
    expect(detectName('أريد موقعاً لمطعمي في دمشق')).toBeNull();
    expect(detectName('build me a website for my business in London')).toBeNull();
    expect(detectName('make a website for Manchester')).toBeNull();
  });
  it('detects known cities in both scripts', () => {
    expect(detectCity('ابن لي موقع لمطعم في دمشق', 'ar')).toBe('دمشق');
    expect(detectCity('موقع لعيادة بالرياض', 'ar')).toBe('الرياض');
    expect(detectCity('a website for my shop in Manchester', 'en')).toBe('Manchester');
    expect(detectCity('a website for my shop', 'en')).toBeNull();
  });
  it('extracts phone, WhatsApp, email, colour and language from the sentence', () => {
    const partial = siteSentence('أنشئ موقعاً أزرق لعيادة أسنان اسمها «ابتسامة» في جدة، واتساب 0551234567 والبريد smile@example.com')!;
    expect(partial.kind).toBe('clinic');
    expect(partial.name).toBe('ابتسامة');
    expect(partial.whatsapp).toBe('0551234567');
    expect(partial.email).toBe('smile@example.com');
    expect(partial.primary).toBe('#1d4ed8');
    expect(partial.lang).toBe('ar');
    expect(siteSentence('ابن لي موقع بالإنجليزية لمطعمي')?.lang).toBe('en');
    expect(siteSentence('Build a site for my restaurant, phone 07700 900123')?.phone).toBe('07700900123');
  });
  it('lists the sections the sentence asks for', () => {
    const requests = detectRequests('أريد موقعاً فيه قسم الفريق والأسئلة الشائعة والأسعار ونموذج تواصل وخريطة بصفحة واحدة');
    expect(requests.wants).toEqual(expect.arrayContaining(['team', 'faq', 'pricing']));
    expect(requests.form).toBe(true);
    expect(requests.map).toBe(true);
    expect(requests.singlePage).toBe(true);
    const english = detectRequests('a site with our team, projects, reviews and a blog');
    expect(english.wants).toEqual(expect.arrayContaining(['team', 'projects', 'testimonials', 'posts']));
    expect(detectRequests('a plain website').wants).toEqual([]);
  });
});
