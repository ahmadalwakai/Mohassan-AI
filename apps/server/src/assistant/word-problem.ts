import type { LocalComputation } from './local-computation.js';
import type { Evidence } from './mind/contract.js';
import { evaluateWordExpression, type WordExpression } from './word-problem-graph.js';
import { extractQuantities, normalizeWordProblem } from './word-problem-quantities.js';
import { parseEqualShare, parseGroups, parseTimedRate } from './word-problem-rates.js';
import { parseEnglishRelations } from './word-problem-relations.js';
import { parseArabicWordProblem } from './word-problem-arabic.js';
import { parseAgeComparison, parseInverseProportion, parseInverseRate } from './word-problem-proportions.js';
import { parseAllocations } from './word-problem-allocations.js';
import { parseRepeatedRates } from './word-problem-repeated-rates.js';
import { parseItemCosts } from './word-problem-costs.js';

const englishQuestion = /\b(?:how (?:many|much|far|long|old)|what (?:is|was|will be) (?:the |her |his |their )?(?:total|difference|average|sum|cost|number|price|amount|percentage|fraction|age)|(?:calculate|find|determine) (?:the |her |his |their )?)\b/iu;
const arabicQuestion = /(?<!\p{L})كم(?!\p{L})/u;
const sentenceBoundary = /\.(?=\s|$)|[!;؛]/u;
const externalAction = /^(?:(?:and |then |also |please |kindly |ثم )*)(?:search|look up|find online|open|visit|navigate|save|remember|send|email|publish|post|schedule|delete|run|execute|translate|summarize|write|ابحث|افتح|ارسل|أرسل|احفظ|انشر|ترجم|اكتب)(?!\p{L})/iu;
const storyVerb = /\b(?:has|have|had|owns?|owned|buys?|bought|sells?|sold|gets?|got|receives?|received|gives?|gave|takes?|took|makes?|made|produces?|produced|prints?|printed|reads?|read|works?|worked|costs?|runs?|ran|walks?|walked|travels?|traveled|uses?|used|spends?|spent|earns?|earned|needs?|needed|holds?|held|contains?|contained|each|per)\b/iu;
const arabicStory = /(?<!\p{L})(?:لدى|عند|مع|اشترى|اشترت|باع|باعت|أعطى|أعطت|ينتج|تنتج|يصنع|تصنع|يطبع|تطبع|يقرأ|تقرأ|كل)(?!\p{L})/u;

interface Problem {
  lang: 'ar' | 'en';
  statements: string[];
  question: string;
}

