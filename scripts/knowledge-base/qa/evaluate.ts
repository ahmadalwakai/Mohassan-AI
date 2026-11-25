import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createKnowledgeQa, openKnowledgeBase, type Language } from '../../../packages/knowledge-base/src/index.ts';
import { scoreAnswer, type GoldAnswer } from './score.ts';

interface QuestionRow {
  dataset: string;
  id: string;
  type: string;
  questions: Partial<Record<Language, string>>;
  gold: GoldAnswer;
}

interface Metrics {
  questions: number;
  correct: number;
  wrong: number;
  abstained: number;
  choices: number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    data: { type: 'string' },
    store: { type: 'string' },
    split: { type: 'string', default: 'held-out' },
  } });
  const { data, store, split } = values;
  if (!data || !store || (split !== 'dev' && split !== 'held-out')) {
    throw new Error('Usage: npx tsx scripts/knowledge-base/qa/evaluate.ts --data DIRECTORY --store SQLITE [--split dev|held-out]');
  }
  const file = `${split}.jsonl`;
  const content = await readFile(join(data, file));
  const questionSha256 = createHash('sha256').update(content).digest('hex');
  const lock = JSON.parse(await readFile(new URL('./public-eval-lock.json', import.meta.url), 'utf8')) as {
    questions: Record<string, string>;
    wikidata: { sha256: string };
  };
  if (questionSha256 !== lock.questions[file]) throw new Error(`Unexpected ${file} SHA-256`);
  const rows = content.toString().trimEnd().split('\n').map(line => JSON.parse(line) as QuestionRow);
  const knowledge = openKnowledgeBase(store);
  try {
    if (knowledge.card.fingerprint !== `sha256:${lock.wikidata.sha256}`) {
      throw new Error('Unexpected Wikidata slice SHA-256');
    }
    const qa = createKnowledgeQa(knowledge);
    const groups = new Map<string, Metrics>();
    const wrong = [];
    const unresolved: Record<string, number> = {};
    for (const row of rows) {
      for (const language of ['ar', 'en'] as const) {
        const question = row.questions[language];
        if (!question) continue;
        const answer = qa.answer(question, { language });
        const score = scoreAnswer(row.gold, answer);
        const keys = [
          `all/${language}/all`, `${row.dataset}/${language}/all`, `${row.dataset}/${language}/${row.type}`,
        ];
        for (const key of keys) {
          const metrics = groups.get(key) ?? { questions: 0, correct: 0, wrong: 0, abstained: 0, choices: 0 };
          metrics.questions++;
          if (score === 'correct') metrics.correct++;
          else if (score === 'abstained') metrics.abstained++;
          else if (score === 'choice') metrics.choices++;
          else metrics.wrong++;
          groups.set(key, metrics);
        }
        if (answer.status === 'answered' && score !== 'correct') {
          wrong.push({ dataset: row.dataset, id: row.id, language, type: row.type, reason: score, gold: row.gold,
            predicted: answer.values, claims: answer.facts.map(fact => fact.statement.id) });
        } else if (answer.status !== 'answered') {
          const reason = answer.status === 'choice' ? 'choice' : answer.reason;
          unresolved[reason] = (unresolved[reason] ?? 0) + 1;
        }
      }
    }
    const metrics = Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
      const answered = group.correct + group.wrong;
      return [key, {
        ...group,
        accuracy: group.correct / group.questions,
        answeredAccuracy: answered ? group.correct / answered : null,
        coverage: answered / group.questions,
        abstention: (group.abstained + group.choices) / group.questions,
      }];
    }));
    process.stdout.write(`${JSON.stringify({ split, questionSha256, card: knowledge.card, metrics, wrong, unresolved }, null, 2)}\n`);
  } finally {
    knowledge.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Knowledge QA evaluation failed'}\n`);
  process.exitCode = 1;
});
