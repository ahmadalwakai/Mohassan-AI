import { readFileSync } from 'node:fs';
import { predictQuestionEdit } from '../../apps/server/src/assistant/question-edit-model.ts';
import { questionEditOrder } from '../../apps/server/src/assistant/question-edit-weights.ts';
import { combineQuestionRewrites, questionRewriteOrder } from '../../apps/server/src/assistant/question-rewrite-order.ts';
import { rewriteFollowUpQuestion } from '../../apps/server/src/assistant/question-rewriter.ts';
import { normalizeQuestionRewrite, questionRewriteCounts, questionRewriteLiteral, scoreQuestionRewrite } from './question-edit-metrics.ts';

interface CanardRow {
  History: string[];
  Question: string;
  Question_no: number;
  Rewrite: string;
}

interface FilteredDev {
  receipt: { sourceSha256: string; exclusionManifestSha256: string; input: number; dropped: number; retained: number };
  rows: CanardRow[];
}

const pronoun = /\b(he|him|his|she|her|hers|it|its|they|them|their|theirs)\b/giu;
const possessive = /^(?:his|hers|its|their|theirs)$/iu;
const possessiveHer = /^\s+\p{L}/u;

function replacePronouns(question: string, article: string): string {
  return question.replace(pronoun, (word: string, _group: string, offset: number) => {
    if (possessive.test(word) || (word.toLowerCase() === 'her' && possessiveHer.test(question.slice(offset + word.length)))) {
      return `${article}'s`;
    }
    return article;
  });
}

const methods = ['pronounReplacement', 'rules', 'model', 'rulesFirst', 'modelFirst'] as const;
type Method = (typeof methods)[number];
function allMethods(): Record<Method, ReturnType<typeof questionRewriteCounts>> {
  return Object.fromEntries(methods.map(method => [method, questionRewriteCounts()])) as Record<Method, ReturnType<typeof questionRewriteCounts>>;
}

const [inputPath, ...rest] = process.argv.slice(2);
if (!inputPath || rest.length) throw new Error('Pass the filtered JSON produced by prepare-canard-dev.py.');
const { receipt, rows } = JSON.parse(readFileSync(inputPath, 'utf8')) as FilteredDev;
if (receipt?.input !== 3430 || receipt.retained !== rows.length || receipt.input !== receipt.retained + receipt.dropped) {
  throw new Error('Invalid CANARD dev preparation receipt.');
}

const all = allMethods();
const contextDependentFollowUps = allMethods();

for (const row of rows) {
  const [articleTitle, sectionTitle, ...dialogue] = row.History;
  const turns = [];
  for (let index = 0; index < dialogue.length; index += 2) {
    turns.push({ question: dialogue[index]!, answer: dialogue[index + 1] });
  }
  const history = { articleTitle, sectionTitle, turns };
  const rules = rewriteFollowUpQuestion(row.Question, history);
  const model = predictQuestionEdit(row.Question, history)?.text ?? null;
  const outputs: Record<Method, string> = {
    pronounReplacement: replacePronouns(row.Question, articleTitle),
    rules,
    model: model ?? row.Question,
    rulesFirst: combineQuestionRewrites(row.Question, 'rules-first', () => rules, () => model),
    modelFirst: combineQuestionRewrites(row.Question, 'model-first', () => rules, () => model),
  };
  const reference = questionRewriteLiteral(row.Rewrite);
  const dependsOnContext = row.Question_no > 1 && reference && !normalizeQuestionRewrite(row.Question).includes(reference);
  for (const method of methods) {
    scoreQuestionRewrite(all[method], outputs[method], row.Rewrite, reference);
    if (dependsOnContext) scoreQuestionRewrite(contextDependentFollowUps[method], outputs[method], row.Rewrite, reference);
  }
}

console.log(JSON.stringify({
  receipt, canardPreferredOrder: questionEditOrder, selectedOrder: questionRewriteOrder, all, contextDependentFollowUps,
}, null, 2));
