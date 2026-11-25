// Requests quoted in the source reports, including excerpts as printed with ellipses.
// Full reproductions of live cases come from the existing tests named below. Never use this fixture for training.
import type { QuestionShape } from '../../apps/server/src/assistant/understanding/question-shape.js';

const gaps = 'docs/AGENT-GAPS-2026-11-22.md';
const repairs = 'docs/LIVE-TEST-REPAIRS-2026-11-23.md';

export interface DocumentedRequest {
  text: string;
  source: string;
  expected?: Pick<QuestionShape, 'questionWord' | 'answerType'> | null;
}

type QuotedRequest = [text: string, questionWord?: string | null, answerType?: QuestionShape['answerType']];
function quoted(source: string, requests: QuotedRequest[]): DocumentedRequest[] {
  return requests.map(([text, questionWord, answerType]) => ({
    text, source, expected: questionWord === null ? null : questionWord && answerType ? { questionWord, answerType } : undefined,
  }));
}

export const documentedRequests = [
  ...quoted(`${gaps}:19–39, assistant identity`, [
    ['ما هي قدراتك', 'ما', 'list'],
    ['are you groq ai ?', 'are', 'yes/no'],
    ['هل تستطيع أنشاء مشروع كامل ؟ موقع إلكتروني', 'هل', 'yes/no'],
    ['can you build a website for my bakery', 'can', 'yes/no'],
  ]),
  ...quoted(`${gaps}:44–58, page reading`, [
    ['افتح X وأخبرني بـY'],
    ['افتح https://www.python.org وأخبرني بآخر إصدار مذكور في الصفحة'],
    ['افتح الموقع https://example.com … وأخبرني بالعنوان الرئيسي … ونص الرابط'],
    ['افتح youtube وقل لي نكتة', null],
  ]),
  ...quoted(`${gaps}:68–72, campaign routing and pending writing card`, [
    ['Ads for boiler repair, … 40 pounds a week …', null],
    ['Set up ads for …, budget 25 pounds a day', null],
    ['Advertise my removals company …', null],
    ['I run a barbershop … want more bookings, spend 15 pounds per day', null],
    ['اكتب رسالة بريد احترافية…', null],
    ['create a campaign for tyrerescue.uk …', null],
    ['اكتب إعلان لخدمة النقل', null],
  ]),
  ...quoted(`${gaps}:98–123, calculation and compound planning`, [
    ['احسب … ثم اذكر …', null],
    ['اختبار تخطيط فقط: اكتب مسودة لحملة …', null],
    ['(١٢ زائد ٨) قسمة على ٣', null],
    ['احسب (١٢ زائد ٨) قسمة على ٣', null],
    ['كم حاصل 17 × 23؟ ثم اذكر في جملتين ما الأدوات التي تستطيع استخدامها الآن فعلياً.', 'كم', 'quantity'],
  ]),
  ...quoted(`${gaps}:181–193, calculation and the image-description conversation`, [
    ['12 على 4', null],
    ['3 في 4', null],
    ['احسب … ثم احسب …', null],
    ['can you create image', 'can', 'yes/no'],
    ['bmw logo', null],
    ['لون أسود على خلفية بيضاء', null],
  ]),
  ...quoted(`${gaps}:249–277, search and source selection`, [
    ['لماذا السماء زرقاء؟', 'لماذا', 'reason'],
    ['نص أبيض على خلفية سوداء', null],
    ['هل المشروع يعمل كما في الصورة، وهل كل شيء متصل ليعطي إجابة صحيحة ودقيقة؟', 'هل', 'yes/no'],
    ['على أي نموذج لغوي تعمل؟', 'أي', 'definition'],
    ['ما هي لغتي المفضلة؟', 'ما', 'definition'],
    ['ما هو رقم جوالي؟', 'ما', 'quantity'],
    ['لا تبحث في الويب. ما عاصمة فرنسا؟', 'ما', 'place'],
    ['كم عدد سكان أستراليا؟', 'كم', 'quantity'],
    ['كم يبلغ ارتفاع جبل إيفرست؟', 'كم', 'quantity'],
    ['Who wrote Pride and Prejudice?', 'who', 'person'],
    ['ما عاصمة فرنسا؟ ثم كم عدد سكانها؟', 'ما', 'place'],
  ]),
  ...quoted(`${gaps}:309–316, remaining search, recall and planning gaps`, [
    ['Who invented the telephone?', 'who', 'person'],
    ['كم عمر ميسي؟', 'كم', 'quantity'],
    ['كم عدد سكان أستراليا/كندا/السعودية؟', 'كم', 'quantity'],
    ['ما سرعة الضوء؟', 'ما', 'quantity'],
    ['متى سقط جدار برلين؟', 'متى', 'time'],
    ['تذكر أنني أفضل العربية', null],
    ['من ذاكرتي، ما لغتي المفضلة؟'],
    ['تذكر أن اسم شركتي هو النخبة للنقل', null],
    ['كيف أستعد لمقابلة عمل؟', 'كيف', 'method'],
    ['cover letter'],
    ['ما عاصمة فرنسا وكم عدد سكانها؟', 'ما', 'place'],
    ['احسب… ثم ابحث عن…', null],
    ['لا تبحث في الويب. ما عاصمة إيطاليا؟', 'ما', 'place'],
  ]),
  ...quoted(`${gaps}:341–371, explanation and follow-up questions`, [
    ['ليش السماء زرقاء؟', 'لماذا', 'reason'],
    ['لماذا سميت القاهرة بهذا الاسم؟', 'لماذا', 'reason'],
    ['لماذا تحدث الزلازل؟', 'لماذا', 'reason'],
    ['ما أسباب الحرب العالمية الثانية؟', 'ما', 'reason'],
    ['لماذا يهاجر سمك السلمون؟', 'لماذا', 'reason'],
    ['Why is the sky blue?', 'why', 'reason'],
    ['Why did the Roman Empire fall?', 'why', 'reason'],
    ['ما سبب زرقة السماء؟', 'ما', 'reason'],
    ['لماذا سمي البحر الأحمر بهذا الاسم؟', 'لماذا', 'reason'],
    ['لماذا؟', null],
    ['لماذا تأخر طلبي؟', 'لماذا', 'reason'],
    ['لماذا فعلت ذلك', 'لماذا', 'reason'],
    ['ما عاصمة اليابان؟', 'ما', 'place'],
    ['لماذا هي العاصمة؟', 'لماذا', 'reason'],
    ['مرحبا، لماذا تهاجر الطيور؟', 'لماذا', 'reason'],
  ]),
  ...quoted(`${repairs}:27–50, quoted inputs and excerpts from live cases B–H`, [
    ['QA test 2026-11-23:'],
    ['reply with the result in one short Arabic sentence'],
    ['your previous result'],
    ['Add 12 to your previous result', null],
    ['أضف 5 إلى النتيجة السابقة', null],
    ['Multiply it by 2', null],
    ['هذا'],
    ['Title:'],
    ['sample.pdf'],
    ['and report …'],
    ['Explain why …'],
    ['اشرح لماذا تسقط الأمطار', 'لماذا', 'reason'],
    ['the web for … Return the page title and source link'],
  ]),
  ...quoted('tests/assistant-live-test-repairs-chat.test.ts, complete reproduction requests for B, C, F, G, H', [
    ['QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.', null],
    ['Add 12 to your previous result.', null],
    ['Open https://example.com/ and report the page heading and the first sentence from the live page.', null],
    ['Explain why rain falls in two short Arabic sentences.', 'why', 'reason'],
    ['Search the web for the official IANA documentation about example domains. Return the page title and source link.'],
    ['Search the web for the official list of reserved test domains. Return the page title and source link.'],
  ]),
  ...quoted('tests/assistant-live-test-pdf-chat.test.ts, reproduction requests for D and E', [
    ['Create a downloadable one-page PDF named sample.pdf. Title: Sample Document. Body: Hello from the browser. Arabic text: مرحباً، هذا مستند تجريبي. Use a plain white background and black text. The content is complete; generate the file now and provide its download link.', null],
    ['اصنع لي ملف PDF من نصّ أكتبه', null],
  ]),
  ...quoted(`${repairs}:63–95, remaining gaps and regression failures`, [
    ['اكتب إعلان لخدمة النقل', null],
    ['أضف X إلى Y', null],
    ['Add 2 eggs to it', null],
  ]),
];
