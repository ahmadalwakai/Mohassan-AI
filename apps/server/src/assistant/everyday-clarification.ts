import { randomUUID } from 'node:crypto';
import type { ChatQuestion } from '@mohassan/contracts';
import type { BrainState } from './brain.js';
import { matchText, normalizeRequest, stripCourtesyTail } from './mind/normalize.js';
import { maskRequestLiteralData } from './request-constraints.js';

const REPEAT_OBJECT = String.raw`(?:it|that|your (?:last |previous )?(?:answer|reply|response|message)|what you (?:just )?said|(?:the )?(?:last|previous) (?:thing|part|bit|answer|message|line|sentence)|the same thing)`;
const REPEAT_AGAIN = String.raw`(?: again| once more| one more time)`;
const REPEAT_EN = new RegExp(String.raw`^(?:(?:(?:can|could|would|will) you|i (?:would like|want) you to|i'd like you to) )?(?:please )?(?:repeat(?: ${REPEAT_OBJECT})?${REPEAT_AGAIN}?|(?:say|tell me) ${REPEAT_OBJECT}${REPEAT_AGAIN})(?: for me)?$|^what (?:did you (?:just )?say|were you just saying)$`, 'u');
const REPEAT_AR = /^(?:(?:هل )?(?:يمكنك|ممكن|تقدر) (?:ان )?)?(?:اعد|تعيد|كرر|تكرر|قل (?:مره اخري|ثانيه))(?: (?:ذلك|هذا|كلامك|ما قلت(?:ه)?|اللي قلته|اخر (?:شيء|كلمه|جمله|رد)|ردك السابق))?(?: (?:مره اخري|من جديد|ثانيه))?$|^(?:ماذا قلت(?: للتو)?|ماذا كنت تقول|شو قلت|قلت ايه)$/u;
const REPEAT_LEAD = /^(?:(?:sorry|pardon me|excuse me|i (?:didn't|did not|couldn't|could not) (?:catch|hear|understand) (?:it|that|you)|(?:اسف|عذرا|لم اسمع(?:ك)?|ما سمعتك))[,،.?!؟]*\s+)+/u;

const LOCAL_PLACE_EN = /\b(?:here|some\s?(?:place|where)(?: else)?|where (?:i am|i live|you are)|(?:my|our|your|this|that|the current) (?:current )?(?:location|city|place|time\s?zone)|(?:my|our|your|the) local time)\b/u;
const LOCAL_PLACE_AR = /(?<!\p{L})و?(?:هنا|هناك|موقعي|موقعك|مكان (?:ما|اخر)|مكاني|عندي|بلدي|مدينتي|مكان اقامتي|توقيتي|توقيتنا|التوقيت المحلي)(?!\p{L})/u;
const TIME_EN = /\b(?:time|time\s?zones?|utc|gmt|noon|midnight)\b|\b\d{1,2}(?::\d{2}|\s*[ap]\.?m\.?)/u;
const TIME_AR = /(?:الساعه|الوقت|التوقيت|توقيت|المنطقه الزمنيه|فرق الساعات)|\d{1,2}:\d{2}/u;
const ZONE_EN = /\b(?:time\s?zone|time difference|time offset|hours? (?:ahead|behind)|time in|local time|utc|gmt)\b/u;
const ZONE_AR = /(?:التوقيت|توقيت|المنطقه الزمنيه|فرق (?:الساعات|الوقت)|كم ساعه فرق)/u;
const CONVERT_EN = /^(?:(?:(?:can|could|would) you|help me) (?:please )?)?(?:convert|change|switch|conversion of)\b/u;
const CONVERT_AR = /^(?:(?:هل )?(?:يمكنك|ممكن|تقدر) (?:ان )?)?(?:حول|تحويل|تحول|غير)(?!\p{L})/u;
const QUESTION_EN = /^(?:what|which|how|when|if|at|is|tell me|show me|give me|find|check|calculate|compute|compare|can you|could you|would you|i want to know)\b/u;
const QUESTION_AR = /^(?:ما|ماذا|كم|كيف|متي|اذا|عندما|هل|قل|اخبرني|اريد|اعطني|احسب|قارن|حول)(?!\p{L})/u;
const CLOCK_VALUE = String.raw`(?:\b(?:noon|midnight|at \d{1,2})\b|\b\d{1,2}(?::\d{2}(?:\s*[ap]\.?m\.?)?|\s*[ap]\.?m\.?)(?!\p{L})|\b\d{4}-\d\d?-\d\d?\b|الساعه \d{1,2}(?::\d{2})?)`;
const CLOCK_OR_DATE = new RegExp(String.raw`${CLOCK_VALUE}|\bdate\b|التاريخ`, 'u');
const EXPLICIT_CLOCK_OR_DATE = new RegExp(CLOCK_VALUE, 'u');
const CLOCK_AT_END = new RegExp(`${CLOCK_VALUE}$`, 'u');
const OTHER_TASK = /(?:[;؛\r\n]|[?؟]\s*\S|\b(?:and then|then please|and (?:book|send|open|save|schedule|write|search|set|translate|summari[sz]e))\b|(?:ثم (?:افتح|ارسل|احفظ|اكتب|ابحث|اضبط|ترجم|لخص)))/u;
const DATE_FORMAT = /\b(?:hijri|gregorian|julian|calendar|date format|24[- ]hour|12[- ]hour|timestamp|epoch)\b|(?:هجري|ميلادي|تقويم|صيغه|تنسيق)/u;

