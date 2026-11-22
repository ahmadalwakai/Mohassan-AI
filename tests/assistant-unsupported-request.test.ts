import { describe, expect, it } from 'vitest';
import { searchRefusedReply, unsupportedReply, unsupportedRequest } from '../apps/server/src/assistant/unsupported-request.js';
import { notWebReason, tidy, webQuestion } from '../apps/server/src/assistant/hands.js';

describe('unsupportedRequest', () => {
  it('names drawing and image generation', () => {
    for (const text of ['ارسم لي صورة قطة', 'ارسم قطة', 'صمم لي شعارًا لمخبزي', 'ولّد صورة لغروب الشمس', 'Draw a cat', 'generate an image of a sunset', 'Make me a logo for my bakery']) {
      expect(unsupportedRequest(text), text).toMatchObject({ kind: 'image' });
    }
  });

  it('names playing or generating media', () => {
    for (const text of ['شغّل أغنية لفيروز', 'سمعني موسيقى هادئة', 'شغل فيديو عن الطبخ', 'Play some music', 'play me a song by Fairuz', 'Create a video about my shop']) {
      expect(unsupportedRequest(text), text).toMatchObject({ kind: 'media' });
    }
  });

  it('names booking, buying, calling and sending', () => {
    for (const text of ['احجز لي طاولة في مطعم', 'اطلب لي بيتزا', 'اتصل بأمي', 'أرسل رسالة إلى أحمد', 'Book me a flight to Paris next Monday', 'Order me a pizza', 'Call my mom', 'Send an email to Sara']) {
      expect(unsupportedRequest(text), text).toMatchObject({ kind: 'act' });
    }
  });

  it('leaves questions, lookups, conversions and browser commands alone', () => {
    for (const text of ['ما عاصمة اليابان؟', 'Node.js latest version', 'كم سعر الذهب اليوم؟', 'حوّل 100 دولار إلى يورو', 'Call of Duty release date',
      'ابحث عن صور القطط', 'افتح يوتيوب وابحث عن أغنية فيروز', 'who wrote the novel One Hundred Years of Solitude', 'send me the latest news', 'كم 15 ضرب 23؟']) {
      expect(unsupportedRequest(text), text).toBeNull();
    }
  });

  it('never claims memory, Ads or reminders: those paths decide first', () => {
    // The chat consults notWebReason() before this detector, so a campaign, a reminder or a note is never an unsupported request.
    for (const text of ['شغّل حملة إعلانية جديدة', 'ذكرني أن أتصل بأمي غدًا', 'احفظ في ذاكرتي أن أحجز طاولة']) {
      expect(notWebReason(tidy(text)), text).not.toBeNull();
    }
  });

  it('replies in the request language with what cannot be done and the nearest alternative', () => {
    expect(unsupportedReply({ kind: 'image', lang: 'ar' })).toContain('لا أرسم الصور');
    expect(unsupportedReply({ kind: 'image', lang: 'ar' })).toContain('ابحث عن');
    expect(unsupportedReply({ kind: 'media', lang: 'en' })).toContain('open youtube');
    expect(unsupportedReply({ kind: 'act', lang: 'ar' })).toContain('لا أحجز');
    expect(unsupportedReply({ kind: 'generic', lang: 'en' })).toContain('current capabilities');
  });

  it('does not stand in the way of the web question that follows a real question', () => {
    expect(webQuestion('ما عاصمة اليابان؟')).toMatchObject([{ kind: 'search' }]);
    expect(unsupportedRequest('ما عاصمة اليابان؟')).toBeNull();
  });
});

describe('searchRefusedReply', () => {
  it('explains a source refusal in the request language without repeating the guard message', () => {
    const ar = searchRefusedReply('افعل شيئًا مفيدًا', 'افعل شيئا مفيدا', 'ASSISTANT_SEARCH_SOURCE', 'guard');
    expect(ar).toContain('لم أبحث في الويب عن «افعل شيئا مفيدا»');
    expect(ar).toContain('ما هو');
    const en = searchRefusedReply('do something useful', 'do something useful', 'ASSISTANT_SEARCH_SOURCE', 'guard');
    expect(en).toContain('I did not search the web for “do something useful”');
  });

  it('passes the guard message through for provenance and query errors', () => {
    expect(searchRefusedReply('x', 'x', 'RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد')).toBe('أزل بيانات الاعتماد');
    expect(searchRefusedReply('x', 'x', 'ASSISTANT_SEARCH_PROVENANCE', 'provenance')).toBe('provenance');
  });
});
