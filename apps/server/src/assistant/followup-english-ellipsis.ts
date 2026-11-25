import type { QuestionHistory } from './question-rewriter.js';

const QUESTION_LEAD = /^(?:who|whom|whose|what|which|when|where|why|how|is|are|was|were|do|does|did|can|could|has|have|had|will|would)\b/iu;
const TYPE_GROUPS = [
  'act bill law', 'album record', 'book novel', 'film movie', 'song single track',
  'city town', 'company firm', 'organization organisation', 'station', 'team club',
  'award prize', 'band', 'bridge', 'building', 'campaign', 'church', 'conference',
  'event', 'festival', 'library', 'museum', 'park', 'project', 'school', 'series',
  'tournament', 'tour', 'university',
].map(group => group.split(' '));
const TYPE_REFERENCE = new RegExp(`\\b(the|this|that) (${TYPE_GROUPS.flat().join('|')})\\b`, 'giu');
const AFTER_NOMINAL = /^(?:$|[,.;:]|\s+(?:about|after|and|at|before|by|during|for|from|in|into|of|on|or|since|to|when|where|with|without|is|are|was|were|has|have|had|can|could|do|does|did|will|would|begin|come|end|go|happen|last|make|mention|open|operate|start|take|win)\b)/iu;
const DATE_SUFFIX = /(?:\s*[:–—-]\s*|\s+(?:of|in)\s+)\d{4}(?:\s*[-–—]\s*\d{2,4})?$/u;
const DATE_QUALIFIER = /\s+\(\d{4}(?:\s*[-–—]\s*\d{2,4})?\)$/u;
const ARTICLE_QUALIFIER = /\s+\([^()]+\)$/u;
const MEDIA_EPISODE = /\b(?:episode|part) (?:[IVXLCDM]+|\d+)\s*:/iu;
const NAME = /^(?:the\s+)?\p{Lu}[\p{L}\p{M}\p{N}'’.-]*(?:\s+(?:(?:and|of|the|in|on|de|du|van|von)\s+)?[\p{Lu}\p{N}][\p{L}\p{M}\p{N}'’.-]*){0,12}$/u;
const PRECEDING_NOMINAL = /^(?:what|which) (?:is|was) (.+)$/iu;
const PROPERTY_FRAME = /^((?:what|which|how (?:many|much))\s+[^?]{1,160}\b(?:of|in|for)\s+)(.+)$/iu;
const TIME_FRAME = /^((?:what(?: else)? happened|did anything(?: else)? happen)) (in|during|between) (\d{4}(?:\s*[-–—]\s*\d{2,4}| and \d{4})?)$/iu;
const YEAR_FOLLOWUP = /^(in|during) (\d{4})$/iu;
const EVENT_FRAME = /^what (?:is|was) (?:a|an|one|the) (?:\p{L}+ )?(?:event|development) that (?:happened|occurred)\b[^?]{0,100}$/iu;
const QUESTION_FRAME = /^(?:(when|where|how long)\s+)?((?:did|do|does|was|were|is|are|has|have|had|could|would|will)\s+[^?]+)$/iu;

function textField(value: string | undefined, maxLength: number): string {
  const text = (value ?? '').trim();
  return text.length <= maxLength && !/[\p{Cc}\p{Cf}]/u.test(text) ? text.replace(/\s+/gu, ' ') : '';
}

function heading(value: string | undefined): string {
  const text = textField(value, 160);
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s.,:&()'’"“”–—-]*$/u.test(text) ? text : '';
}

function mentions(text: string, name: string): boolean {
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const subject = words(name);
  return Boolean(subject && ` ${words(text)} `.includes(` ${subject} `));
}

function titleHead(title: string): string {
  return title.replace(DATE_QUALIFIER, '').replace(DATE_SUFFIX, '').split(/\s+/u).at(-1)?.toLowerCase() ?? '';
}

function hasName(title: string): boolean {
  return /[\p{L}\p{M}]\s+(?:the\s+)?\p{Lu}/u.test(title) || /\p{Lu}[^\s]*:/u.test(title);
}

type NamedReferent = { title: string; headed: boolean };

