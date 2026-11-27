import type { ModelCouncil } from '@mohassan/contracts';
import { factualPassage, type FactualPassage } from './factual-evidence.js';
import { judge, ownLines, type JudgeEvidence } from './judge.js';
import { extractQuote, isPageInstruction } from './mind/extract.js';
import { buildFrame } from './mind/frame.js';
import { questionLanguage } from './reply-check.js';

type Discussion = NonNullable<ModelCouncil['discussion']>;
export type CouncilProposal = Discussion['proposals'][number];
export type CouncilCheck = Discussion['checks'][number];
export type CouncilVote = Omit<Discussion['votes'][number], 'member'> & { measured: boolean };

export interface CouncilAnswer {
  member: string;
  answer: string;
  evidence?: { url: string; quote: string };
}

const PIPELINE = 'pipeline';
const UNCERTAIN = 'uncertain';
const MAX_PROPOSALS = 16;
const MAX_CHECKS = 64;
const MAX_QUOTE = 400;
const MAX_ANSWER = 600;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const UNCERTAIN_CLAIM = /\b(?:not|never|might|allegedly|disputed)\b|n['’]t\b|(?<!\p{L})(?:لا|لم|لن|ليس|ليست|ربما)(?!\p{L})/iu;

function answerKey(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[.!؟?]+$/u, '').trimEnd();
}

/** Keep whole words and numeric spans, including signs and decimal separators. */
function answerPattern(answer: string): RegExp | undefined {
  const key = answerKey(answer);
  if (!key || !/[\p{L}\p{N}]/u.test(key)) return;
  const literal = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const start = /^\p{N}/u.test(key) ? '[\\p{L}\\p{N}\\p{M}+−-]|\\p{N}[.,٫٬]' : '[\\p{L}\\p{N}\\p{M}]';
  const end = /\p{N}$/u.test(key) ? '[\\p{L}\\p{N}\\p{M}]|[.,٫٬]\\p{N}' : '[\\p{L}\\p{N}\\p{M}]';
  return new RegExp(`(?<!${start})${literal}(?!${end})`, 'u');
}

function containsAnswer(quote: string, answer: string): boolean {
  return answerPattern(answer)?.test(answerKey(quote)) ?? false;
}

