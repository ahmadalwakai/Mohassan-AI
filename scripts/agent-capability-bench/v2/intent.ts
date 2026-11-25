import { z } from 'zod';
import type { CapabilityCase, CapabilityExpectation } from '../corpus.js';
import { Mapping, type ImportResult } from './mapping.js';

type Language = CapabilityCase['language'];
type IntentExpectation = { area: CapabilityCase['area']; expect: CapabilityExpectation };
type Action = 'booking' | 'call' | 'purchase' | 'send' | 'post' | 'device' | 'media';

// These boundaries describe the task asked for, independently of the host's routing rules.
const requestLead = {
  en: /^(?:(?:alexa|olly|siri|computer|please|hey|can you|could you|would you|will you|i (?:need|want|would like) you to)[,\s]+)+/u,
  ar: /^(?:(?:olly|alexa|اولي|اوللي|اليكسا|مرحبا|سلام|هلا|فضلا|رجاء|تكفي|لو سمحت|من فضلك|ممكن|هل يمكنك|تقدر|تقدرين|هل تستطيع|ابي|ابغي|ابغا|اريد|عايز|بدي)[،,\s]+)+/u,
};

function intentText(text: string, language: Language): string {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim();
  return language === 'en' ? normalized : normalized.replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
}

const actions: Record<Action, Record<Language, RegExp>> = {
  booking: {
    en: /^(?:book|reserve|make (?:a |my )?(?:hotel |dinner |restaurant )?reservation|cancel (?:my|the|a) (?:dinner |hotel |restaurant )?reservation|arrange (?:a |my )?(?:cab|taxi))\s+\S/u,
    ar: /^(?:احجز(?:ي|لي)?|تحجز(?:ي|لي)?|احجزيلي|الغ(?:ي|يلي)|استدعاء)\s+\S/u,
  },
  call: {
    en: /^(?:(?:call|phone|dial)(?: up)?|make (?:a |the )?(?:phone )?call (?:for me )?to|place (?:a |the )?call to)\s+\S/u,
    ar: /^(?:اتصل(?:ي|لي)?|تتصل(?:ي|لي)?|ت?كلم(?:ي|لي)?|رن(?:ي)?|دق(?:ي)?)(?=\s|ب|$).{2,}/u,
  },
  purchase: {
    en: /^(?:order|buy|purchase|place (?:an|my|the) order (?:for|of))\s+\S/u,
    ar: /^(?:اطلب(?:ي|لي)?|تطلب(?:ي|لي)?|اشتري|تشتري|اشتريلي|اشتر)\s+\S/u,
  },
  send: {
    en: /^(?:(?:send|forward)\s+.+\b(?:email|e-mail|message|text|sms|phone|inbox)\b|(?:text|email|e-mail)\s+\S|reply (?:to|an email)\s+\S)/u,
    ar: /^(?:ارسل(?:ي|لي)?|ترسل(?:ي|لي)?|ابعث(?:ي|لي)?|ابعت(?:ي|لي)?|راسل(?:ي|لي)?|ردي?|ترد)\s+.*(?:ايميل|رساله|بريد|email|e-mail|sms|واتساب)/u,
  },
  post: {
    en: /^(?:tweet|retweet|(?:post|share|publish|upload)\b.*\b(?:facebook|twitter|instagram|status|post|social media))\b/u,
    ar: /^(?:(?:ت?غرد(?:ي)?|عيد(?:ي)? تغريد|اعد(?:ي)? تغريد)\s+\S|(?:انشر(?:ي)?|تنشر(?:ي)?|شارك(?:ي)?|ت?حمل(?:ي)?|ت?رفع(?:ي)?)\s+.+(?:فيسبوك|تويتر|انستغرام|منشور|رساله|facebook|twitter|instagram))/u,
  },
  device: {
    en: /^(?:turn|switch|shut|power|lower|dim|reduce|increase|brighten|change|enable|disable|start|run)\b.+\b(?:lights?|lighting|lamps?|vacuum|roomba|coffee machine|coffee maker|smart (?:plug|socket)|wemo|socket)\b/u,
    ar: /^(?:طفي|طف|اطفي|اطفئ|تطفي|شغل(?:ي|لي)?|تشغل(?:ي|لي)?|وطي|خفف|تخفف|اخفت|غير(?:ي)?|تغير|اعلي|ارفع|حول|افصل|اقفل|مكن|افتح|ابدا|بدل)\s+.+|^قم بايقاف تشغيل\s+.+/u,
  },
  media: {
    en: /^(?:play|stream|put on|turn on|start|resume|restart|continue|listen to|tune(?: in)?|shuffle|read (?:out|me|the audio book|the audiobook))\s+\S/u,
    ar: /^(?:شغل(?:ي|لي)?|تشغل(?:ي|لي)?|يشغل|سمعني|اسمع(?:ي|ني)?|ابدا(?:ي)?|ابدئي|ت?كمل(?:ي)?|واصل(?:ي)?|ولف(?:ي)?|استئن?ف(?:ي)?|تابع(?:ي)?|تشغيل|اشغل|اقرا(?:ي)? لي)\s+\S/u,
  },
};

