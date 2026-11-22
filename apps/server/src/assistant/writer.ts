import { notWebReason, tidy } from './hands.js';
import { matchText, normalizeRequest } from './mind/normalize.js';
import { requestActionText } from './request-context.js';
import { requestOperationText, requestScopeActionText } from './request-scope.js';

/**
 * Letters and emails without a model: one card asks who it is for, what kind it is, what to say and who signs it,
 * then a fixed frame wraps the owner's own words. Nothing here writes free text; the details stay exactly as typed.
 * Writing a frame cannot hold (translation, poems, stories, rewriting a given text) gets a plain answer instead.
 */
export type LetterKind = 'request' | 'apology' | 'thanks' | 'followup' | 'congrats' | 'complaint' | 'general';
export type Lang = 'ar' | 'en';
export interface WritingTask {
  kind: LetterKind;
  lang: Lang;
  /** Explicit literal body from the current request; never an invented summary. */
  suppliedText?: string;
  /** The template can draft, but cannot perform an outbound delivery action. */
  pendingDelivery?: true;
}
export type WritingDecision = WritingTask | { unsupported: string; lang: Lang };

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
  [/^(?:ترجم|تترجم|translate)|ترجم[ةه]/iu, 'الترجمة', 'translation'],
  [/شعر|قصيد|poem|verse/iu, 'كتابة الشعر', 'poems'],
  [/قص[ةه]|حكاي|story/iu, 'كتابة القصص', 'stories'],
  [/صحح|صحّح|حسّن|حسن\s|اعد صياغ|أعد صياغ|صيغ|اختصر|لخص|rewrite|proofread|shorten|summari[sz]e|improve|correct/iu, 'تحسين نص أو إعادة صياغته', 'rewriting a text'],
  [/مقال|بحث|سيرة ذاتي|cv\b|résumé|resume|essay|article|وصف منتج|product description|تغريد|منشور|tweet|post\b|caption/iu, 'المقالات والمنشورات والأوصاف', 'articles, posts and descriptions'],
];
const LETTER = /رسال|بريد|ايميل|ميل|خطاب|اشعار|\b(?:email|e-mail|mail|letter|message|note)\b/iu;
const MODAL = /^(?:(?:can|could|would) you(?: please)?\s+|(?:هل يمكنك|هل تستطيع|هل تقدر|ممكن|تقدر|ممكنك)\s+(?:ان\s+)?)/iu;
const WRITING_START = /^(?:اكتب(?:لي)?|تكتب(?:لي)?|صغ|تصيغ|حرر|الف|ترجم|تترجم|اعد صياغه|تعيد صياغه|صحح|تصحح|حسن|اختصر|تختصر|لخص(?:لي)?|تلخص|write|draft|compose|translate|rewrite|paraphrase|proofread|shorten|summari[sz]e|reword|edit|polish|improve|correct)(?!\p{L})/iu;
const CODE_ARTIFACT = /(?<!\p{L})(?:كود|داله|سكريبت|اختبار برمجي|برنامج|function|class|script|code|test|endpoint)(?!\p{L})/iu;
const ADS_ARTIFACT = /(?<!\p{L})(?:حمله|حملات|اعلان|اعلانات|campaign|campaigns|ads|advertisements?)(?!\p{L})/iu;
const REWORK = /^(?:ترجم|تترجم|اعد صياغه|تعيد صياغه|صحح|تصحح|حسن|اختصر|تختصر|لخص(?:لي)?|تلخص|translate|rewrite|paraphrase|proofread|shorten|summari[sz]e|reword|edit|polish|improve|correct)(?!\p{L})/iu;
const MAX_WRITING_INPUT = 4000;
const QUOTES: Record<string, string> = { '«': '»', '“': '”', '"': '"', "'": "'" };

interface LiteralBody { text: string; start: number; end: number }
function quotedBody(request: string, start: number): LiteralBody | null {
  const closing = QUOTES[request[start]!];
  if (!closing) return null;
  for (let index = start + 1; index < request.length; index++) {
    if (request[index] === closing && request[index - 1] !== '\\') return request.slice(start + 1, index).trim()
      ? { text: request.slice(start + 1, index), start, end: index + 1 } : null;
  }
  return null;
}

/** Delimiters identify literal body data; all characters inside remain unchanged. */
function suppliedBody(request: string): LiteralBody | null {
  const marker = /\b(?:saying|with (?:this|the) (?:text|body))\s*[:：]?\s*|(?:بالنص|نصها|محتواها|تقول)\s*[:：]?\s*/iu.exec(request);
  if (marker) {
    const start = marker.index + marker[0].length;
    const quoted = quotedBody(request, start);
    if (quoted) return quoted;
  }
  for (const match of request.matchAll(/[:：]/gu)) {
    const at = match.index;
    if (/https?$/iu.test(request.slice(Math.max(0, at - 5), at)) || /\d/u.test(request[at - 1] ?? '') && /\d/u.test(request[at + 1] ?? '')) continue;
    if (!LETTER.test(matchText(request.slice(0, at)))) continue;
    if (/(?:\b(?:subject|title|to|from)|الموضوع|العنوان|الى|إلى|من)\s*$/iu.test(request.slice(0, at))) continue;
    let start = at + 1;
    if (request[start] === ' ') start++;
    const quoted = quotedBody(request, start);
    if (quoted) return quoted;
    const text = request.slice(start);
    if (text.trim()) return { text, start, end: request.length };
  }
  return null;
}