function sourceUrl(url: string | undefined): url is string {
  if (!url || url.length > 2048 || !/^https?:\/\//iu.test(url) || /[\s<>]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return /^https?:$/u.test(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function canQuote(quote: string): boolean {
  return Boolean(quote && quote.length <= MAX_QUOTE && !isPageInstruction(quote)
    && !/[?؟]$/u.test(quote) && !UNCERTAIN_CLAIM.test(quote));
}

function hasExactSentence(text: string, quote: string): boolean {
  const sentences = sentenceSegmenter.segment(text);
  let offset = text.indexOf(quote);
  while (offset >= 0) {
    if (sentences.containing(offset)?.segment.trim() === quote) return true;
    offset = text.indexOf(quote, offset + quote.length);
  }
  return false;
}

function citedPage(proposal: CouncilProposal, evidence: readonly JudgeEvidence[]): JudgeEvidence | undefined {
  const { answer, evidenceQuote, evidenceUrl } = proposal;
  if (!evidenceQuote || !sourceUrl(evidenceUrl) || !canQuote(evidenceQuote) || isPageInstruction(answer)
    || !containsAnswer(evidenceQuote, answer)) return;
  return evidence.find(page => page.kind === 'page' && page.url === evidenceUrl && hasExactSentence(page.text, evidenceQuote));
}

function findEvidence(candidate: CouncilAnswer, evidence: readonly JudgeEvidence[], pageKeys: Map<JudgeEvidence, string>): Pick<CouncilProposal, 'evidenceUrl' | 'evidenceQuote'> {
  if (candidate.evidence) {
    const citation = { evidenceUrl: candidate.evidence.url, evidenceQuote: candidate.evidence.quote };
    return citedPage({ member: candidate.member, answer: candidate.answer, ...citation }, evidence) ? citation : {};
  }
  const match = !isPageInstruction(candidate.answer) && answerPattern(candidate.answer);
  if (!match) return {};
  for (const page of evidence) {
    if (page.kind !== 'page' || !sourceUrl(page.url)) continue;
    if (!pageKeys.has(page)) pageKeys.set(page, answerKey(page.text));
    if (!match.test(pageKeys.get(page)!)) continue;
    for (const { segment } of sentenceSegmenter.segment(page.text)) {
      const quote = segment.trim();
      if (canQuote(quote) && match.test(answerKey(quote))) return { evidenceUrl: page.url, evidenceQuote: quote };
    }
  }
  return {};
}

/** An empty proposal records abstention. Raw runner output remains on the council member for measurement. */
export function proposeCouncilAnswers(candidates: readonly CouncilAnswer[], evidence: readonly JudgeEvidence[]): CouncilProposal[] {
  const seen = new Set<string>();
  const pageKeys = new Map<JudgeEvidence, string>();
  const proposals: CouncilProposal[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.member)) continue;
    seen.add(candidate.member);
    const answer = candidate.member === PIPELINE ? ownLines(candidate.answer)[0]?.text ?? '' : candidate.answer.trim();
    const citation = answer && answer.length <= MAX_QUOTE ? findEvidence({ ...candidate, answer }, evidence, pageKeys) : {};
    proposals.push({
      member: candidate.member,
      answer: candidate.member === PIPELINE || citation.evidenceUrl ? answer.slice(0, MAX_ANSWER) : '',
      ...citation,
    });
    if (proposals.length === MAX_PROPOSALS) break;
  }
  return proposals;
}

function sourceLine(title: string | undefined, url: string, language: 'en' | 'ar'): string {
  const label = (title || url).replace(/[\[\]<>\r\n]/gu, '').trim() || url;
  const target = url.replace(/\(/gu, '%28').replace(/\)/gu, '%29');
  return `**${language === 'ar' ? 'المصدر' : 'Source'}:** [${label}](${target})`;
}

export function councilModelReply(proposal: CouncilProposal, language: 'en' | 'ar'): string {
  return sourceUrl(proposal.evidenceUrl)
    ? `${proposal.answer}\n\n${sourceLine(undefined, proposal.evidenceUrl, language)}`
    : '';
}

export function uncertainCouncilReply(language: 'en' | 'ar', evidence: readonly JudgeEvidence[]): string {
  const sources = new Map<string, string>();
  for (const page of evidence) {
    if (page.kind === 'page' && sourceUrl(page.url)) sources.set(page.url, sourceLine(page.title, page.url, language));
  }
  const reply = language === 'ar' ? 'لم أتمكن من التحقق من جواب مؤكد.' : 'I could not verify an answer.';
  return [reply, ...Array.from(sources.values()).slice(0, 3)].join('\n\n');
}

interface DiscussionInput {
  question: string;
  previous: string | null;
  proposals: readonly CouncilProposal[];
  evidence: readonly JudgeEvidence[];
  checks: readonly CouncilCheck[];
  pipelineStands: boolean;
  keepPipeline: boolean;
  allowReplacement?: boolean;
  vote: (member: string) => CouncilVote;
}

/** Look for a direct copular assertion, in either order, for simple what-is questions. */
function copularValue(quote: string, question: string): string | undefined {
  const request = /^(?:what (is|are|was|were)|ما (هو|هي)) (.+)$/u.exec(answerKey(question));
  if (!request) return;
  const assertion = answerKey(quote);
  const [copula, subject] = [request[1] ?? request[2], request[3]];
  const prefix = `${subject} ${copula} `;
  const suffix = ` ${copula} ${subject}`;
  if (assertion.startsWith(prefix)) return assertion.slice(prefix.length);
  if (assertion.endsWith(suffix)) return assertion.slice(0, -suffix.length);
}

