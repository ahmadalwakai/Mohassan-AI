// The caller supplies matching text, so these patterns do not change the query sent to search.
const QUESTION_OPENING = /^(?:(?:(?:في|الي|علي|عن|من|مع|لدي|حسب|تحت|داخل|خارج)\s+)?(?:ما|ماذا|كم|كيف|متي|اين|وين|من|مين|هل|اي|وش|شو|شنو|ايش|ايهما|ماهو|ماهي|بكم|بماذا|لمن|لاي|باي)|(?:لماذا|ليش|ليه))(?=\s+\S)|^(?:(?:(?:in|on|at|by|to|from|for|with|under|about)\s+)?(?:what|who|whom|whose|when|where|why|how|which)|is|are|does|do|can|will)\b(?=['’]|\s+\S)/iu;
const ENGLISH_AUXILIARY_QUESTION = /^(?:was|were|did|has)\s+\S[^?]*\?$/iu;

const QUOTED_TITLE = /((?<![\p{L}\p{N}])(?:book|novel|poem|film|movie|play|show|series|album|song|program(?:me)?|(?:ال)?(?:كتاب|روايه|قصيده|فيلم|مسرحيه|مسلسل|البوم|اغنيه|برنامج))\s+)(?:«[^»\r\n]+»|“[^”\r\n]+”|"[^"\r\n]+")/giu;
const ARABIC_RELATIVE_CLAUSE = /(?<=\p{L}\s)(?:الذي|التي|الذين|اللذين|اللتين|اللذان|اللتان|اللواتي|اللاتي)\s+[^؟?!،,؛;]+/gu;
const ARABIC_RESUMPTIVE = /(?<![\p{L}\p{N}])(?:فيه|فيها|له|لها|نفسه|نفسها)(?![\p{L}\p{N}])/gu;
const ENGLISH_RELATIVE = /\b((?:the|an?)\s+(?!one\b)[a-z][a-z’-]*)\s+that\b(?=\s+(?:(?:is|are|was|were|has|have|had|will|can|could|would|did|does|[a-z]{2,}ed|[a-z]{2,}s|i|you|he|she|they|we)\b|[a-z]+\s+(?:the\b|an?\b|\d)))/giu;

export function startsFactualQuestion(text: string): boolean {
  return QUESTION_OPENING.test(text) || ENGLISH_AUXILIARY_QUESTION.test(text);
}

/** Remove pronouns with a grammatical role inside the current question before checking for references to earlier turns. */
export function questionCoreferenceText(text: string): string {
  if (!startsFactualQuestion(text)) return text;
  return text.replace(QUOTED_TITLE, '$1quoted-title')
    .replace(ARABIC_RELATIVE_CLAUSE, clause => clause.replace(ARABIC_RESUMPTIVE, ''))
    .replace(ENGLISH_RELATIVE, '$1')
    .replace(/^(how\s+(?:many|much)\s+[^?]+?\s+(?:are|is|were|was))\s+there(?=\s+(?:in|on|among|at)\s+\p{L})/iu, '$1')
    .replace(/^(how\s+(?:long|much)\s+(?:does|did|will|would)\s+)it(?=\s+(?:take|cost)\s+to\s+\p{L}+\s+\p{L})/iu, '$1');
}
