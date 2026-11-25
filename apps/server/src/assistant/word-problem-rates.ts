import { evaluateWordExpression, operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

const n = `(${numberSource})`;
const noun = String.raw`([a-z][a-z'-]*(?: [a-z][a-z'-]*){0,3}?)`;
const owner = String.raw`([a-z][a-z'-]*(?: [a-z][a-z'-]*){0,4}?)`;
const productiveVerb = String.raw`(?:makes?|made|produces?|produced|prints?|printed|displays?|displayed|reads?|read|writes?|wrote|picks?|picked|collects?|collected|sells?|sold|earns?|earned|runs?|ran|walks?|walked|drives?|drove|travels?|traveled|travelled|cycles?|cycled|uses?|used|consumes?|consumed|drinks?|drank|eats?|ate|buys?|bought|can make|can read|can produce|can walk|can travel)`;
const forwardVerb = String.raw`(?:make|produce|print|display|read|write|pick|collect|sell|earn|run|walk|drive|travel|cycle|use|consume|drink|eat|buy)`;
const time = String.raw`(seconds?|minutes?|hours?|days?|weeks?|months?|years?|shifts?|sessions?|rounds?|trips?)`;
const pattern = (source: string) => new RegExp(`^${source}$`, 'iu');

function sameOwner(reference: string, subject: string): boolean {
  const name = (text: string) => text.toLowerCase().replace(/^(?:a|an|the) /u, '');
  return /^(?:he|she|it|they)$/iu.test(reference) || name(reference) === name(subject);
}

const activityNames = [
  'make makes made', 'produce produces produced', 'print prints printed', 'display displays displayed', 'read reads', 'write writes wrote',
  'pick picks picked', 'collect collects collected', 'sell sells sold', 'earn earns earned', 'run runs ran',
  'walk walks walked', 'drive drives drove', 'travel travels traveled travelled', 'cycle cycles cycled',
  'use uses used', 'consume consumes consumed', 'drink drinks drank', 'eat eats ate', 'buy buys bought orders ordered',
  'have has had', 'get gets got receive receives received',
];

function activity(value: string): string | undefined {
  const verb = value.toLowerCase().replace(/^can /u, '');
  return activityNames.find(group => group.split(' ').includes(verb));
}

function literal(value: string): WordExpression | null {
  const parsed = parseNumber(value);
  return parsed === null || parsed.startsWith('-') ? null : quantity(parsed);
}

const fixedTimeUnits: Readonly<Record<string, string>> = {
  second: '1', minute: '60', hour: '3600', day: '86400', week: '604800',
};

export function translateDuration(value: WordExpression, from: string, to: string): WordExpression | null {
  const input = unitKey(from), target = unitKey(to);
  if (input === target) return value;
  if (!Object.hasOwn(fixedTimeUnits, input) || !Object.hasOwn(fixedTimeUnits, target)) return null;
  return operation('*', value, operation('/', quantity(fixedTimeUnits[input]!), quantity(fixedTimeUnits[target]!)), 'Convert the duration');
}

const periodRate = pattern(String.raw`${owner} (${productiveVerb}) ([$£€] ?)?${n}(?: ${noun})? (?:per|each|every|an?|in(?: (?:an?|one))?) ${time}`);
const timedIntervalRate = pattern(String.raw`${owner} (${productiveVerb}) ([$£€] ?)?${n}(?: ${noun})? (?:in|every) ${n} ${time}`);
const timedRequest = pattern(String.raw`how (many|much|far)(?: ${noun})? (?:does|do|did|will|would|can|could) ${owner} (${forwardVerb})(?: (?:in total|altogether))? (?:in|over|for|after) ${n} ${time}(?: (?:in total|altogether))?`);
const conditionalTiming = pattern(String.raw`(?:if )?${owner} (works?|worked|continues?|continued|does this|keeps? going|runs?|ran|walks?|walked|drives?|drove|travels?|traveled|travelled) (?:for )?${n} ${time}`);
const untimedRequest = pattern(String.raw`how (many|much|far)(?: ${noun})? (?:does|do|did|will|would|can|could) ${owner} (${forwardVerb})(?: (?:in total|altogether))?`);

function isRequestedUnit(kind: string, requested: string | undefined, given: string | undefined, currency: string | undefined): boolean {
  if (requested) {
    const unit = unitKey(requested);
    return given ? unit === unitKey(given) : Boolean(currency && (unit === 'money'
      || unit === ({ '$': 'dollar', '£': 'pound', '€': 'euro' }[currency.trim()])));
  }
  return kind.toLowerCase() === 'much' && Boolean(currency)
    || kind.toLowerCase() === 'far' && Boolean(given && /^(?:kilomet(?:er|re)|met(?:er|re)|mile|yard|foot)$/u.test(unitKey(given)));
}

export function parseTimedRate(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length > 2 || !statements.length) return null;
  const rate = periodRate.exec(statements[0]!);
  const intervalRate = rate ? null : timedIntervalRate.exec(statements[0]!);
  if (!rate && !intervalRate) return null;
  const [, subject, verb, currency, amount, unit] = (rate ?? intervalRate)!;
  const baseDuration = rate ? quantity('1') : literal(intervalRate![6]!);
  const baseTime = (rate ? rate[6] : intervalRate![7])!;
  const baseAmount = literal(amount!);
  if (!baseAmount || !baseDuration) return null;
  const direct = statements.length === 1 ? timedRequest.exec(question) : null;
  const indirect = statements.length === 2 ? untimedRequest.exec(question) : null;
  const condition = indirect ? conditionalTiming.exec(statements[1]!) : null;
  const ask = direct ?? indirect;
  if (!ask || !sameOwner(ask[3]!, subject!) || activity(verb!) !== activity(ask[4]!)
    || !isRequestedUnit(ask[1]!, ask[2], unit, currency)) return null;
  const conditionalActivity = condition && activity(condition[2]!);
  if (indirect && (!condition || !sameOwner(condition[1]!, subject!) || conditionalActivity && conditionalActivity !== activity(verb!))) return null;
  const value = literal((direct?.[5] ?? condition?.[3])!);
  if (!value) return null;
  const duration = translateDuration(value, (direct?.[6] ?? condition?.[4])!, baseTime);
  if (!duration) return null;
  const perUnit = rate ? baseAmount : operation('/', baseAmount, baseDuration, 'Find the amount per period');
  return operation('*', perUnit, duration);
}

