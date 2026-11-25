import { evaluateExactArithmeticExpression } from './calculator.js';
import { operation, quantity, type WordExpression } from './word-problem-graph.js';
import type { SearchProblem, SearchQuantity, SearchTarget } from './arithmetic-search-quantities.js';

type Operator = '+' | '-' | '*' | '/';
type Dimension = { unit: string; per: string | null } | 'scalar' | null;
type Constant = 'conversion' | 'average' | 'percent' | 'complement';
type Binding = 'rate-product' | 'rate-quotient' | 'group-product' | 'share-quotient';

export interface SearchCandidate {
  graph: WordExpression;
  expression: string;
  value: string;
  features: Record<string, number>;
  operations: number;
}

interface Node {
  graph: WordExpression;
  expression: string;
  value: string;
  dimension: Dimension;
  mask: number;
  operations: number;
  inferred: number;
  support: number;
  root?: Operator;
  left?: Node;
  right?: Node;
  constant?: Constant;
  binding?: Binding;
}

interface Relation {
  dimension: Dimension;
  inferred: number;
  support: number;
  binding?: Binding;
}

const MAX_QUANTITIES = 7;
const MAX_OPERATIONS = 4;
const SUBSET_BEAM = 12;
const RESULT_LIMIT = 100;
const OPERATORS: readonly Operator[] = ['+', '-', '*', '/'];
const CUES = {
  addition: /\b(?:also|and|another|more|plus|additional|extra|added|add|combined|together|altogether|total)\b/u,
  gain: /\b(?:buy|buys|bought|get|gets|got|receive[ds]?|earn(?:ed|s)?|win|wins|won|added|adds?|gain(?:s|ed)?)\b/u,
  loss: /\b(?:lost|lose[sd]?|broke|broken|used?|gave|give[sn]?|ate|eat(?:en|s)?|spent|spends?|sold|sells?|removed?|minus|fewer|less|left|remaining|leftover|off)\b/u,
  distribution: /\b(?:per|each|every|apiece|daily|weekly|monthly|yearly|equally|rate|respectively)\b/u,
  comparison: /\b(?:than|compared|difference|between|fewer|as many|as much|as old|as long)\b/u,
  scaling: /\b(?:times|twice|thrice|triple[ds]?|double[ds]?|half|fraction|percent(?:age)?|discount|increased|decreased|reduced)\b|%/u,
  division: /\b(?:split|divid(?:e[ds]?|ing)|shar(?:e[ds]?|ing)|among|between|equally|per|apiece|ratio|average|mean)\b/u,
  cost: /\b(?:costs?|pay(?:s|ing)?|paid|price[ds]?|spen[dt]|buy|buys|bought|purchase[ds]?|earn(?:s|ed)?|worth|charged?)\b/u,
  uncertainty: /\b(?:some|several|unknown|at least|at most|approximately|about|either|neither|unless|except|respectively|not)\b/u,
};

const CURRENCY = new Set(['dollar', 'euro', 'pound sterling', 'cent', 'penny', 'yen']);
const INVENTORY_BEFORE_AMOUNT = /\b(?:has|had|have|owns?|owned|begins?|began|starts?|started|there (?:are|were))\b/u;
const CREDIT_BEFORE_AMOUNT = /\b(?:added|bought|purchased|gets?|got|received|acquired|earned|won|collected|picked)\s*(?:an?|another|about|on|extra|additional|more)?\s*[$£€¥]?\s*$/u;
const DEBIT_BEFORE_AMOUNT = /\b(?:lost|sold|spent|used|gave away|discarded|donated|ate|removed|took out|threw away)\s*[$£€¥]?\s*$/u;
const EXPLICIT_SHARE = /\b(?:each|apiece|per|evenly|equally|average)\b/u;
const CONVERSIONS: Readonly<Record<string, readonly [family: string, scale: number]>> = {
  second: ['fixed time', 1], minute: ['fixed time', 60], hour: ['fixed time', 3_600],
  day: ['fixed time', 86_400], week: ['fixed time', 604_800],
  month: ['calendar', 1], year: ['calendar', 12],
  millimeter: ['metric length', 1], centimeter: ['metric length', 10],
  meter: ['metric length', 1_000], kilometer: ['metric length', 1_000_000],
  inch: ['customary length', 1], foot: ['customary length', 12],
  yard: ['customary length', 36], mile: ['customary length', 63_360],
  milliliter: ['metric volume', 1], liter: ['metric volume', 1_000],
  milligram: ['metric mass', 1], gram: ['metric mass', 1_000], kilogram: ['metric mass', 1_000_000],
};

