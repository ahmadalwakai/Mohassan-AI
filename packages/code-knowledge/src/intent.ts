import { hasErrorMessage } from './tokens.js';
import type { QuestionType } from './types.js';

const comparison = /\b(?:vs\.?|versus|compar(?:e|ing|ison)|differ(?:ence|ences|ent))\b|الفرق بين|مقارنة بين|قارن بين/iu;
const error = /\b(?:how (?:do (?:i|we)|to) fix|why (?:am i|do i|does .+?) get(?:ting)?|what (?:causes|does .+? error mean)|error message|stack trace|exception)\b|(?:سبب|حل|أصلح|اصلاح|إصلاح|رسالة) (?:هذا )?الخطأ/iu;
const api = /\b(?:use|using|usage|syntax|parameter|argument|return value|api|call|invoke)\b|[اأإ]ستخد(?:ام|م)|تستخدم|تمرير|وسيط|استدعاء|وسائط/iu;
const concept = /\b(?:how (?:do|does) .+ work|what .+ use .+ for)\b/iu;
const howTo = /\b(?:how (?:can|could|do|does|should|to|would)|ways? to|examples? (?:of|for))\b|^(?:check|convert|create|find|install|parse|read|remove|sort|write)\b|(?:^|\s)(?:كيف|شلون|إزاي|ازاي|طريقة)(?=\s)/iu;
const ownEdit = /^(?:(?:please\s+)?(?:edit|fix|modify|patch|refactor|rename|change|update|rewrite)\s+(?:(?:my|our|the|this|these)\s+)?(?:repo(?:sitory)?|workspace|project|files?|code|script|function)\b|(?:عد[ّ]?ل|غي[ّ]?ر|(?:أ|ا)صلح|(?:أ|ا)عد كتابة)\s+(?:ملف|ملفي|المشروع|مشروعي|الكود|كودي|الدالة))/iu;
const existingImplementation = /\b(?:in (?:this|my|our|the) (?:repo(?:sitory)?|workspace|codebase)|unified diff|git diff|propose a patch)\b|(?:في (?:هذا المستودع|مشروعي)|صيغة diff)/iu;

export function isEditRequest(text: string): boolean {
  const question = text.trim();
  return ownEdit.test(question) || existingImplementation.test(question);
}

export function classifyQuestion(text: string): QuestionType {
  if (hasErrorMessage(text) || error.test(text)) return 'error';
  if (comparison.test(text)) return 'comparison';
  if (concept.test(text)) return 'concept';
  if (api.test(text)) return 'api-usage';
  if (howTo.test(text)) return 'how-to';
  return 'concept';
}
