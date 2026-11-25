import type { Lang } from '../mind/contract.js';
import { matchText } from '../mind/normalize.js';
import { maskRequestLiteralData } from '../request-constraints.js';

const DIRECTIVE = String.raw`(?:(?:please )?(?:reply|answer|respond) (?:to me )?in (arabic|english)|(?:رد|جاوب|اجب)(?: علي| لي)? (بالعربي(?:ه)?|بالانجليزي(?:ه)?))(?:\s+(?:please|من فضلك|لو سمحت))?`;
const BOUNDARY = String.raw`[,.!?؟،؛;:\n]`;
const REPLY_LANGUAGE = new RegExp(String.raw`(?:^|${BOUNDARY})\s*${DIRECTIVE}(?=\s*(?:$|${BOUNDARY}))`, 'gu');
const WHOLE_DIRECTIVE = new RegExp(String.raw`^\s*${DIRECTIVE}(?:\s|${BOUNDARY})*$`, 'u');

export function isMannersLanguageDirective(text: string): boolean {
  return WHOLE_DIRECTIVE.test(matchText(text));
}

/** The detector supplies the language of the recognized expression, independent of names and literal payloads. */
export function selectMannersLanguage(text: string, matchedLanguage: Lang): Lang {
  let language = matchedLanguage;
  for (const match of matchText(maskRequestLiteralData(text)).matchAll(REPLY_LANGUAGE)) {
    language = /^(?:arabic|بالعربي)/u.test(match[1] ?? match[2]) ? 'ar' : 'en';
  }
  return language;
}
