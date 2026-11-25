import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  answerSelectionSplitFingerprint, createAnswerSelectionSplit, validateAnswerSelectionSplit,
  type AnswerSelectionPartition, type AnswerSelectionSplit, type AnswerSelectionSplitPage, type AnswerSelectionSplitQuestion,
} from './fixtures/answer-selection/split.js';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/answer-selection/${name}.json`, import.meta.url), 'utf8'));
}

const pages = readFixture<AnswerSelectionSplitPage[]>('pages');
const questions = readFixture<AnswerSelectionSplitQuestion[]>('questions');
const manifest = readFixture<AnswerSelectionSplit>('split');

function memberships(key: 'pageIds' | 'questionIds'): Map<string, AnswerSelectionPartition> {
  const owner = new Map<string, AnswerSelectionPartition>();
  for (const partition of ['development', 'holdout'] as const) {
    for (const id of manifest[partition][key]) {
      expect(owner.has(id), id).toBe(false);
      owner.set(id, partition);
    }
  }
  return owner;
}

describe('frozen answer selection split', () => {
  it('keeps translated pages and all pages of each multi-page question in one partition', () => {
    const pageMembers = memberships('pageIds');
    const questionMembers = memberships('questionIds');
    const topics = new Map<string, AnswerSelectionPartition>();
    expect(pageMembers.size).toBe(pages.length);
    expect(questionMembers.size).toBe(questions.length);
    for (const { id, language } of pages) {
      const topic = id.slice(language.length + 1);
      const partition = pageMembers.get(id);
      expect(partition, id).toBeDefined();
      if (topics.has(topic)) expect(topics.get(topic), id).toBe(partition);
      topics.set(topic, partition!);
    }
    for (const { id, pageIds } of questions) {
      const partition = questionMembers.get(id);
      expect(partition, id).toBeDefined();
      for (const pageId of pageIds) expect(pageMembers.get(pageId), id).toBe(partition);
    }
    for (const language of ['ar', 'en'] as const) {
      const cases = questions.filter(question => question.language === language);
      const holdoutShare = cases.filter(question => questionMembers.get(question.id) === 'holdout').length / cases.length;
      expect(holdoutShare, language).toBeCloseTo(0.3, 1);
    }
  });

  it('reconstructs the exact manifest regardless of input row order', () => {
    expect(() => validateAnswerSelectionSplit(manifest, pages, questions)).not.toThrow();
    expect(createAnswerSelectionSplit([...pages].reverse(), [...questions].reverse())).toEqual(manifest);
  });

  it('pins held-out page text, question wording and expected quotes independently of membership', () => {
    const pageId = manifest.holdout.pageIds[0];
    const questionId = manifest.holdout.questionIds[0];
    const changedPage = pages.map(page => page.id === pageId ? { ...page, text: `${page.text}\nChanged.` } : page);
    const changedPrompt = questions.map(question => question.id === questionId ? { ...question, question: `${question.question} Changed.` } : question);
    const changedLabel = questions.map(question => question.id === questionId ? { ...question, expected: [...question.expected, ['Changed.']] } : question);
    for (const [pageRows, questionRows] of [[changedPage, questions], [pages, changedPrompt], [pages, changedLabel]] as const) {
      const altered = createAnswerSelectionSplit(pageRows, questionRows);
      expect(altered.groups).toEqual(manifest.groups);
      expect(altered.development.sha256).toBe(manifest.development.sha256);
      expect(altered.holdout.sha256).not.toBe(manifest.holdout.sha256);
      expect(altered.sha256).not.toBe(manifest.sha256);
      expect(() => validateAnswerSelectionSplit(manifest, pageRows, questionRows)).toThrow(/pinned fixtures have changed/u);
    }
  });

  it('rejects a manifest with a newly hashed overlapping assignment', () => {
    const altered = structuredClone(manifest);
    altered.development.pageIds.push(altered.holdout.pageIds[0]);
    altered.sha256 = answerSelectionSplitFingerprint(altered);
    expect(() => validateAnswerSelectionSplit(altered, pages, questions)).toThrow(/split or pinned fixtures have changed/u);
  });
});
