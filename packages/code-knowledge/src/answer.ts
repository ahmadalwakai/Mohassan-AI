import { classifyQuestion, isEditRequest } from './intent.js';
import { glossaryTerms } from './glossary.js';
import { CodeIndex, type SearchHit } from './indexer.js';
import { extractErrorSignatures, extractSymbols, isOperatorToken, tokenize, tokenizeQuery } from './tokens.js';
import type { Citation, CodeAnswer, CodeBlock, Corpus, Excerpt, Passage, QuestionType, SourceCard } from './types.js';

const MAX_QUESTION_LENGTH = 16_000;
const sentencePattern = /[^\n]+?(?:[.!?]+(?=\s|$)|(?=\n|$))/gu;
const namedComparison = /(?:\b(?:difference|comparison) between\s+|^compar(?:e|ing)\s+|الفرق بين\s+|مقارنة بين\s+|قارن بين\s+)/iu;
const comparisonSeparator = /\s+(?:vs\.?|versus|compared (?:to|with))\s+/iu;
const remedy = /\b(?:instead|correct|avoid|should|caused by|occurs when|to (?:fix|resolve|prevent))\b/iu;
const requestedVersion = /\b(python|node(?:[. -]?js)?|typescript)\s+v?(\d+(?:\.\d+){0,2})(?![\w.])/iu;
const diagnosticOutput = /^(?:\s*(?:\/\/|#|\*)\s*)?(?:Uncaught )?(?:[\w]*(?:Error|Exception|Warning):[^\r\n]+|Traceback \(most recent call last\):)/gmu;
const proceduralContext = /\b(?:when|while|after|before|without)\b/iu;
const ecosystems = [
  { mentions: /\b(?:node[. -]?js|(?:in|with) node|node(?=\s+v?\d))\b/iu, tag: /^(?:node[. -]?js)(?:$|-)/iu },
  { mentions: /\btypescript\b/iu, tag: /^typescript(?:$|-)/iu },
  { mentions: /\b(?:javascript|java script)\b/iu, tag: /^javascript(?:$|-)/iu },
  { mentions: /\bpython\b/iu, tag: /^python(?:$|-|\d)/iu },
  { mentions: /\b(?:postgresql|postgres)\b/iu, tag: /^postgres(?:ql)?(?:$|-)/iu },
  { mentions: /\b(?:bash|zsh|posix shell)\b/iu, tag: /^(?:bash|zsh|shell|posix)(?:$|-)/iu },
];

function overlap(text: string, terms: ReadonlySet<string>): number {
  return new Set(tokenize(text).filter(term => terms.has(term))).size;
}

function hasDiagnostic(text: string, signatures: ReadonlySet<string>): boolean {
  return signatures.size > 0 && extractErrorSignatures(text).some(signature => signatures.has(signature));
}

function eligible(hit: SearchHit, intent: QuestionType, signatures: ReadonlySet<string>, strongSymbolMatch: boolean): boolean {
  if (intent === 'error' && signatures.size > 0) return hit.matchedError;
  if (strongSymbolMatch) return hit.lexicalMatches > 0;
  return hit.lexicalMatches >= 2 && hit.lexicalMatches / hit.queryTermCount >= 0.42;
}

function hasBothSides(passage: Passage, question: string): boolean {
  const subject = question.split(namedComparison)[1];
  const explicit = (subject ?? question).split(comparisonSeparator);
  const sides = explicit.length === 1 && subject ? subject.split(/\s+and\s+|\s+و\s*/iu) : explicit;
  if (sides.length !== 2) return false;
  const content = new Set(tokenize([passage.title, passage.text, ...passage.code.map(block => block.text)].join('\n')));
  return sides.every(side => {
    const terms = tokenizeQuery(side.replace(/\s+in\s+.+$/iu, '').replace(/^(?:compare|comparing)\s+/iu, ''));
    const operators = terms.filter(isOperatorToken);
    const subjectTerms = operators.length ? operators : terms;
    return subjectTerms.length > 0 && subjectTerms.every(term => content.has(term));
  });
}

function selectSentences(text: string, terms: ReadonlySet<string>, signatures: ReadonlySet<string>, hit: SearchHit): string[] {
  const ranked = [...text.matchAll(sentencePattern)]
    .map(([match], position) => {
      const sentence = match.trim();
      const diagnostic = hasDiagnostic(sentence, signatures) ? 5 : 0;
      const fix = hit.matchedError && remedy.test(sentence) ? 3 : 0;
      return { sentence, position, score: overlap(sentence, terms) + diagnostic + fix };
    })
    .filter(({ sentence, score }) => score > 0 && sentence.length > 12 && sentence.length <= 600)
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .slice(0, 3);
  return ranked.sort((left, right) => left.position - right.position).map(({ sentence }) => sentence);
}

function selectCode(passage: Passage, terms: ReadonlySet<string>, hit: SearchHit, signatures: ReadonlySet<string>): CodeBlock[] {
  const ranked = passage.code.filter(block => {
    if (block.role === 'failure' || !block.text.trim() || block.text.length > 8_000) return false;
    if (!hit.matchedError || block.role === 'fix') return true;
    return ![...block.text.matchAll(diagnosticOutput)].some(([output]) => hasDiagnostic(output, signatures));
  })
    .map((block, position) => ({
      block,
      position,
      score: overlap(block.text, terms) + ([...hit.exactSymbols, ...hit.foldedSymbols].some(symbol => block.text.includes(symbol)) ? 3 : 0)
        + (hit.matchedError && block.role === 'fix' ? 4 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.position - right.position);
  const best = ranked[0];
  // A passage with one example can pair it with an exact diagnostic, even when
  // the fix does not repeat the diagnostic's words.
  return best && (best.score > 0 || (ranked.length === 1 && hit.matchedError)) ? [best.block] : [];
}

function citationFor(passage: Passage, source: SourceCard): Citation {
  return {
    title: passage.title,
    url: passage.url,
    questionUrl: passage.questionUrl,
    sourceTitle: source.title,
    sourceUrl: source.url,
    version: source.version,
    fingerprint: source.fingerprint,
    license: passage.license ?? source.license,
    licenseUrl: passage.licenseUrl ?? source.licenseUrl,
    attribution: passage.attribution ?? [],
    copyrightNotice: passage.copyrightNotice ?? source.copyrightNotice,
  };
}

export class CodeKnowledge {
  private readonly index: CodeIndex;
  private readonly sources: ReadonlyMap<string, SourceCard>;

  constructor(corpus: Corpus) {
    this.index = new CodeIndex(corpus.passages);
    this.sources = new Map(corpus.sources.map(source => [source.id, source]));
  }

  answer(question: string, options: { mode?: 'error' } = {}): CodeAnswer {
    if (!question.trim() || question.length > MAX_QUESTION_LENGTH) {
      return { status: 'abstained', intent: options.mode ?? 'concept', reason: 'unsupported-request' };
    }
    const intent = options.mode ?? classifyQuestion(question);
    if (isEditRequest(question)) return { status: 'abstained', intent, reason: 'unsupported-request' };
    const terms = new Set(tokenizeQuery(question));
    const signatures = new Set(extractErrorSignatures(question));
    const strongSymbols = new Set(extractSymbols(question));
    const languageText = [question, ...glossaryTerms(question)].join(' ');
    const requestedEcosystems = ecosystems.filter(({ mentions }) => mentions.test(languageText));
    const version = languageText.match(requestedVersion)?.[2];
    const versionMatches = (source: SourceCard) => {
      if (!version) return true;
      const sourceVersion = source.version.replace(/^v/u, '');
      return source.kind === 'documentation' && (sourceVersion === version || sourceVersion.startsWith(version + '.'));
    };
    const topic = requestedEcosystems.reduce((text, { mentions }) => text.replace(mentions, ''), languageText);
    const topicTerms = new Set(tokenize(topic).filter(term => term !== 'new'));
    const actionTerms = intent === 'how-to' && proceduralContext.test(topic)
      ? new Set(tokenize(topic.split(proceduralContext)[0]).filter(term => term !== 'new'))
      : undefined;
    const accepts = (passage: Passage) => requestedEcosystems.every(({ tag }) => passage.tags.some(value => tag.test(value)));
    const excerpts: Excerpt[] = [];
    for (const hit of this.index.search(question, 40, accepts)) {
      const { passage } = hit;
      const source = this.sources.get(passage.sourceId);
      const strongSymbolMatch = hit.exactSymbols.some(symbol => strongSymbols.has(symbol)) || hit.foldedSymbols.length > 0;
      if (!source || !versionMatches(source) || !eligible(hit, intent, signatures, strongSymbolMatch)) continue;
      if (intent === 'comparison' && !hasBothSides(passage, question)) continue;
      if (excerpts.some(excerpt => excerpt.citation.url === passage.url)) continue;
      const sentences = selectSentences(passage.text, terms, signatures, hit);
      const code = selectCode(passage, terms, hit, signatures);
      if (sentences.length === 0 || code.length === 0) continue;
      const evidence = [...sentences, ...code.map(block => block.text)].join('\n');
      if (!hit.matchedError && !strongSymbolMatch) {
        if (overlap(evidence, topicTerms) < Math.max(1, Math.ceil(0.6 * topicTerms.size))) continue;
        if (actionTerms && overlap(evidence, actionTerms) < Math.min(2, actionTerms.size)) continue;
      }
      if (excerpts.length && !code.some(block => block.role === 'fix') && !sentences.some(sentence => remedy.test(sentence))) continue;
      excerpts.push({ sentences, code, citation: citationFor(passage, source) });
      if (intent !== 'error' || excerpts.length === 2) break;
    }
    return excerpts.length
      ? { status: 'answered', intent, excerpts }
      : { status: 'abstained', intent, reason: 'insufficient-evidence' };
  }
}
