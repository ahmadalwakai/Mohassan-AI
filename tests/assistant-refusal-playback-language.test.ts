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
    'ولع الضو',
    'طفي الضو',
    'سكر المكيف',
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
    'شغلي محمد عبده',
    'سكّر الراديو',
    'أريد أن أستمع للقرآن',
    'I would like to hear the Qur’an',
    'I want to hear some live music',
    'I’d like to listen to a surah',
    'I wanna listen to an album',
    'I wanna hear some music',
    'watch the new episode',
    'I’m gonna watch a movie',
    'Gonna play my favorite track',
    'Play this programme for us',
    'Start playing The Wind in the Willows',
    'Start "The Wind in the Willows"',
    'Resume the “Wind in the Willows”',
    'Resume The Wind in the Willows on YouTube',
    'Start The Wind in the Willows by Kenneth Grahame',
    'Resume The Wind in the Willows بصوت الراوي',
    'Start the next audiobook',
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
    'شغل السيرفر',
    'شغل npm run dev',
    'شغل الخادم المحلي',
    'شغل الدوكر',
    'شغل الوورد',
    'شغل الواي فاي',
    'شغل البلوتوث',
    'شغل السيارة',
    'شغل فكرك',
    'شغّل خادم البودكاست',
    'شغّل أدوات الاستماع من tools/stream.mjs',
    'شغّل echo music',
    'شغّل الاكسل',
    'شغّل غسالة الملابس',
    'ترجم «ولّع نور الحديقة»',
    'I want to hear about that documentary',
    'I wanna listen to what you wrote about the movie',
    'Watch the browser while the video uploads',
    'Watch the channel for new comments',
    'Can a toddler see the picture and hear the song?',
    'I’m gonna watch for movie spoilers',
    'I wanna play chess',
    'Start the next lesson',
    'start the dev server',
    'start the docker compose stack',
    'start the payment service',
    'resume the training run',
    'Start The Wind in the Willows',
    'Resume The Wind in the Willows',
    'Start the workshop by noon',
    'Start tomorrow by lunchtime',
    'Resume by adding the references',
    'Resume the analysis of the new episode',
    'Start the podcast service',
    'Start "The Wind in the Willows" --dry-run',
    'Resume the podcast from ./worker.mjs',
    'Start `monitor --audio`',
    'Translate “Start the podcast” into Arabic',
    'Do not start "The Wind in the Willows"',
    'Start the introduction with a hook',
    'Start the code review',
    'Resume the guided exercise',
    'Resume adding the citations',
    'Resume the discussion about tomorrow’s schedule',
  ])('preserves the supported path for %s', request => {
    expect(classifyRefusal(request, context)).toBeNull();
  });

  it('preserves the physical action refusal outside the smart-device list', () => {
    expect(classifyRefusal('شغل الفرن', context)).toEqual({ code: 'no_capability', alternative: 'public_info' });
  });
});
