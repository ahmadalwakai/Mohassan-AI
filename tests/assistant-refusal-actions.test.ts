import { describe, expect, it } from 'vitest';
import { classifyRefusal } from '../apps/server/src/assistant/refusal/classifier.js';
import { assessRequestScope } from '../apps/server/src/assistant/request-scope.js';
import type { RefusalAlternative } from '../apps/server/src/assistant/refusal/types.js';

const effects: readonly [string, RefusalAlternative][] = [
  ['Hey Mira, play a recording of the chamber ensemble.', 'find_media'],
  ['Would you resume the audiobook from chapter twelve?', 'find_media'],
  ['بدي تسمعني البودكاست عن عمارة المدن.', 'find_media'],
  ['Please switch the porch lamps off before I leave.', 'device_control'],
  ['لو سمحتي خفّضي سطوع المصباح بجانب المكتبة.', 'device_control'],
  ['Could you place an order for a box of pastries?', 'place_order'],
  ['اطلب لي وجبة عدس من المقهى القريب.', 'place_order'],
  ['I would like for you to reserve a seat on the ferry.', 'make_booking'],
  ['أبيك تحجز لي مقعد في القطار الصباحي.', 'make_booking'],
  ['Give my housing coordinator a call.', 'place_call'],
  ['كلمي الكهربائي على جواله.', 'place_call'],
  ['Forward the itinerary to our customer.', 'draft'],
  ['ابعث العرض عبر تليجرام لقروب المدرسة.', 'draft'],
  ['Share the rehearsal notice on Mastodon.', 'publish_content'],
  ['انشري الإعلان في المدونة الخاصة بالنادي.', 'publish_content'],
  ['Find the café menu and then order a bowl of soup.', 'place_order'],
];

describe('unsupported external effects', () => {
  it.each(effects)('detects the action in %s', (request, alternative) => {
    expect(classifyRefusal(request, { fullAccess: true })).toMatchObject({ alternative });
  });

  it.each([
    'Where can I stream the chamber ensemble recording?',
    'How can I pair the dimmer and lower the brightness of the porch lamps?',
    'How can I pair the wireless speaker and play a song through it?',
    'How do I review my basket and order a box of pastries?',
    'كيف أضبط المؤقت وأخفض سطوع المصباح؟',
    'Find an official guide for publishing a notice.',
    'Compare ferry seats before booking the crossing.',
    'Draft a reminder to send to the housing coordinator.',
    'Send a text template here.',
    'Call the parseRow function from the unit test.',
    'Adjust a recipe for a coffee maker.',
    'Order the coffee blends by price.',
    'شغّل تطبيق الخرائط على الكمبيوتر.',
    'ترجم العبارة التالية: «انشر الإعلان في المدونة».',
    'Draft a message: switch the porch lamps off.',
  ])('keeps the supported path for %s', request => {
    expect(classifyRefusal(request, { fullAccess: true })).toBeNull();
  });

  it('declines a direct action even when scope initially describes a public lookup', () => {
    const request = 'Play the field recording from the archive';
    const scope = assessRequestScope(request);
    expect(scope.source).toBe('public_lookup');
    expect(classifyRefusal(request, { fullAccess: true, scope })).toMatchObject({ alternative: 'find_media' });
    expect(classifyRefusal(request, { fullAccess: true, scope, capabilities: { mediaModel: true } })).toBeNull();
  });
});