function span(problem: SearchProblem, index: number): string {
  const q = problem.quantities[index]!;
  return `${q.before.slice(-5).join(' ')} ${q.after.slice(0, 5).join(' ')}`;
}

function dimensionKey(type: Dimension): string {
  if (type === null) return '?';
  return type === 'scalar' ? '' : `${type.unit}/${type.per ?? ''}`;
}

function sameUnit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a === 'money' && CURRENCY.has(b) || b === 'money' && CURRENCY.has(a);
}

function compatible(a: Dimension, b: Dimension): boolean {
  if (!a || !b || a === 'scalar' || b === 'scalar') return a === b;
  return sameUnit(a.unit, b.unit) && (a.per === b.per || sameUnit(a.per, b.per));
}

function targetMatch(dimension: Dimension, target: SearchTarget): number {
  if (dimension === null) return 0;
  if (dimension === 'scalar') return target.intent === 'percentage' || target.intent === 'comparison' ? 1 : target.unit ? -1 : 0;
  if (target.intent === 'percentage') return -1;
  if (target.unit && !sameUnit(dimension.unit, target.unit)) return -1;
  if (!target.per && dimension.per && !['per-unit', 'rate'].includes(target.intent)) return -1;
  if (target.per && dimension.per && !sameUnit(target.per, dimension.per)) return -1;
  return target.unit && (!target.per || dimension.per) ? 1 : 0;
}

function literal(value: string, dimension: Dimension, mask: number, constant?: Constant): Node | null {
  const evaluated = evaluateExactArithmeticExpression(value);
  if (!evaluated.ok) return null;
  return { graph: quantity(value), expression: value, value: evaluated.value, dimension, mask, operations: 0, inferred: 0, support: 0, constant };
}

function operand(value: string): string {
  return value.includes('/') || value.startsWith('-') ? `(${value})` : value;
}

function combine(operator: Operator, left: Node, right: Node, relation: Relation, label?: string): Node | null {
  const operations = left.operations + right.operations + 1;
  if (operations > MAX_OPERATIONS) return null;
  const result = evaluateExactArithmeticExpression(`${operand(left.value)} ${operator} ${operand(right.value)}`);
  if (!result.ok) return null;
  const show = (node: Node) => node.root ? `(${node.expression})` : operand(node.expression);
  return {
    graph: operation(operator, left.graph, right.graph, label), expression: `${show(left)} ${operator} ${show(right)}`,
    value: result.value, dimension: relation.dimension, mask: left.mask | right.mask, operations,
    inferred: left.inferred + right.inferred + relation.inferred, support: left.support + right.support + relation.support,
    root: operator, left, right, binding: relation.binding,
  };
}

function bitCount(mask: number): number {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
}

function leafIndex(mask: number): number {
  return 31 - Math.clz32(mask);
}

