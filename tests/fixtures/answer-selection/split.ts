import { createHash } from 'node:crypto';

type Language = 'ar' | 'en';
export type AnswerSelectionPartition = 'development' | 'holdout';

export interface AnswerSelectionSplitPage {
  id: string;
  language: Language;
  title: string;
  url: string;
  revisionUrl: string;
  text: string;
}

export interface AnswerSelectionSplitQuestion {
  id: string;
  language: Language;
  question: string;
  pageIds: readonly string[];
  expected: readonly (readonly string[])[];
}

interface Partition {
  pageIds: string[];
  questionIds: string[];
  sha256: string;
}

export interface AnswerSelectionSplit {
  version: 1;
  algorithm: 'page-family-sha256-prefix-v1';
  targetHoldoutPercent: 30;
  groups: { pageIds: string[]; partition: AnswerSelectionPartition }[];
  development: Partition;
  holdout: Partition;
  sha256: string;
}

interface PageGroup {
  topic: string;
  pageIds: string[];
  counts: Record<Language, number>;
  order: string;
}

const HOLDOUT_PERCENT = 30;
const GROUP_ORDER_SALT = 'answer-selection-split-v1\n';
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => compare(left, right)));
  });
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => compare(left.id, right.id));
}

function pageGroups(pages: readonly Pick<AnswerSelectionSplitPage, 'id' | 'language'>[],
  questions: readonly Pick<AnswerSelectionSplitQuestion, 'id' | 'language' | 'pageIds'>[]): PageGroup[] {
  const topics = new Map<string, string>();
  const parents = new Map<string, string>();
  for (const page of pages) {
    const match = /^(ar|en)-(.+)$/u.exec(page.id);
    if (!match || match[1] !== page.language || topics.has(page.id)) throw new Error(`Invalid or duplicate page ID ${page.id}`);
    // In this fixture set, translated pages share the same topic ID after the language prefix.
    const topic = match[2];
    topics.set(page.id, topic);
    parents.set(topic, topic);
  }

  function root(topic: string): string {
    let current = topic;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  }

  function topicFor(pageId: string): string {
    const topic = topics.get(pageId);
    if (!topic) throw new Error(`Unknown fixture page ${pageId}`);
    return topic;
  }

  const questionIds = new Set<string>();
  for (const question of questions) {
    if (!question.pageIds.length || questionIds.has(question.id)) throw new Error(`Page-less or duplicate question ${question.id}`);
    questionIds.add(question.id);
    const linked = [...new Set(question.pageIds.map(id => root(topicFor(id))))].sort(compare);
    const first = linked[0];
    for (const topic of linked.slice(1)) parents.set(topic, first);
  }

  const grouped = new Map<string, PageGroup>();
  for (const [pageId, topic] of topics) {
    const key = root(topic);
    let group = grouped.get(key);
    if (!group) {
      group = { topic: key, pageIds: [], counts: { ar: 0, en: 0 }, order: sha256(GROUP_ORDER_SALT + key) };
      grouped.set(key, group);
    }
    group.pageIds.push(pageId);
  }
  for (const question of questions) grouped.get(root(topicFor(question.pageIds[0])))!.counts[question.language]++;
  return [...grouped.values()].sort((left, right) => compare(left.order, right.order) || compare(left.topic, right.topic));
}

/** Assignment uses page and question IDs, language and co-occurrence only. */
function holdoutGroupCount(groups: readonly PageGroup[], pageCount: number): number {
  if (groups.length < 2) throw new Error('At least two independent page groups are required');
  const totals = groups.reduce((counts, group) => ({ ar: counts.ar + group.counts.ar, en: counts.en + group.counts.en }), { ar: 0, en: 0 });
  let closest = 1;
  let bestQuestionDistance = Infinity;
  let bestPageDistance = Infinity;
  let ar = 0;
  let en = 0;
  let pages = 0;
  for (let index = 0; index < groups.length - 1; index++) {
    const group = groups[index];
    ar += group.counts.ar;
    en += group.counts.en;
    pages += group.pageIds.length;
    const questionDistance = Math.abs(100 * ar - HOLDOUT_PERCENT * totals.ar) + Math.abs(100 * en - HOLDOUT_PERCENT * totals.en);
    const pageDistance = Math.abs(100 * pages - HOLDOUT_PERCENT * pageCount);
    if (questionDistance < bestQuestionDistance || questionDistance === bestQuestionDistance && pageDistance < bestPageDistance) {
      closest = index + 1;
      bestQuestionDistance = questionDistance;
      bestPageDistance = pageDistance;
    }
  }
  return closest;
}

export function answerSelectionSplitFingerprint(manifest: Omit<AnswerSelectionSplit, 'sha256'>): string {
  const { version, algorithm, targetHoldoutPercent, groups, development, holdout } = manifest;
  return sha256(canonicalJson({ version, algorithm, targetHoldoutPercent, groups, development, holdout }));
}

export function createAnswerSelectionSplit(pages: readonly AnswerSelectionSplitPage[], questions: readonly AnswerSelectionSplitQuestion[]): AnswerSelectionSplit {
  const grouped = pageGroups(pages, questions);
  const cutoff = holdoutGroupCount(grouped, pages.length);
  const groups = grouped.map(({ pageIds }, index) => ({
    pageIds: pageIds.sort(compare),
    partition: index < cutoff ? 'holdout' as const : 'development' as const,
  }));

  function partition(name: AnswerSelectionPartition): Partition {
    const pageIds = groups.filter(group => group.partition === name).flatMap(group => group.pageIds).sort(compare);
    const ids = new Set(pageIds);
    const includedPages = byId(pages.filter(page => ids.has(page.id)));
    const includedQuestions = byId(questions.filter(question => ids.has(question.pageIds[0])));
    return {
      pageIds,
      questionIds: includedQuestions.map(question => question.id),
      sha256: sha256(canonicalJson({ pages: includedPages, questions: includedQuestions })),
    };
  }

  const manifest: Omit<AnswerSelectionSplit, 'sha256'> = {
    version: 1,
    algorithm: 'page-family-sha256-prefix-v1',
    targetHoldoutPercent: HOLDOUT_PERCENT,
    groups,
    development: partition('development'),
    holdout: partition('holdout'),
  };
  return { ...manifest, sha256: answerSelectionSplitFingerprint(manifest) };
}

/** Check membership and evidence integrity without making any predictions. */
export function validateAnswerSelectionSplit(manifest: AnswerSelectionSplit, pages: readonly AnswerSelectionSplitPage[], questions: readonly AnswerSelectionSplitQuestion[]): void {
  const expected = createAnswerSelectionSplit(pages, questions);
  if (canonicalJson(manifest) !== canonicalJson(expected)) throw new Error('Answer selection split or pinned fixtures have changed');
}
