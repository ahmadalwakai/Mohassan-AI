import type { KnowledgeAnswer } from '../../../packages/knowledge-base/src/qa-types.ts';

export interface GoldAnswer {
  kind: 'entity' | 'quantity' | 'date' | 'text' | 'boolean';
  values: (string | number | boolean)[];
}

type Answered = Extract<KnowledgeAnswer, { status: 'answered' }>;

function decimal(value: string | number | boolean): string {
  const parts = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  if (!parts) return String(value);
  const whole = parts[2].replace(/^0+(?=\d)/u, '');
  const fraction = parts[3]?.replace(/0+$/u, '');
  const sign = parts[1] === '-' && (whole !== '0' || fraction) ? '-' : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function equivalent(gold: GoldAnswer, prediction: Answered['values'][number], expected: string | number | boolean) {
  switch (prediction.kind) {
    case 'entity':
      return gold.kind === 'entity' && prediction.id === expected;
    case 'quantity':
      return gold.kind === 'quantity' && decimal(prediction.amount) === decimal(expected);
    case 'date': {
      if (gold.kind !== 'date' || prediction.calendar !== 'Q1985727') return false;
      const date = /^([+-]?\d{1,16})(?:-(\d{2})(?:-(\d{2}))?)?(?:T00:00:00Z)?$/u.exec(String(expected));
      return Boolean(date && prediction.year === Number(date[1]) &&
        (date[2] === undefined || prediction.month === Number(date[2])) &&
        (date[3] === undefined || prediction.day === Number(date[3])));
    }
    case 'text':
      return gold.kind === 'text' && [prediction.text, String(expected)]
        .map(text => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' '))
        .every((value, _, values) => value === values[0]);
  }
}

export function scoreAnswer(gold: GoldAnswer, answer: KnowledgeAnswer) {
  if (answer.status !== 'answered') return answer.status;
  const sourced = answer.facts.length > 0 && answer.facts.every(fact =>
    Boolean(fact.statement.snak && fact.source.url && Array.isArray(fact.references) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(fact.dates.snapshot)));
  if (!sourced) return 'missing-evidence';
  const matches = gold.values.length > 0 && answer.values.length > 0 &&
    gold.values.every(expected => answer.values.some(value => equivalent(gold, value, expected))) &&
    answer.values.every(value => gold.values.some(expected => equivalent(gold, value, expected)));
  return matches ? 'correct' : 'incorrect';
}
