import { englishStem } from '../../../../packages/skills/src/stems.js';
import type { QuestionHistory } from './question-rewriter.js';

const name = String.raw`(?:[Tt]he\s+)?\p{Lu}[\p{L}\p{M}'’.-]*(?:(?:\s+(?:of|the|de|van|von))?\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,5}`;
// The existing conversation entity extractor uses these roles to recognize named people.
const namedSubject = new RegExp(String.raw`^(?:([Aa]ctor|[Aa]ctress|[Dd]ancer|[Dd]rummer|[Gg]uitarist|[Bb]assist|[Jj]ournalist|[Mm]usician|[Pp]hysicist|[Ss]cientist|[Vv]ocalist|[Ww]riter)\s+)?(${name})\s+(?=[a-z])`, 'u');
const coordinatedNames = new RegExp(String.raw`${name}(?:(?:,\s*(?:and\s+)?|\s+and\s+)${name})+`, 'gu');
const namedGroup = new RegExp(String.raw`\bthe\s+${name}(?=[.!?,;]|\s+(?:in|at|from|during)\b|$)`, 'gu');
const possessiveRole = /^(his|her)\s+(father|mother|son|daughter|brother|sister|husband|wife|partner|friend|colleague)\s+(?=[a-z])/iu;
const nonSubject = /^(?:A|An|As|Before|By|During|He|Her|His|I|In|It|No|On|She|Since|That|The|They|This|We|When|Yes|You)$/iu;
const eventQuestion = /^what (?:happened|took place)\b/iu;
const identityQuestion = /^(?:who (?:is|was)|what (?:is|was)|which (?:one|person))\s+(.+)$/iu;
const topicType = /\b(?:album|book|city|club|company|film|game|group|novel|organization|project|record|series|show|song|team|work)\b/iu;

function cleanLine(text = ''): string {
  return text.slice(0, 700).split(/\r?\n/u, 1)[0].trim();
}

