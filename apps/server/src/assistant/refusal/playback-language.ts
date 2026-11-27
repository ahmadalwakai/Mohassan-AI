import { parseDesktopCommand } from '@mohassan/desktop';
import { assessRequestScope } from '../request-scope.js';
import { head, words } from './patterns.js';

// Dialect spellings are matched after refusal text normalization. Sources retrieved 2026-11-27.
// Egyptian imperatives: https://verbix.com/egyptian-arabic/verb/%D8%B4%D9%8E%D8%BA%D9%91%D9%8E%D9%84
// Egyptian playback usage: https://resources.lingualism.com/wp-content/uploads/Mido-in-Egyptian-Arabic-Glossary-Lingualism.pdf
// Egyptian household glossary: https://resources.lingualism.com/egyptian-arabic/the-house/
// Palestinian lexicon (شَعِّل, ضَوّ, طَفِّى): https://sites.google.com/nyu.edu/palestine-lexicon/download
// Peace Corps English–Tunisian Arabic Dictionary, TURN OFF and TURN ON: https://files.eric.ed.gov/fulltext/ED183017.pdf#page=464
export const arabicPlay = '(?:شغل|اشغل)(?:ي|لي)?(?: لي)?';
export const arabicSwitchOn = '(?:ولع|شعل)(?:ي|لي)?(?: لي)?';
export const arabicSwitchOff = '(?:طف|طفي|اطفي|اطفئ|سكر)(?:ي|لي)?(?: لي)?';
export const dialectLightNoun = 'ضو';

// Arabic media libraries and broadcasting terminology, retrieved 2026-11-27.
// https://support.apple.com/ar-sa/111118
// https://support.google.com/youtube/answer/12220281?hl=ar
// https://www.itu.int/dms_pub/itu-d/opb/ind/d-ind-ar-2012-pdf-a.pdf
export const arabicMediaAdditions = '(?:قائمه|قوائم) (?:ال)?تشغيل|المفضله|اف ام|fm';

// Cambridge Dictionary and English Grammar Today, retrieved 2026-11-27.
// https://dictionary.cambridge.org/dictionary/english/quran
// https://dictionary.cambridge.org/dictionary/english/sura
// https://dictionary.cambridge.org/dictionary/english/wanna
// https://dictionary.cambridge.org/dictionary/english/gonna
// https://dictionary.cambridge.org/grammar/british-grammar/will-or-be-going-to
// https://dictionary.cambridge.org/grammar/british-grammar/word-choice-listen-listen-to-or-hear
// https://dictionary.cambridge.org/dictionary/english/watch
export const englishSacredMedia = "qur'?an|surahs?|suras?";
export const colloquialMediaLead = "(?:(?:i )?wanna|(?:(?:i'm|i am) )?gonna) ";
export const optionalColloquialMediaLead = `(?:${colloquialMediaLead})?`;

const arabicNamedHead = head(`${arabicPlay}(?= )`);
const englishNamedHead = head(`${colloquialMediaLead}play|start playing`);
const impliedPlaybackHead = head('resume(?= \\p{L}+ \\p{L})|start(?= the \\p{L}+ \\p{L})');
const nameOperand = head(String.raw`\p{L}[\p{L}\p{N}'’ .,:-]{1,100}$`);
const vagueOperand = head('it|this|that|them|anything|something|more|next|previous|the (?:next|previous|last|first)|(?:هذا|هذه|هذي|لي|اي شيء|اي شي|شيء|شي|حاجه)(?=[ .!?]*$)');
// Preserve the software, document, conversation and workspace actions handled by the existing routes.
const workOperand = words('apps?|applications?|software|programs?|programming|code|scripts?|commands?|tests?|projects?|builds?|workflows?|jobs?|tasks?|sessions?|conversations?|chats?|drafts?|reports?|documents?|files?|meetings?|timers?|games?|analysis|discussion|lessons?|tutorials?|exercises?|routines?|introductions?|paragraphs?|sections?|reviews?|(?:ال)?(?:تطبيق|برنامج|امر|اوامر|سكريبت|سكربت|اختبار(?:ات)?|فحص|تحقق|بناء|مشروع|مهمه|مهاره|حمله|محاكي|موقع|كود|شفره|ملف|مجلد|لعبه|مؤقت|منصب|وظيفه|دور)');
const continuationOperand = head('as|with|where|from|what|my|our|(?:the )?work|كيف|وين|من|مخك|عقلك');
const activityOperand = head('[a-z]+ing(?= [a-z])');

/** A name may also refer to a local app or an ordinary task. Preserve those command paths. */
export function isAdditionalNamedPlayback(text: string): boolean {
  const arabic = arabicNamedHead.exec(text);
  const implied = impliedPlaybackHead.exec(text);
  const action = arabic ?? englishNamedHead.exec(text) ?? implied;
  if (!action) return false;
  const name = text.slice(action[0].length).trim();
  if (!nameOperand.test(name) || vagueOperand.test(name) || workOperand.test(name) || continuationOperand.test(name)
    || implied && activityOperand.test(name)) return false;
  // The desktop parser recognizes the base imperative, including known app aliases.
  const command = arabic ? `شغل ${name}` : text;
  return parseDesktopCommand(command) === null && assessRequestScope(command).destination !== 'pc';
}
