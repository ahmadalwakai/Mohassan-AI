import { analyzeKnowledgeQuestion, knowledgeQuestionLanguage } from './question-analysis.ts';
import type { EntityCandidate, Fact, openKnowledgeBase } from './query.ts';
import { calendarDateBounds, readWikidataDate } from './query-values.ts';
import type { KnowledgeAnswer, KnowledgeMention, KnowledgeProperty, KnowledgeQuestion, KnowledgeTime, KnowledgeValue } from './qa-types.ts';
import { knowledgeFact, knowledgeValueKey, readKnowledgeValue, renderKnowledgeValue } from './qa-values.ts';
import type { Language } from './types.ts';

type Knowledge = ReturnType<typeof openKnowledgeBase>;
type Resolved = { entityId: string; label: string };

const MESSAGES = {
  unsupported: ['no supported factual question form', 'لم يتطابق السؤال مع صيغة أسئلة الحقائق المدعومة'],
  'entity-not-found': ['no matching entity', 'لم يتطابق الاسم مع أي عنصر'],
  'fact-not-found': ['no matching statement', 'لم أجد عبارة مطابقة'],
  'conflicting-facts': ['conflicting or unresolved statements', 'العبارات متعارضة أو غير محددة'],
  'incomplete-comparison': ['incomplete comparable evidence', 'لا تتوفر أدلة قابلة للمقارنة لكل العناصر'],
  'same-entity': ['the names refer to the same entity', 'تشير الأسماء إلى العنصر نفسه'],
} as const;
type Reason = keyof typeof MESSAGES;

const COUNTRY: KnowledgeProperty = { id: 'P17', label: { en: 'country', ar: 'الدولة' }, answerType: 'entity' };
const INTERVAL_PROPERTIES = new Set(['P6', 'P26', 'P27', 'P35', 'P36', 'P38']);

function displayName(candidate: EntityCandidate, language: Language): string {
  return candidate.labels[language] ?? candidate.labels[language === 'ar' ? 'en' : 'ar'] ?? candidate.entityId;
}

function abstention(language: Language, searched: string[], reason: Reason, question?: KnowledgeQuestion): KnowledgeAnswer {
  const ar = language === 'ar';
  const message = ar ? 'لم أجد في قاعدة المعرفة' : 'I couldn’t find this in the knowledge base';
  return {
    status: 'abstained', language, question, reason, searched,
    text: `${message}. ${ar ? 'البحث عن' : 'Searched for'} ${searched.join(' ← ')}. ${MESSAGES[reason][ar ? 1 : 0]}.`,
  };
}

