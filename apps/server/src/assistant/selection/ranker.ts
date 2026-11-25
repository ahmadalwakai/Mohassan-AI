import { observedLayout } from '@mohassan/browser';
import { isDisambiguationPage, isUiText, textLanguage } from '../answer-check.js';
import { classifyPage } from '../page-cache.js';
import { classifyQuestion, extractAnswerType, type AnswerTypeEvidence, type QuestionIntent } from './answer-types.js';
import { combinedCalibration, originalCalibration, type SelectionWeights } from './calibration.js';
import { entityAgreement, questionEntities, type EntityAgreement } from './entity.js';
import { pageStructure, type SelectionBlock } from './page-structure.js';
import { selectionTerms, stemOverlap } from './word-forms.js';

export interface SelectionPage {
  url: string;
  title: string;
  text: string;
  blocks?: readonly SelectionBlock[];
}

export interface QuoteCandidate {
  text: string;
  url: string;
  title: string;
  kind: 'title' | 'lead' | 'sentence' | 'list' | 'table';
  heading?: string;
  cells?: readonly string[];
  position: number;
  previousText?: string;
}

export interface SelectionFeatures {
  type: AnswerTypeEvidence | null;
  entity: EntityAgreement;
  overlap: number;
  position: number;
  source: number;
}

interface AssessedCandidate extends QuoteCandidate {
  features: SelectionFeatures;
  eligible: boolean;
}

export interface RankedCandidate extends AssessedCandidate {
  score: number;
  reasons: readonly string[];
}

export interface PreparedSelection {
  intent: QuestionIntent;
  candidates: readonly AssessedCandidate[];
}

export interface SelectionDecision {
  intent: QuestionIntent;
  selected: RankedCandidate | null;
  ranked: readonly RankedCandidate[];
  threshold: number;
  reason: 'selected' | 'unsupported-question' | 'no-evidence' | 'below-threshold';
}

