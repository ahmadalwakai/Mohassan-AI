import type { ChatCapabilities } from '@mohassan/contracts';
import { evaluateLocalConversation } from '../local-conversation.js';
import type { Lang } from '../mind/contract.js';
import { fixedReply, type LocalReply } from '../mind/limits.js';
import { describeAvailableSelfCapabilities } from '../self-knowledge.js';
import type { MannersDetection } from './detect.js';

type Variants = readonly [string, ...string[]];
type Copy = Record<Lang, Variants>;
type Act = MannersDetection['act'];

const COPY: Record<Exclude<Act, 'capabilities'>, Copy> = {
  greeting: {
    ar: ['مرحبًا!', 'أهلًا وسهلًا!', 'أهلًا بك!'],
    en: ['Hi there!', 'Hello!', 'Hello there!'],
  },
  thanks: {
    ar: ['العفو!', 'العفو بكل سرور.'],
    en: ['You’re welcome!', 'Happy to help!', 'You’re very welcome.'],
  },
  apology: {
    ar: ['لا بأس.', 'لا داعي للاعتذار.'],
    en: ['No worries.', 'It’s all right.'],
  },
  compliment: {
    ar: ['شكرًا على لطفك.', 'شكرًا على كلامك الطيب.'],
    en: ['Thank you for the kind words.', 'Thanks for saying that.'],
  },
  farewell: {
    ar: ['إلى اللقاء!', 'مع السلامة!', 'أتمنى لك يومًا طيبًا.'],
    en: ['See you!', 'Take care!', 'Have a good one!'],
  },
  wellbeing: {
    ar: ['بخير، شكرًا لسؤالك.', 'بخير، وجاهز للمساعدة.'],
    en: ['Doing well, thanks for asking.', 'All good here, thanks for asking.'],
  },
  identity: {
    ar: ['أنا موحسن، مساعد رقمي.'],
    en: ['I’m Mohassan, a digital assistant.'],
  },
  joke: {
    ar: [
      'طلبت الفاصلة العشرية دقيقةً في الاجتماع، وقالت إنها تحتاج إلى جزءٍ منها فقط.',
      'قال التقويم إنه لا يستطيع تأجيل الموعد، فأيامه معدودة.',
      'فتح الحاسوب نافذةً للتهوية، فدخلت منها التحديثات.',
    ],
    en: [
      'A decimal point joined the meeting and promised it would take a fraction of everyone’s time.',
      'The calendar turned down a day off because its days were numbered.',
      'A computer opened a window for fresh air and let in three software updates.',
    ],
  },
  encouragement: {
    ar: ['شكرًا لك على التشجيع!', 'شكرًا على أمنياتك الطيبة!'],
    en: ['Thanks for the encouragement!', 'Thank you for the kind words.'],
  },
  insult: {
    ar: ['أنا هنا للمساعدة إذا أردت المتابعة.', 'يمكننا المتابعة إذا أردت.'],
    en: ['I’m here to help if you’d like to continue.', 'We can keep going if you’d like.'],
  },
};

const GREETING: Partial<Record<NonNullable<MannersDetection['detail']>, Copy>> = {
  peace: { ar: ['وعليكم السلام!', 'وعليكم السلام ورحمة الله!'], en: ['Peace be upon you too!'] },
  morning: { ar: ['صباح النور!', 'صباح الخير!'], en: ['Good morning!'] },
  afternoon: { ar: ['مرحبًا، طاب نهارك!'], en: ['Good afternoon!'] },
  evening: { ar: ['مساء النور!', 'مساء الخير!'], en: ['Good evening!'] },
  meeting: { ar: ['سررت بلقائك أيضًا!', 'تشرفت بمعرفتك!'], en: ['Nice to meet you too!', 'The pleasure is mine!'] },
};

const DIALECT_GREETING: Partial<Record<NonNullable<MannersDetection['dialect']>, Variants>> = {
  egyptian: ['أهلًا!', 'أهلًا وسهلًا!'],
  gulf: ['يا هلا!', 'أهلًا وسهلًا!'],
  levantine: ['أهلين!', 'أهلًا وسهلًا!'],
  iraqi: ['هلا بيك!', 'يا هلا!'],
  maghrebi: ['مرحبًا بيك!', 'أهلًا وسهلًا!'],
  sudanese: ['يا مرحب!', 'أهلًا وسهلًا!'],
  yemeni: ['يا هلا!', 'أهلًا وسهلًا!'],
};