function localPair(problem: SearchProblem, left: Node, right: Node): {
  forward: boolean; group: boolean; distribution: boolean; division: boolean; comparison: boolean; loss: boolean; gain: boolean; cost: boolean;
} {
  const first = left.mask && leafIndex(left.mask & -left.mask);
  const next = right.mask && leafIndex(right.mask & -right.mask);
  const earlier = Math.min(first, next);
  const later = Math.max(first, next);
  const a = problem.quantities[earlier]!;
  const b = problem.quantities[later]!;
  const near = later === earlier + 1 && b.sentence - a.sentence <= 1;
  const between = problem.text.slice(a.end, b.start).toLowerCase();
  const beforeSecond = b.before.slice(-5).join(' ');
  const around = `${between} ${b.after.slice(0, 4).join(' ')}`;
  const bothLeaves = bitCount(left.mask) === 1 && bitCount(right.mask) === 1;
  return {
    forward: first < next,
    group: bothLeaves && near && a.sentence === b.sentence && /^[\w' -]+\b(?:of|with|containing|holding|holds?)\s*$/u.test(between),
    distribution: bothLeaves && near && CUES.distribution.test(around),
    division: near && (CUES.division.test(around) || b.category === 'time' && /\b(?:in|over|during|for|every)\s*$/u.test(between)),
    comparison: near && CUES.comparison.test(around),
    loss: near && CUES.loss.test(beforeSecond),
    gain: near && CUES.gain.test(beforeSecond),
    cost: bothLeaves && near && CUES.cost.test(`${a.before.slice(-4).join(' ')} ${around}`),
  };
}

function relationFor(operator: Operator, left: Node, right: Node, problem: SearchProblem): Relation | null {
  const a = left.dimension;
  const b = right.dimension;
  const target = problem.target;
  const pair = localPair(problem, left, right);
  if (operator === '+' || operator === '-') {
    if (a && b && !compatible(a, b)) return null;
    const support = operator === '+' ? (pair.gain ? 2 : 0) - (pair.loss ? 2 : 0)
      : (pair.loss && pair.forward ? 3 : 0) + (pair.comparison ? 1 : 0);
    return { dimension: a ?? b, inferred: a && b ? 0 : 1, support: support + (a && b ? 2 : 0) };
  }
  if (operator === '*') {
    if (a === 'scalar' || b === 'scalar') return { dimension: a === 'scalar' ? b : a, inferred: 0, support: 3 };
    if (a && b) {
      if (sameUnit(a.per, b.unit) && sameUnit(b.per, a.unit)) return { dimension: 'scalar', inferred: 0, support: 4, binding: 'rate-product' };
      if (sameUnit(a.per, b.unit)) return { dimension: { unit: a.unit, per: b.per }, inferred: 0, support: 4, binding: 'rate-product' };
      if (sameUnit(b.per, a.unit)) return { dimension: { unit: b.unit, per: a.per }, inferred: 0, support: 4, binding: 'rate-product' };
      // A bound rate only scales across its own denominator.
      if (a.per || b.per) return null;
      if (pair.group && !sameUnit(a.unit, b.unit)) {
        return { dimension: pair.forward ? b : a, inferred: 0, support: 4, binding: 'group-product' };
      }
      if ((pair.distribution || pair.cost) && target.unit && sameUnit(a.unit, target.unit) !== sameUnit(b.unit, target.unit)) {
        return { dimension: sameUnit(a.unit, target.unit) ? a : b, inferred: 1, support: pair.distribution ? 2 : 0 };
      }
      return null;
    }
    if (!pair.distribution && !pair.group && !pair.cost && Boolean(a) !== Boolean(b)) return null;
    return { dimension: a ?? b, inferred: 1, support: pair.distribution || pair.group ? 1 : 0 };
  }
  if (b === 'scalar') return { dimension: a, inferred: 0, support: 2 };
  if (!a || !b) return { dimension: a ?? null, inferred: 1, support: pair.distribution ? 1 : 0 };
  if (a === 'scalar') {
    return b.per ? { dimension: { unit: b.per, per: b.unit }, inferred: 0, support: 2 } : null;
  }
  if (compatible(a, b)) {
    if (!pair.division && !pair.comparison && !['comparison', 'percentage', 'rate', 'per-unit'].includes(target.intent)) return null;
    return { dimension: 'scalar', inferred: 0, support: 2 + Number(pair.comparison) };
  }
  if (sameUnit(a.unit, b.unit) && !a.per && b.per) return { dimension: { unit: b.per, per: null }, inferred: 0, support: 4, binding: 'rate-quotient' };
  if (sameUnit(a.per, b.per)) return { dimension: { unit: a.unit, per: b.unit }, inferred: 0, support: 3 };
  if (a.per || b.per) return null;
  if (pair.group || !pair.division && !['rate', 'per-unit', 'average'].includes(target.intent)) return null;
  return { dimension: { unit: a.unit, per: b.unit }, inferred: pair.division ? 0 : 1, support: pair.division ? 3 : 1, binding: 'share-quotient' };
}

function preferredRoot(node: Node, target: SearchTarget): boolean {
  switch (target.intent) {
    case 'remainder': return node.root === '-' || node.root === '*';
    case 'difference': return node.root === '-';
    case 'rate':
    case 'per-unit': return node.root === '/' || node.root === '*';
    case 'average': return node.root === '/';
    case 'percentage': return asksPercent(target) ? node.root === '*' && node.right?.constant === 'percent' : node.root === '/';
    case 'comparison': return node.root === '-' || node.root === '/';
    case 'total': return node.root === '+' || node.root === '*';
    case 'unknown': return true;
  }
}

function asksPercent(target: SearchTarget): boolean {
  return /\b(?:percent(?:age)?|per cent)\b/u.test(target.words.join(' '));
}

function conversionDestinations(problem: SearchProblem): string[] {
  return [...new Set([problem.target.unit, problem.target.per, ...problem.quantities.map(item => item.per)]
    .filter((unit): unit is string => unit !== null && Object.hasOwn(CONVERSIONS, unit)))];
}

function conversions(node: Node, destinations: readonly string[]): Node[] {
  const result: Node[] = [];
  if (!node.dimension || node.dimension === 'scalar' || node.dimension.per || !Object.hasOwn(CONVERSIONS, node.dimension.unit)) return result;
  const [family, from] = CONVERSIONS[node.dimension.unit]!;
  for (const unit of destinations) {
    const [targetFamily, to] = CONVERSIONS[unit]!;
    if (unit === node.dimension.unit || family !== targetFamily) continue;
    const divide = to % from === 0;
    const factor = divide ? String(to / from) : from % to === 0 ? String(from / to) : `${from}/${to}`;
    const constant = literal(factor, 'scalar', 0, 'conversion');
    const converted = constant && combine(divide ? '/' : '*', node, constant, { dimension: { unit, per: null }, inferred: 0, support: 2 },
      `Convert ${node.dimension.unit} to ${unit}`);
    if (converted) result.push(converted);
  }
  return result;
}

function leaves(q: SearchQuantity, index: number, problem: SearchProblem, destinations: readonly string[]): Node[] {
  const dimension = q.unit ? { unit: q.unit, per: q.per } : q.kind === 'amount' ? null : 'scalar';
  const node = literal(q.value, dimension, 1 << index);
  if (!node) return [];
  const result = [node, ...conversions(node, destinations)];
  if (dimension === 'scalar' && (q.kind === 'fraction' || q.kind === 'percentage')
    && CUES.loss.test(`${span(problem, index)} ${problem.target.words.join(' ')}`)) {
    const one = literal('1', 'scalar', 0, 'complement');
    const complement = one && combine('-', one, node, { dimension: 'scalar', inferred: 0, support: 3 }, 'Find the remaining fraction');
    if (complement && !complement.value.startsWith('-')) result.push(complement);
  }
  return result;
}

function completion(node: Node, problem: SearchProblem, destinations: readonly string[]): Node[] {
  const result = [node];
  const { target } = problem;
  if (target.intent === 'average' && node.root === '+' && targetMatch(node.dimension, target) >= 0) {
    const count = literal(String(bitCount(node.mask)), 'scalar', 0, 'average');
    const average = count && combine('/', node, count, { dimension: node.dimension, inferred: 0, support: 3 }, 'Divide by the number of observations');
    if (average) result.push(average);
  }
  if (target.intent === 'percentage' && asksPercent(target) && node.dimension === 'scalar' && node.root === '/') {
    const hundred = literal('100', 'scalar', 0, 'percent');
    const percent = hundred && combine('*', node, hundred, { dimension: 'scalar', inferred: 0, support: 3 }, 'Convert the ratio to a percentage');
    if (percent) result.push(percent);
  }
  if (target.unit && destinations.includes(target.unit) && node.right?.constant !== 'conversion') {
    result.push(...conversions(node, [target.unit]));
  }
  return result;
}

function usesBalanceDirections(node: Node, problem: SearchProblem): boolean {
  const { quantities, target } = problem;
  if (target.intent !== 'remainder' || !target.unit || node.value.startsWith('-')
    || quantities.some(q => !sameUnit(q.unit, target.unit) || q.per || q.inQuestion)
    || !INVENTORY_BEFORE_AMOUNT.test(quantities[0]!.before.join(' '))) return false;

  const annotatedSigns = quantities.map((q, index) => {
    if (index === 0) return 1;
    const text = problem.text.slice(quantities[index - 1]!.end, q.start).toLowerCase();
    if (DEBIT_BEFORE_AMOUNT.test(text)) return -1;
    return CREDIT_BEFORE_AMOUNT.test(text) ? 1 : 0;
  });
  if (annotatedSigns.includes(0) || !annotatedSigns.includes(-1)) return false;
  function signsMatch(current: Node, sign: number): boolean {
    if (!current.root) return annotatedSigns[leafIndex(current.mask)] === sign;
    return (current.root === '+' || current.root === '-') && signsMatch(current.left!, sign)
      && signsMatch(current.right!, current.root === '-' ? -sign : sign);
  }
  return signsMatch(node, 1);
}

function addCoherentFeatures(node: Node, problem: SearchProblem, features: Record<string, number>): void {
  if (features.omitted || features.matched !== 1 || CUES.uncertainty.test(problem.context.toLowerCase())) return;
  const { quantities, target } = problem;
  if (usesBalanceDirections(node, problem)) features['bound:inventory'] = 1;
  if (target.intent === 'remainder' && quantities.length === 2 && features['constant:complement']) features['bound:remainder-share'] = 1;
  if (node.binding === 'share-quotient' && node.dimension && node.dimension !== 'scalar' && node.dimension.per
    && ['rate', 'per-unit'].includes(target.intent) && EXPLICIT_SHARE.test(target.words.join(' '))) {
    features['bound:requested-share'] = 1;
    if (sameUnit(node.dimension.per, target.per)) features['bound:requested-denominator'] = 1;
    if (node.left?.root === '+' && !node.right?.root) features['bound:combined-share'] = 1;
  }
  if (node.binding === 'rate-product' && !features.inferred) features['bound:rate-product'] = 1;
  if (node.binding === 'rate-quotient' && !features.inferred) features['bound:rate-quotient'] = 1;
  if (node.binding === 'group-product' && quantities.length === 2 && target.intent === 'total') features['bound:group-total'] = 1;
  if (target.intent === 'average' && features['constant:average'] && !features.inferred) features['bound:average'] = 1;
}

function candidateFeatures(node: Node, problem: SearchProblem, spans: readonly string[], prior: number): Record<string, number> {
  const { quantities, target } = problem;
  const chosen = quantities.map((q, index) => ({ q, index })).filter(({ index }) => node.mask & (1 << index));
  const used = chosen.length;
  const matching = chosen.filter(({ q }) => sameUnit(q.unit, target.unit));
  const targetWords = target.words.join(' ');
  const features: Record<string, number> = {
    bias: 1,
    operations: node.operations,
    used,
    available: quantities.length,
    omitted: quantities.length - used,
    support: node.support / node.operations,
    prior,
    inferred: node.inferred,
    matched: targetMatch(node.dimension, target),
    matchingInputs: matching.length,
    hasTarget: Number(Boolean(target.unit)),
    preferred: Number(preferredRoot(node, target)),
    integer: Number(/^-?\d+$/u.test(node.value)),
    negative: Number(node.value.startsWith('-')),
    zero: Number(node.value === '0'),
    usedQuestion: chosen.filter(({ q }) => q.inQuestion).length,
    omittedQuestion: quantities.filter(q => q.inQuestion).length - chosen.filter(({ q }) => q.inQuestion).length,
    entities: new Set(chosen.map(({ q }) => q.entity).filter(Boolean)).size,
    targetEntity: chosen.filter(({ q }) => q.entity && q.entity === target.entity).length,
    amountUnits: new Set(chosen.map(({ q }) => q.unit).filter(Boolean)).size,
    repeatedUnit: Number(chosen.some(({ q }, index) => chosen.slice(index + 1).some(item => sameUnit(q.unit, item.q.unit)))),
    span: chosen.at(-1)!.index - chosen[0]!.index,
    sentenceGap: chosen.at(-1)!.q.sentence - chosen[0]!.q.sentence,
    [`root:${node.root}`]: 1,
    [`intent:${target.intent}`]: 1,
    [`intent:${target.intent}:${node.root}`]: 1,
    [`steps:${node.operations}`]: 1,
    [`used:${used}`]: 1,
    [`available:${quantities.length}`]: 1,
  };
  for (const [cue, pattern] of Object.entries(CUES)) {
    if (pattern.test(targetWords)) features[`question:${cue}:${node.root}`] = 1;
    const near = chosen.filter(({ index }) => pattern.test(spans[index]!)).length;
    if (near) features[`near:${cue}:${node.root}`] = near / used;
    if (pattern.test(problem.text.toLowerCase())) features[`text:${cue}:${node.root}`] = 1;
  }
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.root) {
      const key = `operation:${current.root}`;
      features[key] = (features[key] ?? 0) + 1;
      stack.push(current.left!, current.right!);
    }
    if (current.constant) features[`constant:${current.constant}`] = 1;
  }
  for (const { q } of chosen) {
    const key = `quantity:${q.kind}`;
    features[key] = (features[key] ?? 0) + 1;
  }
  if (node.left!.mask && node.right!.mask) {
    const pair = localPair(problem, node.left!, node.right!);
    for (const [cue, active] of Object.entries(pair)) if (active) features[`pair:${cue}:${node.root}`] = 1;
  }
  addCoherentFeatures(node, problem, features);
  return features;
}

