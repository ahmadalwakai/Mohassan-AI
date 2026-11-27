// Causal connectors and claim checks adapted from PR #13, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/pull/13/files
export const reasonEffectLink = /(?<!\p{L})(?:و?لذلك|و?لهذا|نتيج[ةه]\s+لذلك|مما\s+(?:يجعل|يؤدي\s+[إا]ل[ىي])|و(?:هو|هي)\s+السبب(?:\s+(?:الرئيسي|[اأ]لاساسي))?(?=\s+ل)|which is why|therefore|as a result(?! of)|thus)(?!\p{L})/iu;

const afterCause = /بسبب|(?:^|\s)(?:و|ف)?لان(?:ه|ها|هم|هما|نا|ك)(?=[\s،.]|$)|(?:^|\s)(?:و|ف)?لان\s+ال|نتيجه\s+(?:ل|عن)|وذلك\s+ل|(?:يعود|تعود|يرجع|ترجع|يعزي|تعزي)\s+(?:(?:ذلك|هذا|السبب)\s+)?الي|(?:^|\s)نسبه\s+(?:الي|ل)|\bbecause\b|\bdue to\b|\bcaused by\b|\bas a result of\b|\bresult(?:s|ing|ed)? from\b|\bowing to\b/u;
const causeNoun = /(?:^|\s)(?:و|ف)?(?:ال)?(?:سبب|اسباب)(?=\s)|\bthe (?:main |primary |chief |real )?(?:reason|cause)s?\b/gu;
const reasonFiller = new Set(['ليه', 'بهذا', 'هذا', 'هذه', 'قبل', 'بعد', 'ان', 'جدا', 'كثيرا', 'دائما', 'تكون', 'يكون', 'كان', 'كانت', 'تبدو', 'يبدو', 'تظهر', 'يظهر', 'لا', 'لم', 'لن', 'ليس', 'ليست',
  'so', 'very', 'always', 'often', 'much', 'reason', 'reasons', 'cause', 'causes', 'caused', 'looks', 'appears', 'not', 'never', 'isnt', 'arent', 'dont', 'doesnt', 'didnt']);
const reasonPredicate = /(?:^|\s)(?:ليس سوي|هو|هي|يتمثل في|تكمن في|يعود الي|تعود الي|is|are|was|were|includes?)(?=\s)|^\s*:/u;
const unstatedReason = /\b(?:discussed|debated|studied|investigated|unknown|unclear|unexplained|a mystery|(?:studying|exploring|investigating) (?:why|the cause))\b|(?:غير (?:معروف|مفهوم|واضح)|موضوع (?:بحث|دراسه|نقاش))/u;
const reasonNegation = /(?<!\p{L})(?:لا|لم|لن|ليس|ليست|not|never|isnt|arent|dont|doesnt|didnt|cannot|cant)(?!\p{L})/u;
// A regional or seasonal cause only answers a question narrowed to that kind of case.
const restrictedCase = /(?:^|\s)(?:في|خلال)\s+(?:فصل|موسم|فصول|الشتاء|الصيف|الربيع|الخريف|المناطق|منطقه|مناطق|غرب|شرق|شمال|جنوب|بعض|هذه|تلك|اغلب|معظم)(?=\s|$)|(?:^|\s)(?:به|بها|فيه|فيها)(?=\s|$)|\b(?:in|during)\s+(?:winter|summer|spring|autumn|(?:the\s+)?(?:tropics|monsoon|north|south|east|west)|some|these|those|this\s+region|that\s+region|parts\s+of|most\s+of)\b|\b(?:within|across|throughout)\s+\S/u;

const stem = (word: string) => /^زرق(?:اء|ه)?$/u.test(word) ? 'زرق' : word.slice(0, 4);
// Arabic clitics may precede a stem. English word starts keep "rainfall" from also matching "fall".
const holds = (word: string, term: string) => /\p{Script=Arabic}/u.test(term) ? word.includes(term)
  : word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^fell\b/u, 'fall').startsWith(term);

export function matchesReasonAnswer(question: string, line: string, questionWords: readonly string[],
  subjectWords: readonly string[], allowImpliedSubject: boolean): boolean {
  const narrowedQuestion = restrictedCase.test(question);
  const negativeQuestion = reasonNegation.test(question);
  const subjects = subjectWords.map(stem);
  const asked = questionWords.filter(word => !subjectWords.includes(word) && !reasonFiller.has(word)).map(stem);
  const wanted = asked.length ? asked : subjects;
  if (!wanted.length) return false;

  const positions = (words: readonly string[], terms: readonly string[]) => words.flatMap((word, index) =>
    terms.some(term => holds(word, term)) ? [index] : []);
  const matchesEffect = (part: string) => {
    if (reasonNegation.test(part) !== negativeQuestion || unstatedReason.test(part)) return false;
    const words = part.trim().split(/\s+/u);
    const effectAt = positions(words, wanted);
    if (!effectAt.length) return false;
    if (!asked.length || !subjects.length) return true;
    const subjectAt = positions(words, subjects);
    if (subjectAt.length) return effectAt.some(i => subjectAt.some(j => Math.abs(i - j) <= 3));
    return allowImpliedSubject && (effectAt.some(index => index < 2) || positions(line.split(/\s+/u), subjects).length > 0);
  };

  const link = reasonEffectLink.exec(line);
  if (link) {
    const cause = line.slice(0, link.index).trim();
    const effect = line.slice(link.index + link[0].length);
    if (cause.split(/\s+/u).length >= 3 && !/[.;؛]$/u.test(cause) && !unstatedReason.test(cause)
      && (narrowedQuestion || !restrictedCase.test(line)) && matchesEffect(effect)) return true;
  }
  for (const clause of line.split(/[،,؛;]|\.(?!\d)/u)) {
    const cause = afterCause.exec(clause);
    if (cause) {
      const effect = clause.slice(0, cause.index);
      const explanation = clause.slice(cause.index + cause[0].length);
      if ((narrowedQuestion || !restrictedCase.test(effect)) && /\p{L}{2}/u.test(explanation)
        && !unstatedReason.test(explanation) && matchesEffect(effect)) return true;
    }
    for (const noun of clause.matchAll(causeNoun)) {
      const words = clause.slice(noun.index + noun[0].length).trim().split(/\s+/u);
      const topicAt = words.slice(0, 6).findLastIndex(word => [...subjects, ...asked].some(term => holds(word, term)));
      const effect = words.slice(0, topicAt + 1).join(' ');
      const explanation = words.slice(topicAt + 1).join(' ');
      const listsCause = /^\s*و?من (?:اسباب|سبب)\s/u.test(clause);
      if (topicAt >= 0 && explanation && !unstatedReason.test(explanation) && matchesEffect(effect)
        && (listsCause || /:\s*$/u.test(effect) || reasonPredicate.test(explanation))) return true;
    }
  }
  return false;
}