function findNamedReferent(kind: string, article: string, section: string, turns: QuestionHistory['turns']): NamedReferent | null {
  const types = TYPE_GROUPS.find(group => group.includes(kind)) ?? [kind];
  const typed = (title: string): NamedReferent | null =>
    hasName(title) && types.includes(titleHead(title)) ? { title, headed: true } : null;
  const recent = turns.slice(-3).reverse();
  for (const turn of recent) {
    const previous = textField(turn.question, 240).replace(/[?!.]+$/u, '');
    const answer = textField(turn.answer, 240).replace(/[.,!?]+$/u, '');
    const subject = PRECEDING_NOMINAL.exec(previous)?.[1];
    if (!answer || !subject) continue;
    const typePrefix = /^(?:(?:it|this|that) (?:is|was) )?(?:an?|the|(?:first|second|third|fourth|fifth|last)) (?:[a-z]+ ){0,3}([a-z]+)(?=$|[,.;]| (?:about|based|by|from|in|that|which|with)\b)/iu.exec(answer)?.[1];
    if (typePrefix && types.includes(typePrefix.toLowerCase())) {
      const sectionCore = section.replace(DATE_QUALIFIER, '').replace(DATE_SUFFIX, '');
      const title = section && mentions(subject, sectionCore) ? section : NAME.test(subject) ? subject : '';
      if (title) return typed(title) ?? { title, headed: false };
    }
    const subjectType = titleHead(subject.replace(/\s+(?:called|named|titled)$/iu, ''));
    if (/^(?:the|this|that)\s+/iu.test(subject) && types.includes(subjectType) && NAME.test(answer)) {
      return typed(answer) ?? { title: answer, headed: false };
    }
  }
  if (types.includes('film') && hasName(section) && MEDIA_EPISODE.test(section)
    && recent.some(turn => types.some(type => mentions(turn.question.slice(0, 240), type)))) return { title: section, headed: false };
  return typed(section) ?? typed(article);
}

function insideQuotation(text: string, position: number): boolean {
  return [...text.matchAll(/["“][^"”]+["”]/gu)]
    .some(match => position > match.index && position < match.index + match[0].length);
}

function replaceNominal(question: string, article: string, section: string, turns: QuestionHistory['turns']): string {
  return question.replace(TYPE_REFERENCE, (phrase: string, _determiner: string, kind: string, position: number) => {
    if (insideQuotation(question, position) || !AFTER_NOMINAL.test(question.slice(position + phrase.length))) return phrase;
    const referent = findNamedReferent(kind.toLowerCase(), article, section, turns);
    if (!referent || mentions(question, referent.title)) return phrase;
    if (/^the /iu.test(referent.title)) return referent.title.replace(/^The\b/u, 'the');
    return referent.headed ? `the ${referent.title}` : `the ${kind.toLowerCase()} ${referent.title}`;
  });
}

function inheritQuestionFrame(question: string, previous: string): string | null {
  if (/^(?:when|where|how long)$/iu.test(question)) {
    const frame = QUESTION_FRAME.exec(previous);
    if (frame && frame[1]?.toLowerCase() !== question.toLowerCase()) {
      return `${question.charAt(0).toUpperCase()}${question.slice(1)} ${frame[2].charAt(0).toLowerCase()}${frame[2].slice(1)}`;
    }
  }
  const target = /^what about (.+)$/iu.exec(question)?.[1];
  const frame = target && NAME.test(target) && PROPERTY_FRAME.exec(previous);
  if (frame && NAME.test(frame[2]) && !mentions(frame[2], target)) return `${frame[1]}${target}`;

  const period = YEAR_FOLLOWUP.exec(question);
  const previousPeriod = period && /\b(in|during) \d{4}$/iu.exec(previous);
  if (period && previousPeriod && QUESTION_LEAD.test(previous) && previousPeriod[1].toLowerCase() === period[1].toLowerCase()) {
    return `${previous.slice(0, previousPeriod.index)}${previousPeriod[1]} ${period[2]}`;
  }
  return null;
}

export function isEnglishYearFollowup(question: string): boolean {
  return YEAR_FOLLOWUP.test(question.trim().replace(/[?]+$/u, ''));
}

/** Restore noun phrases and question frames that have concrete evidence in the supplied context. */
export function rewriteEnglishEllipsis(question: string, history: QuestionHistory): string | null {
  const candidate = question.replace(/[?]+$/u, '').trim();
  if (!candidate || candidate.length > 700 || /[?؟\r\n]|\p{Script=Arabic}/u.test(candidate)) return null;
  const bare = candidate.replace(/^(?:and|but)\s+/iu, '');
  const previous = textField(history.turns.at(-1)?.question, 240).replace(/[?!.]+$/u, '');
  const inherited = inheritQuestionFrame(bare, previous);
  if (inherited) return `${inherited}?`;
  if (!QUESTION_LEAD.test(bare)) return null;

  const article = heading(history.articleTitle).replace(ARTICLE_QUALIFIER, '');
  const section = heading(history.sectionTitle);
  const nominal = replaceNominal(bare, article, section, history.turns);
  if (nominal !== bare) return `${nominal.charAt(0).toUpperCase()}${nominal.slice(1)}?`;
  const retainsArticle = mentions(previous, article) || /\b(?:he|she|it|they|his|her|its|their)\b/iu.test(previous)
    || TIME_FRAME.test(previous) || EVENT_FRAME.test(previous);
  if (!article || !retainsArticle || mentions(bare, article)) return null;
  const event = TIME_FRAME.exec(bare);
  if (event) return `${event[1]} to ${article} ${event[2]} ${event[3]}?`;
  if (EVENT_FRAME.test(bare)) return `${bare} for ${article}?`;
  return null;
}
