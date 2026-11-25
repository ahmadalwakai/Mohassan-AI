import { evaluateReferencedComputation } from '../computation-reference.js';
import { matchText } from '../mind/normalize.js';
import type { PlanToolResult } from './executor.js';
import { normalizePlanConversion, parseSourceComputation, sourceComputationExpression, type SourceComputation } from './source-computation.js';
import type { PlanStep, PlanValue, ResolvedStepInputs } from './types.js';

const NUMBER = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(?:\s*([^\d\r\n\s][^\r\n]*))?$/iu;
const BUDGET = /\b(?:buy|afford|purchase)\b|(?:اشتري|ابتاع|اجيب|جيب)(?!\p{L})/iu;
const USD = String.raw`USD|U\.S\. dollars?|US dollars?|dollars?|دولار(?:ا|ات)?(?: امريكي)?`;
const PRICE_AMOUNT = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const PURCHASE_BUDGET = new RegExp(String.raw`(?:(?:\$|\bUSD)\s*(${PRICE_AMOUNT})(?!\d|[.,]\d)|(?<![\d.,])(${PRICE_AMOUNT})\s*(?:${USD})(?!\p{L}))`, 'giu');
const GRAM = /\bgrams?\b|(?<!\p{L})(?:جرام|غرام)(?:ا|ات)?(?!\p{L})/iu;
const MASS_IN_GRAMS: Readonly<Record<string, number>> = { 'USD/g': 1, 'USD/kg': 1_000, 'USD/ozt': 31.1034768 };
const NUMBER_FORMAT = new Intl.NumberFormat('en', { useGrouping: false, maximumSignificantDigits: 15 });
const ARABIC = /\p{Script=Arabic}/u;

export function valueText(value: PlanValue): string {
  switch (value.type) {
    case 'number': return [NUMBER_FORMAT.format(value.value), value.unit].filter(Boolean).join(' ');
    case 'list': return value.value.join('\n');
    case 'entity': return [value.label || value.value, value.url].filter(Boolean).filter((item, index, items) => items.indexOf(item) === index).join('\n');
    case 'file': return [value.label, value.value].filter(Boolean).join('\n');
    case 'text': return value.value;
  }
}

