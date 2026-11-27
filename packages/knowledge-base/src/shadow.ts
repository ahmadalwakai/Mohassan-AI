import { setImmediate } from 'node:timers/promises';
import { normalizeLookupKey } from './normalize.ts';
import type {
  ComparisonQuery, ComparisonResult, EntityCandidate, Fact, openKnowledgeBase, SuperlativeQuery, SuperlativeResult,
} from './query.ts';
import type { DataCard, EntityCategory } from './types.ts';

type KnowledgeQueries = Pick<ReturnType<typeof openKnowledgeBase>, 'card' | 'lookupEntity' | 'lookupFacts' | 'superlative' | 'compare'>;
type SnapshotIdentity = Pick<DataCard, 'dataset' | 'source' | 'dumpDate' | 'fingerprint' | 'license'>;

type FactQuestion = {
  kind: 'fact';
  entity: string;
  property: string;
  year?: number;
  category?: EntityCategory;
};

type SuperlativeQuestion = { kind: 'superlative' } & SuperlativeQuery;
type ComparisonQuestion = { kind: 'compare'; entities: readonly [string, string, ...string[]] }
  & Omit<ComparisonQuery, 'entityIds'>;

export type OfflineKnowledgeQuestion = FactQuestion | SuperlativeQuestion | ComparisonQuestion;

export type OfflineKnowledgeShadowResult =
  | { status: 'unsupported' | 'error' }
  | { status: 'ambiguous'; candidates: EntityCandidate[] }
  | { status: 'unavailable'; reason: 'entity-not-found' | 'same-entity' }
  | { kind: 'fact'; status: 'found' | 'unavailable' | 'multiple-statements' | 'non-value'; entity: EntityCandidate; facts: Fact[] }
  | { kind: 'superlative'; status: SuperlativeResult['status']; ranking: SuperlativeResult }
  | { kind: 'compare'; status: ComparisonResult['status']; comparison: ComparisonResult };

export interface OfflineKnowledgeShadowInput {
  /** Submit only questions the caller has selected for public factual evaluation. */
  readonly question: string | OfflineKnowledgeQuestion;
  /** The caller supplies a public or redacted baseline answer suitable for its log. */
  readonly answer: string;
  readonly runId?: string;
}

export interface OfflineKnowledgeShadowReport {
  at: string;
  answer: string;
  runId?: string;
  snapshot: SnapshotIdentity;
  result: OfflineKnowledgeShadowResult;
}

const ENGLISH_FACTS = new Map([
  ['population', 'P1082'], ['area', 'P2046'], ['capital', 'P36'], ['currency', 'P38'],
]);
const ARABIC_FACTS = new Map([
  ['عدد سكان', 'P1082'], ['عدد السكان في', 'P1082'], ['مساحه', 'P2046'], ['عاصمه', 'P36'], ['عمله', 'P38'],
]);
const SQUARE_KILOMETRE = 'Q712226';