function key(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function includesWords(text: string, phrase: string): boolean {
  return !!phrase && ` ${key(text)} `.includes(` ${key(phrase)} `);
}

function isArticleAlias(name: string, article: string): boolean {
  return !!article && (key(name) === key(article) || !key(name).includes(' ') && includesWords(article, name));
}

function articleName(title: string | undefined): string {
  return cleanLine(title).replace(/\s+\([^()]+\)$/u, '').trim();
}

function namedTopic(heading: string | undefined): string {
  const label = articleName(heading);
  return label.length <= 160 && /^\p{Lu}/u.test(label) && !/[?؟!;<>]/u.test(label) ? label : '';
}

function answerClauses(answer: string): string[] {
  return answer.split(/(?<!\b\p{Lu})\.\s+|[!?]\s+|;\s+/u)
    .map(clause => clause.trim().replace(/^(?:[A-Z][\p{L}]+\s+\d[\d ,]*|(?:In|On|Since|By)\s+[^,]{1,45}),\s*/u, ''));
}

function firstPredicate(clause: string): string {
  return /^(?:(?:also|ever|first|then|had|has|have|was|were|is|are|be|been)\s+)*([a-z]+)\b/iu.exec(clause.trim())?.[1]?.toLowerCase() ?? '';
}

function samePredicate(left: string, right: string): boolean {
  if (left.length < 3 || right.length < 3) return false;
  return englishStem(left) === englishStem(right) || `${left}d` === right || `${right}d` === left;
}

function possessive(text: string): string {
  return /s$/iu.test(text) ? `${text}'` : `${text}'s`;
}

interface Actor {
  label: string;
  predicate: string;
  typed: boolean;
  pronoun?: 'he' | 'she';
}

function actorInClause(clause: string, article: string, previous: string): Actor | undefined {
  const role = possessiveRole.exec(clause);
  if (role && article && (role[1].toLowerCase() === 'his' ? /\b(?:he|his)\b/iu : /\b(?:she|her)\b/iu).test(previous)) {
    const pronoun = /^(?:father|son|brother|husband)$/iu.test(role[2]) ? 'he'
      : /^(?:mother|daughter|sister|wife)$/iu.test(role[2]) ? 'she' : undefined;
    return { label: `${possessive(article)} ${role[2].toLowerCase()}`,
      predicate: firstPredicate(clause.slice(role[0].length)), typed: true, pronoun };
  }
  const subject = namedSubject.exec(clause);
  if (subject && !nonSubject.test(subject[2]) && !isArticleAlias(subject[2], article)) {
    const pronoun = /^actress$/iu.test(subject[1] ?? '') ? 'she' : undefined;
    return { label: subject[2], predicate: firstPredicate(clause.slice(subject[0].length)), typed: Boolean(subject[1]), pronoun };
  }
  return undefined;
}

function namedObject(history: QuestionHistory, section: string, article: string): string | undefined {
  if (!section || key(section) === key(article)) return undefined;
  const recent = history.turns.slice(-4);
  // A heading alone may be a theme. Require an actual mention and evidence that
  // the dialogue treats it as an object rather than just a section heading.
  const introduced = recent.some(turn => includesWords(cleanLine(turn.question), section)
    && topicType.test(cleanLine(turn.answer)));
  const current = cleanLine(recent.at(-1)?.question);
  return introduced && (topicType.test(current) || includesWords(current, section)) ? section : undefined;
}

function groupAfterPreposition(answer: string, before: string, hasSingularActor: boolean): string | undefined {
  const preposition = /\b(with|for|against|among|between|by|from|to|of)\s*$/iu.exec(before)?.[1];
  if (!preposition) return undefined;
  const operand = Array.from(answer.matchAll(new RegExp(String.raw`\b${preposition}\s+([^;!?\n]+)`, 'giu'))).at(-1)?.[1];
  return operand?.match(coordinatedNames)?.[0].replace(/[.]+$/u, '')
    || (hasSingularActor ? operand?.match(namedGroup)?.map(group => group.replace(/[.]+$/u, '')).find(group => /s$/iu.test(group)) : undefined);
}

function confirmedPair(history: QuestionHistory, article: string, previous: string, answer: string): string | undefined {
  if (!article || !/\b(?:they|the two|both)\b/iu.test(answer)
    || !/\b(?:together|relationship|couple|married|each other)\b/iu.test(previous)) return undefined;
  const other = history.turns.slice(-3, -1).reverse().map(turn => {
    const asked = /^who (?:is|was)\s+(.+?)[?]?$/iu.exec(cleanLine(turn.question))?.[1];
    if (!asked) return '';
    const section = namedTopic(history.sectionTitle);
    return includesWords(section, asked) ? section : new RegExp(`^${name}$`, 'u').test(asked) ? asked : '';
  }).find(label => label && !isArticleAlias(label, article));
  return other ? `${article} and ${other}` : undefined;
}

type Reference = (pronoun: string, before: string, after: string) => string | undefined;
const masculine = /^(?:he|him|his)$/u;
const feminine = /^(?:she|her|hers)$/u;
const plural = /^(?:they|them|their|theirs)$/u;
const neutral = /^(?:it|its)$/u;
const inferredCleft = /^(?:what|who|where|when|why|how)\s+(?:was|is|were|are)\s*$/iu;
const cleftRest = /^\s+(?:(?:about|in)\b[^?]{0,100}\s+)?that\s+\p{L}/iu;
const effectPredicate = /^\s+(?:affect|anger|annoy|confuse|disturb|frighten|help|influence|surprise|upset)\s+\p{L}/iu;

/** Undefined keeps the legacy decision. An empty result preserves the original word. */
export function buildEnglishReferentResolver(question: string, history: QuestionHistory): Reference {
  const last = history.turns.at(-1);
  const previous = cleanLine(last?.question).replace(/[?]+$/u, '');
  const answer = cleanLine(last?.answer);
  const article = articleName(history.articleTitle);
  const section = namedTopic(history.sectionTitle);
  const actors = answerClauses(answer)
    .map(clause => actorInClause(clause, article, previous)).filter(actor => actor !== undefined);
  const object = namedObject(history, section, article);
  const identity = identityQuestion.exec(previous)?.[1];
  const group = answer.match(coordinatedNames)?.[0]?.replace(/[.]+$/u, '');
  const pair = confirmedPair(history, article, previous, answer);
  const hasSingularActor = /\b(?:he|she)\b/iu.test(question);
  const sectionOwner = /^([\p{Lu}][\p{L}\p{M}-]*)['’]s\s/u.exec(section)?.[1];
  const active = new Map<string, string>();

  return (pronoun, before, after) => {
    if (pronoun === 'it' && inferredCleft.test(before.trim()) && cleftRest.test(after)) return '';
    if (plural.test(pronoun)) {
      if (active.has('plural')) return active.get('plural');
      const next = groupAfterPreposition(answer, before, hasSingularActor)
        || (/\btogether\b/iu.test(question) || /\b(?:who|which \p{L}+)\b[^?]*\b(?:both|together)\b/iu.test(previous) ? group : undefined)
        || pair;
      if (next) active.set('plural', next);
      return next;
    }
    if (neutral.test(pronoun)) return object;
    if (/^(?:this|that)$/u.test(pronoun) && identity && includesWords(identity, article)
      && /\b(?:do|does|did|can|could|will|would)\s*$/iu.test(before)
      && effectPredicate.test(after)) return article;

    const family = masculine.test(pronoun) ? 'he' : feminine.test(pronoun) ? 'she' : null;
    if (!family) return undefined;
    if (active.has(family)) return active.get(family);
    const predicate = firstPredicate(after);
    const previousPredicate = new RegExp(String.raw`\b${family}\s+([^?]+)`, 'iu').exec(previous)?.[1];
    const suitable = actors.filter(actor => (!actor.pronoun || actor.pronoun === family)
      && (!article || actor.typed || includesWords(section, actor.label)
        || sectionOwner && includesWords(actor.label, sectionOwner)));
    const matching = suitable.filter(actor => samePredicate(predicate, actor.predicate)
      || previousPredicate && (actor.typed || includesWords(section, actor.label))
        && samePredicate(predicate, firstPredicate(previousPredicate)));
    const selected = matching.length === 1 ? matching[0]
      : eventQuestion.test(previous) && suitable.length === 1 && suitable[0].typed && pronoun === family ? suitable[0] : undefined;
    if (selected) active.set(family, selected.label);
    return selected?.label;
  };
}