const INVITATION: Copy = {
  ar: ['كيف أساعدك؟', 'بماذا أستطيع مساعدتك؟'],
  en: ['How can I help?', 'What can I help with?'],
};

const NIGHT: Copy = {
  ar: ['تصبح على خير!', 'ليلة طيبة!'],
  en: ['Good night!', 'Good night, take care!'],
};

const ENCOURAGE_USER: Copy = {
  ar: ['حظًا موفقًا!', 'ابدأ بخطوة صغيرة، فكل تقدّم يُحسب.'],
  en: ['Good luck, you’ve got this!', 'Start with one small step and build from there.'],
};

function choose(copy: Variants, key: string): string {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) | 0;
  return copy[(hash >>> 0) % copy.length];
}

function capabilityCopy(lang: Lang, capabilities: ChatCapabilities | undefined, compact: boolean): string {
  if (!capabilities) return lang === 'ar' ? 'لا تتوفر لديّ قائمة قدرات هذه المحادثة.' : 'I don’t have the capability list for this conversation.';
  const available = describeAvailableSelfCapabilities(capabilities.available, lang);
  if (capabilities.chatModel) available.push(lang === 'ar' ? 'صياغة ردود حرة' : 'writing free-form replies');
  const items = compact ? available.slice(0, 2) : available;
  if (!items.length) return lang === 'ar' ? 'لا تظهر أدوات مفعّلة في هذه المحادثة.' : 'This conversation has no tools listed as available.';
  if (lang === 'ar') return `أستطيع مساعدتك في ${items.join('، و')}.`;
  const list = items.length > 2 ? `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}` : items.join(' and ');
  return `I can help with ${list}.`;
}

function copyFor(detection: MannersDetection, capabilities: ChatCapabilities | undefined, compact: boolean, variationKey?: string): string {
  const { act, language, dialect, detail, socialText } = detection;
  const key = variationKey ?? socialText;
  if (act === 'capabilities') return capabilityCopy(language, capabilities, compact);
  if (act === 'greeting') {
    const specialized = detail ? GREETING[detail]?.[language] : undefined;
    const mirrored = language === 'ar' && dialect ? DIALECT_GREETING[dialect] : undefined;
    const hello = choose(specialized ?? mirrored ?? COPY.greeting[language], key);
    return compact || detail === 'quiet' || detail === 'meeting' ? hello : `${hello} ${choose(INVITATION[language], key)}`;
  }
  if (act === 'identity') {
    if (detail === 'name') return language === 'ar' ? 'موحسن' : 'Mohassan';
    if (detail === 'creator') {
      const question = language === 'ar' ? 'من صنعك؟' : 'Who created you?';
      return evaluateLocalConversation(question)?.text ?? COPY.identity[language][0];
    }
    if (detail === 'human') return language === 'ar' ? 'لا، أنا موحسن، مساعد رقمي.' : 'No, I’m Mohassan, a digital assistant.';
    if (detail === 'ai') return language === 'ar' ? 'نعم، أنا موحسن، مساعد رقمي.' : 'Yes, I’m Mohassan, a digital assistant.';
  }
  if (act === 'wellbeing' && language === 'ar' && dialect && dialect !== 'msa') return 'تمام، شكرًا لسؤالك.';
  if (act === 'farewell' && detail === 'night') return choose(NIGHT[language], key);
  if (act === 'encouragement' && detail === 'encourage-me') return choose(ENCOURAGE_USER[language], key);
  return choose(COPY[act][language], key);
}

export function renderMannersReply(detection: MannersDetection, capabilities?: ChatCapabilities, variationKey?: string): LocalReply {
  return fixedReply(copyFor(detection, capabilities, false, variationKey));
}

/** Acknowledgment only. The request's own answer, evidence, and status come from its normal handler. */
export function renderMannersClause(detection: MannersDetection, capabilities?: ChatCapabilities, variationKey?: string): string {
  return copyFor(detection, capabilities, true, variationKey);
}
