import type { Fact } from './query.ts';
import { formatAmount, quantityInUnit, readWikidataDate, unitId } from './query-values.ts';
import type { KnowledgeAnswerType, KnowledgeFact, KnowledgeValue } from './qa-types.ts';

function fields(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function readKnowledgeValue(
  fact: Fact,
  expected: KnowledgeAnswerType,
  label: (id: string) => string,
): KnowledgeValue | undefined {
  const { snak } = fact.statement;
  const data = snak.snaktype === 'value' ? snak.datavalue : undefined;
  if (!data) return;
  const value = fields(data.value);
  if (expected === 'entity' && data.type === 'wikibase-entityid') {
    const id = value?.id ?? (value?.['entity-type'] === 'item' && Number.isSafeInteger(value['numeric-id'])
      ? `Q${value['numeric-id']}` : undefined);
    if (typeof id === 'string' && /^Q[1-9]\d*$/u.test(id)) return { kind: 'entity', id, label: label(id) };
  }
  if (expected === 'quantity' && data.type === 'quantity' && typeof value?.unit === 'string') {
    const unit = unitId(value.unit);
    const amount = unit && quantityInUnit(fact.statement, unit);
    if (unit && amount) return { kind: 'quantity', amount: formatAmount(amount), unit };
  }
  if (expected === 'date') return readWikidataDate(snak);
  if (expected === 'text') {
    if (data.type === 'string' && typeof data.value === 'string' && data.value.trim()) {
      return { kind: 'text', text: data.value };
    }
    if (data.type === 'monolingualtext' && typeof value?.text === 'string' && value.text.trim() &&
      typeof value.language === 'string') {
      return { kind: 'text', text: value.text, language: value.language };
    }
  }
}

export function knowledgeValueKey(value: KnowledgeValue): string {
  switch (value.kind) {
    case 'entity': return value.id;
    case 'quantity': return `${value.amount} ${value.unit}`;
    case 'date': return `${value.calendar} ${value.precision} ${value.year} ${value.month ?? ''} ${value.day ?? ''} ${clock(value)}`;
    case 'text': return value.text;
  }
}

export function knowledgeFact(fact: Fact): KnowledgeFact {
  const { qualifiers, references } = fact.statement;
  return {
    ...fact, references,
    dates: {
      snapshot: fact.source.dumpDate,
      qualifiers: Object.values(qualifiers).flat().filter(snak => snak.datavalue?.type === 'time'),
      references: references.flatMap(reference => Object.values(reference.snaks).flat())
        .filter(snak => snak.datavalue?.type === 'time'),
    },
  };
}

function clock(value: Extract<KnowledgeValue, { kind: 'date' }>): string {
  return value.precision < 12 ? '' : value.raw.split('T')[1].split(':').slice(0, value.precision - 11).join(':').replace(/Z$/u, '');
}

export function renderKnowledgeValue(
  value: KnowledgeValue,
  language: 'ar' | 'en',
  unitLabel: (id: string) => string,
): string {
  switch (value.kind) {
    case 'entity': return value.label;
    case 'quantity': {
      const units: Record<string, [string, string]> = {
        Q11573: ['m', 'م'], Q828224: ['km', 'كم'], Q25343: ['m²', 'م²'], Q712226: ['km²', 'كم²'],
      };
      const unit = units[value.unit]?.[language === 'ar' ? 1 : 0] ?? unitLabel(value.unit);
      return value.unit === '1' ? value.amount : `${value.amount} ${unit}`;
    }
    case 'date': {
      const parts = [String(Math.abs(value.year)).padStart(4, '0')];
      if (value.month !== undefined) parts.push(String(value.month).padStart(2, '0'));
      if (value.day !== undefined) parts.push(String(value.day).padStart(2, '0'));
      const era = value.year < 0 ? (language === 'ar' ? ' ق.م.' : ' BCE') : '';
      const time = clock(value);
      const calendar = value.calendar === 'Q1985786' ? (language === 'ar' ? ' (يولياني)' : ' (Julian)') : '';
      return parts.join('-') + (time ? ` ${time} UTC` : '') + era + calendar;
    }
    case 'text': return value.text;
  }
}
