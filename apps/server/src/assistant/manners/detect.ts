import type { Lang } from '../mind/contract.js';
import { matchText } from '../mind/normalize.js';
import { maskRequestLiteralData } from '../request-constraints.js';
import { arabicAlternativeSeparator, arabicAssistantAddress } from './arabic.js';
import { englishAssistantAddress, isEverydayManners, normalizeEnglishThanks } from './everyday.js';
import { fullMannersEnabled } from './flags.js';
import { isMannersLanguageDirective, selectMannersLanguage } from './language.js';
import { extendedSpeechActRules, speechActRules, type MannersDetail, type MannersDialect, type SpeechAct, type SpeechActRule } from './speech-acts.js';

export type { MannersDetail, MannersDialect, SpeechAct } from './speech-acts.js';

export interface MannersDetection {
  act: SpeechAct;
  detail?: MannersDetail;
  language: Lang;
  dialect: MannersDialect | null;
  socialText: string;
  request: string | null;
}

interface SocialSpan {
  rule: SpeechActRule;
  end: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’‘-][\p{L}\p{M}\p{N}]+)*/gu;
const SEPARATOR = /[،,؛;!?؟:：\r\n]|\.(?=\s|$)|[—–]|-(?=\s)/u;
const LEADING_SEPARATOR = /^(?:[\s،,؛;!?؟:：]+|[—–-](?=\s)|\.(?=\s|$))+/u;
const DECORATION = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\uFE0F.,،;؛!?؟:：…—–-]*$/u;
const URL = /(?:https?:\/\/|www\.)[^\s<>"'«»]+/giu;
const NAME = /^(?:[\s,،]+)(?:(?:(?:يا|آ|ya)\s+)?(?:موحسن|موحسان|محسن|mohassan|mohasan|muhassan|يا\s+(?:غالي|صديقي|صديق|باشا|زول|معلم|استاذ)|ya\s+(?:zalameh|zool|akhi)|(?:my\s+)?(?:friend|assistant|mate|pal))|(?:يا\s+)?["“«][\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+){0,2}["”»])(?=$|[\s.!?؟،,؛;:：—–])/iu;
const OTHER_NAME = /^(?:[\s,،]+)(?:(?:يا|آ)\s+[\p{L}\p{M}]+|\p{Lu}[\p{L}\p{M}]+(?:[ -]\p{Lu}[\p{L}\p{M}]+)?)(?=\s*(?:$|[.!?؟،,؛;:：—–]))/u;
const ENGLISH_ADDRESS = new RegExp(String.raw`^[\s,]+${englishAssistantAddress}(?=\s*(?:$|[.!?,;:—–]))`, 'iu');
const ADDITIVE = /^(?:and|also|and also|as well as|وكمان|وكذلك|وايضا|وأيضا|وأيضًا|و)(?=\s|[،,])(?:\s|[،,])+/iu;
// Heads let unpunctuated greetings split from requests. Separated clauses can
// fall through to the existing router even if their heads are unfamiliar here.
const REQUEST_HEAD = /^(?:(?:please|kindly|can you|could you|would you|i (?:need|want|would like)|what|which|who|when|where|why|how|is|are|did|does|do|can|find|search|look|open|visit|check|read|write|draft|translate|summari[sz]e|list|show|calculate|compute|solve|convert|compare|explain|tell|give|remember|save|delete|send|sort|help|do not|don['’]t|never|avoid|without)\b|(?:من|ماذا|ما|متي|امتي|اين|وين|فين|كيف|كيفاش|ازاي|لماذا|ليه|ليش|علاش|كم|شنو|هسه|هل|اي|وش|شو|ايش|ممكن|اريد|عايز|عاوز|ابغي|ابي|ابغا|بدي|بغيت|اشتي|نبي|لو سمحت|من فضلك|افتح|ابحث|دور|فتش|تصفح|اكتب|احسب|حول|قارن|اشرح|ترجم|لخص|رتب|اعرض|اضغط|صف|اذكر|انقل|انسخ|اقرا|ارسل|احفظ|تذكر|استرجع|استخدم|امسح|احذف|ساعدني|خلينا|سوي|اعمل|دير|شوف|لاتبحث|لا|بدون|ممنوع)(?![\p{L}\p{M}])|(?:ab7ath|baddi|bghit|abgha|e7seb|efta7|ekteb|ektob|2olli|tarjem|targem|lakhis|shoof|shouf|3ayez|3ayz)\b|\d+\s*[-+×÷*/^]\s*\d|https?:\/\/)/iu;
const NAME_ONLY = /^(?:(?:just|only) (?:tell|write|say|give) (?:me )?(?:the |your )?name|(?:your |the )?name only|(?:اكتب|قل|اذكر) (?:الاسم|اسمك) (?:فقط|وبس)|الاسم (?:فقط|وبس))[\s.!?؟،,]*$/u;
const STRICT_TRAILING = /[،,؛;]|(?:[!?؟\r\n.]|[—–])(?=\s|$)/gu;
const OTHER_COMMAND = /^(?:go|close|cancel|stop|start|pause|resume|continue|proceed|launch|install|run|exit|move|copy|export|set|enable|disable|remove|edit|add|print|turn|press)\b/iu;
const MATH_START = /^[+-]?(?:\d+|\.\d+)\s*[-+×÷*/^]\s*[+-]?(?:\d+|\.\d+)/u;
const LEADING_COURTESY = /^(?:please|kindly|من فضلك|لو سمحت)[\s,،:]+/iu;
const LEADING_ADDRESS = new RegExp(String.raw`^\s*(?:(?:${englishAssistantAddress}|mohassan|يا موحسن)\s*[,،:]\s*|(?:${englishAssistantAddress}|mohassan|موحسن|يا موحسن)\s+)`, 'iu');
const LEADING_DISCOURSE = /^(?:well|okay|ok|all right|alright)\s*[,]\s*/iu;
const TRAILING_COURTESY = /^(?:please|kindly|من فضلك|لو سمحت|ارجوك)[\s.!?؟،,]*$/u;
const ENGLISH_ALTERNATIVE_SEPARATOR = /[,:](?=\s*(?:as|or|are(?:n[’']?t)? you)\b)/giu;
const MAX_SOCIAL_CLAUSES = 6;

function normalized(text: string): string {
  return matchText(text).replace(/[‘’]/gu, "'").replace(/\s+/gu, ' ').trim();
}

function firstSocialSpan(original: string, view: string, from: number, extended: boolean): SocialSpan | null {
  // Keep punctuation in the outer view: a colon may delimit literal input.
  const unpunctuated = view.slice(from).replace(ENGLISH_ALTERNATIVE_SEPARATOR, ' ');
  const tail = extended ? unpunctuated.replace(arabicAlternativeSeparator, ' ') : unpunctuated;
  let best: SocialSpan | null = null;
  let count = 0;
  let previousEnd = from;
  let start = from;
  const rules = extended ? extendedSpeechActRules : speechActRules;
  for (const word of tail.matchAll(WORD)) {
    const position = from + word.index;
    const gap = tail.slice(previousEnd - from, word.index);
    if (++count > 24 || (count === 1 ? !DECORATION.test(original.slice(from, position)) : !/^\s+$/u.test(gap))) break;
    if (count === 1) start = position;
    previousEnd = position + word[0].length;
    const phrase = normalized(tail.slice(start - from, previousEnd - from)).replace(/(?<=[a-z])-(?=[a-z])/gu, ' ');
    const rule = rules.find(candidate => candidate.pattern.test(phrase))
      ?? everydayThanksWithSpellingVariant(phrase);
    if (rule) best = { rule, end: previousEnd };
  }
  if (!best) return null;
  const rest = original.slice(best.end);
  const otherName = OTHER_NAME.exec(rest)?.[0] ?? '';
  const nameText = otherName.replace(/^[\s،,]+/u, '');
  const name = ENGLISH_ADDRESS.exec(rest)?.[0] ?? NAME.exec(rest)?.[0]
    ?? (!isRequest(nameText) && !OTHER_COMMAND.test(nameText) ? otherName : '');
  const end = best.end + name.length;
  const addressedSalam = name && normalized(view.slice(start, best.end)) === 'سلام' && DECORATION.test(original.slice(end));
  const rule = addressedSalam ? { ...best.rule, act: 'farewell' as const, detail: undefined } : best.rule;
  return { rule, end };
}

function everydayThanksWithSpellingVariant(phrase: string): SpeechActRule | undefined {
  const corrected = normalizeEnglishThanks(phrase);
  return corrected === phrase ? undefined
    : speechActRules.find(rule => rule.act === 'thanks' && rule.language === 'en' && rule.pattern.test(corrected));
}

function strongerAct(current: SpeechActRule, next: SpeechActRule): SpeechActRule {
  if (next.detail === 'quiet') return current.act === 'greeting' ? { ...current, detail: 'quiet' } : current;
  if (next.act === 'greeting' && current.act !== 'greeting') return current;
  if (next.act === 'compliment' && current.act === 'thanks') return current;
  // In a bilingual greeting the first greeting provides the response language.
  if (next.act === 'greeting' && current.act === 'greeting' && next.language !== current.language) return current;
  if (next.act === current.act && current.detail && !next.detail && current.language === next.language) return current;
  return next;
}

function isRequest(text: string): boolean {
  const key = normalized(text);
  return REQUEST_HEAD.test(key) || OTHER_COMMAND.test(key) || MATH_START.test(key);
}

function formatOrLanguageOnly(text: string, rule: SpeechActRule): boolean {
  const phrase = normalized(text);
  return isMannersLanguageDirective(text) || rule.act === 'identity' && rule.detail === 'name' && NAME_ONLY.test(phrase)
    || isEverydayManners(rule) && TRAILING_COURTESY.test(phrase);
}

function leadingSocial(original: string, view: string, extended: boolean, from = 0): { rule: SpeechActRule; end: number; requestStart: number | null } | null {
  const tail = view.slice(from);
  const arabicAddress = extended ? arabicAssistantAddress.exec(tail)?.[0] : undefined;
  const address = arabicAddress ?? LEADING_ADDRESS.exec(tail)?.[0];
  const prefix = LEADING_COURTESY.exec(tail)?.[0] ?? address ?? LEADING_DISCOURSE.exec(tail)?.[0];
  const prefixed = prefix ? firstSocialSpan(original, view, from + prefix.length, extended) : null;
  const addressed = extended && prefix === address && prefixed?.rule;
  const addressedSocial = addressed && (
    addressed.language === 'en' && addressed.act === 'compliment'
    || arabicAddress && addressed.language === 'ar' && (addressed.act === 'apology' || addressed.act === 'wellbeing')
  );
  const first = firstSocialSpan(original, view, from, extended)
    ?? (prefixed && (addressedSocial || isEverydayManners(prefixed.rule)) ? prefixed : null);
  if (!first) return null;
  let { rule, end } = first;
  for (let clauses = 0; clauses < MAX_SOCIAL_CLAUSES; clauses++) {
    const tail = original.slice(end);
    if (DECORATION.test(tail)) return { rule, end: original.length, requestStart: null };
    const boundary = LEADING_SEPARATOR.exec(tail)?.[0] ?? '';
    const rest = end + boundary.length;
    if (formatOrLanguageOnly(original.slice(rest), rule)) return { rule, end: original.length, requestStart: null };
    const connector = ADDITIVE.exec(original.slice(rest))?.[0] ?? '';
    const next = firstSocialSpan(original, view, rest + connector.length, extended);
    if (next) {
      rule = strongerAct(rule, next.rule);
      end = next.end;
      continue;
    }
    if (connector && isRequest(original.slice(rest + connector.length))) return { rule, end, requestStart: rest + connector.length };
    // Written Arabic often attaches the linking waw to the request head.
    if (/^[وف][\p{Script=Arabic}]/u.test(original.slice(rest)) && isRequest(original.slice(rest + 1))) {
      return { rule, end, requestStart: rest + 1 };
    }
    if (isRequest(original.slice(rest)) || boundary.length > 0 && SEPARATOR.test(boundary) && /[\p{L}\p{N}]/u.test(view.slice(rest))) {
      return { rule, end, requestStart: rest };
    }
    return null;
  }
  return null;
}

function trailingSocial(original: string, view: string, from: number, extended: boolean): { rule: SpeechActRule; start: number; requestEnd: number } | null {
  const tail = view.slice(from);
  // A colon can introduce a literal operand. A greeting after the colon must
  // stay with the request, even when the particular instruction is unfamiliar.
  const colon = tail.search(/[:：]/u);
  const boundaries = [...tail.slice(0, colon === -1 ? undefined : colon).matchAll(STRICT_TRAILING)];
  for (const boundary of boundaries.slice(-MAX_SOCIAL_CLAUSES)) {
    const position = from + boundary.index;
    const start = position + boundary[0].length;
    const requestEnd = /[،,؛;\r\n—–]/u.test(boundary[0]) ? position : start;
    const request = original.slice(from, requestEnd).trim();
    if (!isRequest(request)) continue;
    const social = leadingSocial(original, view, extended, start);
    if (social && social.requestStart === null) return { rule: social.rule, start, requestEnd };
  }
  return null;
}

/** Recognize outer conversational acts while retaining the user's original request text. */
export function detectManners(original: string, extended = fullMannersEnabled()): MannersDetection | null {
  if (!original.trim() || original.length > 8000) return null;
  const view = maskRequestLiteralData(original).replace(URL, value => ' '.repeat(value.length));
  const leading = leadingSocial(original, view, extended);
  const trailing = leading?.requestStart === null ? null : trailingSocial(original, view, leading?.requestStart ?? 0, extended);
  const rule = leading?.rule ?? trailing?.rule;
  if (!rule) return null;
  const request = leading?.requestStart === null ? null
    : original.slice(leading?.requestStart ?? 0, trailing?.requestEnd).trim() || null;
  const socialText = leading ? original.slice(0, leading.end).trim() : original.slice(trailing?.start).trim();
  const language = selectMannersLanguage(original, rule.language);
  const dialect = language === 'ar' ? rule.dialect ?? 'msa' : null;
  return { act: rule.act, detail: rule.detail, language, dialect, socialText, request };
}