function judgeProposal(input: DiscussionInput, proposal: CouncilProposal, frame: ReturnType<typeof buildFrame>,
  directByPage: Map<JudgeEvidence, FactualPassage | undefined>, page?: JudgeEvidence): CouncilCheck {
  const check = { checker: 'judge', member: proposal.member };
  if (!proposal.answer) return { ...check, verdict: 'unsure', note: 'No answer to assess.' };

  try {
    const quote = page && proposal.evidenceQuote;
    const reply = quote && proposal.evidenceUrl
      ? `${quote}\n\n${sourceLine(page?.title, proposal.evidenceUrl, questionLanguage(input.question))}` : proposal.answer;
    const verdict = judge({
      question: input.question, previous: input.previous, reply, status: 'completed',
      ...(quote && { evidence: [{ ...page, kind: 'page', text: quote }] }),
    });
    // Reuse the pipeline's relation extractor when it can identify a precise span independently.
    const blocking = verdict.decision === 'withhold' || verdict.codes.includes('page_subject_mismatch')
      || verdict.codes.includes('language_mismatch');
    const note = [verdict.decision, ...verdict.codes].join(', ').slice(0, 240);
    if (blocking) return { ...check, verdict: 'contradicts', note };
    if (verdict.decision !== 'send' || !quote || !page) return { ...check, verdict: 'unsure', note };

    if (!directByPage.has(page)) directByPage.set(page, factualPassage({ title: page.title ?? '', text: page.text }, input.question));
    const direct = directByPage.get(page);
    const extracted = extractQuote(quote, frame);
    const directQuote = direct && answerKey(quote) === answerKey(direct.quote);
    const copular = copularValue(quote, input.question);
    const value = (directQuote ? direct.value : undefined) ?? copular ?? extracted?.value;
    const same = (text: string) => answerKey(text) === answerKey(proposal.answer);
    // A span must fill the requested relation. A sentence can serve as-is when the extractor finds that relation in it.
    const supportsValue = value && same(value) && (!['number', 'money'].includes(frame.answerType ?? '') || directQuote);
    const supportsStatement = same(quote) && (Boolean(extracted?.value || directQuote || copular)
      || frame.answerType === 'definition' && !verdict.codes.includes('definition_form_missing'));
    if (direct && !same(direct.value) && !same(direct.quote) && !(supportsStatement && containsAnswer(quote, direct.value))) {
      return { ...check, verdict: 'contradicts', note: 'The page directly states a different answer to this question.' };
    }
    return supportsValue || supportsStatement
      ? { ...check, verdict: 'supports', note: 'The cited claim matches the requested subject and relation.' }
      : { ...check, verdict: 'unsure', note: 'The citation mentions the answer without establishing the requested relation.' };
  } catch {
    return { ...check, verdict: 'unsure', note: 'The judge could not assess this answer.' };
  }
}

function exceeds(weight: number, other: number): boolean {
  // Equivalent decimal sums can round differently depending on which members voted.
  return weight - other > Number.EPSILON * Math.max(weight, other);
}

