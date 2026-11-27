import { describe, expect, it } from 'vitest';
import { imageSpecification, searchRefusedReply, unsupportedReply, unsupportedRequest } from '../apps/server/src/assistant/unsupported-request.js';
import { notWebReason, tidy, webQuestion } from '../apps/server/src/assistant/hands.js';
import { replyLanguage } from '../apps/server/src/assistant/reply-check.js';

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

/**
 * A message that only says how a picture should look. Real request rq091 (2026-11-22): a colour-on-background
 * description after a logo was searched on its own words and answered with a physics sentence from the article «لون».
 * These cases use their own wording, not the set's.
 */
describe('imageSpecification', () => {
  it('takes a whole description of colours and background as a picture, with nothing before it', () => {
    for (const text of ['أزرق على خلفية رمادية', 'بخلفية شفافة', 'أبيض على أسود', 'شعار أحمر بدون خلفية', 'صورة القطة السوداء على خلفية بيضاء',
      'white on a black background', 'with a transparent background', 'logo without a background', 'no background']) {
      expect(imageSpecification(text), text).toBe(text);
      expect(unsupportedRequest(text), text).toMatchObject({ kind: 'image', spec: text });
    }
  });

  it('takes a bare colour, resolution or style as a picture only right after one was asked for or named', () => {
    expect(imageSpecification('باللون الأخضر', ['هل تستطيع رسم الصور؟'])).toBe('باللون الأخضر');
    expect(imageSpecification('in blue', ['tesla logo'])).toBe('in blue');
    expect(imageSpecification('make it blue', ['ارسم لي قطة'])).toBe('make it blue');
    expect(imageSpecification('بدقة عالية', ['draw a fox', 'بخلفية شفافة'])).toBe('بدقة عالية');
    expect(imageSpecification('كرتوني', ['صمم لي شعارًا لمخبزي'])).toBe('كرتوني');
    const alone: [string[], string][] = [[[], 'باللون الأخضر'], [[], 'in blue'], [[], 'png'], [['ما عاصمة اليابان؟'], 'باللون الأخضر'],
      [['what is the weather in Paris'], 'in blue'], [['draw a fox', 'ما عاصمة اليابان؟'], 'in blue']];
    for (const [earlier, text] of alone) expect(imageSpecification(text, earlier), `${earlier.join(' | ')} → ${text}`).toBeNull();
  });

  it('leaves a description that follows a PDF, a website or a letter to that work', () => {
    expect(imageSpecification('بخلفية سوداء', ['أنشئ ملف PDF بعنوان خطة العمل'])).toBeNull();
    expect(imageSpecification('خلفية بيضاء', ['ابنِ لي موقعًا لمطعمي'])).toBeNull();
    expect(imageSpecification('white background', ['write a letter to my landlord'])).toBeNull();
  });

  it('leaves questions, figurative uses and names with colours alone', () => {
    for (const text of ['لماذا تبدو السماء زرقاء؟', 'ما أفضل لون للنص على خلفية بيضاء؟', 'what colour goes with a white background', 'اعتقالات على خلفية الاحتجاجات',
      'black and white', 'البيت الأبيض', 'Black Sea', 'الثقب الأسود', 'المياه البيضاء', 'ما هو اللون الأسود', 'how to remove a white background in photoshop', 'ابحث عن صور القطط']) {
      expect(imageSpecification(text), text).toBeNull();
      expect(unsupportedRequest(text), text).toBeNull();
    }
  });

  it('names the description back, without the lead words, before the limit', () => {
    const found = unsupportedRequest('طيب، بخلفية زرقاء فاتحة من فضلك');
    expect(found).toMatchObject({ kind: 'image', lang: 'ar', spec: 'بخلفية زرقاء فاتحة' });
    const ar = unsupportedReply(found!);
    expect(ar).toContain('فهمت «بخلفية زرقاء فاتحة» وصفًا لشكل الصورة');
    expect(ar).toContain('لا أرسم الصور');
    expect(ar).toContain('ابحث عن');
    expect(unsupportedReply({ kind: 'image', lang: 'en', spec: 'white on black' })).toContain('I took “white on black” as how the image should look');
    // A drawing request keeps its plain reply.
    expect(unsupportedReply(unsupportedRequest('ارسم لي صورة قطة')!)).not.toContain('فهمت');
  });
});

describe('searchRefusedReply', () => {
  it('explains a source refusal in the request language without repeating the guard message', () => {
    const ar = searchRefusedReply('افعل شيئًا مفيدًا', 'افعل شيئا مفيدا', 'ASSISTANT_SEARCH_SOURCE');
    expect(ar).toContain('لم أبحث في الويب عن «افعل شيئا مفيدا»');
    expect(ar).toContain('ما هو');
    expect(replyLanguage(ar).replyLang).toBe('ar');
    const en = searchRefusedReply('do something useful', 'do something useful', 'ASSISTANT_SEARCH_SOURCE');
    expect(en).toContain('I did not search the web for “do something useful”');
    expect(replyLanguage(en).replyLang).toBe('en');
  });

  // The guard cases come from the chat catch site, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts#L3260
  it.each([
    ['ASSISTANT_SEARCH_PROVENANCE', 'بعض كلمات البحث', 'some search terms'],
    ['RESEARCH_QUERY_INVALID', 'موضوعًا محددًا', 'a specific search topic'],
    ['RESEARCH_QUERY_SECRET', 'بيانات الاعتماد', 'credentials'],
  ])('localizes the %s refusal without echoing its guard code', (code, arabicDetail, englishDetail) => {
    const en = searchRefusedReply('search for a subject', 'a subject', code);
    expect(replyLanguage(en).replyLang).toBe('en');
    expect(en).toContain(englishDetail);
    expect(en).not.toMatch(/\p{Script=Arabic}/u);
    expect(en).not.toContain(code);
    const ar = searchRefusedReply('ابحث عن موضوع', 'موضوع', code);
    expect(replyLanguage(ar).replyLang).toBe('ar');
    expect(ar).toContain(arabicDetail);
    expect(ar).not.toContain(code);
  });
});
