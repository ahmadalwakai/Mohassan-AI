import { notWebReason, tidy } from './hands.js';

/**
 * Letters and emails without a model: one card asks who it is for, what kind it is, what to say and who signs it,
 * then a fixed frame wraps the owner's own words. Nothing here writes free text; the details stay exactly as typed.
 * Writing a frame cannot hold (translation, poems, stories, rewriting a given text) gets a plain answer instead.
 */
export type LetterKind = 'request' | 'apology' | 'thanks' | 'followup' | 'congrats' | 'complaint' | 'general';
export type Lang = 'ar' | 'en';
export interface WritingTask { kind: LetterKind; lang: Lang }
export type WritingDecision = WritingTask | { unsupported: string; lang: Lang };

const ARABIC = /[؀-ۿ]/u;
const KINDS: [LetterKind, RegExp][] = [
  ['apology', /اعتذار|أعتذر|اعتذر|apolog|sorry/iu],
  ['thanks', /شكر|thank/iu],
  ['congrats', /تهنئ|تهني|مبارك|congrat|birthday|عيد ميلاد/iu],
  ['complaint', /شكوى|شكوي|تظلم|complain/iu],
  ['followup', /متابع|follow.?up|تذكير بـ|reminder about/iu],
  ['request', /طلب|أطلب|اطلب|request|asking for|إجاز|اجاز|leave/iu],
];
/** Writing that needs a model: a frame cannot translate, compose verse or a story, or rework the owner's text. */
const FREE: [RegExp, string, string][] = [
  [/^(?:ترجم|translate)|ترجم[ةه]/iu, 'الترجمة', 'translation'],
  [/شعر|قصيد|poem|verse/iu, 'كتابة الشعر', 'poems'],
  [/قص[ةه]|حكاي|story/iu, 'كتابة القصص', 'stories'],
  [/صحح|صحّح|حسّن|حسن\s|اعد صياغ|أعد صياغ|صيغ|اختصر|لخص|rewrite|proofread|shorten|summari[sz]e|improve|correct/iu, 'تحسين نص أو إعادة صياغته', 'rewriting a text'],
  [/مقال|بحث|سيرة ذاتي|cv\b|résumé|resume|essay|article|وصف منتج|product description|تغريد|منشور|tweet|post\b|caption/iu, 'المقالات والمنشورات والأوصاف', 'articles, posts and descriptions'],
];
const LETTER = /رسال|بريد|إيميل|ايميل|ايميل|ميل|خطاب|إشعار|email|e-mail|mail|letter|message|note/iu;

/** What a writing request is, or null when it is not one. */
export function writingTask(request: string): WritingDecision | null {
  const text = tidy(request);
  if (notWebReason(text) !== 'writing') return null;
  const lang: Lang = ARABIC.test(text) ? 'ar' : 'en';
  // Translating or reworking a text is never a new letter, even when the text is «رسالتي»; verse, stories and
  // articles are, only when no letter is named («اكتب رسالة فيها قصة» is a letter).
  for (const [index, [pattern, ar, en]] of FREE.entries()) {
    const reworks = index === 0 || index === 3;
    if (pattern.test(text) && (reworks || !LETTER.test(text.replace(pattern, '')))) return { unsupported: lang === 'ar' ? ar : en, lang };
  }
  const kind = KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'general';
  if (!LETTER.test(text) && kind === 'general') return { unsupported: lang === 'ar' ? 'هذا النوع من الكتابة' : 'this kind of writing', lang };
  return { kind, lang };
}

const KIND_LABELS: Record<LetterKind, [string, string]> = {
  request: ['طلب', 'Request'], apology: ['اعتذار', 'Apology'], thanks: ['شكر', 'Thanks'], followup: ['متابعة', 'Follow-up'],
  congrats: ['تهنئة', 'Congratulations'], complaint: ['شكوى', 'Complaint'], general: ['رسالة عامة', 'General message'],
};
const ORDER: LetterKind[] = ['request', 'apology', 'thanks', 'followup', 'congrats', 'complaint'];

/** One card with four questions; the guessed kind is chosen in advance and can be changed. */
export function writingQuestion(task: WritingTask) {
  const ar = task.lang === 'ar';
  const kinds = task.kind === 'general' ? ORDER : [task.kind, ...ORDER.filter(kind => kind !== task.kind)];
  return {
    prompt: ar ? 'أكتب لك الرسالة من قالب رسمي، والتفاصيل تبقى بكلماتك. أجب عن هذه الأسئلة:' : 'I will put your message in a formal frame and keep the details in your words. Answer these:',
    fields: [
      { id: 'to', prompt: ar ? 'لمن الرسالة؟ (الاسم والصفة)' : 'Who is it for? (name and role)', suggestions: [], placeholder: ar ? 'مثلاً: الأستاذ خالد، مدير المشتريات' : 'e.g. Ms Brown, purchasing manager' },
      { id: 'kind', prompt: ar ? 'ما نوعها؟' : 'What kind is it?', suggestions: kinds.slice(0, 6).map(kind => ({ label: KIND_LABELS[kind][ar ? 0 : 1] })), selected: task.kind === 'general' ? [] : [0] },
      { id: 'details', prompt: ar ? 'ماذا تريد أن تقول؟ اكتب الأهم في سطر أو سطرين.' : 'What do you want to say? The main point in a line or two.', suggestions: [], placeholder: ar ? 'مثلاً: تأخر التسليم يومين بسبب الشحن' : 'e.g. delivery is two days late because of shipping' },
      { id: 'from', prompt: ar ? 'من يوقّعها؟' : 'Who signs it?', suggestions: [], placeholder: ar ? 'اسمك وصفتك' : 'your name and role' },
    ],
  };
}