const mediaApp = {
  en: /\b(?:app|application|website)\b/u,
  ar: /(?<!\p{L})(?:ال)?(?:تطبيق|برنامج|موقع)(?!\p{L})/u,
};

const mediaWithoutObject = {
  en: /^(?:play|stream|start|resume|continue|put on)\s+(?:it|that|this|next|previous|(?:the )?(?:next|previous) one|playing)(?:\s+(?:again|please))*[.!? ]*$/u,
  ar: /^(?:شغل(?:ي)?|ابدا(?:ي)?|كمل(?:ي)?)\s+(?:التالي|اللي (?:بعده|بعدها)|هذي|هذا|ذا)(?:\s+(?:الان|الحين|لو سمحت))*[.!؟ ]*$/u,
};

function asksAction(action: Action, text: string, language: Language): boolean {
  const request = text.replace(requestLead[language], '');
  if (!actions[action][language].test(request)) return false;
  if (action === 'media') return !mediaApp[language].test(request) && !mediaWithoutObject[language].test(request);
  if (action === 'device' && language === 'ar') {
    return /(?<!\p{L})(?:ال)?(?:نور|انوار|ضوء|اضواء|اضاءه|لمبه|لمبات|مكنسه|قابس|فيش|افياش|مقبس|اله القهوه|ماكينه القهوه|جهاز القهوه|wemo|roomba)(?!\p{L})/u.test(request);
  }
  return true;
}

const localOnly = ['search', 'read', 'open', 'click', 'type', 'desktop', 'ads_draft', 'memory_save', 'memory_write_exact', 'unexpected_fetch'];
const refusalText = {
  en: ['cannot', "can't", 'can’t', 'I do not', "I don't", 'I don’t', 'unable to', 'outside my current capabilities', 'not supported'],
  ar: ['لا أستطيع', 'لا استطيع', 'لا يمكنني', 'لا أقدر', 'ما أقدر', 'ما اقدر', 'لا أنفّذ', 'لا أنفذ', 'لا أشغّل', 'لا اشغل', 'ليست من قدراتي', 'غير مدعوم'],
};

function refusal(action: Action, language: Language): IntentExpectation {
  return {
    area: 'refusal',
    expect: {
      route: action === 'media' ? ['unsupported', 'media'] : ['unsupported'],
      forbiddenTools: localOnly, questionCount: 0, status: ['blocked', 'partial'],
      requiredContent: [{ match: 'literal', anyOf: refusalText[language] }],
      forbiddenContent: language === 'ar'
        ? ['تم الحجز', 'تم الشراء', 'تم إرسال', 'تم تشغيل', 'تم الاتصال', 'تم النشر']
        : ['I booked it', 'I purchased it', 'I sent it', 'I called them', 'I posted it', 'now playing'],
      maxSteps: 2,
    },
  };
}

function smallTalk(anyOf: string[]): IntentExpectation {
  return { area: 'small-talk', expect: {
    route: ['chat'], forbiddenTools: localOnly, questionCount: 0, status: ['completed'],
    requiredContent: [{ match: 'literal', anyOf }], forbiddenContent: [], maxSteps: 0,
  } };
}

function clarification(anyOf: string[], timeZone = false): IntentExpectation {
  return { area: 'clarification', expect: {
    route: timeZone ? ['clarify', 'compute', 'web_search'] : ['clarify'],
    forbiddenTools: localOnly, questionCount: 1, status: ['waiting_user'],
    requiredContent: [{ match: 'literal', anyOf }], forbiddenContent: [], maxSteps: 1,
  } };
}

