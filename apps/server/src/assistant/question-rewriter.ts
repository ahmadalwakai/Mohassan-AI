import { rewriteEnglishEllipsis } from './followup-english-ellipsis.js';
import { buildEnglishReferentResolver } from './followup-english-referents.js';
import { maskRequestLiteralData } from './request-constraints.js';

export interface QuestionHistoryTurn {
  question: string;
  answer?: string;
}

export interface QuestionHistory {
  articleTitle?: string;
  sectionTitle?: string;
  /** Oldest first. */
  turns: readonly QuestionHistoryTurn[];
}

const ENGLISH_LEAD = /^(?:(?:and|but)\s+)?(?:who|whom|whose|what|which|when|where|why|how|am|is|are|was|were|do|does|did|can|could|may|might|must|shall|should|will|would|has|have|had)\b/iu;
const ARABIC_LEAD = /^(?:[وف])?(?:ما|ماذا|من|متى|أين|اين|لماذا|كيف|كم|هل|أي|اي|أينما)(?!\p{L})/u;
const ENGLISH_REFERENCE = /\b(?:he|him|his|she|her|hers|it|its|they|them|their|theirs|this|that|these|those)\b/giu;
const POSSESSIVE = /^(?:his|hers|its|their|theirs)$/u;
const PLURAL = /^(?:they|them|their|theirs|these|those)$/u;
const PERSONAL = /^(?:he|him|his|she|her|hers)$/u;
const DEMONSTRATIVE = /^(?:this|that|these|those)$/u;
const MASCULINE = /^(?:he|him|his)$/u;
const APOSTROPHE = /['’]$/u;
const QUESTION_END = /[?؟]+$/u;
const PUNCTUATION_END = /[.!?؟…]+$/u;
const MAX_TURNS = 12;

const NAMED_SPAN = /\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*(?:\s+(?:(?:of|the|de|del|van|von|bin|al)\s+)?\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*)*/gu;
const NON_NAME = /^(?:a|an|the|i|we|you|yes|no|he|she|it|they|some|there|this|that|these|those|his|her|its|their|in|on|at|during|after|before|to|from|for|with|and|but|if|by|when|what|where|which|why|who|whom|whose|how|is|are|was|were|do|does|did|has|have|had|will|would|can|could|may|might|should|must|tell|please)$/iu;
const GENERIC_SECTION = /^(?:background|beginnings|biography|career|early (?:years|life)|history|later (?:years|life)|legacy|overview|personal life|reception|see also|مقدمة|تاريخ|بدايات|نشأة)$/iu;
const NEGATIVE_REPLY = /^(?:cannotanswer|no answer|unknown|i (?:do not|don't) know|غير معروف)$/iu;

function line(text: string | undefined, limit = 700): string {
  return (text ?? '').slice(0, limit).split(/\r?\n/u, 1)[0].trim();
}

function heading(text: string | undefined): string {
  const title = line(text, 160).replace(/\s+\([^()]+\)$/u, '').trim();
  return /[?؟!;:]/u.test(title) ? '' : title;
}

function namedSpans(text: string): string[] {
  return Array.from(text.matchAll(NAMED_SPAN), match => {
    const words = match[0].split(/\s+/u);
    while (words.length && NON_NAME.test(words[0])) words.shift();
    return words.join(' ').replace(/['’]s$/iu, '');
  }).filter(name => name.length > 1 && !NEGATIVE_REPLY.test(name));
}

function shortAnswer(text: string | undefined): string {
  const answer = line(text, 121).replace(PUNCTUATION_END, '');
  return answer.length <= 120 && !NEGATIVE_REPLY.test(answer) && !/[?؟!;:]|\.\s/u.test(answer) ? answer : '';
}

function possessive(entity: string): string {
  if (APOSTROPHE.test(entity) || /['’]s$/iu.test(entity)) return entity;
  return /s$/iu.test(entity) ? `${entity}'` : `${entity}'s`;
}

function containsEntity(text: string, entity: string): boolean {
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return ` ${words(text)} `.includes(` ${words(entity)} `);
}

function withoutEnglishConjunction(question: string): string {
  return question.replace(/^(?:and|but)\s+(.+)/iu, (raw, rest: string) =>
    /^\p{Lu}/u.test(raw) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest);
}

function englishContext(history: QuestionHistory) {
  const article = heading(history.articleTitle);
  const section = heading(history.sectionTitle);
  const specificSection = GENERIC_SECTION.test(section) ? '' : section;
  const turns = history.turns.slice(-MAX_TURNS);
  const previous = line(turns.at(-1)?.question).replace(QUESTION_END, '');
  const answer = shortAnswer(turns.at(-1)?.answer);
  const questionNames = namedSpans(previous);
  const answerNames = namedSpans(line(turns.at(-1)?.answer));
  const olderNames = turns.slice(0, -1).reverse().flatMap(turn => [
    ...namedSpans(line(turn.question)), ...namedSpans(line(turn.answer)),
  ]);
  const names = [...new Set([article, ...questionNames, ...answerNames, specificSection, ...olderNames].filter(Boolean))];
  return { article, specificSection, previous, answer, questionNames, answerNames, names };
}

type EnglishContext = ReturnType<typeof englishContext>;

function englishEntity(reference: string, context: EnglishContext, question: string): string {
  const { article, specificSection, previous, answer, questionNames, answerNames, names } = context;
  if (PERSONAL.test(reference)) {
    // An article gives the ongoing subject. An explicit focus change can name a different person.
    const alternative = questionNames[0];
    const focusChange = /^(?:who (?:is|was|are|were)\b|(?:tell me|more)\s+about\b)/iu.test(previous);
    if (focusChange && alternative && !containsEntity(question, alternative)) return alternative;
    return article || alternative || answerNames[0] || names[0] || '';
  }
  if (PLURAL.test(reference)) {
    const coordinate = questionNames.at(-2) && questionNames.at(-1) && `${questionNames.at(-2)} and ${questionNames.at(-1)}`;
    const group = /\b(?:the|some|several|both|two|three)\s+(?:[a-z]+\s+)?(?:[a-z]+s|people|children|men|women)\b/iu.exec(previous)?.[0];
    return (coordinate && previous.includes(coordinate) ? coordinate : '') || article || group || questionNames[0] || answerNames[0] || names[0] || '';
  }
  if (DEMONSTRATIVE.test(reference)) {
    return specificSection || (answer && /^(?:the|a|an)\s/iu.test(answer) ? answer : '') || answerNames[0] || questionNames[0] || article || names[0] || '';
  }
  const answerIntroducesEntity = /^(?:what|which)\s+(?:(?:was|is)\s+the\s+name|(?:book|film|song|company|project|team|place|building|venue)\b)/iu.test(previous);
  if (answerIntroducesEntity && answerNames.length === 1) return answerNames[0];
  return questionNames[0] || specificSection || article || answerNames[0] || names[0] || '';
}

function resolveEnglishReferences(question: string, context: EnglishContext, focus?: ReturnType<typeof buildEnglishReferentResolver>): string {
  const quotations = Array.from(question.matchAll(/["“][^"”]+["”]/gu));
  const outer = focus ? maskRequestLiteralData(question) : question;
  const introduced = new Set<string>();
  return question.replace(ENGLISH_REFERENCE, (raw: string, position: number) => {
    if (outer.slice(position, position + raw.length) !== raw
      || quotations.some(match => position > match.index && position < match.index + match[0].length)) return raw;
    const reference = raw.toLowerCase();
    const before = question.slice(0, position);
    const after = question.slice(position + raw.length);
    const focused = focus?.(reference, before, after);
    if (focused === '') return raw;
    // Relative clauses, complementizers and demonstrative determiners have a stated referent.
    if (reference === 'that' && (/^['’]s\b/iu.test(after)
      || /\b(?:say|said|think|thought|know|knew|believe|believed|mean|meant|show|showed|ensure)\s+$/iu.test(before))) return raw;
    if (!focused && DEMONSTRATIVE.test(reference) && /^\s+\p{L}/u.test(after)
      && !/^\s+(?:is|are|was|were|do|does|did|mean|happen(?:ed)?|cause[d]?|start(?:ed)?|end(?:ed)?|affect(?:ed)?|change[d]?|lead|led|help(?:ed)?)\b/iu.test(after)) return raw;
    if (reference === 'it' && (/^\s+(?:raining|snowing|safe|possible|necessary|true|likely|important)\b/iu.test(after)
      || /\b(?:is|was|would)\s+$/iu.test(before) && /^\s+\p{L}+\s+(?:to|that)\b/iu.test(after))) return raw;
    const entity = focused ?? englishEntity(reference, context, question);
    if (!entity) return raw;
    const family = DEMONSTRATIVE.test(reference) ? reference
      : MASCULINE.test(reference) ? 'he' : PERSONAL.test(reference) ? 'she' : PLURAL.test(reference) ? 'they' : 'it';
    const antecedent = `${family}:${entity.toLowerCase()}`;
    // Once the referent appears in this question, a later co-reference is already local.
    if (introduced.has(antecedent) || containsEntity(before, entity)) return raw;
    introduced.add(antecedent);
    const herPossessive = reference === 'her' && /^\s+\p{L}/u.test(after)
      && !/^\s+(?:to|with|at|for|in|on|by|and|or|from|as|about|personally)\b/iu.test(after);
    if (POSSESSIVE.test(reference) || herPossessive) return possessive(entity);
    return /^(?:his|her|their|its|a|an|the)\s+/iu.test(entity) && before.trim() ? entity.charAt(0).toLowerCase() + entity.slice(1) : entity;
  });
}

const ENGLISH_AUX = /^(?:(what|which|who|whom|whose|when|where|why|how)(?:\s+(many|much|long|often|old))?\s+)?(am|is|are|was|were|do|does|did|can|could|may|might|must|shall|should|will|would|has|have|had)\s+(.+)$/iu;
const ENGLISH_OBJECT_QUESTION = /^(?:what|which)\s+\p{L}+(?:\s+\p{L}+){0,2}?\s+(do|does|did|can|could|will|would)\s+(.+)$/iu;

function previousEnglishQuestion(context: EnglishContext): string {
  if (!context.previous || !ENGLISH_LEAD.test(context.previous)) return '';
  return resolveEnglishReferences(withoutEnglishConjunction(context.previous), { ...context, questionNames: [] });
}

function englishExplanation(previous: string, answer: string, lead: string): string {
  const objectQuestion = ENGLISH_OBJECT_QUESTION.exec(previous);
  if (objectQuestion && answer) return `${lead} ${objectQuestion[1].toLowerCase()} ${objectQuestion[2]} ${answer}`;
  const frame = ENGLISH_AUX.exec(previous);
  if (frame) {
    const [, wh, modifier, auxiliary, clause] = frame;
    const object = /^(?:what|which|whom)$/iu.test(wh ?? '') && /^(?:did|does|do|can|could|will|would)$/iu.test(auxiliary)
      ? answer : '';
    if (/^(?:what|which|whom)$/iu.test(wh ?? '') && !object) return '';
    if (modifier === 'old' || /^(?:why|how)$/iu.test(wh ?? '') && wh.toLowerCase() === lead.toLowerCase()) return '';
    return `${lead} ${auxiliary.toLowerCase()} ${clause}${object ? ` ${object}` : ''}`;
  }
  const subjectQuestion = /^(?:who|what)\s+(.+)$/iu.exec(previous)?.[1];
  return subjectQuestion && answer ? `${lead} was it that ${answer} ${subjectQuestion}` : '';
}

function englishEllipsis(question: string, context: EnglishContext): string {
  const bare = withoutEnglishConjunction(question);
  const previous = previousEnglishQuestion(context);
  if (!previous) return '';
  const more = /^(what|who|where|when)\s+else$/iu.exec(bare)?.[1];
  if (more && previous.toLowerCase().startsWith(`${more.toLowerCase()} `)) {
    return `${more} else ${previous.slice(more.length + 1)}`;
  }
  const explanation = /^(why|how)(?:\s+so)?$/iu.exec(bare)?.[1];
  if (explanation) return englishExplanation(previous, context.answer, explanation);
  if (/^(?:(?:what\s+(?:happened|came)\s+)?(?:after\s+(?:that|this)|next)|then\s+what)$/iu.test(bare)) {
    const event = /^(?:what happened|what took place)\b/iu.test(previous) && /^(?:the|a|an)\s/iu.test(context.answer)
      ? context.answer : context.specificSection;
    if (event) return `What happened after ${event}`;
    const frame = ENGLISH_AUX.exec(previous);
    if (frame && /^(?:when|where)?$/iu.test(frame[1] ?? '')) {
      const subject = [...context.names].sort((first, second) => second.length - first.length)
        .find(name => frame[4].toLowerCase().startsWith(`${name.toLowerCase()} `));
      if (subject) return `What happened after ${subject} ${frame[3].toLowerCase()} ${frame[4].slice(subject.length + 1)}`;
    }
  }
  return '';
}

const ARABIC_NOMINAL = /(^|[^\p{L}\p{M}])([وف]?)(سكان|مساح[تة]|عاصم[تة]|رئيس|مؤسس|تاريخ|أعضاء|اعضاء|طول|عرض|سعر|عدد|عمر|اسم|لون|موقع|مكان|هدف|سبب|نتيج[تة]|بداي[تة]|نهاي[تة]|مد[تة]|تكلف[تة])(?:هما|هم|هن|ها|ه)(?![\p{L}\p{M}])/gu;
const ARABIC_ATTACHED = /(^|[^\p{L}\p{M}])([وف]?)(في|عن|من|مع|إلي|الي|علي|ب|ل)(?:هما|هم|هن|ها|ه)(?![\p{L}\p{M}])/gu;
const ARABIC_OBJECT = /(^|[^\p{L}\p{M}])([وف]?)(أسس|اسس|بنى|بنا|زار|افتتح|اخترع|اكتشف|صمم|ألف|الف|كتب|أخرج|اخرج|شاهد|رسم)(?:هما|هم|هن|ها|ه)(?![\p{L}\p{M}])/gu;
const ARABIC_SUBJECT = /^(?:[وف])?(?:أين|اين|متى|هل|من|كيف)\s+(?:تقع|يقع|توجد|يوجد|تأسست|تأسس|تاسست|تاسس|افتتحت|افتتح|ظهرت|ظهر|أسس|اسس|زار|زارت|بدأ|بدأت|بدا|بدات|بنى|بنت|نجح|نجحت)\s+(.+)$/u;
const ARABIC_QUESTION_FOCUS = /^(?:[وف])?(?:ما|ماذا|كم|أين|اين)\s+(?:(?:هو|هي|عدد|تاريخ|سعر|سكان|مساحة|عاصمة|موقع|اسم|طول|عمر|سبب)\s+)+(.+)$/u;
const ARABIC_SIMPLE_SUBJECT = /^(?:[وف])?(?:أين|اين)\s+(ال.+)$/u;
const ARABIC_EVENT = /^(?:[وف])?(?:متى|أين|اين|كيف|لماذا)\s+(?:توفي|توفيت|ولد|ولدت|تزوج|تزوجت|سافر|سافرت|تأسس|تأسست|تاسس|تاسست|افتتح|افتتحت|انتهى|انتهت|بدأ|بدأت|بدا|بدات|ظهر|ظهرت|نجح|نجحت)$/u;

function arabicContext(history: QuestionHistory) {
  const turns = history.turns.slice(-MAX_TURNS);
  const previous = line(turns.at(-1)?.question).replace(QUESTION_END, '');
  const answer = shortAnswer(turns.at(-1)?.answer);
  const section = heading(history.sectionTitle);
  const answerEntity = /^(?:ما|من|أي|اي)\s+/u.test(previous)
    && /^[\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+){0,4}$/u.test(answer)
    && !/^(?:نعم|لا|ليس|كان|كانت|هو|هي|تم|منذ)(?:\s|$)/u.test(answer) ? answer : '';
  const topic = turns.slice().reverse().map(turn => {
    const question = line(turn.question).replace(QUESTION_END, '');
    const subject = ARABIC_SUBJECT.exec(question)?.[1] || ARABIC_QUESTION_FOCUS.exec(question)?.[1] || ARABIC_SIMPLE_SUBJECT.exec(question)?.[1] || '';
    return subject.length <= 100 && !/[?؟:!]|^(?:ذلك|هذا|هذه|هو|هي|هم)$/u.test(subject) ? subject : '';
  }).find(Boolean);
  return { previous, answer, entity: answerEntity || topic || heading(history.articleTitle) || (!GENERIC_SECTION.test(section) ? section : '') };
}

function resolveArabicReferences(question: string, entity: string): string {
  if (!entity) return question;
  return question
    .replace(ARABIC_NOMINAL, (_raw, boundary: string, conjunction: string, stem: string) => `${boundary}${conjunction}${stem.replace(/ت$/u, 'ة')} ${entity}`)
    .replace(ARABIC_OBJECT, (_raw, boundary: string, conjunction: string, stem: string) => `${boundary}${conjunction}${stem.replace(/^بنا$/u, 'بنى')} ${entity}`)
    .replace(ARABIC_ATTACHED, (_raw, boundary: string, conjunction: string, stem: string) => {
      if (stem === 'ب' || stem === 'ل') {
        const target = stem === 'ل' ? entity.replace(/^ال/u, 'ل') : entity;
        return `${boundary}${conjunction}${stem}${target}`;
      }
      const preposition = stem.replace(/ي$/u, 'ى');
      return `${boundary}${conjunction}${stem === 'في' ? stem : preposition} ${entity}`;
    })
    .replace(/(^|[^\p{L}\p{M}])(?:هو|هي|هم|هما|هن)(?=\s+\p{L})/gu, (raw, boundary: string, position: number) => {
      return /^(?:[وف])?(?:ما|من)\s*$/u.test(question.slice(0, position + boundary.length)) ? raw : `${boundary}${entity}`;
    })
    .replace(/(^|[^\p{L}\p{M}])(?:هذا|هذه|ذلك|تلك|هؤلاء|أولئك)$/u, (_raw, boundary: string) => `${boundary}${entity}`)
    .replace(ARABIC_EVENT, match => `${match} ${entity}`);
}

function arabicEllipsis(question: string, previous: string, answer: string): string {
  if (/^(?:[وف])?ماذا\s+(?:أيض[ًاا]+|غير ذلك)$/u.test(question) && /^(?:[وف])?ماذا\s+/u.test(previous)) {
    return `ماذا ${previous.replace(/^(?:[وف])?ماذا\s+/u, '')} أيضًا`;
  }
  if (/^(?:[وف])?ماذا\s+بعد\s+(?:ذلك|هذا)$/u.test(question) && answer) return `ماذا حدث بعد ${answer}`;
  const explanation = /^(?:[وف])?(لماذا|كيف)$/u.exec(question)?.[1];
  const clause = /^(?:[وف])?(?:متى|أين|اين|هل)\s+(.+)$/u.exec(previous)?.[1];
  return explanation && clause ? `${explanation} ${clause}` : '';
}

/** Apply deterministic edits to a single question using the preceding question and answer turns. */
export function rewriteFollowUpQuestion(question: string, history: QuestionHistory, useV2 = process.env.MOHASSAN_FOLLOWUP_V2 === '1'): string {
  const original = question.trim();
  const candidate = original.replace(QUESTION_END, '');
  if (!candidate || candidate.length > 700 || /[?؟\r\n]/u.test(candidate)) return original;

  if (ARABIC_LEAD.test(candidate) || /^(?:[وف])?بعد\s+(?:ذلك|هذا)$/u.test(candidate)) {
    const { previous, answer, entity } = arabicContext(history);
    const bare = candidate.replace(/^(?:[وف])?بعد\s+(?:ذلك|هذا)$/u, 'ماذا بعد ذلك');
    const revised = arabicEllipsis(bare, resolveArabicReferences(previous, entity), answer) || resolveArabicReferences(candidate, entity);
    return revised !== candidate ? `${revised.replace(/^[وف](?=متى|أين|اين|كيف|لماذا|كم|ماذا|ما\s|هل|من\s)/u, '')}؟` : original;
  }
  const englishV2 = useV2 && !/\p{Script=Arabic}/u.test(candidate);
  const expanded = englishV2 ? rewriteEnglishEllipsis(candidate, history) : null;
  if (!expanded && !ENGLISH_LEAD.test(candidate) && !/^(?:(?:and|but)\s+)?(?:after\s+(?:that|this)|next|then\s+what)$/iu.test(candidate)) return original;
  const context = englishContext(history);
  const target = expanded?.replace(QUESTION_END, '') ?? candidate;
  const focus = englishV2 ? buildEnglishReferentResolver(target, history) : undefined;
  const revised = (!expanded && englishEllipsis(candidate, context)) || resolveEnglishReferences(target, context, focus);
  if (revised === candidate) return original;
  return `${withoutEnglishConjunction(revised)}?`;
}
