import { directRoute } from '../brain.js';
import type { HandsStep } from '../hands.js';
import { foldText } from '../../../../../packages/skills/src/stems.js';

// The address is a single token in the open command. Conjunctions in paths and query strings stay in the address.
const OPEN_THEN_ASK = /^(?<head>[^:\r\n]{1,65}(?<address>https?:\/\/[^\s<>"“”«»،,]+))(?:\s+(?:in (?:the |a )?browser|(?:في|على) (?:ال)?متصفح))?\s*[,،]?\s+(?:and(?: then)?\s+|then\s+|(?:ثم|وبعدها|وبعدين)\s+|و\s*)(?<ask>.+)$/iu;
const SPEECH = /^(?:(?:please )?(?:tell me|show(?: me)?|give me|report|quote|return|extract|check|confirm|identify|state|find out)|(?:اخبرني|[أإ]خبرني|خبرني|قل\s*لي|قلي|اذكر(?: لي)?|اعطني|أعطني|اعرض(?: لي)?|أعرض(?: لي)?|ارني|أرني|انقل(?: لي)?|وضح لي|بين لي|تحقق من|اكتب(?: لي)?|أكتب(?: لي)?|[اإأ]قر[اأ](?:\s*لي)?))\s+/iu;
const EN_QUESTION = /^(?:(?:who|when|where|whose)(?!\s+(?:should|could|can|would|will)\b)|(?:in )?(?:what|which) (?:year|month|day|weekday|date|time|city|country|region|location)|how (?:many|much|long|far|high|tall|heavy|wide|deep|fast))\s+\S/u;
const AR_QUESTION = /^(?:(?:في )?اي (?:عام|سنه|شهر|يوم|تاريخ|وقت|ساعه|مدينه|دوله|بلد|مكان)|متي|اين|وين|من|مين|كم|كام|قديش|اديش)\s+\S/u;
const EN_FIELD = /^(?:what(?:'s| is| was)\s+)?(?:the )?(?:(?:opening|closing|start|end|departure|arrival) time|(?:opening|closing|office|business|visiting) hours|(?:total )?(?:date|year|month|day|weekday|time|length|distance|duration|height|width|depth|area|weight|price|cost|fee|fare|address|location|capacity|quantity|author|designer|maker|founder|number of))\b/u;
const AR_FIELD = /^(?:(?:ما(?: هو| هي)?|وش|شو|شنو|ايش)\s+)?(?:ال)?(?:تاريخ|عام|سنه|شهر|يوم|وقت|ساعه|طول|مسافه|مده|ارتفاع|عرض|عمق|مساحه|وزن|سعر|تكلفه|اجره|رسم|رسوم|عنوان|موقع|سعه|عدد|رقم|مؤلف|مصمم|مؤسس)(?=\s|$)/u;
const IDENTIFIER_FIELD = /^(?:what(?:'s| is| was)\s+)?(?:the )?(?:[a-z][a-z-]* ){1,3}number(?:\s|[,.:;]|$)/u;
const PAGE_TOPIC = /^(?:what (?:the|this) (?:page|article|site) (?:says|reports|shows) about|(?:ما|ماذا) (?:تقول|تقوله|يقول|يقوله|يذكر|يذكره|تذكر|تذكره) (?:الصفحه|المقال|الموقع) عن)\s+\p{L}/u;
const ANOTHER_ACTION = /(?:^|[.!?؟;؛]\s+|\s+(?:and(?: then)?|then)\s+)(?:please )?(?:open|visit|navigate|click|tap|press|type|enter|select|delete|remove|send|post|submit|buy|book|publish|save|sign in|log in|write|draft|download|upload|search)\b|(?:^|[،؛,;]\s*|\s+)(?:ثم\s+|وبعدها\s+|و\s*)?(?:افتح|اذهب|ادخل|اضغط|انقر|احذف|ارسل|انشر|اشتر|احجز|احفظ|سجل|حمل|ارفع|ابحث)(?=\s|$)/u;
const FIELD_ENTRY = /\b(?:into|in) (?:the |a )?(?:field|form|input|text ?box)\b|(?:^|\s)(?:في|داخل) (?:ال)?(?:خانه|حقل|مربع|نموذج)(?=\s|$)/u;

/** Add a read-only answer step to an explicit open when the rest asks for a concrete fact. */
export function parseOpenPageRequest(request: string, hasNextStep: (question: string) => boolean): HandsStep[] | null {
  if (process.env.MOHASSAN_ANSWER_SELECTION !== '1') return null;
  const match = OPEN_THEN_ASK.exec(request)?.groups;
  if (!match) return null;
  const address = URL.parse(match.address!);
  if (!address || address.username || address.password) return null;
  const open = directRoute(match.head!.replace(/^please\s+/iu, '').replace(/\s+the (?:site|website|page)(?=\s)/iu, ' '));
  if (!open?.finishes || open.screenshot || open.url !== match.address) return null;

  const ask = match.ask!;
  const speech = SPEECH.exec(ask);
  const question = ask.slice(speech?.[0].length ?? 0).trim();
  if (!question || question.length > 300 || /https?:\/\//iu.test(question) || hasNextStep(question)) return null;
  const folded = foldText(question);
  if (ANOTHER_ACTION.test(folded) || FIELD_ENTRY.test(folded)) return null;
  const directQuestion = EN_QUESTION.test(folded) || AR_QUESTION.test(folded) || PAGE_TOPIC.test(folded);
  const requestedField = speech && (EN_FIELD.test(folded) || AR_FIELD.test(folded) || IDENTIFIER_FIELD.test(folded));
  if (!directQuestion && !requestedField) return null;
  return [{ kind: 'open', url: open.url, name: open.name }, { kind: 'ask_page', question, strictFact: true }];
}
