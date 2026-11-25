import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CodeKnowledge, questionTypes, readCorpus } from '../../packages/code-knowledge/src/index.js';
import type { Corpus, QuestionType } from '../../packages/code-knowledge/src/index.js';

export type Split = 'development' | 'held-out';

interface Contributor {
  name: string;
  url: string;
}

export interface EvaluationCase {
  id: number;
  question: string;
  type: QuestionType;
  source: {
    url: string;
    author: Contributor;
    license: string;
    licenseUrl: string;
    revision: { url: string; date: string; author: Contributor; license: string; licenseUrl: string };
    lastEdit: string;
  };
  // At least one literal in each group has to appear in the selected evidence.
  expected: readonly (readonly string[])[];
}

type EvaluationAnswer = {
  intent: QuestionType;
  status: 'abstained';
} | {
  intent: QuestionType;
  status: 'answered';
  excerpts: readonly {
    sentences: readonly string[];
    code: readonly { text: string }[];
    citation: { url: string };
  }[];
};

type Outcome = 'correct' | 'wrong' | 'abstained';

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function containsLiteral(evidence: string, literal: string): boolean {
  const needle = normalize(literal);
  if (!needle) return false;
  const identifier = /[\p{L}\p{N}_$]/u;
  const startsIdentifier = identifier.test(needle[0]);
  const endsIdentifier = identifier.test(needle[needle.length - 1]);
  let fromIndex = 0;
  while (fromIndex < evidence.length) {
    const index = evidence.indexOf(needle, fromIndex);
    if (index === -1) return false;
    const prefix = evidence[index - 1] ?? '';
    const suffix = evidence[index + needle.length] ?? '';
    if ((!startsIdentifier || !identifier.test(prefix)) && (!endsIdentifier || !identifier.test(suffix))) {
      return true;
    }
    fromIndex = index + 1;
  }
  return false;
}

export function scoreQuestion(question: Pick<EvaluationCase, 'id' | 'type' | 'expected'>, answer: EvaluationAnswer) {
  const excerpts = answer.status === 'answered' ? answer.excerpts : [];
  const evidence = excerpts.flatMap(({ sentences, code }) => [...sentences, ...code.map(({ text }) => text)]).map(normalize);
  const missing = question.expected.filter((alternatives) =>
    !alternatives.some((literal) => evidence.some((excerpt) => containsLiteral(excerpt, literal))),
  );
  let outcome: Outcome = 'wrong';
  if (answer.status === 'abstained') outcome = 'abstained';
  else if (question.expected.length > 0 && missing.length === 0) outcome = 'correct';
  return {
    id: question.id,
    type: question.type,
    predictedType: answer.intent,
    outcome,
    missing,
    citations: [...new Set(excerpts.map(({ citation }) => citation.url))],
  };
}

function stackOverflowQuestionId(url: string): number | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== 'stackoverflow.com') return undefined;
  const id = /^\/(?:questions|q)\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1];
  return id === undefined ? undefined : Number(id);
}

export function excludeEvaluationThreads(corpus: Corpus, cases: readonly Pick<EvaluationCase, 'id'>[]): Corpus {
  const ids = new Set(cases.map(({ id }) => id));
  return {
    sources: corpus.sources,
    passages: corpus.passages.filter((passage) => {
      const id = stackOverflowQuestionId(passage.questionUrl ?? passage.url);
      return id === undefined || !ids.has(id);
    }),
  };
}

async function readQuestions(split: Split) {
  const raw = await readFile(new URL(`./questions/${split}.json`, import.meta.url), 'utf8');
  return {
    cases: JSON.parse(raw) as readonly EvaluationCase[],
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string' },
      split: { type: 'string', default: 'development' },
      output: { type: 'string' },
    },
  });
  const { corpus, split, output } = values;
  if (!corpus || (split !== 'development' && split !== 'held-out')) {
    throw new Error('Usage: evaluate.ts --corpus <file> [--split development|held-out] [--output <file>]');
  }

  const development = await readQuestions('development');
  const heldOut = await readQuestions('held-out');
  const questions = split === 'development' ? development : heldOut;
  const original = await readCorpus(corpus);
  const filtered = excludeEvaluationThreads(original, [...development.cases, ...heldOut.cases]);
  const answerer = new CodeKnowledge(filtered);
  const cases = questions.cases.map((question) => scoreQuestion(question, answerer.answer(question.question)));
  const perType = Object.fromEntries(questionTypes.map((type) => [type, { correct: 0, wrong: 0, abstained: 0 }]));
  for (const result of cases) perType[result.type][result.outcome]++;
  const results = {
    split,
    questionsSha256: questions.sha256,
    sources: filtered.sources.map(({ id, version, fingerprint }) => ({ id, version, fingerprint })),
    excludedPassages: original.passages.length - filtered.passages.length,
    perType,
    cases,
  };
  const json = `${JSON.stringify(results, null, 2)}\n`;
  if (output) await writeFile(output, json);
  process.stdout.write(json);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
