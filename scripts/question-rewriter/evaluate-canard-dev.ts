import { readFileSync } from 'node:fs';
import { rewriteFollowUpQuestion } from '../../apps/server/src/assistant/question-rewriter.ts';

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

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
}

function withoutEndingPunctuation(text: string): string {
  return text.trim().replace(/[.!?؟]+$/u, '').trimEnd();
}

function counts() {
  return { total: 0, exact: 0, normalizedSubstring: 0 };
}

function score(result: ReturnType<typeof counts>, output: string, reference: string, normalizedReference: string) {
  result.total++;
  if (output === reference) result.exact++;
  if (normalizedReference && normalize(output).includes(normalizedReference)) result.normalizedSubstring++;
}

const [inputPath, ...rest] = process.argv.slice(2);
if (!inputPath || rest.length) throw new Error('Pass the filtered JSON produced by prepare-canard-dev.py.');
const { receipt, rows } = JSON.parse(readFileSync(inputPath, 'utf8')) as FilteredDev;
if (receipt?.input !== 3430 || receipt.retained !== rows.length || receipt.input !== receipt.retained + receipt.dropped) {
  throw new Error('Invalid CANARD dev preparation receipt.');
}

const all = { pronounReplacement: counts(), rewriter: counts() };
const contextDependentFollowUps = { pronounReplacement: counts(), rewriter: counts() };

for (const row of rows) {
  const [articleTitle, sectionTitle, ...dialogue] = row.History;
  const turns = [];
  for (let index = 0; index < dialogue.length; index += 2) {
    turns.push({ question: dialogue[index]!, answer: dialogue[index + 1] });
  }
  const baseline = replacePronouns(row.Question, articleTitle);
  const rewritten = rewriteFollowUpQuestion(row.Question, { articleTitle, sectionTitle, turns });
  const reference = normalize(withoutEndingPunctuation(row.Rewrite));
  score(all.pronounReplacement, baseline, row.Rewrite, reference);
  score(all.rewriter, rewritten, row.Rewrite, reference);
  if (row.Question_no > 1 && reference && !normalize(row.Question).includes(reference)) {
    score(contextDependentFollowUps.pronounReplacement, baseline, row.Rewrite, reference);
    score(contextDependentFollowUps.rewriter, rewritten, row.Rewrite, reference);
  }
}

console.log(JSON.stringify({ receipt, all, contextDependentFollowUps }, null, 2));
