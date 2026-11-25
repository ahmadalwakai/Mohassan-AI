// The caller supplies matching text, so these patterns do not change the query sent to search.
const QUESTION_OPENING = /^(?:(?:(?:في|الي|علي|عن|من|مع|لدي|حسب|تحت|داخل|خارج)\s+)?(?:ما|ماذا|كم|كيف|متي|اين|وين|من|مين|هل|اي|ايه|وش|شو|شنو|ايش|ايهما|ماهو|ماهي|بكم|بماذا|مم|مما|لمن|لاي|باي)|(?:لماذا|ليش|ليه))(?=\s+\S)|^(?:(?:(?:in|on|at|by|to|from|for|with|under|about)\s+)?(?:what|who|whom|whose|when|where|why|how|which)|is|are|does|do|can|will)\b(?=['’]|\s+\S)/iu;
const ENGLISH_AUXILIARY_QUESTION = /^(?:am|was|were|did|has|have|had|could|would|should|may|might|must)\s+\S[^?]*\?$/iu;
const LEADING_ADJUNCT = /^(?:in|on|at|during|after|before|between|among|under|في|خلال|قبل|بعد|بين|تحت)\s+[^,،:：?!؟.]{1,100}[,،]\s+/iu;
const STATEMENT_QUESTION = /^(?:[^?؟!.:：]{4,160}\b(?:is|are|was|were|did|does)\b[^?؟!.:：]{0,100}\s+(?:who|where|when|what|(?:what|which)\s+[a-z-]+(?:\s+[a-z-]+){0,2})|[^?؟!.:：]{5,160}\s+[بفل]?اي\s+\p{Script=Arabic}+(?:\s+\p{Script=Arabic}+){0,3})\s*[?؟]$/iu;

const QUOTED_TITLE = /((?<![\p{L}\p{N}])(?:book|novel|poem|film|movie|play|show|series|album|song|program(?:me)?|(?:ال)?(?:كتاب|روايه|قصيده|فيلم|مسرحيه|مسلسل|البوم|اغنيه|برنامج))\s+)(?:«[^»\r\n]+»|“[^”\r\n]+”|"[^"\r\n]+")/giu;
const ARABIC_RELATIVE_CLAUSE = /(?<=[\p{L}"»”)](?:\s|،\s))(?:و?)(?:الذي|التي|الذين|اللذين|اللتين|اللذان|اللتان|اللواتي|اللاتي)\s+[^؟?!،,؛;]+/gu;
const ARABIC_RESUMPTIVE = /(?<![\p{L}\p{N}])(?:فيه|فيها|له|لها|نفسه|نفسها)(?![\p{L}\p{N}])/gu;
const ENGLISH_RELATIVE = /\b((?:the|an?)\s+(?!one\b)(?:[a-z][a-z’-]*\s+){0,4}[a-z][a-z’-]*)\s+that\b(?=\s+(?:(?:is|are|was|were|has|have|had|will|can|could|would|did|does|built|chose|found|grew|held|led|made|ran|sang|sold|took|won|wrote|[a-z]{2,}ed|[a-z]{2,}s|i|you|he|she|they|we)\b|[a-z]+\s+(?:the\b|an?\b|\d|can\b|could\b|will\b|would\b)))/giu;
const ENGLISH_LOCAL_SUBJECT = /^(how\s+[a-z]+\s+(?:was|were|is|are)\s+)((?:the|an?)\s+[^?;,]{1,100}?)(\s+(?:when|before|after)\s+)(?:he|she|they|it)\b(?=\s+[a-z])/iu;
const WEATHER_DUMMY_SUBJECT = /^(how\s+(?:cold|hot|warm|humid|windy|wet|dry)\s+(?:does|did|can|will)\s+)it(?=\s+get\s+(?:[^?;,]+?\s+)?(?:in|on|at|near)\s+\p{L})/iu;
const ARABIC_FOCUSED_COPULA = /^(اي\s+[^؟?!،,؛;]{2,100}?)\s+(?:هو|هي)\s+(?=ال\p{L})/u;
const DATE_ARGUMENT = /((?:\b(?:in|on|since|during|before|after)|(?<!\p{L})(?:في|من|عام|لعام|العام|سنه|لسنه|موسم|بتاريخ))\s+)(?:\d{1,4}(?:[-/]\d{1,4}){1,2}|(?:1[0-9]{3}|20[0-9]{2}))(?![\d/-])/giu;

export function startsFactualQuestion(text: string, allowStatement = true): boolean {
  const clause = text.replace(LEADING_ADJUNCT, '');
  return QUESTION_OPENING.test(text) || QUESTION_OPENING.test(clause) || ENGLISH_AUXILIARY_QUESTION.test(clause)
    || allowStatement && STATEMENT_QUESTION.test(text);
}

/** Keep dates and year ranges in questions from becoming arithmetic operands. */
export function factualNumberText(text: string): string {
  return startsFactualQuestion(text) ? text.replace(DATE_ARGUMENT, '$1date') : text;
}

/** Remove pronouns with a grammatical role inside the current question before checking for references to earlier turns. */
export function questionCoreferenceText(text: string): string {
  if (!startsFactualQuestion(text)) return text;
  return text.replace(QUOTED_TITLE, '$1quoted-title')
    .replace(ARABIC_RELATIVE_CLAUSE, clause => clause.replace(ARABIC_RESUMPTIVE, ''))
    .replace(ARABIC_FOCUSED_COPULA, '$1 ')
    .replace(ENGLISH_RELATIVE, '$1')
    .replace(ENGLISH_LOCAL_SUBJECT, '$1$2$3')
    .replace(WEATHER_DUMMY_SUBJECT, '$1')
    .replace(/^(how\s+(?:many|much)\s+[^?]+?\s+(?:are|is|were|was))\s+there(?=\s+(?:in|on|among|at)\s+\p{L})/iu, '$1')
    .replace(/^(how\s+(?:long|much)\s+(?:does|did|will|would)\s+)it(?=\s+(?:take|cost)\s+to\s+\p{L}+\s+\p{L})/iu, '$1');
}
