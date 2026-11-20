import type { Frame, MindReply } from './contract.js';

export type LocalReply = Pick<MindReply, 'status' | 'text' | 'claims' | 'evidence'>;

const LOCAL_TEXT = {
  ar: {
    name: 'موحسن',
    identity: 'أنا موحسن، مساعدك في الحساب واسترجاع المعلومات وقراءة المصادر.',
    creator: 'أنشأ تطبيق موحسن وطوّره أحمد الوكاع، المطوّر الرئيسي.',
    greeting: 'مرحبًا! كيف أساعدك؟',
    peace: 'وعليكم السلام! كيف أساعدك؟',
    thanks: 'العفو، يسعدني أن أساعدك.',
    limits: 'لا أستطيع حاليًا الكتابة الحرة أو الترجمة أو الشرح بأسلوبي. يمكنني البحث وعرض ما تقوله المصادر بنصها.',
  },
  en: {
    name: 'Mohassan',
    identity: 'I’m Mohassan, your assistant for calculations, retrieving information and reading sources.',
    creator: 'Ahmad Alwakai is the creator and lead developer of the Mohassan application.',
    greeting: 'Hello! How can I help?',
    peace: 'Peace be upon you too! How can I help?',
    thanks: 'You’re welcome. Glad to help.',
    limits: 'I cannot write, translate or explain in my own words yet. I can search and show you what the sources say directly.',
  },
} as const;

export function fixedReply(text: string, status: LocalReply['status'] = 'completed', claim: 'fixed' | 'not_found' = 'fixed'): LocalReply {
  return { status, text, claims: [{ text, support: [], status: claim }], evidence: [] };
}

export function limits(frame: Frame): LocalReply {
  const copy = LOCAL_TEXT[frame.lang];
  const text = frame.text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '');
  if (frame.intent === 'identity') {
    if (/\b(?:creat(?:ed?|or)|made|built|develop(?:ed?|er)|coded|founder)\b|(?:صنعك|انش[أا]ك|ابتكرك|طورك|برمجك|المطور|مؤسس|من وراك)/iu.test(text)) return fixedReply(copy.creator);
    if (frame.valueOnly || /\b(?:your name|called)\b|(?:اسمك|يسمونك)/iu.test(text)) return fixedReply(copy.name);
    return fixedReply(copy.identity);
  }
  if (frame.intent === 'smalltalk') {
    if (/\b(?:thank(?:s| you)?|thx|cheers|appreciate)\b|(?:شكر|تسلم|ممنون|مشكور|يعطيك العافي|جزاك الله)/iu.test(text)) return fixedReply(copy.thanks);
    if (/السلام عليكم|\b(?:as[ -]?salam|peace be upon you)\b/iu.test(text)) return fixedReply(copy.peace);
    return fixedReply(copy.greeting);
  }
  return fixedReply(copy.limits, 'blocked');
}

export function askForDetails(frame: Frame): LocalReply & { question: { prompt: string } } {
  const text = frame.lang === 'ar' ? 'ما الذي تريد معرفة تفاصيله؟ حدّد المطلوب في رسالة واحدة.'
    : 'What would you like to know about? Please include the details together.';
  return { ...fixedReply(text, 'waiting_user'), question: { prompt: text } };
}

export function notAvailable(frame: Frame): LocalReply {
  const text = frame.lang === 'ar' ? 'هذا المسار غير متاح حاليًا.' : 'This route is currently unavailable.';
  return fixedReply(text, 'blocked');
}