const MAX_PAGE_CHARS = 60_000;
const MAX_CANDIDATES = 500;
const MAX_QUOTE_CHARS = 900;
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const chrome = /^(?:from wikipedia, the free encyclopedia|من ويكيبيديا، الموسوعة الحرة|jump to (?:navigation|content)|(?:main article|see also|further information|المقالة الرئيسية|طالع أيضًا)\s*:|last updated\b|آخر تحديث|archived from\b|authority control\b|retrieved from\b|تعديل مصدري|تصنيفات\s*:)/iu;
const listItem = /^\s*(?:[-*•▪◦]|\p{Nd}{1,3}[.)])\s+\S/u;
const headingLine = /^\s*(?:#{1,6}\s+(.+?)\s*#*|(.+?)\s*\[(?:edit|عدل)\])\s*$/iu;

function textBlocks(text: string): SelectionBlock[] {
  const blocks: SelectionBlock[] = [];
  let heading: string | undefined;
  for (const raw of text.slice(0, MAX_PAGE_CHARS).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const section = headingLine.exec(line);
    if (section) {
      heading = (section[1] ?? section[2]).trim();
      continue;
    }
    const cells = line.split(/\t|\s+\|\s+/u).map(cell => cell.trim());
    if (cells.length > 1 && cells.every(Boolean)) blocks.push({ kind: 'table', text: line, cells, heading });
    else blocks.push({ kind: listItem.test(line) ? 'list' : 'paragraph', text: line, heading });
  }
  return blocks;
}

/** Quotes stay in source order here. A heading or a cell can inform the extractor without being written into a sentence. */
export function quoteCandidates(page: SelectionPage): QuoteCandidate[] {
  if (isDisambiguationPage(page)) return [];
  const { title, url } = page;
  const candidates: QuoteCandidate[] = [];
  const seen = new Set<string>();
  let position = 0;
  let previousText: string | undefined;
  let previousHeading: string | undefined;
  let lead = true;
  const blocks = page.blocks ?? pageStructure(page) ?? observedLayout(page);
  const flatText = blocks?.length ? page.text.replace(/\s+/gu, ' ') : undefined;
  const add = (text: string, kind: QuoteCandidate['kind'], block?: SelectionBlock) => {
    const key = `${kind}\n${block?.heading ?? ''}\n${text}`;
    if (!text || text.length > MAX_QUOTE_CHARS || !/\p{L}/u.test(text) || chrome.test(text) || isUiText(text) || seen.has(key)) return;
    if (flatText !== undefined && kind !== 'title' && !flatText.includes(text.replace(/\s+/gu, ' '))) return;
    seen.add(key);
    candidates.push({ text, url, title, kind, position, heading: block?.heading, cells: block?.cells,
      previousText: kind === 'sentence' && block?.heading === previousHeading ? previousText : undefined });
    if (kind !== 'title') position++;
    previousText = kind === 'sentence' || kind === 'lead' ? text : undefined;
    previousHeading = block?.heading;
  };
  add(title.trim(), 'title');
  for (const block of blocks?.length ? blocks : textBlocks(page.text)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (block.kind !== 'paragraph') {
      add(block.text.trim(), block.kind, block);
      continue;
    }
    for (const { segment } of segmenter.segment(block.text)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const before = candidates.length;
      add(segment.trim(), lead ? 'lead' : 'sentence', block);
      if (candidates.length !== before) lead = false;
    }
  }
  return candidates;
}

/** A small provenance prior. The host class cannot make unsupported claims eligible. */
function sourceWeight(url: string): number {
  const parsed = URL.parse(url);
  if (!parsed || !/^https?:$/u.test(parsed.protocol)) return 0;
  if (/(?:^|\.)(?:gov|edu)(?:\.[a-z]{2})?$/iu.test(parsed.hostname)) return 4;
  return classifyPage(url) === 'other' ? 1 : 2;
}

/** Replaceable scoring seam. Eligibility and exact quotes are established independently of the scorer. */
export type SentenceScorer = (features: Readonly<SelectionFeatures>) => { score: number; reasons: readonly string[] };

export function calibratedScorer(weights: Readonly<SelectionWeights>): SentenceScorer {
  return ({ type, entity, overlap, position, source }) => {
    const typePoints = (type?.strength ?? 0) * weights.type;
    const entityPoints = { match: 29, inferred: weights.inferredEntity, unknown: 0, conflict: -40 }[entity.agreement];
    const overlapPoints = Math.round(weights.overlap * overlap);
    const positionPoints = Math.round(weights.position * Math.max(0, 7 - Math.floor(position / 3)) / 7);
    return {
      score: typePoints + entityPoints + overlapPoints + positionPoints + source,
      reasons: [`type:${type?.cue ?? 'missing'}:${typePoints}`, `entity:${entity.reason}:${entityPoints}`,
        `stem-overlap:${overlapPoints}`, `position:${positionPoints}`, `source-quality:${source}`],
    };
  };
}

export const scoreSentence = calibratedScorer(originalCalibration);
const scoreCombined = calibratedScorer(combinedCalibration);

function eligibleClaim(intent: QuestionIntent, query: ReturnType<typeof questionEntities>, candidate: QuoteCandidate) {
  const language = textLanguage(candidate.text);
  if (language !== 'none' && language !== 'mixed' && language !== intent.language) return null;
  const type = extractAnswerType(intent, candidate);
  const entity = entityAgreement(query, { ...candidate, pageTitle: candidate.title });
  return { type, entity, eligible: (type?.strength ?? 0) >= 2 && (entity.agreement === 'match' || entity.agreement === 'inferred') };
}

export function prepareAnswerSelection(question: string, pages: readonly SelectionPage[]): PreparedSelection {
  const intent = classifyQuestion(question);
  if (intent.type === 'unknown') return { intent, candidates: [] };
  const query = questionEntities(question);
  const terms = selectionTerms(question);
  const candidates: AssessedCandidate[] = [];
  for (const page of pages) {
    const source = sourceWeight(page.url);
    for (const candidate of quoteCandidates(page)) {
      const claim = eligibleClaim(intent, query, candidate);
      if (!claim) continue;
      const overlap = stemOverlap(terms, selectionTerms(candidate.text));
      const features: SelectionFeatures = { type: claim.type, entity: claim.entity, overlap, position: candidate.position, source };
      candidates.push({ ...candidate, features, eligible: claim.eligible && source > 0 });
    }
  }
  return { intent, candidates };
}

export function decidePreparedAnswer({ intent, candidates }: PreparedSelection, score: SentenceScorer, threshold: number): SelectionDecision {
  if (intent.type === 'unknown') return { intent, selected: null, ranked: [], threshold, reason: 'unsupported-question' };
  const ranked = candidates.map(candidate => ({ ...candidate, ...score(candidate.features) }));
  // Stable sort preserves the original page and quote order for equal scores.
  ranked.sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score);
  const top = ranked.find(candidate => candidate.eligible);
  const selected = top && top.score >= threshold ? top : null;
  return { intent, selected, ranked, threshold, reason: selected ? 'selected' : top ? 'below-threshold' : 'no-evidence' };
}

