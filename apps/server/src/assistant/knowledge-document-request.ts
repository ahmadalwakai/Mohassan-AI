import { matchText } from './mind/normalize.js';

const DOCUMENT = /\b(?:documents?|files?|guides?|manuals?|handbooks?|knowledge base|uploaded|imported|evaluated records?|internal records?)\b|(?:مستند|وثيق|وثايق|ملف|دليل|كتيب|قاعده المعرفه|المرفوع|المستورد|السجلات الداخليه)/iu;
const LOCAL_EN = /\b(?:the|my|our|your)\s+(?:local|internal|saved|stored|uploaded|imported|evaluated|private)\s+(?:[\p{L}\p{N}'’-]+\s+){0,10}(?:documents?|files?|reports?|letters?|guides?|manuals?|handbooks?|knowledge base)\b|\b(?:my|our)\s+(?:[\p{L}\p{N}'’-]+\s+){0,8}(?:documents?|files?|reports?|guides?|manuals?|handbooks?|knowledge base)\b|\b(?:the|my|our|your)\s+(?:documents?|files?|reports?|letters?)\s+(?:(?:that|which)\s+)?(?:(?:was|were|is|are|you|i|we)\s+)?(?:saved|stored|uploaded|imported|evaluated)\b/iu;
const STORAGE_RELATION = /\b(?:documents?|files?|reports?|letters?|guides?|manuals?|handbooks?)\s+((?:that|which)\s+(?:you|i|we)\s+(?:saved|stored|uploaded|imported|evaluated))\b/giu;
const LOCAL_AR = /(?<!\p{L})(?:ال)?(?:مستند\p{L}*|وثيق\p{L}*|ملف\p{L}*|تقرير\p{L}*|خطاب\p{L}*|دليل\p{L}*|كتيب\p{L}*|وثائق|تقارير)(?:\s+[\p{L}\p{N}]+){0,8}\s+(?:ال)?(?:مخزن|محفوظ|مقيم|مرفوع|مستورد|موجود\s+(?:عندك|لديك|عندي|لدي))(?:ه|ين)?(?!\p{L})|(?<!\p{L})(?:مستندات|مستند|وثائق|وثيقت|ملفات|ملف|تقارير|تقرير|دليل|كتيب)(?:ي|نا)(?!\p{L})/iu;
const OTHER_SOURCE = /https?:\/\/|(?:^|\s)(?:[a-z]:[\\/]|(?:~|\.{1,2})?\/|\\\\)\S+|\b(?:search|browse|look up)\b[^.!?؟\n]{0,80}\b(?:web|online|internet)\b|\b(?:website|publicly available|publicly published)\b|(?:الويب|الانترنت|الموقع الرسمي|علي\s+(?:جهازي|الحاسوب|الكمبيوتر|سطح المكتب))/iu;
const NON_READ = /^(?:(?:please|can you|could you|من فضلك|لو سمحت)\s+)*(?:write|draft|create|make|generate|update|edit|delete|remove|rename|translate|upload|import|save|download|send|email|publish|export|اكتب|صغ|انشئ|اصنع|عدل|احذف|ازل|ترجم|ارفع|استورد|احفظ|نزل|ارسل|انشر|صدر)(?!\p{L})/iu;
const SUMMARY = /^(?:(?:please|can you|could you|من فضلك|لو سمحت|ممكن)\s+)*(?:summari[sz]e|give me (?:a|the) summary of|لخص(?:لي)?|اختصر|اعطني ملخص)(?!\p{L})/iu;
const READ = /^(?:(?:please|can you|could you|من فضلك|لو سمحت|ممكن)\s+)*(?:read|show me|اقرا|اعرض)(?!\p{L})/iu;
const GENERAL_METHOD = /^(?:how (?:do|can|should|would) (?:i|we|one)\b|what is (?:a|an)\b|(?:كيف (?:اقرا|احفظ|ارفع|انشئ)|ما (?:تعريف|معني))(?!\p{L}))/iu;

export function mentionsKnowledgeDocument(request: string): boolean {
  return DOCUMENT.test(matchText(request)) || explicitKnowledgeDocumentRequest(request);
}