const hasGroups = pattern(String.raw`${owner} (has|have|had|gets?|got|buys?|bought|ordered|packed|prepared|receives?|received|made|makes|used|uses|collects?|collected) ${n} ${noun}`);
const groupContents = pattern(String.raw`each ${noun} (?:has|had|holds?|held|contains?|contained|includes?|included|comes? with) ${n} ${noun}`);
const straightGroups = pattern(String.raw`${owner} (has|have|had|buys?|bought|ordered|packed|receives?|received|made|makes|gets?|got|uses?|used) ${n} ${noun} (?:of|with) ${n} ${noun}(?: each)?`);
const allItems = pattern(String.raw`how many ${noun} (?:(?:does|do|did|will|would) ${owner} (have|have now|get|buy|receive|make|use)|(?:are|were) there)(?: (?:in all|altogether|in total|total))?`);

export function parseGroups(statements: readonly string[], question: string): WordExpression | null {
  const asked = allItems.exec(question);
  if (!asked || !statements.length || statements.length > 2) return null;
  const combined = statements.length === 1 ? straightGroups.exec(statements[0]!) : null;
  const stock = statements.length === 2 ? hasGroups.exec(statements[0]!) : null;
  const contents = stock ? groupContents.exec(statements[1]!) : null;
  if (!combined && (!stock || !contents || unitKey(stock[4]!) !== unitKey(contents[1]!))) return null;
  const subject = (combined?.[1] ?? stock?.[1])!;
  const action = (combined?.[2] ?? stock?.[2])!;
  const asksForStock = /^(?:have|have now)$/iu.test(asked[3] ?? '');
  if (asked[3] && (asksForStock ? /^(?:used|uses)$/iu.test(action) : activity(asked[3]) !== activity(action))) return null;
  const count = parseNumber((combined?.[3] ?? stock?.[3])!);
  const amount = count && /^\d+$/u.test(count) ? quantity(count) : null;
  const groupSize = literal((combined?.[5] ?? contents?.[2])!);
  if (!amount || !groupSize || asked[2] && !sameOwner(asked[2], subject)
    || unitKey(asked[1]!) !== unitKey((combined?.[6] ?? contents?.[3])!)) return null;
  return operation('*', amount, groupSize);
}

const distribution = pattern(String.raw`(?:if )?${owner} (?:shares?|shared|divides?|divided|distributes?|distributed) (?:them|the ${noun}) (?:evenly|equally) (?:among|between|into) ${n} ${noun}`);
const eachResult = pattern(String.raw`how many ${noun} (?:does|do|did|will|would) each ${noun} (?:receive|get|have|hold|contain)`);

export function parseEqualShare(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length !== 2) return null;
  const stock = hasGroups.exec(statements[0]!);
  const spread = distribution.exec(statements[1]!);
  const asked = eachResult.exec(question);
  if (!stock || !spread || !asked || /^(?:use|used|uses)$/iu.test(stock[2]!) || !sameOwner(spread[1]!, stock[1]!)
    || spread[2] && unitKey(spread[2]) !== unitKey(stock[4]!) || unitKey(stock[4]!) !== unitKey(asked[1]!)
    || unitKey(spread[4]!) !== unitKey(asked[2]!)) return null;
  const amount = literal(stock[3]!);
  const recipients = literal(spread[3]!);
  if (!amount || !recipients) return null;
  const share = operation('/', amount, recipients);
  // A fractional share of countable objects needs a rule for splitting or leftovers.
  const answer = evaluateWordExpression(share);
  return answer && /^\d+$/u.test(answer.value) ? share : null;
}
