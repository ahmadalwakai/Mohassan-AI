import { z } from 'zod';
import type { CapabilityExpectation } from '../corpus.js';
import { includesLiteral, includesNumber, normalizedNumber } from '../score.js';
import { Mapping, type Candidate, type ImportResult } from './mapping.js';

type Language = Candidate['item']['language'];
type Content = CapabilityExpectation['requiredContent'];

const mintakaSource = 'https://raw.githubusercontent.com/amazon-science/mintaka/b6146ffb41562803c45df3c028b4cdad8c09dd4d/data/mintaka_test.json';
const stripEnd = (value: string) => value.trim().replace(/[.!?؟]+$/u, '').trimEnd();
const foldQuery = (value: string) => stripEnd(value.normalize('NFC').replace(/[ـً-ٰٟ]/gu, ''))
  .replace(/\s+/gu, ' ').toLowerCase();
const uniqueText = (values: readonly string[]) => [...new Set(values.map(value => value.trim()))].filter(Boolean);
const validPrompt = (question: string) => Boolean(question.trim()) && question.length <= 4000;
const visibleAnswer = (value: string) => value.length >= 2 && value.length <= 4000 && /[\p{L}\p{N}]/u.test(value);

function json(raw: string, dataset: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in the ${dataset} release.`);
  }
}

function jsonArray(raw: string, dataset: string): unknown[] {
  const value = json(raw, dataset);
  if (!Array.isArray(value) || !value.length) throw new Error(`Expected a nonempty array in the ${dataset} release.`);
  return value;
}

function groundedLookup(question: string, content: Content, evidence: {
  title: string;
  url: string;
  passage: string;
  searchAliases?: string[];
}): Pick<Candidate['item'], 'fixture' | 'turns'> {
  const namedQueries = [...new Set([question, ...(evidence.searchAliases ?? [])].flatMap(value =>
    [value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase(), foldQuery(value)]).filter(Boolean))];
  return {
    fixture: {
      wikiArticleCoverage: 'closed-replay',
      searches: namedQueries.map(query => ({ query, results: [{ title: evidence.title, url: evidence.url, snippet: stripEnd(question) }] })),
      pages: [{ title: evidence.title, url: evidence.url, text: evidence.passage }],
    },
    turns: [{ text: question, expect: {
      source: ['public_lookup'],
      operation: ['lookup'],
      route: ['web_search', 'browser_command', 'news'],
      requiredTools: ['read'],
      questionCount: 0,
      status: ['completed'],
      requiredContent: content,
      forbiddenContent: [],
      maxSteps: 20,
    } }],
  };
}

const mintakaRow = z.object({
  id: z.string().min(1),
  question: z.string(),
  translations: z.object({ ar: z.string().nullish() }),
  answer: z.object({ answerType: z.string(), answer: z.array(z.unknown()).nullable(), mention: z.string().nullish() }),
  complexityType: z.string(),
});
const mintakaEntity = z.object({
  name: z.string().regex(/^Q\d+$/u),
  label: z.object({ en: z.string().nullish(), ar: z.string().nullish() }),
});
const mintakaFactTypes = new Set(['generic', 'count', 'intersection', 'ordinal', 'multihop', 'difference', 'superlative', 'yesno']);

function mintakaAnswer(answer: z.infer<typeof mintakaRow>['answer'], language: Language, question: string): Content | string {
  const values = answer.answer;
  if (!values?.length) return 'unlinked-answer';
  if (answer.answerType === 'entity') {
    const content: Content = [];
    for (const value of values) {
      const entity = mintakaEntity.safeParse(value);
      if (!entity.success || !entity.data.label[language]?.trim()) return 'missing-entity-label';
      const englishMention = language === 'en' && values.length === 1 ? answer.mention : null;
      const names = uniqueText([entity.data.label[language]!, ...(englishMention ? [englishMention] : [])])
        .filter(value => visibleAnswer(value) && !includesLiteral(question, value));
      if (!names.length) return 'answer-in-question';
      content.push({ match: 'literal', anyOf: names });
    }
    return content;
  }
  // Matching bare polarity by substring can pass on unrelated names or refusal text.
  if (answer.answerType === 'boolean') return 'boolean-answer';
  if (values.length !== 1) return 'unsupported-answer-format';
  const value = values[0];
  if (answer.answerType === 'numerical' || answer.answerType === 'date' && typeof value === 'string' && /^\d{4}$/u.test(value)) {
    if (typeof value !== 'string' && typeof value !== 'number' || normalizedNumber(String(value)) === null) return 'unsupported-answer-format';
    if (includesNumber(question, String(value))) return 'answer-in-question';
    return [{ match: 'number', anyOf: [String(value)] }];
  }
  if (answer.answerType === 'string' && language === 'en' && typeof value === 'string' && visibleAnswer(value)) {
    if (includesLiteral(question, value)) return 'answer-in-question';
    return [{ match: 'literal', anyOf: [value.trim()] }];
  }
  return 'unsupported-answer-format';
}

export function importMintaka(raw: string): ImportResult {
  const mapping = new Mapping('mintaka');
  for (const value of jsonArray(raw, 'Mintaka')) {
    const parsed = mintakaRow.safeParse(value);
    for (const language of ['ar', 'en'] as const) {
      if (!parsed.success) { mapping.drop('invalid-row'); continue; }
      const row = parsed.data;
      const question = language === 'ar' ? row.translations.ar : row.question;
      if (!question || !validPrompt(question)) { mapping.drop('missing-or-oversized-question'); continue; }
      const comparison = row.complexityType === 'comparative';
      if (!comparison && !mintakaFactTypes.has(row.complexityType)) { mapping.drop('unknown-complexity'); continue; }
      const content = mintakaAnswer(row.answer, language, question);
      if (typeof content === 'string') { mapping.drop(content); continue; }
      // This is the dataset's QA record. It does not represent a Wikidata article or independent corroboration.
      const annotatedAnswer = content.map(assertion => assertion.anyOf[0]!).join(language === 'ar' ? '، ' : ', ');
      const entry = language === 'ar'
        ? `السؤال: ${stripEnd(question)} | الإجابة: ${annotatedAnswer}`
        : `Question: ${stripEnd(question)} | Answer: ${annotatedAnswer}`;
      mapping.accept(`${row.id}:${language}`, row.id, {
        area: comparison ? 'comparison' : 'factual',
        language,
        variety: language === 'ar' ? 'unspecified' : 'english',
        ...groundedLookup(question, content, { title: 'Mintaka', url: mintakaSource, passage: entry }),
      });
    }
  }
  return mapping.result();
}

const tydiRow = z.object({
  id: z.string().min(1),
  language: z.enum(['arabic', 'english']),
  document_title: z.string().min(1),
  passage_text: z.string().min(1),
  question_text: z.string(),
  answers: z.array(z.object({ text: z.string(), start_byte: z.number().int().nonnegative(), limit_byte: z.number().int().positive() })),
});

function tyDiAnswer(row: z.infer<typeof tydiRow>): Content | string {
  const utf8 = Buffer.from(row.passage_text, 'utf8');
  if (!row.answers.length || row.answers.some(({ text, start_byte, limit_byte }) =>
    limit_byte <= start_byte || limit_byte > utf8.length || !utf8.subarray(start_byte, limit_byte).equals(Buffer.from(text, 'utf8')))) {
    return 'invalid-answer-span';
  }
  const answers = uniqueText(row.answers.map(answer => answer.text));
  const numbers = answers.filter(value => normalizedNumber(value) !== null);
  const literals = answers.filter(value => normalizedNumber(value) === null && visibleAnswer(value)
    && !/^(?:yes|no|نعم|لا)[.!؟?]*$/iu.test(value) && !includesLiteral(row.question_text, value));
  if (literals.length) return [{ match: 'literal', anyOf: literals }];
  const unseen = numbers.filter(value => !includesNumber(row.question_text, value));
  return unseen.length ? [{ match: 'number', anyOf: unseen }] : 'no-scoreable-answer';
}

export function importTyDiQA(arJsonl: string, enJsonl: string): ImportResult {
  const mapping = new Mapping('tydiqa');
  for (const [language, raw] of [['ar', arJsonl], ['en', enJsonl]] as const) {
    const rows = raw.split(/\r?\n/u).filter(line => line.trim());
    if (!rows.length) throw new Error('Expected nonempty TyDiQA-GoldP splits.');
    for (const value of rows) {
      const parsed = tydiRow.safeParse(json(value, 'TyDiQA-GoldP'));
      if (!parsed.success || parsed.data.language !== (language === 'ar' ? 'arabic' : 'english')) {
        mapping.drop('invalid-row-or-language');
        continue;
      }
      const row = parsed.data;
      if (!validPrompt(row.question_text)) { mapping.drop('missing-or-oversized-question'); continue; }
      const content = tyDiAnswer(row);
      if (typeof content === 'string') { mapping.drop(content); continue; }
      const title = row.document_title;
      const url = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /gu, '_'))}`;
      const key = `${row.id}:${language}`;
      mapping.accept(key, `${language}:${foldQuery(title)}`, {
        area: 'factual', language, variety: language === 'ar' ? 'unspecified' : 'english',
        ...groundedLookup(row.question_text, content, { title, url, passage: row.passage_text, searchAliases: [title] }),
      });
    }
  }
  return mapping.result();
}