export function decideCouncilDiscussion(input: DiscussionInput): Discussion {
  const proposals = Array.from(new Map(input.proposals.map(proposal => [proposal.member, proposal])).values()).slice(0, MAX_PROPOSALS);
  const members = new Set(proposals.map(proposal => proposal.member));
  const checks: CouncilCheck[] = [];
  const verified = new Set<string>();
  const frame = buildFrame(input.question);
  const directByPage = new Map<JudgeEvidence, FactualPassage | undefined>();
  for (const proposal of proposals) {
    const page = citedPage(proposal, input.evidence);
    checks.push({
      checker: 'evidence', member: proposal.member, verdict: page ? 'supports' : 'unsure',
      note: page ? 'The exact quote is from the cited page read on this turn.' : 'No matching quote from a page read on this turn.',
    });
    const judged = judgeProposal(input, proposal, frame, directByPage, page);
    checks.push(judged);
    if (page && judged.verdict === 'supports') verified.add(proposal.member);
  }

  const learned = input.checks.filter(check => members.has(check.member) && !['evidence', 'judge'].includes(check.checker));
  // When the record is full, retain objections before endorsements.
  const orderedChecks = [...learned.filter(check => check.verdict === 'contradicts'), ...learned.filter(check => check.verdict !== 'contradicts')];
  for (const check of orderedChecks) {
    if (check.verdict === 'contradicts') verified.delete(check.member);
    if (checks.length < MAX_CHECKS) checks.push(check);
  }

  const ballots = new Map<string, CouncilVote>();
  for (const proposal of proposals) {
    if (proposal.answer) ballots.set(proposal.member, input.vote(proposal.member));
  }
  const votes = Array.from(ballots, ([member, vote]) => ({
    member, weight: vote.weight, weightSource: vote.weightSource.slice(0, 160),
  }));

  const weight = (member: string) => ballots.get(member)?.weight ?? 0;
  const pipeline = proposals.find(proposal => proposal.member === PIPELINE);
  let pipelineSupport = input.pipelineStands ? weight(PIPELINE) : 0;
  const groups = new Map<string, CouncilProposal[]>();
  for (const proposal of proposals) {
    if (proposal.member === PIPELINE || !verified.has(proposal.member)) continue;
    if (input.pipelineStands && pipeline && containsAnswer(pipeline.answer, proposal.answer)) {
      pipelineSupport += weight(proposal.member);
      continue;
    }
    const key = answerKey(proposal.answer);
    const group = groups.get(key) ?? [];
    group.push(proposal);
    groups.set(key, group);
  }

  const ranked = Array.from(groups.values())
    .filter(group => group.length > 1
      && (!input.pipelineStands || ballots.get(PIPELINE)?.measured && group.some(proposal => ballots.get(proposal.member)?.measured)))
    .map(group => ({
      winner: [...group].sort((a, b) => weight(b.member) - weight(a.member))[0]!,
      support: group.reduce((total, proposal) => total + weight(proposal.member), 0),
    })).sort((a, b) => b.support - a.support);
  const best = ranked[0];
  if (input.allowReplacement !== false && best && exceeds(best.support, pipelineSupport) && (!ranked[1] || exceeds(best.support, ranked[1].support))) {
    return { proposals, checks, votes, decision: {
      chosen: best.winner.member,
      reasonAr: 'تحقّق الحكم من الاقتباس، وأيّد الجوابَ عضوان على الأقل، وتجاوز وزن تأييده وزن جواب المحرك وأي جواب منافس مستوفٍ للشروط.',
      reasonEn: 'The judge verified the cited evidence. At least two members agreed, and their combined weight exceeded the pipeline and any other eligible answer.',
    } };
  }

  return { proposals, checks, votes, decision: input.allowReplacement === false ? {
    chosen: PIPELINE,
    reasonAr: 'سُجّلت آراء النماذج للاستشارة، وبقي رد المحرك لهذه المهمة.',
    reasonEn: 'The models provided advice, and the pipeline response stands for this task.',
  } : input.pipelineStands || input.keepPipeline ? {
    chosen: PIPELINE,
    reasonAr: 'بقي رد المحرك لعدم وجود جواب بديل مؤيَّد بالأدلة وبوزن كافٍ لتجاوزه.',
    reasonEn: 'The pipeline response stands. No verified alternative had enough weighted support to replace it.',
  } : {
    chosen: UNCERTAIN,
    reasonAr: 'لم يحصل أي جواب موثّق على تأييد مرجّح كافٍ لإرساله.',
    reasonEn: 'No verified answer had enough weighted support to send.',
  } };
}