/** The current request declares a stored document source and a read operation. */
export function explicitKnowledgeDocumentRequest(request: string): boolean {
  const text = matchText(request).replace(/[ \t]+/gu, ' ').trim();
  if (NON_READ.test(text) || GENERAL_METHOD.test(text) || OTHER_SOURCE.test(text)) return false;
  if (SUMMARY.test(text) && /[:：\n]/u.test(text) && !/^[^:：\n]+[:：]\s*[«"“'‘]/u.test(text)) return false;
  return LOCAL_EN.test(text) || LOCAL_AR.test(text) || [...text.matchAll(STORAGE_RELATION)].length > 0;
}

export const requestsKnowledgeSummary = (request: string): boolean => SUMMARY.test(matchText(request.trim()));

const COUNT_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, واحد: 1, واحده: 1, اثنين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5 };
const SUMMARY_FORMAT = /\s+(?:in\s+(?:(?:at most|up to|exactly)\s+)?(\d+|one|two|three|four|five)\s+((?:bullet\s+)?points?|bullets?|sentences?)|في\s+(?:(\d+|واحده?|اثنين|ثلاثه?|اربعه?|خمسه?)\s+)?(نقطتين|جملتين|نقط[هة]|نقاط|جمل[هة]|جمل)(?:\s+واحده)?)$/iu;
const FILE_WRAPPER = /^(?:(?:the|my|our|your|saved|stored|uploaded|imported|evaluated|private|internal|document|file|(?:ال)?(?:ملف|مستند|وثيقه|محفوظ|محفوظه|مرفوع|مرفوعه)|من|في)\s+)+|\s+(?:(?:document|file)|(?:ال)?(?:محفوظ|محفوظه|مرفوع|مرفوعه))$/giu;
const TITLE_MARKER = /^(?:(?:report|letter|document|file)\s+)?(?:named|called|titled|بعنوان|باسم)\s*[:：]?\s*/iu;
const stripSentenceEnd = (text: string) => text.replace(/[.!؟?]+$/u, '').trim();
const titleKey = (title: string) => matchText(title).match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';

export function knowledgeSummaryRequest(request: string): { title: string; count?: number; bullet: boolean } | null {
  const text = matchText(request.trim());
  const summary = SUMMARY.exec(text);
  const start = summary ?? READ.exec(text);
  if (!start) return null;
  let operand = stripSentenceEnd(start.input.slice(start[0].length).trim());
  // A standalone read names only its source. A command with a field question
  // continues through ordinary fact extraction.
  if (!summary && /\b(?:and then|and (?:tell|show|give)|what|which|how many|how much)\b|[،,؟?]|(?<!\p{L})(?:و?قل لي|و?اخبرني|كم)(?!\p{L})/iu.test(operand)) return null;
  const format = SUMMARY_FORMAT.exec(operand);
  if (format) operand = operand.slice(0, format.index).trim();
  const title = titleKey(operand.replace(FILE_WRAPPER, '').replace(TITLE_MARKER, ''));
  if (!title) return null;
  const countText = format?.[1] ?? format?.[3];
  const count = countText ? (COUNT_WORDS[countText] ?? Number(countText)) : /تين$/u.test(format?.[4] ?? '') ? 2 : format?.[4] ? 1 : undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 5)) return null;
  return { title, count, bullet: Boolean(format && /bullet|point|نقط/u.test(format[0])) };
}

export function matchesKnowledgeTitle(requested: string, supplied: string): boolean {
  return requested === titleKey(supplied) || requested === titleKey(matchText(supplied).replace(FILE_WRAPPER, ''));
}

/** Remove source and reading scaffolding from matching only. Keep titles and fact operands. */
export function knowledgeQuestionText(request: string): string {
  return matchText(request)
    .replace(STORAGE_RELATION, (match: string, relation: string) => match.slice(0, -relation.length).trim())
    .replace(/\b(?:internal|local|evaluated|uploaded|imported|according to|(?:shown|stated|listed|specified|recorded)\s+(?=in\b|for\b))\b/giu, ' ')
    .replace(/\band\s+(?=(?:tell|show|give)\s+me\b|identify\b)/gu, ' ')
    .replace(/((?<!\p{L})(?:ال)?(?:مقيم|محفوظ|مخزن|مرفوع|مستورد)(?:ه|ين)?\s+)مال(?!\p{L})/gu, '$1')
    .replace(/(?<!\p{L})(?:ال)?(?:مستند\p{L}*|وثيق\p{L}*|ملف\p{L}*|تقرير(?:ي|نا)?|تقارير(?:ي|نا)?|وثائق)(?!\p{L})/gu, ' ')
    .replace(/(?<!\p{L})(?:(?:ال)?موجود(?:ه)?\s+(?:عندك|لديك|عندي|لدي)|(?:اريد|ابغي|ابي|بدي|عايز)\s+(?:ان\s+)?(?:اعرف|معرفه)|قل\s+لي|قولي|خبرني|اخبرني|شكد|قديش)(?!\p{L})/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}
