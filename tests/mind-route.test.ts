import { describe, expect, it } from 'vitest';
import type { Source } from '../apps/server/src/assistant/mind/contract.js';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';
import { route } from '../apps/server/src/assistant/mind/route.js';

describe('source order for an evidence request', () => {
  it.each<{ request: string; order: Source[] }>([
    { request: 'Good evening friend!', order: ['fixed'] },
    { request: 'كيف حالك يا صاحبي؟', order: ['fixed'] },
    { request: 'Please multiply 59 by 28.', order: ['computed'] },
    { request: 'كم ١٥٪ من ٣٩٠؟', order: ['computed'] },
    { request: 'How much is 12 SAR in GBP?', order: ['web'] },
    { request: 'حول ٧٠ يورو إلى ريال.', order: ['web'] },
    { request: 'Check today’s sea temperature at Alicante.', order: ['web'] },
    { request: 'ما سعر الفضة اليوم؟', order: ['web'] },
    { request: 'When did the Severn Tunnel open?', order: ['knowledge', 'index', 'web'] },
    { request: 'كم نسبة الملح في البحر الميت؟', order: ['knowledge', 'index', 'web'] },
    { request: 'What is the entry fee according to https://orchard.example/list?', order: ['site', 'index', 'web'] },
    { request: 'ما ساعات الاستقبال في الرابط https://hall.example/office؟', order: ['site', 'index', 'web'] },
    { request: 'What is my current balance at https://finance.example?', order: ['memory'] },
    { request: 'أين وثائقنا حسب https://files.example/list؟', order: ['memory'] },
    { request: 'Open https://quay.example/', order: ['site'] },
    { request: 'افحص موقع https://garden.example/', order: ['site'] },
    { request: 'Please write a poem about the sky.', order: ['fixed'] },
    { request: 'ترجم تقريرا للسويدية.', order: ['fixed'] },
    { request: 'Return the discount terms from https://steward.example/policy.', order: ['site', 'index', 'web'] },
    { request: 'اعرض موعد تجديد حجزنا من https://office.example/renewals.', order: ['memory'] },
    { request: 'أورد رسوم بريد اليوم.', order: ['web'] },
    { request: 'Contrast the two documented water levels for the estuary.', order: ['knowledge', 'index', 'web'] },
  ])('$request', ({ request, order }) => {
    expect(route(buildFrame(request))).toEqual(order);
  });

  it.each<{ request: string; timeSensitive: boolean }>([
    { request: 'How long is the train ride between Birchwood and Seaton?', timeSensitive: false },
    { request: 'كم تستغرق الرحلة بالقطار من وادي الحور إلى قرية الراس؟', timeSensitive: false },
    { request: 'What is the length of the original railway tunnel?', timeSensitive: false },
    { request: 'متى كان موعد القطار في عام 1980 قبل تعديل المسار؟', timeSensitive: false },
    { request: 'What time does the next passenger train leave Oakwood?', timeSensitive: true },
    { request: 'متى ينطلق القطار المسائي من محطة الوادي؟', timeSensitive: true },
    { request: 'Check whether the passenger flight is delayed.', timeSensitive: true },
    { request: 'ما جدول رحلات الحافلة غداً؟', timeSensitive: true },
  ])('distinguishes a transport property from current service for $request', ({ request, timeSensitive }) => {
    const frame = buildFrame(request);
    expect(frame.timeSensitive).toBe(timeSensitive);
    expect(route(frame)).toEqual(timeSensitive ? ['web'] : ['knowledge', 'index', 'web']);
  });

  it.each([
    'HTTP status of https://museum.example/gallery',
    'حالة https://botany.example/seed-bank',
    'Check this: https://network.example/about',
    'Website uptime at https://desk.example/help',
    'جهوزية الموقع https://service.example/library',
    'Endpoint status at https://grid.example/overview',
    'حالة الخدمة على https://radio.example/live',
    'أين تظهر وجهة إعادة التوجيه عند https://waypoint.example/archive؟',
    'استخرج رمز التحويل في https://library.example/old-index.',
  ])('handles the named address as a site inspection for %s', (request) => {
    const frame = buildFrame(request);
    expect(frame).toMatchObject({ intent: 'site_check', missing: [] });
    expect(route(frame)).toEqual(['site']);
  });

  it.each(['CHF/JPY', '45 Swiss francs against British pounds', 'اليورو مقابل الفرنك', 'كم روبية لقاء الدولار الكندي'])('routes the currency pair %s to current evidence', (request) => {
    const frame = buildFrame(request);
    expect(frame).toMatchObject({ intent: 'fact_question', answerType: 'money', timeSensitive: true, missing: [] });
    expect(route(frame)).toEqual(['web']);
  });

  it('keeps named owner data private and missing references local', () => {
    expect(route(buildFrame('My studio renewal date on https://portal.example/billing'))).toEqual(['memory']);
    expect(route(buildFrame('What is my service status at https://portal.example/account'))).toEqual(['memory']);
    expect(route(buildFrame('Check it, please.'))).toEqual(['fixed']);
    expect(route(buildFrame('Convert 16 pounds to kilograms.'))).toEqual(['computed']);
  });
});