function budgetComputation(step: PlanStep, inputs: ResolvedStepInputs): { expression: string; unit: string } | null {
  const normalized = matchText(step.text).replace(/٬/gu, ',').replace(/٫/gu, '.');
  const values = inputs.references.map(input => input.value);
  if (!BUDGET.test(normalized) || !GRAM.test(normalized) || values.length !== 1) return null;
  const price = values[0]!;
  if (price.type !== 'number' || !price.unit || !(price.unit in MASS_IN_GRAMS) || price.value <= 0) return null;
  const amounts = [...normalized.matchAll(PURCHASE_BUDGET)];
  if (amounts.length !== 1) return null;
  const amount = Number((amounts[0]![1] ?? amounts[0]![2])?.replace(/,/gu, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  // The price is per gram, kilogram or explicitly a troy ounce. An unqualified
  // ounce, missing price units, or different currency cannot supply the divisor.
  const grams = MASS_IN_GRAMS[price.unit]!;
  return { expression: `Calculate ${amount} / (${price.value} / ${grams})`, unit: ARABIC.test(step.text) ? 'غرام' : 'g' };
}

function runSourceComputation(operation: SourceComputation, source: Extract<PlanValue, { type: 'number' }>, now: Date): PlanToolResult {
  const expression = sourceComputationExpression(operation, source);
  if (!expression) return { ok: false, reason: 'missing_input' };
  const calculation = evaluateReferencedComputation(`Calculate ${expression}`, now);
  if (!calculation || calculation.status !== 'completed') return { ok: false, reason: 'invalid_result' };
  const computed = calculation.evidence.find(item => item.id === 'calculation')?.value;
  if (!computed || !NUMBER.test(computed)) return { ok: false, reason: 'invalid_result' };
  const evidence = { kind: 'computation', label: 'Local calculation' } as const;
  if ('unit' in operation && operation.unit) {
    if (!source.unit || !/^\p{L}{1,24}$/u.test(source.unit)) return { ok: false, reason: 'missing_input' };
    const conversion = evaluateReferencedComputation(`Convert ${computed} ${source.unit} to ${operation.unit}`, now);
    if (conversion?.status !== 'completed' || conversion.consumption?.kind !== 'conversion' || !conversion.consumption.complete) {
      return { ok: false, reason: 'invalid_result' };
    }
    const shown = conversion.evidence.find(item => item.id === 'calculation')?.value;
    if (!shown || !Number.isFinite(Number(shown))) return { ok: false, reason: 'invalid_result' };
    return { ok: true, value: { type: 'number', value: Number(shown), unit: operation.unit }, text: conversion.text, evidence };
  }
  const value = Number(computed);
  if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_result' };
  return { ok: true, value: { type: 'number', value, ...(source.unit ? { unit: source.unit } : {}) },
    text: [calculation.text, source.unit].filter(Boolean).join(' '), evidence };
}

export function runPlanComputation(step: PlanStep, inputs: ResolvedStepInputs, now: Date): PlanToolResult {
  const budget = budgetComputation(step, inputs);
  if (BUDGET.test(matchText(step.text)) && !budget) return {
    ok: false, reason: 'missing_input',
    question: ARABIC.test(step.text) ? 'ما السعر لكل غرام وبأي عملة؟' : 'What is the price per gram and in which currency?',
  };
  const source = inputs.references.length === 1 ? inputs.references[0]?.value : undefined;
  const operation = source?.type === 'number' ? parseSourceComputation(step.text) : null;
  if (!budget && operation && source?.type === 'number') return runSourceComputation(operation, source, now);
  const text = budget?.expression ?? inputs.text;
  const normalized = normalizePlanConversion(text);
  const calculation = evaluateReferencedComputation(text, now) ?? (normalized ? evaluateReferencedComputation(normalized, now) : null);
  if (!calculation) return { ok: false, reason: 'missing_input' };
  if (calculation.status !== 'completed') return { ok: false, reason: 'invalid_result', text: calculation.text };
  const shown = calculation.evidence.find(item => item.id === 'calculation')?.value;
  if (step.output === 'text') return { ok: true, value: { type: 'text', value: calculation.text }, evidence: { kind: 'computation', label: 'Local calculation' } };
  const number = shown && NUMBER.exec(shown);
  const value = number ? Number(number[1]) : NaN;
  if (!number || !Number.isFinite(value)) return { ok: false, reason: 'invalid_result' };
  const unit = budget?.unit ?? number[2]?.trim();
  const result: PlanValue = { type: 'number', value, ...(unit ? { unit } : {}) };
  return { ok: true, value: result, text: budget ? valueText(result) : calculation.text, evidence: { kind: 'computation', label: 'Local calculation' } };
}

export function runPlanComparison(step: PlanStep, inputs: ResolvedStepInputs): PlanToolResult {
  const values = inputs.references.map(input => input.value);
  if (values.length < 2) return { ok: false, reason: 'missing_input' };
  const ar = ARABIC.test(step.text);
  const figures = values.filter(value => value.type === 'number');
  const details = values.map((value, index) => `${index + 1}. ${'label' in value && value.label && value.type === 'number' ? `${value.label}\n` : ''}${valueText(value)}`);
  if (figures.length === values.length) {
    const units = new Set(figures.map(figure => figure.unit ?? ''));
    if (units.size !== 1) return {
      ok: false, reason: 'invalid_result', text: details.join('\n\n'),
      question: ar ? 'ما الوحدة الموحدة التي تريد المقارنة بها؟' : 'Which common unit should I use for the comparison?',
    };
    const sorted = figures.map((figure, index) => ({ value: figure.value, index })).sort((a, b) => b.value - a.value);
    const highest = sorted[0]!, lowest = sorted.at(-1)!;
    const gap = NUMBER_FORMAT.format(highest.value - lowest.value);
    const difference = [gap, figures[0]!.unit].filter(Boolean).join(' ');
    details.push(highest.value === lowest.value
      ? (ar ? 'القيم متساوية.' : 'The values are equal.')
      : (ar ? `الفرق بين أعلى قيمة وأدناها هو ${difference}.` : `The difference between the highest and lowest values is ${difference}.`));
  } else if (values.every(value => value.type === 'list' || value.type === 'text')) {
    const lists = values.map(value => value.type === 'list' ? value.value : valueText(value).split(/\r?\n/u));
    const canonical = (line: string) => line.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
    const indexed = lists.map(list => new Map(list.filter(line => line.trim()).map(line => [canonical(line), line])));
    const common = [...indexed[0]!.entries()].filter(([key]) => indexed.every(list => list.has(key))).map(([, line]) => line);
    details.push(common.length
      ? [ar ? 'العبارات المشتركة حرفيًا' : 'Exact matches shared by the results', ...common.map(line => `- ${line}`)].join('\n')
      : (ar ? 'لا توجد سطور متطابقة بين النتائج.' : 'The results share no matching lines.'));
  }
  const text = details.join('\n\n');
  return { ok: true, value: { type: 'text', value: text }, evidence: { kind: figures.length === values.length ? 'computation' : 'observation', label: 'Compared verified step results' } };
}
