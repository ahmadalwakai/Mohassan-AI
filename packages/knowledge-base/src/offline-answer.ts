import { analyzeKnowledgeQuestion } from './question-analysis.ts';
import { KNOWLEDGE_PROPERTIES } from './qa-properties.ts';
import { knowledgeValueKey, readKnowledgeValue, renderKnowledgeValue } from './qa-values.ts';
import { orderedStatementDate, readWikidataDate, uniqueDateBounds } from './query-values.ts';
import { openKnowledgeBase, type Fact } from './query.ts';

const PROPERTIES = KNOWLEDGE_PROPERTIES;
const OFFICE_PROPERTIES = new Set<string>([PROPERTIES.headOfState.property.id, PROPERTIES.headOfGovernment.property.id]);
const STABLE_PROPERTIES = new Set<string>([
  PROPERTIES.capital.property.id, PROPERTIES.birthDate.property.id, PROPERTIES.deathDate.property.id,
  PROPERTIES.inception.property.id, PROPERTIES.publication.property.id,
]);

function officeTerm(fact: Fact) {
  const { P580: starts, P582: ends } = fact.statement.qualifiers;
  return {
    start: starts ? uniqueDateBounds(starts) : { earliest: -Infinity, latest: -Infinity },
    end: ends ? uniqueDateBounds(ends) : { earliest: Infinity, latest: Infinity },
  };
}

/** Returns a cited direct answer, or leaves the entire question for the caller. */
export function answerOfflineQuestion(databasePath: string, text: string): string | undefined {
  const question = analyzeKnowledgeQuestion(text);
  if (!question || question.kind !== 'lookup' || question.multiple) return;
  const { property, language, entity, time } = question;
  const office = OFFICE_PROPERTIES.has(property.id);
  const dated = office || property.id === PROPERTIES.population.property.id;
  const currentOffice = office && time?.year === undefined && time?.order !== 'earliest';
  if (!dated && !STABLE_PROPERTIES.has(property.id)) return;
  // A year-qualified request for a stable fact requires context beyond its bare value.
  if (!dated && time?.year !== undefined) return;

  const store = openKnowledgeBase(databasePath);
  try {
    const linkOptions = { language, category: entity.category };
    let linked = store.linkEntity(entity.text, linkOptions);
    for (const alternative of entity.alternatives ?? []) {
      if (linked.status !== 'missing') break;
      linked = store.linkEntity(alternative, linkOptions);
    }
    if (linked.status !== 'linked' || linked.candidate.matchMethod === 'transliteration') return;

    const { entityId } = linked.candidate;
    const facts = store.lookupFacts(entityId, property.id, dated
      ? { ...time, order: time?.order ?? 'latest', pointInTimeOnly: true, allRanks: true }
      : time);
    if (!facts.length) return;

    const snapshotDay = Number(facts[0].source.dumpDate.replaceAll('-', ''));
    if (currentOffice && facts.some(fact => {
      const { start, end } = officeTerm(fact);
      return (start?.latest ?? Infinity) > snapshotDay || (end?.earliest ?? -Infinity) <= snapshotDay;
    })) return;

    const label = (id: string) => {
      const [item] = store.lookupEntity(id);
      return item?.labels[language] ?? item?.labels[language === 'ar' ? 'en' : 'ar'] ?? id;
    };
    const values = new Map<string, string>();
    const observations = new Set<string>();
    for (const fact of facts) {
      const { dumpSource, dumpDate, url } = fact.source;
      if (!dumpSource || !/^\d{4}-\d{2}-\d{2}$/u.test(dumpDate) || !url) return;
      // An ended capital statement cannot answer the unqualified capital question.
      if (property.id === PROPERTIES.capital.property.id && fact.statement.qualifiers.P582?.length) return;
      const value = readKnowledgeValue(fact, property.answerType, label);
      if (!value || value.kind === 'entity' && value.label === value.id) return;
      if (value.kind === 'quantity') {
        if (value.unit !== property.unit || !/^\d+$/u.test(value.amount)) return;
        values.set(knowledgeValueKey(value), new Intl.NumberFormat('en-US').format(BigInt(value.amount)));
      } else {
        values.set(knowledgeValueKey(value), renderKnowledgeValue(value, language, label));
      }
      if (dated) {
        const snak = fact.statement.qualifiers.P585?.[0];
        const point = snak && readWikidataDate(snak);
        if (!point) return;
        observations.add(renderKnowledgeValue(point, language, label));
      }
    }
    if (values.size !== 1 || dated && observations.size !== 1) return;

    if (currentOffice && store.lookupFacts(entityId, property.id, { allRanks: true }).some(fact => {
      // Dated observations already participated in chronological selection.
      if (orderedStatementDate(fact.statement, true)) return false;
      const { start, end } = officeTerm(fact);
      if ((start?.earliest ?? -Infinity) > snapshotDay || (end?.latest ?? Infinity) < snapshotDay) return false;
      const value = readKnowledgeValue(fact, property.answerType, label);
      return !value || !values.has(knowledgeValueKey(value));
    })) return;

    const ar = language === 'ar';
    const [value] = values.values();
    const [observation] = observations;
    const asOf = observation ? ` (${ar ? 'اعتبارًا من' : 'as of'} ${observation})` : '';
    const { url, dumpDate } = facts[0].source;
    const snapshot = ar ? 'لقطة مؤرخة في' : 'snapshot dated';
    return `${value}${asOf}\n\n**${ar ? 'المصدر' : 'Source'}:** [Wikidata ${entityId}](${url}) (${snapshot} ${dumpDate}).`;
  } finally {
    store.close();
  }
}