/** Answers against a caller-owned, already opened local snapshot. No service or clock is consulted. */
export function createKnowledgeQa(knowledge: Knowledge) {
  function execute(question: KnowledgeQuestion): KnowledgeAnswer {
    const { language, property, time } = question;
    const ar = language === 'ar';
    const searched: string[] = [];
    const label = (id: string) => {
      const [candidate] = knowledge.lookupEntity(id);
      return candidate ? displayName(candidate, language) : id;
    };

    function fail(reason: Reason) {
      return abstention(language, searched, reason, question);
    }

    function resolve(mention: KnowledgeMention): Resolved | KnowledgeAnswer {
      searched.push(mention.text);
      const options = { language, category: mention.category };
      let result = knowledge.linkEntity(mention.text, options);
      for (const alternative of mention.alternatives ?? []) {
        if (result.status !== 'missing') break;
        searched.push(alternative);
        result = knowledge.linkEntity(alternative, options);
      }
      if (result.status === 'missing') return fail('entity-not-found');
      if (result.status === 'ambiguous') return {
        status: 'choice', language, question, searched, mention: mention.text, candidates: result.candidates,
        text: ar ? `أيّ عنصر تقصد بـ «${mention.text}»؟` : `Which entity do you mean by “${mention.text}”?`,
      };
      return { entityId: result.candidate.entityId, label: displayName(result.candidate, language) };
    }

    function searchProperty(target: KnowledgeProperty, selection?: KnowledgeTime) {
      const year = selection?.year === undefined ? '' : ` ${ar ? 'في' : 'in'} ${selection.year}`;
      const order = selection?.order === 'latest' ? (ar ? '، الأحدث' : ', latest')
        : selection?.order === 'earliest' ? (ar ? '، الأقدم' : ', earliest') : '';
      const trace = `${target.label[language]} (${target.id})${year}${order}`;
      if (!searched.includes(trace)) searched.push(trace);
    }

    function lookup(entityId: string, target: KnowledgeProperty, selection?: KnowledgeTime, multiple = false) {
      searchProperty(target, selection);
      const intervalYear = selection?.year !== undefined && INTERVAL_PROPERTIES.has(target.id);
      const statements = knowledge.lookupFacts(entityId, target.id, { ...selection, allRanks: multiple || intervalYear });
      const values = new Map<string, KnowledgeValue>();
      const facts: Fact[] = [];
      for (const fact of statements) {
        const value = readKnowledgeValue(fact, target.answerType, label);
        if (!value) return { reason: 'conflicting-facts' } as const;
        if (value.kind === 'text' && value.language && value.language !== language) continue;
        values.set(knowledgeValueKey(value), value);
        facts.push(fact);
      }
      if (!values.size) return { reason: 'fact-not-found' } as const;
      if (!multiple && values.size > 1) return { reason: 'conflicting-facts' } as const;
      return { values: [...values.values()], facts };
    }

    type Scope = Extract<KnowledgeAnswer, { status: 'answered' }>['scope'];

    function found(values: KnowledgeValue[], evidence: Fact[], scope?: Scope, display?: string): KnowledgeAnswer {
      const facts = evidence.map(knowledgeFact);
      const shown = display ?? values.map(value => renderKnowledgeValue(value, language, label)).join(ar ? '، ' : ', ');
      const contextual = scope?.kind === 'recorded-values' ? (ar ? `القيم المسجلة: ${shown}` : `Recorded values: ${shown}`)
        : scope?.kind === 'indexed-category'
          ? (ar ? `${shown} ضمن ${scope.comparable} من العناصر المفهرسة` : `${shown} among ${scope.comparable} indexed entities`)
          : shown;
      const cites = [...new Set(facts.map(fact => {
        const dates = fact.dates.qualifiers.flatMap(snak => {
          const date = readWikidataDate(snak);
          return date ? [`${snak.property} ${renderKnowledgeValue(date, language, label)}`] : [];
        });
        return [fact.property, ...new Set(dates), `${ar ? 'لقطة' : 'snapshot'} ${fact.dates.snapshot}`, fact.source.url].join(' · ');
      }))];
      return { status: 'answered', language, question, searched, values, facts, ...(scope && { scope }),
        text: `${contextual}\n${cites.join('\n')}` };
    }

    function compareDates(entities: Map<string, Resolved>, direction?: 'max' | 'min'): KnowledgeAnswer {
      const rows = [];
      for (const entity of entities.values()) {
        const result = lookup(entity.entityId, property, time);
        if (result.reason || result.values[0].kind !== 'date') return fail('incomplete-comparison');
        const [date] = result.values;
        rows.push({ entity, date, bounds: calendarDateBounds(date), facts: result.facts });
      }
      rows.sort((left, right) => right.bounds.earliest - left.bounds.earliest);
      for (let index = 1; index < rows.length; index++) {
        const [later, earlier] = [rows[index - 1], rows[index]];
        if (later.date.calendar !== earlier.date.calendar ||
          (earlier.bounds.latest >= later.bounds.earliest && knowledgeValueKey(later.date) !== knowledgeValueKey(earlier.date))) {
          return fail('incomplete-comparison');
        }
      }
      const extreme = direction === 'min' ? rows[rows.length - 1] : rows[0];
      const selected = direction ? rows.filter(row => knowledgeValueKey(row.date) === knowledgeValueKey(extreme.date)) : rows;
      const display = selected.map(({ entity, date }) => `${entity.label} (${renderKnowledgeValue(date, language, label)})`).join(ar ? '، ' : ', ');
      const values = selected.map(({ entity, date }): KnowledgeValue => direction
        ? { kind: 'entity', id: entity.entityId, label: entity.label } : date);
      return found(values, rows.flatMap(row => row.facts), undefined, display);
    }

    function compare(mentions: readonly KnowledgeMention[], direction?: 'max' | 'min'): KnowledgeAnswer {
      searchProperty(property, time);
      const entities = new Map<string, Resolved>();
      for (const mention of mentions) {
        const entity = resolve(mention);
        if ('status' in entity) return entity;
        if (entities.has(entity.entityId)) return fail('same-entity');
        entities.set(entity.entityId, entity);
      }
      if (property.answerType === 'date') return compareDates(entities, direction);
      if (!property.unit) return fail('incomplete-comparison');
      const comparison = knowledge.compare({ ...time, entityIds: [...entities.keys()], property: property.id, unit: property.unit });
      if (comparison.status === 'incomplete') return fail('incomplete-comparison');
      const extreme = direction === 'min' ? comparison.rows.at(-1)?.amount : comparison.rows[0]?.amount;
      const selected = direction ? comparison.rows.filter(row => row.amount === extreme) : comparison.rows;
      const rows = selected.map(row => ({
        entity: entities.get(row.entityId)!,
        quantity: { kind: 'quantity' as const, amount: row.amount!, unit: comparison.unit },
      }));
      const values = rows.map(({ entity, quantity }): KnowledgeValue => direction
        ? { kind: 'entity', id: entity.entityId, label: entity.label } : quantity);
      const display = rows.map(({ entity, quantity }) =>
        `${entity.label} (${renderKnowledgeValue(quantity, language, label)})`).join(ar ? '، ' : ', ');
      return found(values, comparison.rows.flatMap(row => row.facts), undefined, display);
    }

    if (question.kind === 'compare') return compare(question.entities, question.direction);
    if (question.kind === 'superlative') {
      if (question.entities) return compare(question.entities, question.direction);
      const categoryNames = {
        people: ['people', 'الأشخاص'], places: ['places', 'الأماكن'], countries: ['countries', 'الدول'],
        cities: ['cities', 'المدن'], organizations: ['organizations', 'المنظمات'], events: ['events', 'الأحداث'],
        works: ['works', 'الأعمال'], units: ['units', 'الوحدات'],
      };
      searched.push(categoryNames[question.category][ar ? 1 : 0]);
      searchProperty(property, time);
      if (!property.unit) return fail('incomplete-comparison');
      const ranking = knowledge.superlative({ ...time, category: question.category, property: property.id, unit: property.unit,
        direction: question.direction });
      if (ranking.status !== 'ranked') return fail('incomplete-comparison');
      const ids = [...new Set(ranking.facts.map(fact => fact.entityId))];
      if (ids.length !== ranking.tieCount) return fail('incomplete-comparison');
      return found(ids.map(id => ({ kind: 'entity', id, label: label(id) })), ranking.facts, {
        kind: 'indexed-category', category: question.category, entities: ranking.categoryEntities, comparable: ranking.comparableEntities,
      });
    }

    const entity = resolve(question.entity);
    if ('status' in entity) {
      // Record the requested fact even when its subject was unavailable.
      searchProperty(property, time);
      return entity.status === 'abstained' ? fail('entity-not-found') : entity;
    }
    if (question.kind === 'path') {
      const evidence: Fact[] = [];
      let id = entity.entityId;
      for (const hop of question.hops) {
        const step = lookup(id, hop);
        if (step.reason) { searchProperty(property, time); return fail(step.reason); }
        const [target] = step.values;
        if (target.kind !== 'entity') return fail('fact-not-found');
        evidence.push(...step.facts);
        id = target.id;
        searched.push(target.label);
      }
      if (question.countryOfBirth && !knowledge.lookupEntity(id, { category: 'countries' }).length) {
        const step = lookup(id, COUNTRY);
        if (step.reason) { searchProperty(property, time); return fail(step.reason); }
        const [target] = step.values;
        if (target.kind !== 'entity') return fail('fact-not-found');
        evidence.push(...step.facts);
        id = target.id;
        searched.push(target.label);
      }
      const result = lookup(id, property, time, question.multiple);
      return result.reason ? fail(result.reason) : found(result.values, [...evidence, ...result.facts]);
    }

    const result = lookup(entity.entityId, property, time, question.kind === 'count' || Boolean(question.multiple));
    if (result.reason) return fail(result.reason);
    if (question.kind === 'count') {
      return found([{ kind: 'quantity', amount: String(result.values.length), unit: '1' }], result.facts, { kind: 'recorded-values' });
    }
    return found(result.values, result.facts);
  }

  function answer(text: string, options: { language?: Language } = {}): KnowledgeAnswer {
    const language = options.language ?? knowledgeQuestionLanguage(text);
    const question = analyzeKnowledgeQuestion(text, language);
    return question ? execute(question) : abstention(language, [text.trim().slice(0, 400)], 'unsupported');
  }

  return { answer, execute };
}