function rankPrior(node: Node, target: SearchTarget): number {
  const match = targetMatch(node.dimension, target);
  return node.support / Math.max(1, node.operations) - node.inferred * 0.75 + match * 1.25
    + Number(preferredRoot(node, target)) + bitCount(node.mask) * 0.2 - node.operations * 0.3;
}

function bestDistinct(nodes: Node[], target: SearchTarget, limit: number, reserveDimensions: boolean): Node[] {
  const ranked = nodes.map(node => ({ node, rank: rankPrior(node, target) })).sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  const dimensions = new Set<string>();
  const result: Node[] = [];
  if (reserveDimensions) {
    for (const { node } of ranked) {
      const dimension = `${node.root ?? ''}:${dimensionKey(node.dimension)}`;
      if (dimensions.has(dimension)) continue;
      dimensions.add(dimension);
      seen.add(`${node.mask}:${dimensionKey(node.dimension)}:${node.expression}`);
      result.push(node);
      if (result.length === limit) return result;
    }
  }
  for (const { node } of ranked) {
    const key = `${node.mask}:${dimensionKey(node.dimension)}:${node.expression}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
    if (result.length === limit) break;
  }
  return result;
}

/** Build a bounded beam of typed trees. An observed quantity is used at most once in a tree. */
export function searchCandidates(problem: SearchProblem): SearchCandidate[] {
  const count = problem.quantities.length;
  if (count === 0 || count > MAX_QUANTITIES) return [];
  const destinations = conversionDestinations(problem);
  const full = (1 << count) - 1;
  const chart: Node[][] = Array.from({ length: full + 1 }, () => []);
  const complete: Node[] = [];
  for (let mask = 1; mask <= full; mask++) {
    const size = bitCount(mask);
    if (size === 1) {
      const index = leafIndex(mask);
      chart[mask] = leaves(problem.quantities[index]!, index, problem, destinations);
      if (count === 1 && problem.target.unit) complete.push(...chart[mask]!.filter(node =>
        node.right?.constant === 'conversion' && targetMatch(node.dimension, problem.target) === 1));
      continue;
    }
    if (size > MAX_OPERATIONS + 1) continue;
    const current: Node[] = [];
    for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
      const rest = mask ^ sub;
      if (sub >= rest) continue;
      for (const first of chart[sub]!) for (const second of chart[rest]!) {
        if (first.operations + second.operations >= MAX_OPERATIONS) continue;
        for (const operator of OPERATORS) {
          const orders = operator === '+' || operator === '*' ? [[first, second]] : [[first, second], [second, first]];
          for (const [left, right] of orders) {
            const relation = relationFor(operator, left!, right!, problem);
            const built = relation && combine(operator, left!, right!, relation);
            if (built) current.push(built);
          }
        }
      }
    }
    chart[mask] = bestDistinct(current, problem.target, SUBSET_BEAM, true);
    const matching = bestDistinct(current.filter(node => targetMatch(node.dimension, problem.target) >= 0), problem.target, SUBSET_BEAM, false);
    for (const node of new Set([...matching, ...chart[mask]!])) for (const result of completion(node, problem, destinations)) {
      if (targetMatch(result.dimension, problem.target) < 0) continue;
      if (['percentage', 'average', 'difference'].includes(problem.target.intent) && !preferredRoot(result, problem.target)) continue;
      complete.push(result);
    }
  }
  const spans = problem.quantities.map((_, index) => span(problem, index));
  return bestDistinct(complete, problem.target, RESULT_LIMIT, false).map(node => ({
    graph: node.graph, expression: node.expression, value: node.value, operations: node.operations,
    features: candidateFeatures(node, problem, spans, rankPrior(node, problem.target)),
  }));
}
