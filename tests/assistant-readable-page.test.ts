import { describe, expect, it } from 'vitest';
import { readableSource, type AgentPage } from '@mohassan/browser';
import { relevantLines } from '../apps/server/src/assistant/hands.js';
import { withoutFigures } from '../apps/server/src/assistant/readable-page.js';

/**
 * Captions glued onto article sentences, and a definition question whose kind word («عملية») the definition never says.
 * The HTML and the 74-word definition are cut from ar.wikipedia.org «ليزك» and «الساد» as read on 2026-11-22.
 */
const DEFINITION = 'تعنى كلمة <b>الليزك</b> تعديل شكل القرنية باستعمال الليزر فتستعمل أداة دقيقة تسمى الميكروكيراتوم لإزالة طبقة رقيقة من سطح القرنية عدا جزء صغير منها يبقيها متصلة بالعين ويتم إبعاده للخلف، (ويمكن إجراء هذه الخطوة أيضا بالفمتوليزر أو مايسمى بالإنتراليزك ) ويستعمل بعد ذلك الإكزايمر ليزر لا زالة جزء من النسيج الداخلي للقرنية (يتم تقديره حسب نوع ودرجة عيب الإبصار) ويتم بعد ذلك إعادة الطبقة السطحية للقرنية لوضعها الطبيعي لتلتحم بدون الحاجة لأية غرز جراحية .';
const LASIK = `<html><head><title>ليزك - ويكيبيديا</title></head><body>
<figure typeof="mw:File/Thumb"><span><video src="x.webm"></video></span><figcaption>فيديو لعملية الليزك</figcaption></figure>
<figure typeof="mw:File/Thumb"><a href="x"><img src="y.jpg"/></a><figcaption>من الأعراض الجانبية الشائعة بعد عملية الليزك نزيف مؤقت تحت الملتحمة</figcaption></figure>
<p>${DEFINITION}</p>
<p>الخطوة الأولى: رغم إنك ستظل مستيقظاً طوال جراحة الليزك إلا أنك لن تشعر بأي ألم، فبعد وضع محلول مخدر بالعين يتم إبعاد الجفون عن بعضها برفق باستعمال أداة طبية.</p>
</body></html>`;
const pageOf = (html: string, url: string): AgentPage => {
  const source = readableSource(html, url);
  return { id: url, url, title: source.title, text: source.text, elements: [], signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T09:00:00.000Z' };
};

describe('pages read over HTTP: captions and definitions', () => {
  it('leaves figures and their captions out of the text, and keeps the paragraphs', () => {
    const text = readableSource(withoutFigures(LASIK), 'https://ar.wikipedia.org/wiki/ليزك').text;
    expect(text).not.toContain('فيديو لعملية الليزك');
    expect(text).not.toContain('نزيف مؤقت تحت الملتحمة');
    expect(text).toContain('تعنى كلمة الليزك تعديل شكل القرنية');
    expect(withoutFigures('<p>أ</p><figure class="x">صورة<figcaption>تعليق</figcaption></figure><p>ب</p>')).toBe('<p>أ</p> <p>ب</p>');
  });

  it('answers «ما هي عملية الليزك» with the article’s own definition, not a caption or a step', () => {
    const page = pageOf(withoutFigures(LASIK), 'https://ar.wikipedia.org/wiki/ليزك');
    const [first] = relevantLines(page, 'ما هي عملية الليزك', 3, true);
    expect(first!.startsWith('تعنى كلمة الليزك تعديل شكل القرنية باستعمال الليزر')).toBe(true);
    // With the captions in the text they glue onto the definition, and the definition no longer leads.
    const glued = relevantLines(pageOf(LASIK, 'https://ar.wikipedia.org/wiki/ليزك'), 'ما هي عملية الليزك', 1, true)[0]!;
    expect(glued.startsWith('تعنى كلمة الليزك')).toBe(false);
  });

  it('keeps the kind word when it is the only subject word', () => {
    const page = pageOf('<html><head><title>جراحة - ويكيبيديا</title></head><body><p>الجراحة هي فرع من الطب يعالج الأمراض بالتدخل اليدوي والأدوات.</p></body></html>', 'https://ar.wikipedia.org/wiki/جراحة');
    expect(relevantLines(page, 'ما هي الجراحة', 1, true)[0]).toBe('الجراحة هي فرع من الطب يعالج الأمراض بالتدخل اليدوي والأدوات.');
  });
});
