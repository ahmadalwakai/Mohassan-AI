// Arabic alternative questions, retrieved 2026-11-27:
// Arabic Language Academy ruling 2077 (أم and أو): https://www.m-a-arabia.com/site/29221.html
// An attested هل … أم question: https://sunnah.com/bukhari:2967
// Winans, Egyptian Arabic, pp. 6–7 (ولا and أو): https://lauren.northrup.me/papers/EAV-winans.pdf
// Ferguson and Ani, Damascus Arabic, unit 8B (ولا and أو): https://www.gw.uni-jena.de/phifakmedia/102212/ferguson-und-ani-damascus-arabic.pdf?nonactive=1&suffix=pdf
// Michigan State University, Egyptian Arabic (إنتَ): https://openbooks.lib.msu.edu/arb101/chapter/reading-and-speaking/
const you = '(?:انت|انتا|انتي)';
const human = '(?:انسان(?: حقيقي)?|بشر|بشري|شخص حقيقي)';
const machine = '(?:مجرد )?(?:الي|اله|روبوت|بوت|شات ?بوت|برنامج(?: حاسوبي)?|حاسوب|كمبيوتر|ذكاء اصطناعي|مساعد (?:الي|ذكي))';
const or = '(?:ام|او|ولا)';
const talking = '(?:اتحدث|اتكلم|اتواصل) (?:مع|الي)|اكلم';
export const arabicAlternativeSeparator = /[،,](?=\s*(?:[أا][مو]|ولا)\p{M}*\s)/gu;

// The caller folds letters and diacritics before matching the whole clause.
function identity(kind: string, other: string): string {
  return [
    `(?:هل ${you}|ا?${you}) ${kind}(?: ${or} (?:${you} )?${other})?`,
    `(?:هل |انا )?(?:${talking}) ${kind}(?: ${or} (?:(?:مع|الي) )?${other})?`,
    `${kind} ${or} ${other}`,
  ].join('|');
}

export const arabicHumanIdentity = identity(human, machine);
export const arabicMachineIdentity = identity(machine, human);

// UC Davis dialogue (كيف حالك, شكرا and يا + name) and Rosetta Stone Arabic 2
// lessons 9-04 and 10-02 (هل أنت بخير, شكرا لك يا + name), retrieved 2026-11-27:
// https://arabicwithoutwalls.ucdavis.edu/alifbaa_unit3/AB3-DialC.pdf
// https://resources.rosettastone.com/CDN/us/pdfs/documentation/RSV2_CT_Arabic_2.pdf
export const arabicWellbeing = `كيف (?:حالك|${you})(?: اليوم)?|(?:هل )?${you} بخير(?: اليوم)?`;

// Abaza, Something of Fear, ch. 4 (سامحني يا + addressee), retrieved 2026-11-27:
// https://www.safahat.org/books/68680686/4/
export const arabicAssistantAddress = /^\s*(?:يا\s+)?(?:موحسن|موحسان|محسن)(?:\s*[,،:]\s*|\s+)/u;