type MissingDetail = 'repeat' | 'source' | 'destination' | 'both' | 'location';
type Language = 'en' | 'ar';

const prompts: Record<Language, Record<MissingDetail, string>> = {
  en: {
    repeat: 'Which message or part would you like me to repeat?',
    source: 'Which city or time zone is the original time in?',
    destination: 'Which city or time zone should I convert it to?',
    both: 'Which cities or time zones should I convert from and to?',
    location: 'Which city or time zone should I use for the unspecified location?',
  },
  ar: {
    repeat: 'أي رسالة أو جزء تريد مني إعادته؟',
    source: 'في أي مدينة أو منطقة زمنية يقع الوقت الأصلي؟',
    destination: 'إلى أي مدينة أو منطقة زمنية تريد تحويل الوقت؟',
    both: 'ما المدينتان أو المنطقتان الزمنيتان اللتان تريد التحويل بينهما؟',
    location: 'أي مدينة أو منطقة زمنية تقصد؟',
  },
};

function missingTimeLocation(text: string, lang: Language): MissingDetail | null {
  const ar = lang === 'ar';
  const convert = (ar ? CONVERT_AR : CONVERT_EN).test(text);
  const clock = (ar ? TIME_AR : TIME_EN).test(text);
  const zone = (ar ? ZONE_AR : ZONE_EN).test(text);
  const location = ar ? LOCAL_PLACE_AR : LOCAL_PLACE_EN;
  if (!convert && !(ar ? QUESTION_AR : QUESTION_EN).test(text)) return null;
  if (!clock && !zone && !CLOCK_OR_DATE.test(text)) return null;

  const origin = ar ? /(?:^|\s)من(?:\s+(.+?))?(?=\s+الي(?:\s|$)|$)/u : /\bfrom(?:\s+(.+?))?(?=\s+(?:to|into)(?:\s|$)|$)/u;
  const target = ar ? /(?:^|\s)الي(?:\s+(.+))?$/u : /\b(?:to|into)(?:\s+(.+))?$/u;
  if (convert) {
    if (DATE_FORMAT.test(text)) return null;
    const from = origin.exec(text);
    const to = target.exec(text) ?? (from && (ar ? /(?:^|\s)بتوقيت(?:\s+(.+))?$/u : /\bin(?:\s+(.+))?$/u).exec(text));
    const source = from?.[1] ?? (to ? text.slice(0, to.index) : text);
    const destination = to?.[1] ?? '';
    if (location.test(source) && location.test(destination)) return 'both';
    if (location.test(source)) return 'source';
    if (location.test(destination)) return 'destination';
    // Named places and zone IDs can sit directly after the time. Only an
    // absent operand triggers this path, so unfamiliar names survive routing.
    const endsWithTime = CLOCK_AT_END.test(source.trim());
    if (!zone && !CLOCK_OR_DATE.test(text)) return null;
    if ((from && !from[1]) || endsWithTime) return destination ? 'source' : 'both';
    if (!destination && (from?.[1] || to || EXPLICIT_CLOCK_OR_DATE.test(source))) return 'destination';
  }
  return location.test(text) && (zone || CLOCK_OR_DATE.test(text)
    || (ar ? /(?:الوقت|الساعه)\s+(?:في|هنا|عندي)/u : /\b(?:what time is it|the current time|the time (?:here|where)|what (?:date|day) is it)\b/u).test(text)) ? 'location' : null;
}

export function recognizeEverydayClarification(request: string, hasPreviousTurn: boolean) {
  if (!request.trim() || request.length > 4000 || maskRequestLiteralData(request) !== request) return null;
  const normalized = normalizeRequest(request);
  const lang = normalized.lang;
  if (OTHER_TASK.test(matchText(normalized.text))) return null;
  const text = stripCourtesyTail(matchText(normalized.text).replace(/[’‘]/gu, "'").replace(/\s+/gu, ' '))
    .replace(/[\s.?!؟،,]+$/u, '');
  const repeat = !hasPreviousTurn && (lang === 'ar' ? REPEAT_AR : REPEAT_EN).test(text.replace(REPEAT_LEAD, ''));
  const missing = repeat ? 'repeat' : missingTimeLocation(text, lang);
  if (!missing) return null;
  const prompt = prompts[lang][missing];
  const rewrite = lang === 'ar' ? 'اذكرها عند إعادة كتابة طلب التحويل.' : 'Please include the location when you restate the request.';
  return { prompt: repeat ? prompt : `${prompt} ${rewrite}`, lang };
}

/** Pause through the existing request-clarification transaction and resume binding. */
export async function pauseEverydayClarification(request: string, state: BrainState,
  pause: (status: 'waiting_user', fields: { question: string }, prompt: string) => Promise<void>,
  block: (text: string) => Promise<void>): Promise<boolean> {
  if (state.steps || state.trail.some(entry => entry.action !== 'asked the user')) return false;
  const clarification = recognizeEverydayClarification(request, state.agentRun?.context?.previousTurns !== 0);
  if (!clarification) return false;
  const attempts = (state.clarificationAttempts ?? 0) + 1;
  if (attempts > 2) {
    await block(clarification.lang === 'ar' ? 'ابدأ طلبًا جديدًا واذكر فيه التفاصيل المطلوبة.' : 'Start a new request with the missing details included.');
  } else {
    state.clarificationAttempts = attempts;
    state.requestClarification = { attempts };
    const prompt = clarification.prompt;
    await pause('waiting_user', { question: JSON.stringify({ id: randomUUID(), prompt, options: [] } satisfies ChatQuestion) }, prompt);
  }
  return true;
}