function readProblem(request: string): Problem | null {
  if (request.length > 1600) return null;
  const text = normalizeWordProblem(request);
  if (/^["«“]|\x60|https?:\/\/|\bwww\./iu.test(text)) return null;
  const body = text.replace(/[.?؟]$/u, '').trim();
  if (/[?؟]/u.test(body)) return null;
  const lang = /\p{Script=Arabic}/u.test(body) ? 'ar' : 'en';
  const questionHead = lang === 'ar' ? arabicQuestion : englishQuestion;
  const sentences = body.split(sentenceBoundary).map(sentence => sentence.trim()).filter(Boolean);
  const last = sentences.pop();
  const head = last && questionHead.exec(last);
  if (!last || !head || sentences.length > 7) return null;
  if (head.index) {
    const lead = last.slice(0, head.index).trim();
    if (!/[,،]$/u.test(lead) || !/^(?:if |إذا |اذا |لو )/iu.test(lead)) return null;
    sentences.push(lead.slice(0, -1).replace(/^(?:if|إذا|اذا|لو) /iu, '').trim());
  }
  let question = last.slice(head.index);
  if (lang === 'en') {
    // A trailing if-clause supplies a fact under the same scope as a leading one.
    const conditional = /^(.+?)\s*,? if (.+)$/iu.exec(question);
    if (conditional) {
      question = conditional[1]!;
      sentences.push(conditional[2]!);
    }
  }
  if (!sentences.length || [...sentences, question].some(sentence =>
    sentence.split(/[,،] |\b(?:and then|and also|then) |(?:^| )ثم /iu).some(part => externalAction.test(part)))) return null;
  return { lang, statements: sentences, question };
}

function display(expression: string): string {
  return expression.replace(/ \* /gu, ' × ').replace(/ \/ /gu, ' ÷ ');
}

type Computed = NonNullable<ReturnType<typeof evaluateWordExpression>>;

function computedReply(lang: Problem['lang'], result: Computed): LocalComputation {
  const finalLine = `${lang === 'ar' ? 'النتيجة النهائية' : 'Final answer'} = ${result.value}`;
  const evidence: Evidence[] = result.steps.map((step, index) => ({
    id: `word-step-${index + 1}`,
    source: 'computed',
    quote: `${step.label ? `${step.label} — ` : ''}${display(step.expression)} = ${step.value}`,
    value: step.value,
  }));
  evidence.push({ id: 'word-problem-answer', source: 'computed', quote: finalLine, value: result.value });
  const text = evidence.map(item => item.quote).join('\n');
  const claims = evidence.map(item => ({ text: item.quote, support: [item.id], status: 'confirmed' as const }));
  const calculation: Evidence = { id: 'calculation', source: 'computed', quote: `${result.expression} = ${result.value}`, value: result.value };
  return { status: 'completed', text, lang, evidence: [calculation, ...evidence], claims };
}

function abstention(problem: Problem, ambiguous: boolean): LocalComputation | null {
  const { lang, statements, question } = problem;
  const context = statements.join(' ');
  const mentions = extractQuantities(context);
  const questionAmounts = extractQuantities(question);
  const missingEventAmount = storyVerb.test(context) && /\b(?:left|remaining)\b/iu.test(question)
    && /\b(?:some|an unknown number|several)\b/iu.test(context);
  if (!ambiguous && (!mentions.length || mentions.length + questionAmounts.length < 2 && !missingEventAmount
    || lang === 'ar' && !arabicStory.test(context))) return null;
  const quantities = [...new Set([...mentions, ...questionAmounts].map(mention => mention.mention))].slice(0, 5);
  const differingTimeUnits = /\b(?:per|every|each|an?) (?:second|minute|hour|day|week|month|year)\b/iu.test(context)
    && /\b(?:in|over|for|after) [^?]+\b(?:shifts?|sessions?|rounds?|trips?)\b/iu.test(question);
  const followUp = ambiguous ? 'Which relationship should I use to connect the quantities?'
    : differingTimeUnits ? 'What is the duration of one of those periods in the rate’s time unit?'
      : missingEventAmount ? 'How many were added or taken away in the event with no stated amount?'
      : 'How are the given quantities related to the amount you want to find?';
  const text = lang === 'ar'
    ? `لم أتمكن من حل المسألة بثقة. فهمت هذه الكميات: ${quantities.join('، ')}. ما العلاقة بين هذه الكميات والكمية المطلوبة؟`
    : `I couldn't solve this problem reliably. I understood these quantities: ${quantities.join(', ')}. ${followUp}`;
  return { status: 'blocked', text, lang, claims: [{ text, support: [], status: 'fixed' }], evidence: [], abstained: true };
}

/** Accept only complete parses. Different evaluable readings require clarification. */
export function evaluateWordProblem(request: string): LocalComputation | null {
  const problem = readProblem(request);
  if (!problem) return null;
  const { lang, statements, question } = problem;
  const parsers = lang === 'ar' ? [parseArabicWordProblem]
    : [parseTimedRate, parseGroups, parseEqualShare, parseEnglishRelations,
      parseInverseProportion, parseInverseRate, parseAgeComparison, parseAllocations, parseRepeatedRates, parseItemCosts];
  const graphs = parsers.map(parse => parse(statements, question)).filter((graph): graph is WordExpression => graph !== null);
  const results = graphs.map(evaluateWordExpression);
  const first = results[0];
  const ambiguous = Boolean(first && results.some(result => result !== null && result.value !== first.value));
  if (first && !ambiguous && results.every(result => result !== null)) return computedReply(lang, first);
  return abstention(problem, ambiguous);
}