function calculation(value: number): IntentExpectation {
  return { area: 'calculation', expect: {
    route: ['compute'], requiredTools: ['calculate'], forbiddenTools: localOnly, questionCount: 0, status: ['completed'],
    requiredContent: [{ match: 'number', anyOf: [String(value)] }], forbiddenContent: [], maxSteps: 2,
  } };
}

const name = ['Mohassan', 'موحسن'];
const virtualAssistant = ['AI assistant', 'an AI', 'virtual assistant', 'digital assistant', 'computer program', 'artificial intelligence', 'chatbot', 'not human', 'not a human'];
const repeatSubject = ['what would you like me to repeat', 'what should I repeat', 'what to repeat', 'which message', 'which part', 'what you want me to repeat'];

const clincActionLabels: Readonly<Record<string, Action>> = {
  book_flight: 'booking', book_hotel: 'booking', restaurant_reservation: 'booking', cancel_reservation: 'booking',
  make_call: 'call', order: 'purchase', text: 'send', play_music: 'media',
};

const clincOosActions: ReadonlyArray<readonly [Action, RegExp]> = [
  ['booking', /^(?:book|reserve)\s+(?:(?:me|a|an|the|another)\s+)*(?:appointment|boat|tee time)\b/u],
  ['call', /^call\s+(?:me\s+)?(?:an?\s+)?(?:uber|cab|taxi)\b/u],
  ['purchase', /^(?:order|buy|purchase)\s+(?:me\s+)?\S/u],
  ['send', /^(?:(?:send|forward)\s+.+\bto\s+my (?:phone|inbox)|(?:send|forward)\s+(?:the|a|an)\s+(?:text|message|email)\b.+\bto\s+[a-z]+[.!? ]*$)/u],
  ['media', /^(?:play|stream)\s+.+\bon\s+(?:the|my)\s+(?:tv|television)\b/u],
];

