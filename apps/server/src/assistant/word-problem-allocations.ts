import { evaluateWordExpression, operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

const owner = String.raw`[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,3}?`;
const unit = String.raw`[a-z]+(?:[ -][a-z]+){0,4}?`;
const number = `(?:${numberSource})`;
const holding = '(?:have|has|had|own|owns|owned|hold|holds|held)';
const whole = (source: string) => new RegExp(`^(?:if )?${source}$`, 'iu');
const joint = whole(String.raw`(?:(?<lead>together|combined|in total),? )?(?<first>${owner}) (?:and|&) (?<second>${owner})(?: (?<middle>together|combined))? (?<verb>${holding}) (?:(?<total>a (?:combined )?total of) )?(?<currency>\$ ?)?(?<amount>${number})(?: (?<unit>${unit}))?(?: (?<tail>together|combined|in total|in all|altogether|between them))?`);
const subject = String.raw`(?<subject>${owner}) (?<verb>${holding})`;
const reference = String.raw`(?<reference>${owner})(?: (?:has|had|does|did))?`;
const direction = '(?<direction>more|less|fewer)';
const offset = whole(String.raw`${subject} (?<currency>\$ ?)?(?<amount>${number}) ${direction}(?: (?<unit>${unit}))? than ${reference}`);
const offsetWithLeadingUnit = whole(String.raw`${subject} (?<amount>${number}) (?<unit>${unit}) ${direction} than ${reference}`);
const multiple = whole(String.raw`${subject} (?<factor>twice|double|thrice|triple|half|${number} times) as (?:much|many) (?<unit>${unit}) as ${reference}`);
const ask = whole(String.raw`how (?:many|much)(?: (?<unit>${unit}))? (?:does|did) (?<owner>${owner}) (?:have|own|hold)`);

function name(value: string): string | null {
  const text = value.toLowerCase();
  return /\b(?:and|or|together|combined|each|both|has|have|had|he|she|they|it)\b/u.test(text) ? null : text;
}

function kind(value: string | undefined, dollars = false): string | null {
  if (!value) return dollars ? 'dollar' : null;
  const key = value.split(/ of /iu).map(unitKey).join(' of ');
  if (/\b(?:and|or|each|more|less|fewer|than|in|by|between|together|combined)\b/u.test(key)) return null;
  if (key === 'money') return 'dollar';
  return !dollars || key === 'dollar' ? key : null;
}

function amount(value: string): WordExpression | null {
  const parsed = parseNumber(value);
  return parsed !== null && !parsed.startsWith('-') ? quantity(parsed) : null;
}

const multipliers: Readonly<Record<string, string>> = {
  twice: '2', double: '2', thrice: '3', triple: '3', half: '1/2',
};
const past = /^(?:had|owned|held)$/iu;

/** Resolve a two-owner total when one share is stated relative to the other. */
export function parseAllocations(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length !== 2) return null;
  const requested = ask.exec(question)?.groups;
  const totals = statements.map(statement => joint.exec(statement)?.groups);
  const jointIndex = totals[0] ? 0 : 1;
  const total = totals[jointIndex];
  if (!requested || !total || !(total.lead || total.middle || total.total || total.tail)) return null;

  const relationText = statements[1 - jointIndex];
  const additive = offset.exec(relationText)?.groups ?? offsetWithLeadingUnit.exec(relationText)?.groups;
  const relationship = additive ?? multiple.exec(relationText)?.groups;
  if (!relationship || past.test(total.verb) !== past.test(relationship.verb)) return null;

  const first = name(total.first), second = name(total.second);
  const subjectOwner = name(relationship.subject), referenceOwner = name(relationship.reference);
  const target = name(requested.owner);
  if (!first || !second || first === second || !target || target !== first && target !== second) return null;
  if (!(subjectOwner === first && referenceOwner === second || subjectOwner === second && referenceOwner === first)) return null;

  const totalKind = kind(total.unit, Boolean(total.currency));
  if (!totalKind || totalKind !== kind(relationship.unit, Boolean(relationship.currency))
    || totalKind !== kind(requested.unit, !requested.unit && /^(?:if )?how much\b/iu.test(question))) return null;
  const totalAmount = amount(total.amount);
  if (!totalAmount) return null;

  let referenceShare: WordExpression;
  if (additive) {
    const adjustment = amount(additive.amount);
    if (!adjustment) return null;
    const shares = operation(additive.direction.toLowerCase() === 'more' ? '-' : '+', totalAmount, adjustment, 'Balance the two shares');
    referenceShare = operation('/', shares, quantity('2'), 'Divide the balanced total between both owners');
  } else {
    const factor = relationship.factor.toLowerCase();
    const multiplier = amount(multipliers[factor] ?? factor.replace(/ times$/u, ''));
    if (!multiplier) return null;
    const shares = operation('+', quantity('1'), multiplier, 'Count the equal parts');
    referenceShare = operation('/', totalAmount, shares, 'Divide the total into equal parts');
  }
  const subjectShare = operation('-', totalAmount, referenceShare, 'Subtract to find the other share');
  const values = [evaluateWordExpression(referenceShare), evaluateWordExpression(subjectShare)];
  if (values.some(value => !value || value.value.startsWith('-'))) return null;
  return target === subjectOwner ? subjectShare : referenceShare;
}
