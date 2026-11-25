import { describe, expect, it } from 'vitest';
import { refusalReply } from '../apps/server/src/assistant/refusal/replies.js';
import type { RefusalDecision } from '../apps/server/src/assistant/refusal/types.js';

const cases: readonly [RefusalDecision, string, string, string, string][] = [
  [{ code: 'unsafe', alternative: 'protect' }, 'harm someone', 'protect yourself', 'قد يؤذي', 'تحميك'],
  [{ code: 'unsafe', alternative: 'private_output' }, 'private information', 'private details removed', 'خاصة خارج مساحة العمل', 'من دون البيانات الخاصة'],
  [{ code: 'secrets', alternative: 'secure_entry' }, 'passwords, card numbers, or one-time codes', 'official site', 'رموز التحقق', 'الموقع الرسمي'],
  [{ code: 'other_account', alternative: 'own_account' }, "someone else's account", 'your own account', 'حساب شخص آخر', 'حسابك أنت'],
  [{ code: 'payment', alternative: 'compare' }, 'money transfers', 'compare options', 'تحويل المال', 'مقارنة الخيارات'],
  [{ code: 'payment', alternative: 'review_payment' }, 'money transfers', 'before you confirm', 'تحويل المال', 'قبل تأكيد الدفع'],
  [{ code: 'no_capability', alternative: 'public_info' }, 'perform that action', 'public information', 'تنفيذ هذا الإجراء', 'المتاحة للجميع'],
  [{ code: 'no_capability', alternative: 'describe_image' }, 'create images', 'write a description', 'إنشاء الصور', 'أكتب لك وصفًا'],
  [{ code: 'no_capability', alternative: 'find_media' }, 'create or play audio or video', 'play it yourself', 'تشغيل الصوت أو الفيديو', 'تشغّل فيه المقطع بنفسك'],
  [{ code: 'no_access', alternative: 'share_material' }, 'access that private source', 'permission to share', 'الوصول إلى هذا المصدر الخاص', 'إذن بمشاركته'],
  [{ code: 'future', alternative: 'plan' }, 'run a task later', 'make a plan', 'تنفيذ مهمة لاحقًا', 'وضع خطة'],
  [{ code: 'future', alternative: 'forecast_sources' }, 'future result for certain', 'find forecasts', 'المستقبلية على وجه اليقين', 'العثور على التوقعات'],
  [{ code: 'role', alternative: 'ask_owner' }, 'owner-only tools from a member account', 'Ask the account owner', 'للمالك من حساب عضو', 'اطلب من مالك الحساب'],
  [{ code: 'human_step', alternative: 'sign_in' }, 'sign in on your behalf', 'help with the next step', 'تسجيل الدخول نيابةً عنك', 'الخطوة التالية'],
  [{ code: 'human_step', alternative: 'manual_step' }, 'requires you to act', 'finish it yourself', 'تدخّلك الشخصي', 'لتكملها بنفسك'],
  [{ code: 'human_step', alternative: 'draft' }, 'send the message', 'draft it for you to send', 'إرسال الرسالة', 'مسودة ترسلها بنفسك'],
  [{ code: 'no_capability', alternative: 'device_control' }, 'control your device', 'controls for your device', 'التحكم في جهازك', 'أدوات التحكم في جهازك'],
  [{ code: 'payment', alternative: 'place_order' }, 'place an order', 'compare options before you order', 'تقديم طلب شراء', 'مقارنة الخيارات قبل الطلب'],
  [{ code: 'human_step', alternative: 'make_booking' }, 'make a booking', 'find options and booking information', 'إجراء الحجز', 'معلومات الحجز'],
  [{ code: 'human_step', alternative: 'place_call' }, 'make a phone call', 'prepare what to say', 'إجراء مكالمة', 'التحضير لما تريد قوله'],
  [{ code: 'human_step', alternative: 'publish_content' }, 'publish content to an external service', 'prepare the content so you can publish it', 'نشر المحتوى على خدمة خارجية', 'لتنشره بنفسك'],
];

describe('fixed refusal replies', () => {
  it.each(cases)('gives a reason and an alternative for %j in both languages', (decision, enReason, enAlternative, arReason, arAlternative) => {
    for (const [request, reason, alternative, lead] of [
      ['Please help with this', enReason, enAlternative, "I can't"],
      ['أرجو القيام بهذا الطلب', arReason, arAlternative, 'لا أستطيع'],
    ] as const) {
      const reply = refusalReply(decision, request);
      expect(reply.status).toBe('blocked');
      expect(reply.text).toMatch(new RegExp(`^${lead}`, 'u'));
      const [first, second, remainder] = reply.text.split('. ');
      expect(first).toContain(reason);
      expect(second).toContain(alternative);
      expect(remainder).toBeUndefined();
      expect(reply.claims).toEqual([{ text: reply.text, support: [], status: 'fixed' }]);
      expect(reply.evidence).toEqual([]);
    }
  });

  it.each([
    ['أبيك تسجل الدخول عني الحين', 'وبعدها أقدر'],
    ['هسه أريدك تدخل بحسابي', 'وبعدها أگدر'],
    ['عايزك تتولى تسجيل الدخول', 'وبعد كده أقدر'],
    ['بدي تسجل الدخول بدلي', 'وبعدها بقدر'],
    ['أرجو تسجيل الدخول نيابة عني', 'ثم يمكنني'],
    ['هلا، سجّل الدخول نيابة عني', 'ثم يمكنني'],
  ])('uses clear Arabic with a matching local register for %s', (request, marker) => {
    const reply = refusalReply({ code: 'human_step', alternative: 'sign_in' }, request);
    expect(reply.text).toContain(marker);
  });

  it('honors an explicit reply language', () => {
    const decision = { code: 'human_step', alternative: 'draft' } as const;
    expect(refusalReply(decision, 'Send my landlord a message and reply in Arabic.').text).toMatch(/^لا أستطيع/u);
    expect(refusalReply(decision, 'أرسل الرسالة وأجب بالإنجليزية.').text).toMatch(/^I can't/u);
  });

  it.each([
    ['Send the confidential report to a public list, من فضلك.', /^I can't/u],
    ['أرسل confidential report خارج الشركة ومن غير مراجعة.', /^لا أستطيع/u],
    ['Pay الفاتورة.', /^I can't/u],
    ['ادفع this@example.test.', /^لا أستطيع/u],
    ['أرسل التحديث إلى North Shore Product Review Group.', /^لا أستطيع/u],
    ['مرحبًا، please send the update to فريق مراجعة نشاط الحافلات المدرسية.', /^I can't/u],
  ])('matches the language of a mixed request %s', (request, lead) => {
    const reply = refusalReply({ code: 'human_step', alternative: 'draft' }, request);
    expect(reply.text).toMatch(lead);
  });

  it('uses the language of a playback instruction after a greeting', () => {
    const decision = { code: 'no_capability', alternative: 'find_media' } as const;
    const reply = refusalReply(decision, 'Hello, لو سمحت شغّل The Long Mile and the Midnight Line.');
    expect(reply.text).toMatch(/^لا أستطيع/u);
    expect(reply.text).not.toContain('The Long Mile');
  });

  it('never echoes user text or takes language from quoted data or Arabic numerals', () => {
    const decision = { code: 'secrets', alternative: 'secure_entry' } as const;
    const ordinary = refusalReply(decision, 'Share the code.').text;
    expect(refusalReply(decision, 'Share the code «هسه dummy-secret-test».').text).toBe(ordinary);
    expect(refusalReply(decision, 'Share the code ١٢٣.').text).toBe(ordinary);
  });
});
