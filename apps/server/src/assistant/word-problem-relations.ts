import { evaluateWordExpression, operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

const number = String.raw`(?:${numberSource})`;
const owner = String.raw`[a-z][a-z'’-]*(?: [a-z][a-z'’-]*){0,3}?`;
const owners = String.raw`${owner}(?: and ${owner}){0,5}`;
const unit = String.raw`[a-z]+(?:[- ][a-z]+){0,3}?`;
const snapshotVerb = 'has|have|had|owns?|owned|started with|began with|contains?|contained|holds?|held';
const additions = ['bought', 'got', 'received', 'found', 'collected', 'picked', 'earned', 'gained', 'added', 'won'];
const removals = ['sold', 'lost', 'spent', 'gave', 'gave away', 'donated', 'used', 'ate', 'removed', 'discarded'];
const observations = ['read', 'wrote', 'walked', 'ran', 'drove', 'made', 'built', 'scored', 'finished', 'completed', 'baked'];
const verbs = [...additions, ...removals, ...observations].join('|');
const queries: Readonly<Record<string, string>> = {
  buy: 'bought', get: 'got', receive: 'received', find: 'found', collect: 'collected', pick: 'picked',
  earn: 'earned', gain: 'gained', add: 'added', win: 'won', sell: 'sold', lose: 'lost', spend: 'spent',
  give: 'gave', 'give away': 'gave away', donate: 'donated', use: 'used', eat: 'ate', remove: 'removed', discard: 'discarded',
  read: 'read', write: 'wrote', walk: 'walked', run: 'ran', drive: 'drove', make: 'made', build: 'built',
  score: 'scored', finish: 'finished', complete: 'completed', bake: 'baked',
};
const eventQueryVerb = Object.keys(queries).join('|');
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const timeSpan = String.raw`(?:on (?:${weekdays.join('|')}|day \d+)|in (?:${months.join('|')}|the (?:morning|afternoon|evening))|today|yesterday)`;
const fractionWords: Readonly<Record<string, string>> = {
  half: '2', halves: '2', third: '3', thirds: '3', quarter: '4', quarters: '4',
  fourth: '4', fourths: '4', fifth: '5', fifths: '5', sixth: '6', sixths: '6',
  seventh: '7', sevenths: '7', eighth: '8', eighths: '8', ninth: '9', ninths: '9', tenth: '10', tenths: '10',
};
const fraction = String.raw`(?:(?:${number}|a|an)[ -](?:${Object.keys(fractionWords).join('|')})|half|\d+\s*/\s*\d+)`;
const proportion = String.raw`(?:${number}\s*(?:%|percent|per cent)|${fraction})`;
const amount = String.raw`(?:(?<dollars>\$)\s*)?(?<amount>${number})(?: (?<more>more|additional))?(?: (?<unit>${unit}))?(?: (?<extra>more))?`;
const reference = String.raw`(?:them|it|(?<possessor>his|her|their|its|the|${owner}['’]s) (?<remaining>remaining )?(?<sourceUnit>${unit}))`;
const whole = (pattern: string) => new RegExp(`^${pattern}$`, 'iu');
const snapshot = whole(String.raw`(?<owner>${owner}) (?:${snapshotVerb}) ${amount}`);
const unownedSnapshot = whole(String.raw`there (?:is|are|was|were) ${amount}`);
const compared = whole(String.raw`(?<owner>${owner}) (?:${snapshotVerb}) (?<amount>${number}) (?<direction>more|fewer|less) (?<unit>${unit}) than (?<reference>${owner})(?: (?:has|had|does|did))?`);
const multiplier = String.raw`(?<factor>twice|double|half|${fraction}|${number} times)`;
const multiple = whole(String.raw`(?<owner>${owner}) (?:${snapshotVerb}) ${multiplier} as (?:many|much)(?: (?<unit>${unit}))? as (?<reference>${owner})(?: (?:has|have|had|owns|owned|does|did))?`);
const multipleQuantity = whole(String.raw`(?<owner>${owner}) (?:${snapshotVerb}) ${multiplier} the (?:number|amount) of (?<unit>${unit}) (?:that )?(?<reference>${owner}) (?:has|have|had|owns|owned)`);
const comparisons = [compared, multiple, multipleQuantity];
const event = whole(String.raw`(?<owner>${owner}) (?<verb>${verbs}) ${amount}`);
const portionEvent = whole(String.raw`(?<owner>${owner}) (?<verb>${removals.join('|')}) (?<share>${proportion}) of ${reference}`);
const subset = whole(String.raw`(?<share>${proportion}) of ${reference} (?:are|were|is|was) (?<unit>${unit})`);
const transfer = whole(String.raw`(?<owner>${owner}) (?:gives?|gave|hands?|handed|donates?|donated) (?<recipients>.+)`);
const delivery = whole(String.raw`(?:(?<dollars>\$)\s*)?(?<amount>${number})(?: (?<unit>${unit}))? to (?<recipient>${owner})`);
const directQuestion = whole(String.raw`how (?<measure>many|much)(?: (?<unit>${unit}))? (?<tense>do|does|did|will) (?<owners>${owners}) (?<verb>have|own|${eventQueryVerb})(?: (?<qualifier>left|remaining|now|originally|at first|to begin with))?(?: (?<total>in total|in all|total|altogether|combined|together))?`);
const globalQuestion = whole(String.raw`how (?:many|much) (?<unit>${unit}) (?:are|is|were|was) (?:there(?: (?<total>in total|in all|total|altogether))?|(?<left>left|remaining))`);
const compareQuestion = whole(String.raw`how (?:many|much) (?<direction>more|fewer|less) (?<unit>${unit}) (?:does|did) (?<owner>${owner}) (?:have|own) than (?<reference>${owner})(?: (?:does|did))?`);
const statisticQuestion = whole(String.raw`what (?:is|was) the (?<statistic>total|average|difference)(?: (?:number|amount))? of (?<unit>${unit}) (?<owners>${owners}) (?<verb>have|has|had|own|owns|owned|${verbs})(?: per (?<period>day|month)(?: on (?:those|these) (?<sample>days|months))?)?`);
const differenceQuestion = whole(String.raw`what (?:is|was) the difference(?: in (?:the number of )?(?<unit>${unit}))? between (?<owner>${owner}) and (?<reference>${owner})`);
const timePrefix = new RegExp(String.raw`^(?<span>${timeSpan}),? `, 'iu');
const timeSuffix = new RegExp(String.raw` (?<span>${timeSpan})$`, 'iu');
const classification = String.raw`(?<verb>are|were|have|had|belong to|belonged to|go to|went to) (?<label>[a-z0-9]+(?:[-' ][a-z0-9]+){0,11}?)`;
const partitionShare = whole(String.raw`(?<share>${proportion}) of (?:the )?(?:(?<remainder>rest|remainder|remaining)(?: (?<restUnit>${unit}))?|them|(?<unit>${unit})) ${classification}`);
const partitionOther = whole(String.raw`(?:the )?(?:others|rest|remainder|(?:other|remaining)(?: (?<unit>${unit}))?) ${classification}`);
const partitionQuestion = whole(String.raw`how many (?:of (?:the )?)?(?<unit>${unit}) ${classification}`);

const unowned = 'there';
const pronoun = /^(?:he|she|they|it)$/u;
const invalidOwner = /\b(?:and|or|than|with|each|both|has|have|had|is|are|was|were)\b/u;
const invalidUnit = /\b(?:and|or|each|per|every|than|more|less|fewer|has|have|had|is|are|was|were|for|of|with|in|to|by|left|remaining|now|another)\b/u;

interface Term {
  owner: string;
  unit: string;
  expression: WordExpression;
  span?: string;
  initial?: WordExpression;
  inferredUnitFrom?: string;
}

interface Event extends Term {
  verb: string;
  additional: boolean;
}

interface Scenario {
  people: Set<string>;
  balances: Term[];
  events: Event[];
}

type Match = Record<string, string | undefined>;

function readOwner(text: string, scene: Scenario): string | null {
  const name = text.toLowerCase();
  if (invalidOwner.test(name)) return null;
  if (!pronoun.test(name)) return name;
  if (scene.people.size === 0) return name;
  return scene.people.size === 1 ? [...scene.people][0] : null;
}

function readUnit(text: string | undefined): string | null {
  const value = text?.toLowerCase();
  return value && !invalidUnit.test(value) ? value === 'money' ? 'dollar' : unitKey(value) : null;
}

function balance(scene: Scenario, name?: string, kind?: string, span?: string): Term | null {
  const matches = scene.balances.filter(term => (name === undefined || term.owner === name)
    && (kind === undefined || term.unit === kind) && term.span === span);
  return matches.length === 1 ? matches[0] : null;
}

function addBalance(scene: Scenario, term: Term): boolean {
  if (scene.balances.some(other => other.owner === term.owner && other.unit === term.unit && other.span === term.span)) return false;
  scene.balances.push(term);
  if (term.owner !== unowned) scene.people.add(term.owner);
  return true;
}

function expressionForAmount(text: string): WordExpression | null {
  const parsed = parseNumber(text.replace(/\s*\/\s*/gu, '/'));
  return parsed && !parsed.startsWith('-') ? quantity(parsed) : null;
}

function isNonnegative(expression: WordExpression): boolean {
  const exact = evaluateWordExpression(expression);
  return exact !== null && !exact.value.startsWith('-');
}

function readProportion(text: string): WordExpression | null {
  const value = text.toLowerCase();
  const percent = /^(.*?)\s*(?:%|percent|per cent)$/u.exec(value);
  if (percent) {
    const numerator = expressionForAmount(percent[1]);
    return numerator ? operation('/', numerator, quantity('100'), 'Convert the percentage') : null;
  }
  if (value === 'half') return quantity('1/2');
  if (value.includes('/')) return expressionForAmount(value);
  const named = /^(.+?)[ -]([a-z]+)$/u.exec(value);
  if (!named || !Object.hasOwn(fractionWords, named[2])) return null;
  const numerator = /^(?:a|an)$/u.test(named[1]) ? quantity('1') : expressionForAmount(named[1]);
  return numerator ? operation('/', numerator, quantity(fractionWords[named[2]]), 'Write the fraction') : null;
}

function partOf(scene: Scenario, groups: Match, speaker?: string): { term: Term; expression: WordExpression } | null {
  if (!groups.share) return null;
  const proportion = readProportion(groups.share);
  if (!proportion || !isNonnegative(operation('-', quantity('1'), proportion))) return null;
  const possessor = groups.possessor?.toLowerCase();
  const relative = possessor && /^(?:his|her|their|its)$/u.test(possessor);
  const explicitOwner = possessor?.replace(/['’]s$/u, '');
  const name = relative ? speaker ?? (scene.people.size === 1 ? [...scene.people][0] : null)
    : possessor && possessor !== 'the' && explicitOwner ? readOwner(explicitOwner, scene) : speaker;
  const kind = readUnit(groups.sourceUnit);
  if (name === null || groups.sourceUnit && !kind) return null;
  const term = balance(scene, name, kind ?? undefined);
  return term && (!term.initial || groups.remaining)
    ? { term, expression: operation('*', term.expression, proportion, 'Take the stated share') } : null;
}

function recordEvent(scene: Scenario, item: Event, subject = true): boolean {
  const earlier = scene.events.filter(previous => previous.owner === item.owner
    && previous.unit === item.unit && previous.verb === item.verb && previous.span === item.span);
  if (earlier.length && !item.additional) return false;
  const held = balance(scene, item.owner, item.unit, item.span);
  if (held && (additions.includes(item.verb) || removals.includes(item.verb))) {
    const subtracting = removals.includes(item.verb);
    const updated = operation(subtracting ? '-' : '+', held.expression, item.expression,
      subtracting ? 'Subtract the amount used or given away' : 'Add the amount received');
    if (subtracting && !isNonnegative(updated)) return false;
    held.initial ??= held.expression;
    held.expression = updated;
  }
  if (subject) scene.people.add(item.owner);
  scene.events.push(item);
  return true;
}

function recordAmount(scene: Scenario, groups: Match, span?: string): boolean {
  if (!groups.amount) return false;
  const expression = expressionForAmount(groups.amount);
  const name = groups.owner ? readOwner(groups.owner, scene) : unowned;
  const additional = Boolean(groups.more || groups.extra);
  if (!name || !expression || groups.more && groups.extra) return false;
  const explicitUnit = readUnit(groups.unit);
  if (groups.unit && !explicitUnit || groups.dollars && explicitUnit && explicitUnit !== 'dollar') return false;
  const kind = groups.dollars ? 'dollar' : explicitUnit ?? (additional ? balance(scene, name, undefined, span)?.unit : undefined);
  if (!kind) return false;
  const term = { owner: name, unit: kind, expression, span };
  if (groups.verb) return recordEvent(scene, { ...term, verb: groups.verb.toLowerCase(), additional });
  return !additional && addBalance(scene, term);
}

/** A coordinated delivery changes only balances with stated starting amounts. */
function recordTransfer(scene: Scenario, match: Match, span?: string): boolean {
  if (!match.owner || !match.recipients) return false;
  const name = readOwner(match.owner, scene);
  if (!name) return false;
  const deliveries = match.recipients.split(/,? and |, /iu);
  if (deliveries.length > 8) return false;
  let kind: string | undefined;
  const items: Term[] = [];
  for (const deliveryText of deliveries) {
    const fields = delivery.exec(deliveryText.trim())?.groups;
    if (!fields) return false;
    const recipient = readOwner(fields.recipient, scene);
    const expression = expressionForAmount(fields.amount);
    const explicitUnit = fields.dollars ? 'dollar' : readUnit(fields.unit);
    if (!recipient || pronoun.test(fields.recipient.toLowerCase()) || name === recipient || !expression
      || fields.unit && !explicitUnit || kind && explicitUnit && kind !== explicitUnit) return false;
    kind ??= explicitUnit ?? balance(scene, name, undefined, span)?.unit;
    if (!kind) return false;
    items.push({ owner: recipient, unit: kind, expression, span });
  }
  const total = sum(items);
  if (!total || !kind || !recordEvent(scene, { owner: name, unit: kind, expression: total, verb: 'gave', additional: true, span })) {
    return false;
  }
  return items.every(item => recordEvent(scene, { ...item, verb: 'received', additional: true }, false));
}

function comparisonMatch(statement: string): Match | undefined {
  for (const pattern of comparisons) {
    const relation = pattern.exec(statement)?.groups;
    if (relation) return relation;
  }
  return undefined;
}

/** Parse one complete statement, preserving the role and period of every count. */
function fact(scene: Scenario, statement: string): boolean {
  const prefixed = timePrefix.exec(statement);
  const suffixed = timeSuffix.exec(statement);
  if (prefixed && suffixed) return false;
  const span = (prefixed ?? suffixed)?.groups?.span.toLowerCase();
  const plain = (prefixed ? statement.slice(prefixed[0].length)
    : suffixed ? statement.slice(0, suffixed.index) : statement).replace(/^(?:then|now),? /iu, '');

  const relation = comparisonMatch(plain);
  if (relation?.owner && relation.reference) {
    const name = readOwner(relation.owner, scene);
    const referenceName = readOwner(relation.reference, scene);
    const kind = readUnit(relation.unit);
    if (!name || !referenceName || name === referenceName || relation.unit && !kind) return false;
    const other = balance(scene, referenceName, kind ?? undefined, span);
    if (!other) return false;
    const factor = relation.factor?.toLowerCase();
    let operand: WordExpression | null = null;
    if (factor && /^(?:twice|double)$/u.test(factor)) operand = quantity('2');
    else if (factor?.endsWith(' times')) operand = expressionForAmount(factor.slice(0, -6));
    else if (factor) operand = readProportion(factor);
    else if (relation.amount) operand = expressionForAmount(relation.amount);
    if (!operand) return false;
    const operator = factor ? '*' : relation.direction?.toLowerCase() === 'more' ? '+' : '-';
    const expression = operation(operator, other.expression, operand, 'Apply the stated comparison');
    if (operator === '-' && !isNonnegative(expression)) return false;
    return addBalance(scene, { owner: name, unit: other.unit, expression, span, inferredUnitFrom: kind ? undefined : referenceName });
  }

  const portion = portionEvent.exec(plain)?.groups ?? subset.exec(plain)?.groups;
  if (portion) {
    if (span) return false;
    const name = portion.owner ? readOwner(portion.owner, scene) : undefined;
    if (name === null) return false;
    const known = partOf(scene, portion, name);
    if (!known) return false;
    if (portion.verb) {
      if (!name || known.term.owner !== name) return false;
      return recordEvent(scene, { ...known.term, expression: known.expression, verb: portion.verb.toLowerCase(), additional: false });
    }
    const kind = readUnit(portion.unit);
    return Boolean(kind && addBalance(scene, { ...known.term, unit: kind, expression: known.expression }));
  }
  const transferred = transfer.exec(plain)?.groups;
  if (transferred && recordTransfer(scene, transferred, span)) return true;
  const simple = snapshot.exec(plain)?.groups ?? unownedSnapshot.exec(plain)?.groups ?? event.exec(plain)?.groups;
  return Boolean(simple && recordAmount(scene, simple, span));
}

function sum(items: readonly Term[]): WordExpression | null {
  if (!items.length) return null;
  return items.slice(1).reduce((total, item) => operation('+', total, item.expression, 'Add the matching amounts'), items[0].expression);
}

function readGroup(scene: Scenario, text: string, collective: boolean): string[] | null {
  const group = text.toLowerCase();
  if (collective && /^(?:they|both)$/u.test(group)) {
    if (scene.events.some(item => !scene.people.has(item.owner)) || group === 'both' && scene.people.size < 2) return null;
    if (scene.people.size > 1) return [...scene.people];
  }
  const members = group.split(' and ').map(name => readOwner(name, scene));
  if (members.some(name => name === null) || new Set(members).size !== members.length) return null;
  return members as string[];
}

function matchingTerms(scene: Scenario, settings: {
  names: string[]; kind: string; verb: string; span?: string; allSpans: boolean; qualifier?: string; past: boolean;
}): Term[] | null {
  const { names, kind, verb, span, allSpans, qualifier, past } = settings;
  const events = !/^(?:have|has|had|own|owns|owned)$/u.test(verb);
  const entries = events ? scene.events.filter(event => event.verb === verb) : scene.balances;
  const matches = entries.filter(item => names.includes(item.owner) && item.unit === kind
    && (events && allSpans || item.span === span));
  if (names.some(name => !matches.some(item => item.owner === name))) return null;
  if (events && qualifier) return null;
  if (events && allSpans && new Set(matches.map(item => item.span === undefined)).size > 1) return null;
  if (qualifier === 'left' || qualifier === 'remaining') return matches.every(item => item.initial) ? matches : null;
  if (qualifier && /^(?:originally|at first|to begin with)$/u.test(qualifier)) {
    return matches.map(item => ({ ...item, expression: item.initial ?? item.expression }));
  }
  if (past && !qualifier && !span && matches.some(item => item.initial)) return null;
  return matches;
}

function categoryKey(groups: Match): string | null {
  if (!groups.verb || !groups.label) return null;
  const equivalent: Readonly<Record<string, string>> = {
    were: 'are', had: 'have', 'belonged to': 'belong to', 'went to': 'go to',
  };
  const verb = groups.verb.toLowerCase();
  const canonical = equivalent[verb] ?? verb;
  const label = groups.label.toLowerCase();
  const description = canonical === 'have' ? label.replace(/ (?:on|in|inside) them$/u, '') : label;
  return `${canonical} ${description}`;
}

/** Classify each share against the explicit whole or the as-yet unassigned remainder. */
function fractionalPartition(statements: readonly string[], question: string): WordExpression | null {
  const ask = partitionQuestion.exec(question)?.groups;
  if (!ask) return null;
  const target = categoryKey(ask);
  const kind = readUnit(ask.unit);
  if (!target || !kind) return null;
  const parts = statements.flatMap(statement => statement.split(/, (?:and )?/iu).map(clause => clause.replace(/^and /iu, '')));
  const opening = snapshot.exec(parts[0] ?? '')?.groups ?? unownedSnapshot.exec(parts[0] ?? '')?.groups;
  if (!opening?.amount || parts.length < 2 || opening.more || opening.extra || opening.dollars || readUnit(opening.unit) !== kind) return null;
  let remaining = expressionForAmount(opening.amount);
  if (!remaining) return null;
  const classified = new Map<string, WordExpression>();
  for (const [index, part] of parts.slice(1).entries()) {
    const allotted = partitionShare.exec(part)?.groups;
    const rest = partitionOther.exec(part)?.groups;
    const clause = allotted ?? rest;
    if (!clause) return null;
    const key = categoryKey(clause);
    if (!key || classified.has(key)) return null;
    const referredUnit = clause.unit ?? clause.restUnit;
    if (referredUnit && readUnit(referredUnit) !== kind) return null;
    if (!allotted) {
      if (!rest || index !== parts.length - 2) return null;
      classified.set(key, remaining);
      continue;
    }
    if (index > 0 && !allotted.remainder || !allotted.share) return null;
    const ratio = readProportion(allotted.share);
    if (!ratio || !isNonnegative(operation('-', quantity('1'), ratio))) return null;
    const share: WordExpression = operation('*', remaining, ratio, 'Calculate the stated share');
    classified.set(key, share);
    remaining = operation('-', remaining, share, 'Remove the classified share');
  }
  return classified.get(target) ?? null;
}

function difference(first: Term | null, second: Term | null, symmetric: boolean): WordExpression | null {
  if (!first || !second || first.unit !== second.unit || first.owner === second.owner && first.span === second.span) return null;
  const result = operation('-', first.expression, second.expression, 'Subtract to find the difference');
  const exact = evaluateWordExpression(result);
  if (!exact) return null;
  if (!exact.value.startsWith('-')) return result;
  return symmetric ? operation('-', second.expression, first.expression, 'Subtract to find the difference') : null;
}

function observedPeriod(span: string, period: string): { scale: string; index: number } | null {
  if (period === 'month') {
    const index = span.startsWith('in ') ? months.indexOf(span.slice(3)) : -1;
    return index === -1 ? null : { scale: 'month', index };
  }
  const weekday = span.startsWith('on ') ? weekdays.indexOf(span.slice(3)) : -1;
  if (weekday !== -1) return { scale: 'weekday', index: weekday };
  const numbered = /^on day (\d+)$/u.exec(span);
  if (numbered && Number.isSafeInteger(Number(numbered[1]))) return { scale: 'numbered', index: Number(numbered[1]) };
  if (span === 'today' || span === 'yesterday') return { scale: 'relative', index: span === 'today' ? 1 : 0 };
  return null;
}

function completePeriods(items: readonly Term[], period: string, sample?: string): boolean {
  if (sample && sample !== `${period}s`) return false;
  const observed = items.map(item => item.span ? observedPeriod(item.span, period) : null)
    .filter(item => item !== null);
  if (observed.length !== items.length || !observed.length) return false;
  const positions = observed.map(item => item.index).sort((left, right) => left - right);
  if (new Set(observed.map(item => item.scale)).size !== 1 || new Set(positions).size !== items.length) return false;
  return Boolean(sample) || positions.at(-1)! - positions[0] + 1 === positions.length;
}

function answer(scene: Scenario, rawQuestion: string): WordExpression | null {
  const timed = timeSuffix.exec(rawQuestion);
  const span = timed?.groups?.span.toLowerCase();
  const question = timed ? rawQuestion.slice(0, timed.index) : rawQuestion;
  const comparative = compareQuestion.exec(question)?.groups;
  const symmetric = differenceQuestion.exec(question)?.groups;
  const pair = comparative ?? symmetric;
  if (pair) {
    const name = readOwner(pair.owner, scene);
    const other = readOwner(pair.reference, scene);
    const kind = readUnit(pair.unit);
    if (!name || !other || pair.unit && !kind) return null;
    const first = balance(scene, name, kind ?? undefined, span);
    const second = balance(scene, other, kind ?? undefined, span);
    return /^(?:less|fewer)$/iu.test(pair.direction ?? '') ? difference(second, first, false)
      : difference(first, second, Boolean(symmetric));
  }
  const global = globalQuestion.exec(question)?.groups;
  if (global) {
    const kind = readUnit(global.unit);
    if (!kind || global.left) return null;
    const standalone = balance(scene, unowned, kind, span);
    if (standalone) return standalone.expression;
    if (!global.total || scene.people.size < 2 || scene.events.some(item => !scene.people.has(item.owner))) return null;
    const matches = matchingTerms(scene, { names: [...scene.people], kind, verb: 'have', span, allSpans: false, past: false });
    return matches ? sum(matches) : null;
  }
  const statistic = statisticQuestion.exec(question)?.groups;
  const query = statistic ?? directQuestion.exec(question)?.groups;
  if (!query?.owners || !query.verb) return null;
  const verb = query.verb.toLowerCase();
  const statisticKey = statistic?.statistic?.toLowerCase();
  const kind = readUnit(query.unit) ?? (!query.unit && query.measure?.toLowerCase() === 'much' ? 'dollar' : null);
  const collective = Boolean(statistic || query.total);
  const names = readGroup(scene, query.owners, collective);
  if (!kind || !names || names.length > 1 && !collective || query.tense?.toLowerCase() === 'will') return null;
  const allSpans = collective && !span;
  const matches = matchingTerms(scene, {
    names, kind, verb: statistic ? verb : queries[verb] ?? verb, span, allSpans,
    qualifier: query.qualifier?.toLowerCase(), past: /^(?:did|had|owned)$/iu.test(query.tense ?? verb),
  });
  if (!matches) return null;
  if (query.period && statisticKey !== 'average') return null;
  if (statisticKey === 'difference') return matches.length === 2 ? difference(matches[0], matches[1], true) : null;
  const total = sum(matches);
  if (statisticKey !== 'average') return total;
  if (!total || matches.length < 2) return null;
  if (query.period) {
    if (names.length !== 1 || !completePeriods(matches, query.period.toLowerCase(), query.sample?.toLowerCase())) return null;
  } else if (matches.length !== names.length) return null;
  return operation('/', total, quantity(String(matches.length)), 'Divide the total by the number of amounts');
}

function emptyScenario(): Scenario {
  return { people: new Set(), balances: [], events: [] };
}

function orderedScenario(statements: readonly string[]): Scenario | null {
  const scene = emptyScenario();
  for (const statement of statements) {
    if (fact(scene, statement)) continue;
    const clauses = statement.split(/,? (?:and then|and|then) /iu);
    if (clauses.length < 2 || clauses.length > 6) return null;
    let previousOwner: string | undefined;
    for (const clause of clauses) {
      const ownClause = snapshot.exec(clause)?.groups ?? event.exec(clause)?.groups ?? comparisonMatch(clause);
      const inherited = previousOwner && `${previousOwner} ${clause}`;
      if (!fact(scene, clause) && (!inherited || !fact(scene, inherited))) return null;
      previousOwner = ownClause?.owner ?? previousOwner;
    }
  }
  return scene;
}

/** Pure comparisons can depend on facts that follow them. Keep balance changes in their original order. */
function comparisonScenario(statements: readonly string[]): Scenario | null {
  const base = emptyScenario();
  let pending: string[] = [];
  for (const statement of statements) {
    const relation = comparisonMatch(statement);
    if (relation) {
      if (!relation.owner || !relation.reference || [relation.owner, relation.reference].some(name => pronoun.test(name.toLowerCase()))) return null;
      pending.push(statement);
    } else {
      const principal = snapshot.exec(statement)?.groups?.owner;
      if (!principal || pronoun.test(principal.toLowerCase()) || !fact(base, statement)) return null;
    }
  }
  while (pending.length) {
    const remainder = pending.filter(statement => !fact(base, statement));
    if (remainder.length === pending.length) return null;
    pending = remainder;
  }
  return base;
}

/** Resolves arithmetic from complete clauses. An unknown fact or reference leaves the reading incomplete. */
export function parseEnglishRelations(statements: readonly string[], question: string): WordExpression | null {
  const scene = orderedScenario(statements) ?? comparisonScenario(statements);
  const bound = scene && scene.balances.every(term => !term.inferredUnitFrom || balance(scene, term.inferredUnitFrom, undefined, term.span));
  return (scene && bound ? answer(scene, question) : null) ?? fractionalPartition(statements, question);
}
