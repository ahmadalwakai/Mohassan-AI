import { observedLayout } from '@mohassan/browser';
import { isDisambiguationPage, isUiText, textLanguage } from '../answer-check.js';
import { classifyPage } from '../page-cache.js';
import { classifyQuestion, extractAnswerType, type AnswerTypeEvidence, type QuestionIntent } from './answer-types.js';
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

export interface RankedCandidate extends QuoteCandidate {
  score: number;
  reasons: readonly string[];
  features: SelectionFeatures;
  eligible: boolean;
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
const SELECT_THRESHOLD = 61;
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
    if (flatText && kind !== 'title' && !flatText.includes(text.replace(/\s+/gu, ' '))) return;
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

export const scoreSentence: SentenceScorer = ({ type, entity, overlap, position, source }) => {
  const typePoints = (type?.strength ?? 0) * 12;
  const entityPoints = { match: 29, inferred: 22, unknown: 0, conflict: -40 }[entity.agreement];
  const overlapPoints = Math.round(26 * overlap);
  const positionPoints = Math.max(0, 7 - Math.floor(position / 3));
  return {
    score: typePoints + entityPoints + overlapPoints + positionPoints + source,
    reasons: [`type:${type?.cue ?? 'missing'}:${typePoints}`, `entity:${entity.reason}:${entityPoints}`,
      `stem-overlap:${overlapPoints}`, `position:${positionPoints}`, `source-quality:${source}`],
  };
};

export function rankAnswer(question: string, pages: readonly SelectionPage[], score: SentenceScorer = scoreSentence): SelectionDecision {
  const intent = classifyQuestion(question);
  const threshold = SELECT_THRESHOLD;
  if (intent.type === 'unknown') return { intent, selected: null, ranked: [], threshold, reason: 'unsupported-question' };
  const query = questionEntities(question);
  const terms = selectionTerms(question);
  const ranked: RankedCandidate[] = [];
  for (const page of pages) {
    const source = sourceWeight(page.url);
    for (const candidate of quoteCandidates(page)) {
      const language = textLanguage(candidate.text);
      if (language !== 'none' && language !== 'mixed' && language !== intent.language) continue;
      const type = extractAnswerType(intent, candidate);
      const entity = entityAgreement(query, { ...candidate, pageTitle: candidate.title });
      const overlap = stemOverlap(terms, selectionTerms(candidate.text));
      const features: SelectionFeatures = { type, entity, overlap, position: candidate.position, source };
      const eligible = (type?.strength ?? 0) >= 2 && (entity.agreement === 'match' || entity.agreement === 'inferred') && source > 0;
      ranked.push({ ...candidate, ...score(features), features, eligible });
    }
  }
  // Stable sort preserves the original page and quote order for equal scores.
  ranked.sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score);
  const top = ranked.find(candidate => candidate.eligible);
  const selected = top && top.score >= threshold ? top : null;
  return { intent, selected, ranked, threshold, reason: selected ? 'selected' : top ? 'below-threshold' : 'no-evidence' };
}