/** Recognizes a small set of full-question forms. Other questions can use the explicit typed API. */
export function parseOfflineKnowledgeQuestion(text: string): OfflineKnowledgeQuestion | undefined {
  const body = text.trim().replace(/[?؟.!]+$/u, '');
  if (text.length > 400 || /[\r\n?؟;؛]/u.test(body)) return;
  const question = normalizeLookupKey(body);
  const dated = / (?:in|as of|في(?: عام| سنه)?) (\d{4})$/u.exec(question);
  const year = dated ? Number(dated[1]) : undefined;
  const unqualified = dated ? question.slice(0, dated.index) : question;

  const englishFact = /^what (?:is|s|was) the (population|area|capital|currency) of (.+)$/u.exec(unqualified);
  if (englishFact && (year !== undefined || !unqualified.startsWith('what was '))) {
    return { kind: 'fact', property: ENGLISH_FACTS.get(englishFact[1])!, entity: englishFact[2], year };
  }
  const arabicFact = /^(?:ما(?: هي| هو)?|كم(?: يبلغ| تبلغ)?) (عدد السكان في|عدد سكان|مساحه|عاصمه|عمله) (.+)$/u.exec(unqualified);
  if (arabicFact) return { kind: 'fact', property: ARABIC_FACTS.get(arabicFact[1])!, entity: arabicFact[2], year };

  const ranking = /^(?:what|which) is the (largest|smallest) country by area$/u.exec(unqualified)
    ?? /^which country is the (largest|smallest) by area$/u.exec(unqualified);
  const arabicRanking = /^(?:ما|ما هي|اي) (اكبر|اصغر) دوله من حيث المساحه$/u.exec(unqualified);
  if (ranking || arabicRanking) {
    return {
      kind: 'superlative', category: 'countries', property: 'P2046', unit: SQUARE_KILOMETRE, year,
      direction: ranking?.[1] === 'smallest' || arabicRanking?.[1] === 'اصغر' ? 'min' : 'max',
    };
  }

  const comparison = /^compare the area of (.+)$/u.exec(unqualified);
  const arabicComparison = /^قارن(?: بين)? (.+) من حيث المساحه$/u.exec(unqualified);
  const names = comparison?.[1].split(/ (?:and|versus) /u) ?? arabicComparison?.[1].split(/ (?:و|مقابل) /u);
  if (names?.length === 2 && names[0] && names[1]) {
    return { kind: 'compare', entities: [names[0], names[1]], property: 'P2046', unit: SQUARE_KILOMETRE, year };
  }
}

function answerQuestion(knowledge: KnowledgeQueries, question: OfflineKnowledgeQuestion): OfflineKnowledgeShadowResult {
  if (question.kind === 'superlative') {
    const { kind, ...options } = question;
    const ranking = knowledge.superlative(options);
    return { kind, status: ranking.status, ranking };
  }

  if (question.kind === 'fact') {
    const candidates = knowledge.lookupEntity(question.entity, { category: question.category });
    if (candidates.length === 0) return { status: 'unavailable', reason: 'entity-not-found' };
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    const [entity] = candidates;
    const facts = knowledge.lookupFacts(entity.entityId, question.property, { year: question.year });
    if (facts.length === 0) return { kind: 'fact', status: 'unavailable', entity, facts };
    if (facts.length > 1) return { kind: 'fact', status: 'multiple-statements', entity, facts };
    const status = facts[0].statement.snak.snaktype === 'value' ? 'found' : 'non-value';
    return { kind: 'fact', status, entity, facts };
  }

  const { kind, entities, ...options } = question;
  const entityIds = [];
  for (const name of entities) {
    const candidates = knowledge.lookupEntity(name);
    if (candidates.length === 0) return { status: 'unavailable', reason: 'entity-not-found' };
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    entityIds.push(candidates[0].entityId);
  }
  if (new Set(entityIds).size !== entityIds.length) return { status: 'unavailable', reason: 'same-entity' };
  const comparison = knowledge.compare({ ...options, entityIds });
  return { kind, status: comparison.status, comparison };
}

/** Runs only when a caller explicitly submits an observation and provides a log sink. */
export function createOfflineKnowledgeShadow(options: {
  knowledge: KnowledgeQueries;
  log: (report: OfflineKnowledgeShadowReport) => void | Promise<void>;
  now?: () => Date;
}): { observe(input: OfflineKnowledgeShadowInput): void; flush(): Promise<void> } {
  const now = options.now ?? (() => new Date());
  const { dataset, source, dumpDate, fingerprint, license } = options.knowledge.card;
  const snapshot = { dataset, source, dumpDate, fingerprint, license };
  let queue = Promise.resolve();
  return {
    observe({ answer, runId, question }) {
      let at: string;
      try { at = now().toISOString(); } catch { return; }
      queue = queue.then(async () => {
        await setImmediate();
        let result: OfflineKnowledgeShadowResult;
        try {
          const parsed = typeof question === 'string' ? parseOfflineKnowledgeQuestion(question) : question;
          result = parsed ? answerQuestion(options.knowledge, parsed) : { status: 'unsupported' };
        } catch {
          result = { status: 'error' };
        }
        await options.log({ at, answer, runId, snapshot, result });
      }).catch(() => { /* A broken log sink cannot reject the observation queue. */ });
    },
    flush: () => queue,
  };
}
