import { evaluateWordExpression, operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

const n = `(${numberSource})`;
const name = String.raw`([a-z][a-z'-]*(?: [a-z][a-z'-]*){0,2}?)`;
const unit = String.raw`([a-z][a-z-]*(?: [a-z][a-z-]*){0,2}?)`;
const period = String.raw`((?:this|last|next) (?:week|month|year)|(?:today|yesterday|tomorrow)|(?:on|in) [a-z]+)`;
const event = String.raw`(read|wrote|written|sold|bought|made|built|produced|saved|earned|collected|finished|completed|scored|picked|printed|painted|planted|used)`;
const share = `(?:half|${numberSource}\\s*(?:%|percent|per cent)|${numberSource})`;
const whole = (source: string) => new RegExp(`^${source}$`, 'iu');

function amount(text: string): WordExpression | null {
  const value = parseNumber(text);
  return value === null || value.startsWith('-') ? null : quantity(value);
}

function proportion(text: string): WordExpression | null {
  if (/^half$/iu.test(text)) return quantity('1/2');
  const percent = /^(.*?)\s*(?:%|percent|per cent)$/iu.exec(text);
  const value = amount(percent?.[1] ?? text);
  return value && (percent ? operation('/', value, quantity('100'), 'Convert the percentage')
    : value.kind === 'value' && value.value.includes('/') ? value : null);
}

function samePerson(first: string, second: string): boolean {
  return /^(?:he|she|it|they)$/iu.test(second) || first.toLowerCase() === second.toLowerCase();
}

function sameEvent(verb: string, other: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/^(?:written|wrote)$/u, 'write');
  return normalize(verb) === normalize(other);
}

const eventAmount = whole(String.raw`${name} ${event} ${n} ${unit} ${period}`);
const proportionOfEvent = whole(String.raw`(?:this|that|this amount|that amount|this number|that number) (?:is|was|represents) (${share}) of (?:the (?:number|amount) of) ${unit} ${name} (?:(?:has|had) )?${event} ${period}`);
const askEvent = whole(String.raw`how (?:many|much) ${unit} (?:(?:has|had) ${name} ${event}|did ${name} (write|read|sell|buy|make|build|produce|save|earn|collect|finish|complete|score|pick|print|paint|plant|use)) ${period}`);
const past: Readonly<Record<string, string>> = {
  write: 'wrote', read: 'read', sell: 'sold', buy: 'bought', make: 'made', build: 'built', produce: 'produced',
  save: 'saved', earn: 'earned', collect: 'collected', finish: 'finished', complete: 'completed', score: 'scored',
  pick: 'picked', print: 'printed', paint: 'painted', plant: 'planted', use: 'used',
};

/** The known amount is a stated share of another, explicitly identified event. */
export function parseInverseProportion(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length !== 2) return null;
  const known = eventAmount.exec(statements[0]!);
  const linked = proportionOfEvent.exec(statements[1]!);
  const asked = askEvent.exec(question);
  if (!known || !linked || !asked) return null;
  const askedPerson = (asked[2] ?? asked[4])!;
  const askedVerb = asked[3] ?? past[asked[5]!.toLowerCase()];
  if (!samePerson(known[1]!, linked[3]!) || !samePerson(known[1]!, askedPerson)
    || !sameEvent(known[2]!, linked[4]!) || !sameEvent(linked[4]!, askedVerb)
    || unitKey(known[4]!) !== unitKey(linked[2]!) || unitKey(linked[2]!) !== unitKey(asked[1]!)
    || known[5]!.toLowerCase() === linked[5]!.toLowerCase() || linked[5]!.toLowerCase() !== asked[6]!.toLowerCase()) return null;
  const part = amount(known[3]!);
  const fraction = proportion(linked[1]!);
  return part && fraction ? operation('/', part, fraction, 'Divide by the stated share') : null;
}

