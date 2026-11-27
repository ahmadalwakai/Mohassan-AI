import { describe, expect, it } from 'vitest';
import { classifyRefusal } from '../apps/server/src/assistant/refusal/classifier.js';

const context = { fullAccess: true };

describe('media and device requests in Arabic and English', () => {
  it.each([
    'لو سمحتي طفّي ضو الممر',
    'سكّري الضو بالمطبخ',
    'ولّع نور الحديقة',
    'شعّل الضو بالمدخل',
    'شغّلي زر الفيش بجانب الباب',
    'Brighten of the porch lamps',
  ])('detects device control in %s', request => {
    expect(classifyRefusal(request, { ...context, capabilities: { mediaModel: true } }))
      .toEqual({ code: 'no_capability', alternative: 'device_control' });
  });

  // Book title from Project Gutenberg, retrieved 2026-11-27. https://www.gutenberg.org/ebooks/289
  it.each([
    'شغّلي قوائم التشغيل',
    'شغّل لي المفضّلة',
    'شغّل إف إم للسيارة',
    'شغّلي فيروز',
    'سكّر الراديو',
    'أريد أن أستمع للقرآن',
    'I would like to hear the Qur’an',
    'I want to hear some live music',
    'I’d like to listen to a surah',
    'I wanna listen to an album',
    'I’m gonna watch a movie',
    'Gonna play my favorite track',
    'Play this programme for us',
    'Start playing The Wind in the Willows',
    'Start The Wind in the Willows',
    'Resume The Wind in the Willows',
  ])('detects playback in %s only when media is unavailable', request => {
    expect(classifyRefusal(request, context)).toEqual({ code: 'no_capability', alternative: 'find_media' });
    expect(classifyRefusal(request, { ...context, capabilities: { mediaModel: true } })).toBeNull();
  });

  it.each([
    'شغّلي فايرفوكس',
    'شغّلي كروم على جهازي',
    'شغّل الاختبارات',
    'شغّل أمر echo hello',
    'شغّل حملة إعلانية جديدة',
    'مين كان سفير وشغل منصب المدير بعد التقاعد؟',
    'شغّل النور في المحاكاة',
    'كيف أقدر أشغّل الراديو؟',
    'شغّل عقلك وحل اللغز',
    'ترجم «ولّع نور الحديقة»',
    'I want to hear about that documentary',
    'I wanna listen to what you wrote about the movie',
    'Watch the browser while the video uploads',
    'Watch the channel for new comments',
    'Can a toddler see the picture and hear the song?',
    'I’m gonna watch for movie spoilers',
    'I wanna play chess',
    'Start the next lesson',
    'Start the introduction with a hook',
    'Start the code review',
    'Resume the guided exercise',
    'Resume adding the citations',
    'Resume the discussion about tomorrow’s schedule',
  ])('preserves the supported path for %s', request => {
    expect(classifyRefusal(request, context)).toBeNull();
  });
});