/** «1. a\n2. b …» (or one line with the numbers inline) back into the answers in order. */
export function numberedAnswers(reply: string, count: number): string[] {
  const parts = reply.split(/(?:^|\s)([1-9])\.\s+/u);
  const answers: string[] = Array(count).fill('');
  for (let at = 1; at + 1 < parts.length; at += 2) {
    const index = Number(parts[at]) - 1;
    if (index >= 0 && index < count) answers[index] = parts[at + 1].trim();
  }
  return answers;
}

const kindOf = (answer: string, fallback: LetterKind): LetterKind =>
  (Object.entries(KIND_LABELS).find(([, labels]) => labels.some(label => answer.includes(label)))?.[0] as LetterKind | undefined)
  ?? KINDS.find(([, pattern]) => pattern.test(answer))?.[0] ?? fallback;

const FRAMES: Record<LetterKind, { ar: [string, string, string]; en: [string, string, string] }> = {
  // [subject, opening line, closing line]
  request: { ar: ['طلب', 'أتقدم إليكم بهذا الطلب، راجياً التكرم بالنظر فيه:', 'شاكراً لكم حسن تعاونكم، وبانتظار ردكم الكريم.'],
    en: ['Request', 'I am writing to ask for your help with the following:', 'Thank you for considering this. I look forward to hearing from you.'] },
  apology: { ar: ['اعتذار', 'أود أن أعتذر لكم بصدق عما يلي:', 'نقدّر تفهمكم، ونعمل على ألا يتكرر ذلك.'],
    en: ['Apology', 'I would like to sincerely apologise for the following:', 'Thank you for your understanding. We are taking steps to make sure it does not happen again.'] },
  thanks: { ar: ['شكر وتقدير', 'أتوجه إليكم بخالص الشكر والتقدير على ما يلي:', 'مع خالص الامتنان، متمنياً لكم دوام التوفيق.'],
    en: ['Thank you', 'I want to thank you sincerely for the following:', 'With many thanks and best wishes.'] },
  followup: { ar: ['متابعة', 'أتابع معكم بخصوص ما يلي:', 'أرجو إفادتي بآخر المستجدات متى ما أتيح لكم ذلك.'],
    en: ['Follow-up', 'I am following up on the matter below:', 'I would be grateful for an update when you have a moment.'] },
  congrats: { ar: ['تهنئة', 'يسعدني أن أتقدم إليكم بأحر التهاني:', 'مع أطيب التمنيات بدوام النجاح والتوفيق.'],
    en: ['Congratulations', 'Warm congratulations:', 'Wishing you continued success.'] },
  complaint: { ar: ['شكوى', 'أود أن أعرض عليكم الشكوى التالية:', 'آمل معالجة الأمر في أقرب وقت، وشاكراً لكم اهتمامكم.'],
    en: ['Complaint', 'I am writing to raise the following complaint:', 'I would appreciate this being resolved as soon as possible. Thank you for your attention.'] },
  general: { ar: ['رسالة', 'أكتب إليكم بخصوص ما يلي:', 'وتفضلوا بقبول فائق الاحترام والتقدير.'],
    en: ['Message', 'I am writing to you about the following:', 'Kind regards.'] },
};

/** The letter: a fixed frame around the owner's own words, which are never changed. */
export function composeLetter(task: WritingTask, reply: string): { text: string; complete: boolean } {
  const [to, kindAnswer, details, from] = numberedAnswers(reply, 4);
  const kind = kindOf(kindAnswer, task.kind);
  const ar = task.lang === 'ar';
  const [subject, opening, closing] = FRAMES[kind][ar ? 'ar' : 'en'];
  const greeting = ar ? (to ? `${to} المحترم،` : 'السادة المحترمون،') : (to ? `Dear ${to},` : 'Dear Sir or Madam,');
  const body = details || (ar ? '[اكتب التفاصيل هنا]' : '[write the details here]');
  const letter = ar
    ? [`**الموضوع:** ${subject}`, '', greeting, 'السلام عليكم ورحمة الله وبركاته، وبعد:', '', opening, body, '', closing, '', 'مع التحية،', from || '[الاسم]'].join('\n')
    : [`**Subject:** ${subject}`, '', greeting, '', opening, body, '', closing, '', 'Best regards,', from || '[Name]'].join('\n');
  const note = ar
    ? '\n\n---\nهذه مسودة من قالب: الإطار ثابت والتفاصيل بكلماتك كما كتبتها. لم يكتبها نموذج.'
    : '\n\n---\nThis draft comes from a template: the frame is fixed and the details are your own words. No model wrote it.';
  return { text: letter + note, complete: Boolean(details && to && from) };
}

/** The plain answer for writing a frame cannot do, instead of a «no model» error. */
export function unsupportedWriting(decision: { unsupported: string; lang: Lang }): string {
  return decision.lang === 'ar'
    ? `${decision.unsupported} تحتاج نموذجاً يكتب نصاً حراً، وموحسن لا يملك نموذج كتابة بعد. أستطيع الآن: كتابة رسالة أو إيميل رسمي من قالب (طلب، اعتذار، شكر، متابعة، تهنئة، شكوى)، والبحث في الإنترنت، وتنفيذ أوامر المتصفح، وإنشاء حملات الإعلانات.`
    : `${decision.unsupported[0].toUpperCase()}${decision.unsupported.slice(1)} needs a model that writes free text, and Mohassan has no writing model yet. What works now: a formal letter or email from a template (request, apology, thanks, follow-up, congratulations, complaint), web search, browser commands and Google Ads campaigns.`;
}
