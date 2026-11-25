import { operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';
import { translateDuration } from './word-problem-rates.js';

const activities = {
  make: 'make makes made', produce: 'produce produces produced', build: 'build builds built',
  pack: 'pack packs packed', fill: 'fill fills filled', print: 'print prints printed',
  prepare: 'prepare prepares prepared', process: 'process processes processed',
  use: 'use uses used', consume: 'consume consumes consumed', assemble: 'assemble assembles assembled',
  receive: 'receive receives received', deliver: 'deliver delivers delivered',
  collect: 'collect collects collected', read: 'read reads', pick: 'pick picks picked',
  harvest: 'harvest harvests harvested', complete: 'complete completes completed',
} as const;

const activityByWord = new Map(Object.entries(activities)
  .flatMap(([activity, words]) => words.split(' ').map(word => [word, activity] as const)));
const activity = [...activityByWord.keys()].join('|');
const amount = `(?:${numberSource})`;
const noun = String.raw`[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,3}?`;
const period = String.raw`(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|shifts?|sessions?|rounds?|trips?|loads?|cycles?)`;
const connector = String.raw`(?:per|each|every|an?)`;
const pattern = (source: string) => new RegExp(`^${source}$`, 'iu');

const supply = pattern(String.raw`(?<subject>${noun}) (?:can )?(?<activity>${activity}) (?<count>${amount}) (?<item>${noun}) ${connector} (?:(?<span>${amount}) )?(?<period>${period})`);
const contents = pattern(String.raw`(?:each|every|an?) (?<group>${noun}) (?<activity>has|holds|contains|includes|carries|is made of|${activity}) (?<count>${amount}) (?<item>${noun})`);
const ownedGroup = pattern(String.raw`(?:(?<subject>${noun}) (?:has|had|owns)|there (?:are|were)) (?<count>${amount}) (?<item>${noun})`);
const duration = String.raw`(?: in| over| for| during| after) (?<span>${amount}) (?<period>${period})`;
const addTogether = String.raw`(?: in total| altogether| combined| together)?`;
const questions = [
  pattern(String.raw`how many (?<item>${noun}) (?:does|do|did|will|would|can|could) (?<subject>${noun}) (?<activity>${activity})${addTogether}(?:${duration})?${addTogether}`),
  pattern(String.raw`how many (?<item>${noun}) (?:are|will be|can be) (?<activity>${activity})(?: by (?<subject>${noun}))?${addTogether}(?:${duration})?${addTogether}`),
];
const workSpan = pattern(String.raw`(?:if )?(?<subject>${noun}) (?:works?|runs?|operates?|continues?|does this|do this) (?:for )?(?<span>${amount}) (?<period>${period})`);
const pronoun = /^(?:he|she|they|it)$/iu;
const genericBridge = /^(?:has|holds|contains|includes|carries|is made of)$/iu;
const unsafeUnit = /\b(?:and|or|per|each|every|for|from|than|with|less|more|left|remaining|total|does|do|must|will|would)\b/iu;
const shortPeriod = /^(?:second|minute|hour)$/u;

interface RateLink {
  input: string;
  output: string;
  count: WordExpression;
  activity: string | undefined;
}

type Match = Record<string, string | undefined>;

function actor(value: string): string {
  return value.trim().toLowerCase().replace(/^(?:the|a|an|all(?: the)?) /u, '');
}

function sameActor(asked: string, given: string): boolean {
  return pronoun.test(asked) || actor(asked) === actor(given);
}

function unit(value: string): string | null {
  return unsafeUnit.test(value) ? null : unitKey(value);
}

function value(text: string): WordExpression | null {
  const number = parseNumber(text);
  return number === null || number.startsWith('-') ? null : quantity(number);
}

function activityKey(word: string): string | undefined {
  return activityByWord.get(word.toLowerCase());
}

function readLink(match: Match): RateLink | null {
  const input = unit(match.group!);
  const output = unit(match.item!);
  const count = value(match.count!);
  if (!input || !output || input === output || !count) return null;
  return { input, output, count, activity: genericBridge.test(match.activity!) ? undefined : activityKey(match.activity!) };
}

function followChain(links: readonly RateLink[], initial: string, requested: string, activity: string) {
  const path: RateLink[] = [];
  let current = initial;
  while (current !== requested && path.length < links.length) {
    const candidates = links.filter(link => link.input === current && !path.includes(link));
    if (candidates.length !== 1) return null;
    const next = candidates[0]!;
    if (next.activity && next.activity !== activity) return null;
    path.push(next);
    current = next.output;
  }
  return current === requested && path.length === links.length ? path : null;
}

export function parseRepeatedRates(statements: readonly string[], question: string): WordExpression | null {
  const request = questions.map(rule => rule.exec(question)?.groups).find(Boolean);
  if (!request || statements.length < 2 || statements.length > 5) return null;
  const requested = unit(request.item!);
  const requestedActivity = activityKey(request.activity!);
  if (!requested || !requestedActivity) return null;

  let rate: Match | undefined;
  let group: Match | undefined;
  let span: Match | undefined;
  const links: RateLink[] = [];
  for (const statement of statements) {
    const rateFact = supply.exec(statement)?.groups;
    const work = workSpan.exec(statement)?.groups;
    const stock = ownedGroup.exec(statement)?.groups;
    const content = contents.exec(statement)?.groups;
    if (rateFact && !rate) rate = rateFact;
    else if (work && !span) span = work;
    else if (stock && !group) group = stock;
    else if (content) {
      const link = readLink(content);
      if (!link) return null;
      links.push(link);
    } else return null;
  }
  if (!rate || !request.span && !span || request.span && span) return null;
  if (span && !sameActor(span.subject!, rate.subject!)) return null;
  const count = value(rate.count!);
  const initial = unit(rate.item!);
  const baseActivity = activityKey(rate.activity!);
  const ratePeriod = unitKey(rate.period!);
  const queryPeriod = unitKey((request.period ?? span?.period)!);
  const requestedSpan = value((request.span ?? span?.span)!);
  if (!count || !initial || !requestedSpan) return null;
  // Day-sized units could imply a work schedule. Convert only hours and shorter durations.
  const elapsed = queryPeriod === ratePeriod ? requestedSpan
    : shortPeriod.test(queryPeriod) && shortPeriod.test(ratePeriod) ? translateDuration(requestedSpan, queryPeriod, ratePeriod) : null;
  if (!elapsed) return null;

  const groupName = /^each /iu.test(rate.subject!) ? unit(rate.subject!.slice(5)) : null;
  const actors = group ? value(group.count!) : null;
  if (group) {
    if (!actors || !groupName || groupName !== unit(group.item!)) return null;
    if (request.subject && !(unit(request.subject) === groupName
      || group.subject && sameActor(request.subject, group.subject) || pronoun.test(request.subject))) return null;
  } else if (groupName || request.subject && !sameActor(request.subject, rate.subject!)) return null;

  const chain = followChain(links, initial, requested, requestedActivity);
  if (!chain || !chain.length && !actors) return null;
  const last = chain.at(-1);
  if (!last?.activity && baseActivity !== requestedActivity) return null;

  const baseSpan = rate.span ? value(rate.span) : null;
  if (rate.span && !baseSpan) return null;
  const perPeriod = baseSpan ? operation('/', count, baseSpan, 'Find the amount per period') : count;
  const amountInSpan = operation('*', perPeriod, elapsed, 'Multiply by the number of periods');
  const amountForGroup = actors ? operation('*', amountInSpan, actors, 'Multiply by the number of participants') : amountInSpan;
  return chain.reduce((expression, link) => operation('*', expression, link.count, 'Multiply by the amount in each group'), amountForGroup);
}
