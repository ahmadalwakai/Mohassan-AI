import { analyzeCompoundRequest, MAX_COMPOUND_REQUEST } from '../compound-request.js';
import { matchText } from '../mind/normalize.js';
import { splitReplyDirective } from '../reply-directive.js';
import { maskRequestLiteralData } from '../request-constraints.js';

const LEAD = /^(?:(?:please|kindly|first(?: of all)?|can you|could you|would you|من فضلك|لو سمحت|ممكن|هل يمكنك|اولا|بدي|بدنا|اريد|ابغي|ابي|ابغا|عايز|عاوز)(?:\s+ان)?[,:،\s]+)*/u;
const ACTION = /^(?:calculate|compute|multiply|divide|add|subtract|convert|find|search|look up|google|check|read|open|visit|remember|save|recall|retrieve|compare|contrast|create|make|generate|prepare|build|design|turn|export|write|draft|compose|show|give|list|tell|what|which|who|where|when|why|how|send|publish|translate|summari[sz]e|delete|update|edit|run|schedule|do not|don['’]t|never|احسب|حسب|اضرب(?:ه|ها)?|اقسم(?:ه|ها)?|اجمع(?:ه|ها)?|اطرح(?:ه|ها)?|اضف|زد|زود|ضاعف(?:ه|ها)?|حول(?:ه|ها)?|ابحث(?:لي)?|بحث|دور(?:لي)?|قلب|فتش|شوف(?:لي)?|جيب(?:لي)?|لق(?:ي|يني)|اقرا(?:ه|ها|هم)?|افتح(?:ه|ها|هم)?|تصفح|تذكر|احفظ(?:ها|ه)?|خزن|سجل|استرجع(?:ها|ه)?|اذكر(?:ها|ه)?|ذكرني|قارن(?:هما|هم|ها|ه)?|وازن|انش[ئي]|اصنع|اعمل|سوي|سو|سولي|جهز|حضر|ولد|صمم|اطبع|صدر|اكتب(?:لي|ه|ها)?|صغ|اعرض|اعطني|اعطيني|هات|شو|ايش|وش|كم|ما|ماذا|كيف|من|وين|اين|متي|ارسل|ابعت|انشر|ترجم|لخص|احذف|عدل|شغل|نفذ|جدول|لا)(?![\p{L}\p{N}])/u;
const ARITHMETIC = /^\(?-?\d+(?:[.٫]\d+)?\s*(?:[+*/÷×^-]|plus\b|minus\b|times\b|زائد|ناقص|ضرب|قسمة)\s*[-(]?\d/u;
const PUNCTUATION = /^[\p{Z}\s،,:؛;]+|[\p{Z}\s،,؛;]+$/gu;
const INTRO = /^(?:please|kindly|please do (?:these|the following)(?: (?:steps|tasks))?|do the following|here are the steps|الرجاء|من فضلك|لو سمحت|قم بالتالي|نفذ التالي|المطلوب|الخطوات)[\s:：.]*$/u;
const BODY = /(?:\b(?:body|content|text)\s*[:：]|\b(?:saying|containing|with (?:this|the following|the) (?:text|content|body))\s*[:：]?|(?:بالنص|نصها|محتواها|المحتوي|النص)\s*[:：])\s*/giu;
const CREATION = /^(?:write|draft|compose|create|make|generate|prepare|احفظ|اكتب|صغ|انشئ|اصنع|اعمل|سوي|جهز)(?!\p{L})/u;
const CONTENT_OBJECT = /\b(?:pdf|letter|email|message|note)\b|(?:ملف|رساله|بريد|خطاب)/u;
const NARRATIVE = /^(?:write|draft|compose|tell|rewrite|اكتب|الف|احك|اعد صياغه)\s+[\s\S]{0,140}?(?:story|fiction|scene|dialogue|play|poem|قصه|حكايه|حوار|مشهد|مسرحيه|قصيده)\s+(?:where|in which|whose|about|عن|حيث|فيها)(?!\p{L})/u;
const REPORTED_CONTENT = /^(?:(?:the|this|a|my|our|saved|stored)\s+){0,3}(?:note|document|file|page|email|message|quote|text)\s+(?:says|reads|contains|states|includes)\b|^(?:النص|الرساله|الصفحه|الملف|المستند|الملاحظه)\s+(?:يقول|تقول|يحتوي|تحتوي|مكتوب)|\b(?:which|that)\s+(?:says|reads|contains|states|includes)\b|(?:الذي|التي)\s+(?:يقول|تقول|يحتوي|تحتوي|مكتوب)/u;

export function actionHead(text: string): string {
  return matchText(text.trim()).replace(LEAD, '');
}

function looksLikeAction(text: string): boolean {
  const head = actionHead(text);
  return ACTION.test(head) || ARITHMETIC.test(head);
}

/** Keeps normalized matching offsets tied to the original clause. */
export function matchingView(text: string): { text: string; starts: number[]; ends: number[] } {
  let offset = 0, matched = '';
  const starts: number[] = [], ends: number[] = [];
  for (const char of text) {
    const normalized = matchText(char);
    matched += normalized;
    for (let index = 0; index < normalized.length; index++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  return { text: matched, starts, ends };
}

export function clauseMatchingText(text: string): string {
  return maskRequestLiteralData(text).replace(/https?:\/\/[^\s<>«»"'\x60،,؛]+/giu, url => ' '.repeat(url.length));
}

interface Boundary { start: number; end: number; kind: 'list' | 'sequence' | 'separator' | 'and' }
const LIST = /^[\t ]*(?:[-*+•▪◦][\t ]+|\(?\d{1,2}[.)،:][\t ]+)/gmu;
const INLINE_LIST = /(?<!\S)\(?\d{1,2}[.)][\t ]+(?=\S)/gu;
const CONNECTOR = /(?<![\p{L}\p{N}])(?:and[\t ]+then|then|after[\t ]+that|afterwards|and[\t ]+finally|finally|next|و?(?:ثم|بعدها|بعديها|بعد[\t ]+(?:ذلك|هيك|كذا)|بعدين|من[\t ]+بعد|اخيرا|بالاخير|في[\t ]+الاخير))(?![\p{L}\p{N}])[\t ,،:]*/gu;
const AND = /\band\b[\t ]+|(?<![\p{L}\p{N}])و[\t ]*/gu;
const SEPARATOR = /[.!?؟;؛,،](?=[\t ]+\S)|\r?\n(?=[\t ]*\S)/gu;

function cutPoints(view: ReturnType<typeof matchingView>): Boundary[] {
  const patterns = { list: LIST, sequence: CONNECTOR, separator: SEPARATOR, and: AND } as const;
  const points: Boundary[] = [];
  for (const kind of Object.keys(patterns) as Array<keyof typeof patterns>) {
    for (const match of view.text.matchAll(patterns[kind])) {
      const start = view.starts[match.index]!, end = view.ends[match.index + match[0].length - 1]!;
      points.push({ start, end, kind });
    }
  }
  if (/^\(?\d{1,2}[.)][\t ]+/u.test(view.text)) {
    for (const match of view.text.matchAll(INLINE_LIST)) {
      if (!looksLikeAction(view.text.slice(match.index + match[0].length))) continue;
      points.push({ start: view.starts[match.index]!, end: view.ends[match.index + match[0].length - 1]!, kind: 'list' });
    }
  }
  return points.sort((a, b) => a.start - b.start || b.end - a.end);
}

function beginsLiteralBody(text: string): boolean {
  const matching = actionHead(text);
  const visible = clauseMatchingText(matching);
  if (NARRATIVE.test(visible) || REPORTED_CONTENT.test(visible)) return true;
  if (!CREATION.test(matching)) return false;
  const colon = /[:：]/u.exec(visible);
  if (colon && CONTENT_OBJECT.test(visible.slice(0, colon.index))
    && !/(?:\b(?:to|from|title|subject)|(?:الى|من|العنوان|عنوان|الموضوع))\s*$/u.test(visible.slice(0, colon.index))
    && !/^\s*["'«“‘`]/u.test(matching.slice(colon.index + 1))) return true;
  // A quoted body protects its own delimiters. A prose body left open at a
  // boundary does not turn words such as "then publish" into a new instruction.
  return [...visible.matchAll(BODY)].some(marker => {
    const after = matching.slice(marker.index + marker[0].trimEnd().length).trimStart();
    return !/^["'«“‘`]/u.test(after)
      && !/^(?:it|that|this|(?:the|its) (?:content|text|result)|(?:النتيجه|الناتج|المحتوي|النص))(?:[.!?؟])?$/u.test(after);
  });
}

/** Weak conjunctions split only before an action, so names and joined nouns stay together. */
export function splitPlanClauses(request: string): string[] {
  const original = request.trim();
  if (!original || original.length > MAX_COMPOUND_REQUEST) return [];
  const compound = analyzeCompoundRequest(original);
  if (compound.reason === 'unbalanced_literal') return [original];
  const masked = clauseMatchingText(original);
  const view = matchingView(masked);
  const framing = splitReplyDirective(original);
  const format = compound.formatting.at(-1);
  const replyStart = framing.directive ? original.indexOf(framing.body) + framing.body.length : original.length;
  const parts: string[] = [];
  let start = 0;
  let listIndent: number | undefined;
  for (const point of cutPoints(view)) {
    if (point.start < start) continue;
    const current = original.slice(start, point.start).replace(PUNCTUATION, '');
    if (point.kind === 'list') {
      const indent = /^[\t ]*/u.exec(original.slice(point.start, point.end))![0].length;
      if (beginsLiteralBody(current) && (listIndent === undefined || indent > listIndent)) continue;
      if (current && !INTRO.test(matchText(current))) parts.push(current);
      listIndent = indent;
    } else {
      if (point.start >= replyStart || format && point.end <= format.start && format.end === original.length
        && !masked.slice(point.end, format.start).trim()) continue;
      const tail = masked.slice(point.end);
      if (!current || !looksLikeAction(tail) || beginsLiteralBody(current)) continue;
      if (!looksLikeAction(current) && !parts.length) continue;
      parts.push(current);
    }
    start = point.end;
  }
  const remainder = original.slice(start).replace(PUNCTUATION, '');
  if (remainder) parts.push(remainder);
  return parts;
}
