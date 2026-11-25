import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { CodeKnowledge, createCodeKnowledgeShadow, formatAnswer, readCorpus } from '../../packages/code-knowledge/src/index.js';

const { values, positionals } = parseArgs({
  options: {
    corpus: { type: 'string' },
    shadow: { type: 'boolean' },
    error: { type: 'boolean' },
  },
  allowPositionals: true,
});
if (!values.corpus || (!positionals.length && process.stdin.isTTY)) {
  throw new Error('Usage: tsx scripts/code-knowledge/ask.ts --corpus <path> [--shadow | --error] [question]');
}
if (values.shadow && values.error) throw new Error('Select a single mode; shadow classifies pasted errors by default');
const question = positionals.length ? positionals.join(' ') : await text(process.stdin);
const answerer = new CodeKnowledge(await readCorpus(values.corpus));
if (values.shadow) {
  createCodeKnowledgeShadow(answerer, event => process.stdout.write(`${JSON.stringify(event)}\n`)).observe(question);
} else {
  const answer = answerer.answer(question, values.error ? { mode: 'error' } : {});
  const locale = /\p{Script=Arabic}/u.test(question) ? 'ar' : 'en';
  process.stdout.write(`${formatAnswer(answer, locale)}\n`);
}
