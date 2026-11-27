// Source rank grammar from https://github.com/ahmadalwakai/Mohassan-AI/pull/13 (retrieved 2026-11-27).
const RANKS = [
  'اكبر|largest|biggest', 'اصغر|smallest', 'اعلي|highest|tallest', 'ادني|اخفض|lowest',
  'اطول|longest', 'اقصر|shortest', 'اقدم|oldest', 'اسرع|fastest', 'اغني|richest',
  'اعمق|deepest',
  'اكثر سكانا|most populous|most populated', 'اقل سكانا|least populous|least populated',
];
const RANK = RANKS.join('|');
const QUESTION = new RegExp(`^(?:(?:ما|من|اي)(?:\\s+(?:هو|هي))?|(?:what|which|who) (?:is|was|are|were) the|which)\\s+(?:ال)?(${RANK})\\s+(.+)$`, 'u');
const CLASS_FIRST = new RegExp(`^(?:(?:which|what) (.+?) (?:is|was|are|were)(?: the)? |اي (.+?) (?:هي|هو) (?:ال)?)(${RANK})(?=\\s|$)(.*)$`, 'u');

/** Recognizes a rank question whose answer supplies an entity absent from the question. */
export function isSuperlativeQuestion(question: string): boolean {
  return QUESTION.test(question) || CLASS_FIRST.test(question);
}