export function rankAnswer(question: string, pages: readonly SelectionPage[], score: SentenceScorer = scoreSentence): SelectionDecision {
  return decidePreparedAnswer(prepareAnswerSelection(question, pages), score, originalCalibration.threshold);
}

export function rankCalibratedAnswer(question: string, pages: readonly SelectionPage[]): SelectionDecision {
  return decidePreparedAnswer(prepareAnswerSelection(question, pages), scoreCombined, combinedCalibration.threshold);
}

/** Ignore only the display cleanup applied by the legacy quote chooser. */
function quoteKey(text: string): string {
  return text.replace(/\[\s*(?:\d+|Note \d+|ملحوظة \d+|[a-zا-ي]|لغات أخرى|عدل|تعديل|عدل المصدر|بحاجة لمصدر|بحاجة إلى مصدر|edit|citation needed)\s*\]/giu, '')
    .replace(/[\u200B\u200E\u200F]/gu, '').replace(/\s+/gu, ' ').trim()
    .replace(/\s+([.،,؛;:!?؟)\]»])/gu, '$1').replace(/([(\[«])\s+/gu, '$1');
}

function matchesLegacyQuote(source: string, quote: string): boolean {
  if (source === quote) return true;
  if (quote.startsWith('…') || !quote.endsWith('…')) return false;
  const prefix = quote.slice(0, -1).trim();
  return Boolean(prefix && source.startsWith(prefix) && /^[\s،,؛;:\-–—]/u.test(source.slice(prefix.length)));
}

/** Recheck the quote as shown and the observed candidate that supplies its context. */
export function acceptsLegacyCandidate(question: string, page: SelectionPage, quote: string): boolean {
  const intent = classifyQuestion(question);
  const displayed = quoteKey(quote);
  if (!displayed || intent.type === 'unknown' || !sourceWeight(page.url)) return false;
  const query = questionEntities(question);
  const matches = quoteCandidates(page).map(candidate => ({ ...candidate, text: quoteKey(candidate.text),
    cells: candidate.cells?.map(quoteKey), previousText: candidate.previousText ? quoteKey(candidate.previousText) : undefined }))
    .filter(candidate => matchesLegacyQuote(candidate.text, displayed));
  return matches.length > 0 && matches.every(candidate => {
    if (!eligibleClaim(intent, query, candidate)?.eligible) return false;
    if (candidate.text === displayed) return true;
    // Do not let a clipped row borrow unseen cells to pass the type check.
    return (candidate.kind === 'lead' || candidate.kind === 'sentence')
      && Boolean(eligibleClaim(intent, query, { ...candidate, text: displayed.slice(0, -1).trim() })?.eligible);
  });
}