const action = String.raw`(make|build|paint|print|produce|pack|sew|read|write|finish|assemble)`;
const time = String.raw`(seconds?|minutes?|hours?|days?|weeks?)`;
const byTime = whole(String.raw`${name} (?:can|could) ${action} ${n} ${unit} in ${n} ${time}`);
const timeTo = whole(String.raw`it takes ${name} ${n} ${time} to ${action} ${n} ${unit}`);
const askTime = whole(String.raw`how many ${time} (?:does|did|will|would) it take ${name} to ${action} ${n} ${unit}`);
const longTime = whole(String.raw`how long (?:does|did|will|would) it take ${name} to ${action} ${n} ${unit}`);
const timeScale: Readonly<Record<string, string>> = { second: '1', minute: '60', hour: '3600', day: '86400', week: '604800' };

export function parseInverseRate(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length !== 1) return null;
  const ability = byTime.exec(statements[0]!);
  const duration = ability ? null : timeTo.exec(statements[0]!);
  if (!ability && !duration) return null;
  const precise = askTime.exec(question);
  const general = precise ? null : longTime.exec(question);
  if (!precise && !general) return null;
  const [subject, verb, count, kind, timeAmount, timeUnit] = ability ? ability.slice(1)
    : [duration![1], duration![4], duration![5], duration![6], duration![2], duration![3]];
  const [reference, askedVerb, target, wanted] = precise ? precise.slice(2) : general!.slice(1);
  if (!samePerson(subject, reference) || verb.toLowerCase() !== askedVerb.toLowerCase() || unitKey(kind) !== unitKey(wanted)) return null;
  const knownCount = amount(count), knownTime = amount(timeAmount), targetCount = amount(target);
  if (!knownCount || !knownTime || !targetCount) return null;
  const elapsed = operation('*', operation('/', knownTime, knownCount, 'Find the time per item'), targetCount);
  if (!precise || unitKey(precise[1]!) === unitKey(timeUnit)) return elapsed;
  const convert = operation('/', quantity(timeScale[unitKey(timeUnit)]!), quantity(timeScale[unitKey(precise[1]!)]!));
  return operation('*', elapsed, convert, 'Convert to the requested time unit');
}

const comparedAges = whole(String.raw`${name} is (twice|double|${numberSource} times) as old as ${name}`);
const futureAges = whole(String.raw`in ${n} years?,? ${name} will be (twice|double|${numberSource} times) as old as ${name}`);
const currentAge = whole(String.raw`how old (?:is) ${name}(?: now| currently)?`);

function multiplier(text: string): WordExpression | null {
  return /^(?:twice|double)$/iu.test(text) ? quantity('2') : amount(text.replace(/ times$/iu, ''));
}

/** Write both age comparisons using their common elapsed time and isolate the younger age. */
export function parseAgeComparison(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length !== 2) return null;
  const current = comparedAges.exec(statements[0]!);
  const future = futureAges.exec(statements[1]!);
  const asked = currentAge.exec(question);
  if (!current || !future || !asked
    || current[1]!.toLowerCase() === current[3]!.toLowerCase()
    || current[1]!.toLowerCase() !== future[2]!.toLowerCase() || current[3]!.toLowerCase() !== future[4]!.toLowerCase()) return null;
  const wanted = asked[1]!.toLowerCase();
  if (wanted !== current[1]!.toLowerCase() && wanted !== current[3]!.toLowerCase()) return null;
  const factorNow = multiplier(current[2]!);
  const factorLater = multiplier(future[3]!);
  const years = amount(future[1]!);
  if (!factorNow || !factorLater || !years) return null;
  const numerator = operation('*', years, operation('-', factorLater, quantity('1')));
  const denominator = operation('-', factorNow, factorLater, 'Find the change in the age multiplier');
  const younger = operation('/', numerator, denominator, 'Find the younger age today');
  const exact = evaluateWordExpression(younger);
  if (!exact || /^-|^0$/u.test(exact.value)) return null;
  return wanted === current[3]!.toLowerCase() ? younger : operation('*', younger, factorNow, 'Find the older age today');
}