function outerInstruction(request: string, body: LiteralBody | null): string {
  const outer = body ? request.slice(0, body.start) + ' [literal body] ' + request.slice(body.end) : request;
  return outer.replace(/«[^»]*»|“[^”]*”|"[^"\r\n]*"|(?<![\p{L}\p{N}])'[^'\r\n]*'(?=$|[\s\p{P}])/gu, ' [literal] ');
}

/** A body instruction mentioning send is data; only an outer directive is pending work. */
function requestsDelivery(instruction: string): boolean {
  const text = matchText(instruction).replace(/’/gu, "'");
  const positive = [...text.matchAll(/(?:\b(?:and(?: then)?|then|also)\s+|[.;!؟]\s*|(?:^|\s)(?:ثم|وبعدين|بعدها)\s+|و(?=ارسل|انشر|ابعت|ابعث|ترسل))(?:(?:please|رجاء)\s+)?(?:send|email|mail|publish|post|deliver|ارسل(?:ها|ه|هم)?|انشر(?:ها|ه)?|ابعت(?:ها|ه)?|ابعث(?:ها|ه)?|ترسل(?:ها|ه)?)(?!\p{L})/giu)];
  if (!positive.length) return false;
  const negative = [...text.matchAll(/\b(?:do not|don't|never|without)\s+(?:(?:actually|ever)\s+)?(?:send(?:ing)?|email(?:ing)?|mail(?:ing)?|publish(?:ing)?|post(?:ing)?|deliver(?:ing)?)\b|(?:^|\s)(?:لا|دون|بدون)\s+(?:ترسل(?:ها|ه)?|ارسل(?:ها|ه)?|ارسال|تنشر(?:ها|ه)?|انشر(?:ها|ه)?|نشر)(?!\p{L})/giu)];
  return (positive.at(-1)?.index ?? -1) > (negative.at(-1)?.index ?? -1);
}

/** What a writing request is, or null when it is not one. */
export function writingTask(request: string): WritingDecision | null {
  if (typeof request !== 'string' || !request.trim() || request.length > MAX_WRITING_INPUT) return null;
  const action = requestActionText(requestScopeActionText(request));
  const body = suppliedBody(request);
  const outer = outerInstruction(request, body);
  const normalized = normalizeRequest(requestActionText(requestScopeActionText(outer)));
  const text = requestOperationText(normalized.match.replace(MODAL, ''));
  const strongWriting = WRITING_START.test(text);
  const coarse = notWebReason(tidy(action));
  if (!strongWriting && coarse !== 'writing') return null;
  const head = text.split(/\b(?:about|regarding|concerning)\b|(?<!\p{L})(?:عن|حول)(?!\p{L})/iu, 1)[0]!;
  const letter = LETTER.exec(head), code = CODE_ARTIFACT.exec(head), ads = ADS_ARTIFACT.exec(head);
  if (!REWORK.test(text) && (code && (!letter || code.index < letter.index) || ads && !letter || coarse === 'planning' && !letter)) return null;
  const lang: Lang = /^(?:can|could|would) you\b/iu.test(normalized.match) ? 'en' : normalized.lang;
  // Translating or reworking a text is never a new letter, even when the text is «رسالتي»; verse, stories and
  // articles are, only when no letter is named («اكتب رسالة فيها قصة» is a letter).
  for (const [index, [pattern, ar, en]] of FREE.entries()) {
    const reworks = index === 0 || index === 3;
    if (pattern.test(text) && (reworks || !LETTER.test(text.replace(pattern, '')))) return { unsupported: lang === 'ar' ? ar : en, lang };
  }
  const kind = KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'general';
  if (!LETTER.test(text) && kind === 'general') return { unsupported: lang === 'ar' ? 'هذا النوع من الكتابة' : 'this kind of writing', lang };
  return { kind, lang, ...(body ? { suppliedText: body.text } : {}), ...(requestsDelivery(outer) ? { pendingDelivery: true as const } : {}) };
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
      { id: 'details', prompt: task.suppliedText ? (ar ? 'هذا هو النص الذي أرسلته. يمكنك تعديله قبل إعداد المسودة.' : 'Your supplied text is shown here; edit it if needed.') : ar ? 'ماذا تريد أن تقول؟ اكتب الأهم في سطر أو سطرين.' : 'What do you want to say? The main point in a line or two.', suggestions: [], multiline: true, ...(task.suppliedText ? { initialValue: task.suppliedText } : {}), placeholder: ar ? 'مثلاً: تأخر التسليم يومين بسبب الشحن' : 'e.g. delivery is two days late because of shipping' },
      { id: 'from', prompt: ar ? 'من يوقّعها؟' : 'Who signs it?', suggestions: [], multiline: true, placeholder: ar ? 'اسمك وصفتك' : 'your name and role' },
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

export interface ComposedLetter {
  text: string;
  /** Entire request fulfilled. A requested send/publish always remains incomplete here. */
  complete: boolean;
  draftComplete: boolean;
  pendingDelivery: boolean;
}

const UNBOUND_PERSON = /^(?:him|her|them|that person|the person|someone|me|myself|my name|my company|our company|unknown|not sure|don't know|له|لها|لهم|هو|هي|هم|الشخص|شخص ما|انا|اسمي|توقيعي|لا اعرف|غير معروف)[.!?؟]*$/iu;
const PLACEHOLDER = /^\s*(?:\[[^\]]{1,100}\]|<[^>]{1,100}>)\s*$/u;
const knownPerson = (value: string) => /[\p{L}\p{N}]/u.test(value) && !PLACEHOLDER.test(value) && !UNBOUND_PERSON.test(matchText(value.trim()));

/** Structured fields avoid treating numbered lines inside the body as card delimiters. */
export function composeLetter(task: WritingTask, reply: string | Readonly<Record<string, string>>): ComposedLetter {
  const structured = typeof reply === 'object' && reply !== null && !Array.isArray(reply) ? reply : null;
  const value = (key: string) => structured && typeof structured[key] === 'string' && structured[key]!.length <= MAX_WRITING_INPUT ? structured[key]! : '';
  const legacy = typeof reply === 'string' ? numberedAnswers(reply, 4) : [];
  const to = structured ? value('to') : legacy[0] ?? '';
  const kindAnswer = structured ? value('kind') : legacy[1] ?? '';
  const enteredDetails = structured ? value('details') : legacy[2] ?? '';
  const from = structured ? value('from') : legacy[3] ?? '';
  const details = enteredDetails.trim() ? enteredDetails : typeof task.suppliedText === 'string' && task.suppliedText.length <= MAX_WRITING_INPUT ? task.suppliedText : '';
  const kind = kindOf(kindAnswer, task.kind);
  const ar = task.lang === 'ar';
  const [subject, opening, closing] = FRAMES[kind][ar ? 'ar' : 'en'];
  const recipientKnown = knownPerson(to);
  const signerKnown = knownPerson(from);
  const greeting = ar ? (recipientKnown ? `${to} المحترم،` : '[اسم المستلم]،') : (recipientKnown ? `Dear ${to},` : 'Dear [recipient],');
  const body = details.trim() ? details : ar ? '[اكتب التفاصيل هنا]' : '[write the details here]';
  const letter = ar
    ? [`**الموضوع:** ${subject}`, '', greeting, 'السلام عليكم ورحمة الله وبركاته، وبعد:', '', opening, body, '', closing, '', 'مع التحية،', signerKnown ? from : '[الاسم]'].join('\n')
    : [`**Subject:** ${subject}`, '', greeting, '', opening, body, '', closing, '', 'Best regards,', signerKnown ? from : '[Name]'].join('\n');
  const note = ar
    ? '\n\n---\nهذه مسودة من قالب: الإطار ثابت والتفاصيل بكلماتك كما كتبتها. لم يكتبها نموذج.'
    : '\n\n---\nThis draft comes from a template: the frame is fixed and the details are your own words. No model wrote it.';
  const pendingDelivery = task.pendingDelivery === true;
  const deliveryNote = pendingDelivery ? ar
    ? '\n\nطلب الإرسال أو النشر ما زال معلقًا. هذه مسودة فقط؛ لم تُرسل ولم تُنشر.'
    : '\n\nThe requested sending or publishing is still pending. This is a draft only; it has not been sent or published.' : '';
  const missingRecipient = !recipientKnown ? ar ? '\n\nحدّد اسم المستلم أو المجموعة المقصودة لإكمال المسودة.' : '\n\nSpecify the recipient name or intended group to complete the draft.' : '';
  const draftComplete = Boolean(details.trim()) && !PLACEHOLDER.test(details) && recipientKnown && signerKnown;
  return { text: letter + note + deliveryNote + missingRecipient, complete: draftComplete && !pendingDelivery, draftComplete, pendingDelivery };
}

/** The plain answer for writing a frame cannot do, instead of a «no model» error. */
export function unsupportedWriting(decision: { unsupported: string; lang: Lang }): string {
  return decision.lang === 'ar'
    ? `${decision.unsupported} تحتاج نموذجاً يكتب نصاً حراً، وموحسن لا يملك نموذج كتابة بعد. أستطيع الآن: كتابة رسالة أو إيميل رسمي من قالب (طلب، اعتذار، شكر، متابعة، تهنئة، شكوى)، والبحث في الإنترنت، وتنفيذ أوامر المتصفح، وإنشاء حملات الإعلانات.`
    : `${decision.unsupported[0].toUpperCase()}${decision.unsupported.slice(1)} needs a model that writes free text, and Mohassan has no writing model yet. What works now: a formal letter or email from a template (request, apology, thanks, follow-up, congratulations, complaint), web search, browser commands and Google Ads campaigns.`;
}