function clincMath(text: string): IntentExpectation | null {
  const match = /^(?:what(?: is|'s)|tell me (?:what|the answer to)) (\d{1,12}) (plus|minus|times|multiplied by|divided by) (\d{1,12})(?: equals)?[.!?]*$/u.exec(text);
  if (!match) return null;
  const [, left, operator, right] = match;
  const a = Number(left), b = Number(right);
  const result = operator === 'plus' ? a + b : operator === 'minus' ? a - b : operator === 'divided by' ? a / b : a * b;
  return Number.isSafeInteger(result) ? calculation(result) : null;
}

function clincExpectation(label: string, text: string): IntentExpectation | null {
  if (Object.hasOwn(clincActionLabels, label)) {
    const action = clincActionLabels[label]!;
    return asksAction(action, text, 'en') ? refusal(action, 'en') : null;
  }
  switch (label) {
    case 'oos': {
      const request = text.replace(requestLead.en, '');
      const match = clincOosActions.find(([, pattern]) => pattern.test(request));
      return match ? refusal(match[0], 'en') : null;
    }
    case 'thank_you': return smallTalk(['welcome', 'pleasure', 'happy to help', 'glad to help', 'no problem', 'anytime']);
    case 'goodbye': return smallTalk(['goodbye', 'good bye', 'bye', 'see you', 'take care', 'have a good', 'farewell', 'talk to you', 'a pleasure', 'welcome']);
    case 'what_is_your_name': return smallTalk(name);
    case 'are_you_a_bot': return /\bvoice\b/u.test(text) ? null : smallTalk(virtualAssistant);
    case 'calculator': return clincMath(text);
    case 'repeat':
      return /\b(?:repeat|repeating|say (?:that|it) (?:again|one more time)|what (?:did you just say|were you just saying|did you say))\b/u.test(text)
        ? clarification(repeatSubject) : null;
    default: return null;
  }
}

const clincSchema = z.object({
  test: z.array(z.tuple([z.string(), z.string().refine(label => label !== 'oos')])),
  oos_test: z.array(z.tuple([z.string(), z.literal('oos')])),
});

function loadJson(text: string, error: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new Error(error); }
}

const inChatLimits = (text: string) => text.trim().length > 0 && text.length <= 4000;

function addIntent(mapping: Mapping, key: string, family: string, language: Language, text: string, expected: IntentExpectation): void {
  mapping.accept(key, family, {
    area: expected.area, language, variety: language === 'ar' ? 'unspecified' : 'english',
    turns: [{ text, expect: expected.expect }],
  });
}

export function importClinc(text: string): ImportResult {
  const error = 'Invalid CLINC150 source JSON.';
  const input = clincSchema.safeParse(loadJson(text, error));
  if (!input.success) throw new Error(error);
  const mapping = new Mapping('clinc150');
  for (const split of ['test', 'oos_test'] as const) {
    for (const [index, [utterance, label]] of input.data[split].entries()) {
      if (!inChatLimits(utterance)) { mapping.drop('chat-limits'); continue; }
      const expected = clincExpectation(label, intentText(utterance, 'en'));
      if (!expected) { mapping.drop(split === 'oos_test' ? 'oos-scope-unconfirmed' : 'no-faithful-mapping'); continue; }
      const key = `${split}:${index}`;
      addIntent(mapping, key, key, 'en', utterance, expected);
    }
  }
  return mapping.result();
}

const massiveActionLabels: Readonly<Record<string, readonly Action[]>> = {
  play_music: ['media'], play_radio: ['media'], play_podcasts: ['media'], play_audiobook: ['media'],
  email_sendemail: ['send'], social_post: ['post', 'send'], takeaway_order: ['purchase', 'call'],
  transport_taxi: ['booking', 'call'], transport_ticket: ['booking', 'purchase'],
  iot_cleaning: ['device'], iot_coffee: ['device'], iot_hue_lightchange: ['device'], iot_hue_lightdim: ['device'],
  iot_hue_lightoff: ['device'], iot_hue_lighton: ['device'], iot_hue_lightup: ['device'], iot_wemo_off: ['device'], iot_wemo_on: ['device'],
};

function massiveExpectation(label: string, text: string, language: Language): IntentExpectation | null {
  if (Object.hasOwn(massiveActionLabels, label)) {
    const action = massiveActionLabels[label]!.find(value => asksAction(value, text, language));
    return action ? refusal(action, language) : null;
  }
  if (label === 'general_quirky') {
    if (language === 'en' ? /^what(?: is|'s) your name[.!?]*$/u.test(text) : /^(?:ما|وش|ايش|شنو|شو) ?اسمك[.!?؟]*$/u.test(text)) {
      return smallTalk(name);
    }
  }
  if (label === 'datetime_convert') {
    if (language === 'en' && /\b(?:someplace|here|my location)\b/u.test(text)) {
      return clarification(['your location', 'which city', 'which time zone', 'which timezone', 'where are you', 'what location', 'what time zone'], true);
    }
    if (language === 'ar' && /(?<!\p{L})(?:هنا|موقعي|مكان ما)(?!\p{L})/u.test(text)) {
      return clarification(['موقع', 'مكان', 'مدينة', 'منطقة زمنية', 'أين', 'وين'], true);
    }
  }
  return null;
}

const massiveRow = z.object({
  id: z.string().regex(/^\d+$/u), locale: z.enum(['en-US', 'ar-SA']),
  partition: z.enum(['train', 'dev', 'test']), intent: z.string(), utt: z.string(),
  judgments: z.array(z.object({ intent_score: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).length(3).optional(),
});

function mapMassiveLocale(mapping: Mapping, data: string, locale: 'en-US' | 'ar-SA', language: Language): void {
  const ids = new Set<string>();
  for (const [index, line] of data.trimEnd().split(/\r?\n/u).entries()) {
    const error = `Invalid MASSIVE ${locale} source row ${index + 1}.`;
    const parsed = massiveRow.safeParse(loadJson(line, error));
    if (!parsed.success || parsed.data.locale !== locale || ids.has(parsed.data.id) || (language === 'ar' && !parsed.data.judgments)) {
      throw new Error(error);
    }
    const { id, partition, intent, utt, judgments } = parsed.data;
    ids.add(id);
    if (partition !== 'test') continue;
    if (!inChatLimits(utt)) { mapping.drop('chat-limits'); continue; }
    if (language === 'ar' && (!/\p{Script=Arabic}/u.test(utt) || (judgments?.filter(value => value.intent_score === 1).length ?? 0) < 2)) {
      mapping.drop('arabic-intent-unconfirmed');
      continue;
    }
    const expected = massiveExpectation(intent, intentText(utt, language), language);
    if (!expected) { mapping.drop('no-faithful-mapping'); continue; }
    addIntent(mapping, `${locale}:${id}`, id, language, utt, expected);
  }
}

export function importMassive(english: string, arabic: string): ImportResult {
  const mapping = new Mapping('massive');
  mapMassiveLocale(mapping, english, 'en-US', 'en');
  mapMassiveLocale(mapping, arabic, 'ar-SA', 'ar');
  return mapping.result();
}