const canardRow = z.object({
  QuAC_dialog_id: z.string().min(1),
  Question_no: z.number().int().positive(),
  History: z.array(z.string()),
  Question: z.string().min(1),
  Rewrite: z.string().min(1),
});

export function importCanard(raw: string): ImportResult {
  const mapping = new Mapping('canard');
  for (const value of jsonArray(raw, 'CANARD')) {
    const parsed = canardRow.safeParse(value);
    if (!parsed.success) { mapping.drop('invalid-row'); continue; }
    const row = parsed.data;
    if (row.Question_no === 1) { mapping.drop('no-previous-turn'); continue; }
    if (row.History.length !== row.Question_no * 2 || row.History.some(value => !value.trim()) || !row.Question.trim()) {
      mapping.drop('invalid-history');
      continue;
    }
    const rewrite = stripEnd(row.Rewrite);
    if (!rewrite || includesLiteral(row.Question, rewrite)) { mapping.drop('no-context-dependent-rewrite'); continue; }
    const [article, section, ...dialogue] = row.History;
    const history = dialogue.map((turn, index) => `${index % 2 === 0 ? 'Question' : 'Answer'}: ${turn}`);
    const text = [
      'Rewrite the final question as a standalone search query using the context below. Return only the rewritten query without ending punctuation.',
      `Article: ${article}`,
      `Section: ${section}`,
      ...history,
      `Final question: ${row.Question}`,
    ].join('\n');
    if (!validPrompt(text) || rewrite.length > 4000) { mapping.drop('oversized-history-or-rewrite'); continue; }
    if (includesLiteral(text, rewrite)) { mapping.drop('rewrite-in-prompt'); continue; }
    mapping.accept(`${row.QuAC_dialog_id}:${row.Question_no}`, row.QuAC_dialog_id, {
      area: 'follow-up', language: 'en', variety: 'english',
      turns: [{ text, expect: {
        source: ['supplied_content'], operation: ['transform'], route: ['writing'], questionCount: 0, status: ['completed'],
        requiredContent: [{ match: 'literal', anyOf: [rewrite] }], forbiddenContent: [], forbiddenTools: ['search', 'read', 'open'], maxSteps: 6,
      } }],
    });
  }
  return mapping.result();
}
