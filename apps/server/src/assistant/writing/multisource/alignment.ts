import { arabicBase, englishStem, foldText, skillStems } from '@mohassan/skills';
import type { WritingSource } from '../evidence.js';
import { sourceBodyIdentity, sourceIdentity } from './gather.js';
import type { Claim, ClaimConflict, ClaimGroup } from './types.js';

const NEGATION = /\b(?:no|not|never|cannot)\b|n['’]t\b|(?<!\p{L})(?:[وف]?(?:لا|لم|لن)|ليس(?:ت)?|غير)(?!\p{L})/gu;
const QUALIFIER = /\b(?:about|around|roughly|approximately|estimated|typically|usually|sometimes|at least|at most|more than|less than|up to|if|unless|during|as of)\b|(?<!\p{L})(?:حوالي|نحو|تقريبا|يقدر|تقدر|عاده|احيانا|علي الاقل|علي الاكثر|اكثر من|اقل من|حتي|اذا|خلال)(?!\p{L})/u;
const POSSIBLE = /\b(?:can|could|may|might|possible|sometimes|often|usually)\b|(?<!\p{L})(?:[وف]?(?:قد|ربما|يمكن|احيانا|غالبا))(?!\p{L})/u;
const NUMBER = /(?<![\p{L}\p{N}.])[-+]?\d+(?:[.,٫٬]\d+)*/gu;
const RELATION_FILLERS = /\b(?:not|no|never|cannot|have|has|had|does|do|did|being|but|then|so)\b|(?<!\p{L})(?:[وف]?(?:لا|لم|لن)|ليس(?:ت)?|فان|فانه|فانها)(?!\p{L})/gu;

function contentTerms(text: string): Set<string> {
  return new Set(skillStems(foldText(text).replace(/n['’]t\b/gu, '').replace(RELATION_FILLERS, ' ')));
}

function entityWords(text: string): string[] {
  return (foldText(text).replace(/^(?:the|an?)\s+/u, '').match(/[\p{L}\p{N}]+(?:[+#]+)?/gu) ?? [])
    .map(word => arabicBase(word));
}

/** Require the full entity name. A shared word does not make two names equivalent. */
export function sameEntity(left: string, right: string): boolean {
  const a = entityWords(left).join(' ');
  return Boolean(a) && a === entityWords(right).join(' ');
}

function matchingTerms(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (!a.size || !b.size) return false;
  const shared = [...a].filter(term => b.has(term)).length;
  if (a.size === 1 || b.size === 1) return a.size === b.size && shared === 1;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.8 && shared / Math.max(a.size, b.size) >= 0.64;
}

// Normalize single values and the most common units. Keep qualifiers and unknown units in the comparison frame.
const units: readonly [RegExp, string, number][] = [
  [/^\s*(?:kilomet(?:er|re)s?|km|كيلومتر(?:ا|ات)?)(?![\p{L}\p{N}])/u, 'length', 1000],
  [/^\s*(?:centimet(?:er|re)s?|cm|سنتيمتر(?:ا|ات)?)(?![\p{L}\p{N}])/u, 'length', 0.01],
  [/^\s*(?:millimet(?:er|re)s?|mm|مليمتر(?:ا|ات)?)(?![\p{L}\p{N}])/u, 'length', 0.001],
  [/^\s*(?:met(?:er|re)s?|m|متر(?:ا|ات)?|امتار)(?![\p{L}\p{N}])/u, 'length', 1],
  [/^\s*(?:kilograms?|kg|كيلو[غج]رام(?:ا|ات)?)(?!\p{L})/u, 'mass', 1000],
  [/^\s*(?:grams?|g|[غج]رام(?:ا|ات)?)(?!\p{L})/u, 'mass', 1],
  [/^\s*(?:percent(?:age)?|%|٪|بالمئ[هة]|في المئ[هة])(?!\p{L})/u, 'percent', 1],
];

interface Quantity { amount: number; frame: string }

function numberValue(text: string): number {
  const normalized = text.replace(/٬/gu, '').replace(/٫/gu, '.');
  const grouping = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;
  return Number(grouping.test(normalized) ? normalized.replace(/,/gu, '') : normalized.replace(/,/gu, '.'));
}

function quantity(value: string, numbers: readonly RegExpMatchArray[]): Quantity | undefined {
  const item = numbers.length === 1 ? numbers[0] : undefined;
  if (!item || item.index === undefined) return undefined;
  const amount = numberValue(item[0]);
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) return undefined;
  const after = value.slice(item.index + item[0].length);
  const unit = units.find(([pattern]) => pattern.test(after));
  const frame = `${value.slice(0, item.index)} ${unit ? after.replace(unit[0], ` ${unit[1]} `) : after}`
    .replace(/[\s.!?؟]+$/u, '').replace(/\s+/gu, ' ').trim();
  return { amount: amount * (unit?.[2] ?? 1), frame };
}

interface Features {
  claim: Claim;
  publisher: string | undefined;
  terms: Set<string>;
  cause: Role;
  effect: Role;
  numbers: number[];
  quantity?: Quantity;
  negated: boolean;
  qualified: boolean;
  statement: string;
}

interface Role { terms: Set<string>; statement: string; negations: number; possible: boolean }

function role(value = ''): Role {
  const folded = foldText(value);
  return { terms: contentTerms(folded), statement: folded.replace(/\s+/gu, ' ').trim(),
    negations: folded.match(NEGATION)?.length ?? 0, possible: POSSIBLE.test(folded) };
}

function features(claim: Claim, publisher: string | undefined): Features {
  const value = claim.value ?? claim.span.text;
  const folded = foldText(value).replace(/[−–]/gu, '-');
  const statement = foldText(claim.span.text);
  const numbers = [...folded.matchAll(NUMBER)];
  return {
    claim,
    publisher,
    terms: contentTerms(value),
    cause: role(claim.cause),
    effect: role(claim.effect),
    numbers: numbers.map(item => numberValue(item[0])),
    quantity: quantity(folded, numbers),
    negated: claim.negated ?? Boolean(folded.match(NEGATION)),
    qualified: Boolean(claim.conditioned || QUALIFIER.test(statement)),
    statement,
  };
}

function sameScope(a: Claim, b: Claim): boolean {
  if (a.kind !== b.kind) return false;
  if (a.subject && b.subject && !sameEntity(a.subject, b.subject)) return false;
  if (a.contrasted && b.contrasted && !sameEntity(a.contrasted, b.contrasted)) return false;
  if (a.attribute && b.attribute && !sameEntity(a.attribute, b.attribute)) return false;
  if (a.step !== undefined && b.step !== undefined && a.step !== b.step) return false;
  return true;
}

function sameDescription(left: Features, right: Features): boolean {
  if (!sameScope(left.claim, right.claim)) return false;
  if (left.claim.kind === 'causal') return left.cause.negations === right.cause.negations && left.effect.negations === right.effect.negations
    && matchingTerms(left.cause.terms, right.cause.terms) && matchingTerms(left.effect.terms, right.effect.terms);
  return matchingTerms(left.terms, right.terms);
}

function sameAmount(left: Quantity, right: Quantity): boolean {
  const tolerance = Number.EPSILON * Math.max(Math.abs(left.amount), Math.abs(right.amount));
  return Math.abs(left.amount - right.amount) <= tolerance;
}

function sameNumericProperty(left: Features, right: Features): boolean {
  const a = left.claim, b = right.claim;
  return a.kind === 'attribute' && b.kind === 'attribute'
    && Boolean(a.subject && b.subject && sameEntity(a.subject, b.subject))
    && Boolean(a.attribute && b.attribute && sameEntity(a.attribute, b.attribute))
    && left.quantity !== undefined && right.quantity !== undefined && left.quantity.frame === right.quantity.frame;
}

function agree(left: Features, right: Features): boolean {
  if (left.negated !== right.negated) return false;
  if ((left.qualified || right.qualified) && left.statement !== right.statement) return false;
  if (sameNumericProperty(left, right)) return sameAmount(left.quantity!, right.quantity!);
  return sameNumbers(left, right) && sameDescription(left, right);
}

function sameNumbers(left: Features, right: Features): boolean {
  return left.numbers.length === right.numbers.length && left.numbers.every((number, index) => number === right.numbers[index]);
}

const polarityFillers = /\b(?:does|do|did|no|not|never)\b|(?<!\p{L})(?:[وف]?(?:لا|لم|لن))(?!\p{L})/gu;

/** For oppositions, retain ordering, scope words and duplicate terms. */
function polaritySignature(role: Role): string {
  const terms = role.statement.replace(/n['’]t\b/gu, '').replace(polarityFillers, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map(term => /^[a-z]+$/u.test(term) ? englishStem(term) : term).join(' ');
}

function oppositeRole(left: Role, right: Role): boolean {
  return !left.possible && !right.possible && left.negations + right.negations === 1
    && Boolean(left.terms.size && right.terms.size) && polaritySignature(left) === polaritySignature(right);
}

function conflictingCausalClause(left: Features, right: Features): boolean {
  if (left.claim.kind !== 'causal' || left.negated || right.negated || !sameScope(left.claim, right.claim) || !sameNumbers(left, right)) return false;
  return left.cause.statement === right.cause.statement && oppositeRole(left.effect, right.effect)
    || left.effect.statement === right.effect.statement && oppositeRole(left.cause, right.cause);
}

// These relations can naturally have several values, so two numerical observations need not conflict.
const multipleValues = new Set(['composition', 'function', 'input', 'output', 'location', 'mechanism', 'property', 'schedule']);

function conflict(left: Features, right: Features): boolean {
  if (!left.publisher || !right.publisher || left.publisher === right.publisher) return false;
  if (conflictingCausalClause(left, right)) return true;
  if (left.qualified || right.qualified) return false;
  if (left.negated !== right.negated && left.claim.negated !== undefined && right.claim.negated !== undefined
    && sameNumbers(left, right)) {
    return sameDescription(left, right);
  }
  return !left.negated && !right.negated && !multipleValues.has(left.claim.attribute ?? '')
    && sameNumericProperty(left, right) && !sameAmount(left.quantity!, right.quantity!);
}

/** Group compatible claims and retain the literal pair for each direct, cross-publisher conflict. */
export function alignClaims(claims: readonly Claim[]): { groups: ClaimGroup[]; conflicts: ClaimConflict[] } {
  const groups: { members: Features[]; publishers: Set<string | undefined> }[] = [];
  const sourcePublishers = new Map<WritingSource, string | undefined>();
  const publisherByBody = new Map<string, string>();
  for (const claim of claims) {
    const source = claim.span.source;
    if (!sourcePublishers.has(source)) {
      const publisher = sourceIdentity(source);
      const body = sourceBodyIdentity(source);
      const independentPublisher = publisher && body ? publisherByBody.get(body) ?? publisher : publisher;
      if (body && independentPublisher) publisherByBody.set(body, independentPublisher);
      sourcePublishers.set(source, independentPublisher);
    }
    const item = features(claim, sourcePublishers.get(source));
    // Requiring agreement with all members keeps a broad middle claim from joining incompatible claims.
    const group = groups.find(candidate => candidate.members.every(member => agree(item, member)));
    if (group) {
      group.members.push(item);
      group.publishers.add(item.publisher);
    } else {
      groups.push({ members: [item], publishers: new Set([item.publisher]) });
    }
  }
  const conflicts: ClaimConflict[] = [];
  for (const [index, group] of groups.entries()) {
    for (const other of groups.slice(index + 1)) {
      const left = group.members.find(member => other.members.some(peer => conflict(member, peer)));
      const right = left && other.members.find(member => conflict(left, member));
      if (left && right) conflicts.push({ left: left.claim, right: right.claim });
    }
  }
  return {
    groups: groups.map(group => ({ claims: group.members.map(member => member.claim), support: group.publishers.size }))
      .sort((a, b) => b.support - a.support),
    conflicts,
  };
}
