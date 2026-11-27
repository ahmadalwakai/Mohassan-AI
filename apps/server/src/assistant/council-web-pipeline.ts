import { figureKind, hasFigureOf, isDisambiguationPage } from './answer-check.js';
import { selectPassage } from './council-passage.js';
import { factualPassage, type FactualPassage } from './factual-evidence.js';
import { entityWords, relevantLines, topicWords } from './hands.js';
import { comparable, type JudgeEvidence } from './judge.js';
import { extractQuote, isPageInstruction } from './mind/extract.js';
import { buildFrame } from './mind/frame.js';

type WebPage = JudgeEvidence & { url: string };
type PipelineProposal = { answer: string; citation: { url: string; quote: string } };

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const count = String.raw`\p{Nd}+(?:[,،٬]\p{Nd}{3})*(?:[.٫]\p{Nd}+)?`;
const arabicPopulation = new RegExp(String.raw`^(?:(?:يبلغ|بلغ|تبلغ|بلغت)\s+)?(?:عدد\s+)?سكان\s+(?<subject>[\p{L}\p{M} ]+?)\s+(?:(?:يبلغ|بلغ|تبلغ|بلغت)\s+)?(?<value>${count}(?:\s+(?:ألف|آلاف|مليون|ملايين|مليار))?)\s+(?:نسمة|نسَمَة|شخص|أشخاص|ساكن)(?!\p{L})`, 'u');
const englishPopulation = new RegExp(String.raw`^(?:the\s+)?population\s+of\s+(?<subject>[\p{L}\p{M} ’'-]+?)\s+(?:is|was|stands at|stood at)\s+(?<value>${count}(?:\s+(?:thousand|million|billion))?)(?![\p{L}\p{N}%]|[.,]\p{Nd}|\s+per\b)`, 'iu');
const founderQuestion = /^من\s+[أا]سس(?:ت)?\s+(?<subject>.+?)[؟?.!]*$/u;
const founderVerb = '[أا]سس(?:ت)?';
const personName = String.raw`(?<value>[\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+){1,4}?)`;
const personalTitle = '(?:(?:ال)?(?:مهندس|دكتور|أستاذ|استاذ)\\s+)?';

function matchesName(subject: readonly string[], name: string): boolean {
  const named = topicWords(name);
  return subject.length === named.length && subject.every(word => named.includes(word));
}

function namedPopulation(page: Pick<WebPage, 'text'> & { title: string }, question: string): FactualPassage | undefined {
  const subject = entityWords(question);
  if (!subject.length) return;
  // A bilingual title can establish the source's own cross-language name. An English title
  // alone does not identify the subject of a sentence that uses an Arabic name.
  const names = /^([^()]+?)\s*\(([^()]+)\)$/u.exec(page.title);
  const alias = names && (matchesName(subject, names[1]) ? topicWords(names[2])
    : matchesName(subject, names[2]) ? topicWords(names[1]) : undefined);
  const candidates = new Map<string, FactualPassage>();
  for (const { segment } of sentences.segment(page.text)) {
    const quote = segment.trim();
    const statement = (arabicPopulation.exec(quote) ?? englishPopulation.exec(quote))?.groups;
    if (!statement || !hasFigureOf('people', quote)) continue;
    if (!matchesName(subject, statement.subject) && !(alias?.length && matchesName(alias, statement.subject))) continue;
    candidates.set(comparable(statement.value), { value: statement.value, quote });
    if (candidates.size > 1) return;
  }
  return candidates.values().next().value;
}

function namedFounder(text: string, subject: string): FactualPassage | undefined {
  const literal = subject.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
  const end = String.raw`(?=[.،,؛;!]|\s+(?:في|عام|سنة|بعد|قبل)(?!\p{L})|$)`;
  const afterSubject = new RegExp(`^${founderVerb}\\s+${literal}\\s+${personalTitle}${personName}${end}`, 'u');
  const beforeSubject = new RegExp(`^${founderVerb}\\s+${personalTitle}${personName}\\s+${literal}${end}`, 'u');
  const candidates = new Map<string, FactualPassage>();
  for (const { segment } of sentences.segment(text)) {
    const quote = segment.trim();
    const value = (afterSubject.exec(quote) ?? beforeSubject.exec(quote))?.groups?.value;
    if (!value) continue;
    candidates.set(comparable(value), { value, quote });
    if (candidates.size > 1) return;
  }
  return candidates.values().next().value;
}

function quoteOnPage(page: WebPage, quote: string, answer: string): string | undefined {
  const index = page.text.indexOf(quote);
  if (index < 0) return;
  const sentence = sentences.segment(page.text).containing(index)?.segment.trim();
  // The strict council citation is one full sentence, up to 400 characters.
  if (sentence && sentence.length <= 400 && sentence.includes(quote) && sentence.includes(answer) && !isPageInstruction(sentence)) return sentence;
}

/** Propose a literal span or statement supported by a complete sentence read for this turn. */
export function pipelineFromEvidence(question: string, pages: readonly WebPage[]): PipelineProposal | undefined {
  const frame = buildFrame(question);
  const population = figureKind(question) === 'people';
  const founder = founderQuestion.exec(question.trim())?.groups?.subject;
  const candidates = new Map<string, PipelineProposal>();
  for (const page of pages) {
    const source = { title: page.title ?? '', text: page.text, elements: [] };
    if (isDisambiguationPage(source)) continue;
    // This is the same direct relation extractor used for factual hands replies.
    const direct = factualPassage(source, question);
    const typed = direct ?? (population ? namedPopulation(source, question) : founder ? namedFounder(page.text, founder) : undefined);
    const ranked = typed || population || founder ? undefined
      : selectPassage(question, [page])?.text ?? relevantLines(source, question, 1, true)[0];
    const extracted = typed ?? (ranked && extractQuote(ranked, frame));
    if (!extracted) continue;
    const answer = extracted.value ?? extracted.quote;
    const quote = quoteOnPage(page, extracted.quote, answer);
    const key = comparable(answer);
    if (quote && key && !candidates.has(key)) candidates.set(key, { answer, citation: { url: page.url, quote } });
    if (candidates.size > 1) return;
  }
  return candidates.values().next().value;
}
