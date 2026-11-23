import { describe, expect, it } from 'vitest';
import { ownFactQuestion } from '../apps/server/src/assistant/own-fact-question.js';

// Wordings written for this test (2026-11-22). The two measured failures come first: both went to a public web search
// in artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json.
describe('a question about a fact of the owner\'s own', () => {
  it.each([
    ['ما هي لغتي المفضلة؟', 'لغتي المفضلة', 'لغتي'],
    ['ما هو رقم جوالي؟', 'رقم جوالي', 'جوالي'],
    ['ما هي أسعار منتجاتي؟', 'أسعار منتجاتي', 'منتجاتي'],
    ['كم عمري؟', 'عمري', 'عمري'],
    ['ما اسمي', 'اسمي', 'اسمي'],
    ['ما لغتي المفضلة', 'لغتي المفضلة', 'لغتي'],
    ['ما هو تاريخ ميلادي؟', 'تاريخ ميلادي', 'ميلادي'],
    ['ما هو رقم لوحة سيارتي؟', 'رقم لوحة سيارتي', 'سيارتي'],
    ['ما هو بريدي الإلكتروني؟', 'بريدي الإلكتروني', 'بريدي'],
    ['ما اسم زوجتي؟', 'اسم زوجتي', 'زوجتي'],
    ['من هو مديري؟', 'مديري', 'مديري'],
    ['أين يقع مكتبي؟', 'مكتبي', 'مكتبي'],
    ['متى موعدي؟', 'موعدي', 'موعدي'],
    ['وما هي جنسيتي؟', 'جنسيتي', 'جنسيتي'],
    ['شو اسم شركتي', 'اسم شركتي', 'شركتي'],
    ['ما هو راتبي الشهري؟', 'راتبي الشهري', 'راتبي'],
    ['ما هي منتجاتنا؟', 'منتجاتنا', 'منتجاتنا'],
    ['من عملائي؟', 'عملائي', 'عملائي'],
    ['هل تعرف اسمي؟', 'اسمي', 'اسمي'],
    ['قل لي رقم هاتفي', 'رقم هاتفي', 'هاتفي'],
    ['أخبرني عن عنواني الحالي', 'عنواني الحالي', 'عنواني'],
    ['ما فصيلة دمي؟', 'فصيلة دمي', 'دمي'],
  ])('%s', (request, topic, owned) => {
    expect(ownFactQuestion(request)).toEqual({ topic, owned });
  });

  it('recognises the owner\'s favourite whatever the noun', () => {
    expect(ownFactQuestion('ما هو لوني المفضل؟')).toEqual({ topic: 'لوني المفضل', owned: 'لوني' });
    expect(ownFactQuestion('من هو لاعبي المفضل؟')).toEqual({ topic: 'لاعبي المفضل', owned: 'لاعبي' });
    expect(ownFactQuestion('ما هي أكلتي المفضلة')).toEqual({ topic: 'أكلتي المفضلة', owned: 'اكلتي' });
  });

  it('strips an attached preposition from the topic', () => {
    expect(ownFactQuestion('أخبرني باسمي')).toEqual({ topic: 'اسمي', owned: 'اسمي' });
  });
});

describe('a public question that only looks personal', () => {
  it.each([
    // A name, a place or a team whose last letter is «ي».
    'كم عمر ميسي؟', 'ما هو طول ميسي؟', 'من هو علي؟', 'ما هي عاصمة جيبوتي؟', 'كم عدد سكان سيدني؟', 'ما هو ترتيب الأهلي؟', 'ما اسم محامي ترامب؟',
    // An adjective whose last letter is «ي».
    'ما هو الذكاء الاصطناعي؟', 'ما هو ذكاء اصطناعي؟', 'ما هو هاتف ذكي؟', 'ما هو تسويق رقمي؟', 'ما هو التحول الرقمي؟', 'ما هو خبز بلدي؟', 'ما هو حساب جاري؟',
    'ما هو طابع بريدي؟', 'ما هو خط طولي؟', 'ما هو تطبيق عملي؟', 'ما هو التاريخ الميلادي اليوم؟', 'ما هو عدد أولي؟', 'ما هو نظام محاسبي؟',
    // A plural before its genitive.
    'كم عدد موظفي الشركة؟', 'كم عدد موظفي جوجل؟', 'من هو لاعب ميسي المفضل؟', 'كم عدد مديري المدارس؟',
    // A how-to, a reason or a task that mentions something of the owner's.
    'كيف أنظف سيارتي؟', 'لماذا تأخر طلبي؟', 'اكتب وصفًا لمنتجاتي', 'كيف أزيد مبيعات متجري؟', 'ما أفضل طريقة لتسويق منتجاتي؟', 'افتح موقعي',
    // Public facts with ordinary words.
    'ما عاصمة فرنسا؟', 'كم عدد سكان اليابان؟', 'ما هي قدراتك؟', 'ما اسمك؟', 'ما هو رقم الطوارئ؟', 'ما هو عمر الأرض؟',
    // Not one short question.
    'ما هو رقم جوالي 0501234567', 'ما اسمي\nوما عمري', '', 'what is my phone number?',
  ])('%s', request => {
    expect(ownFactQuestion(request)).toBeNull();
  });
});
