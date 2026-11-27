import { setTimeout as pauseFor } from 'node:timers/promises';
import { compileQuery, excludesWikipedia, publicSearchText, safeResumeUrl, type AgentPage } from '@mohassan/browser';
import { readingLabel, siteName } from './activity.js';
import { checkAnswerLine, isDisambiguationPage, questionLanguage } from './answer-check.js';
import { checkComparisonCompleteness, comparisonEvidencePassages, comparisonPartialReply } from './comparison-completeness.js';
import { mentionedComparisonSubjects, normalizeComparisonText, parseComparisonQuestion, type ParsedComparisonQuestion } from './comparison-question.js';
import { explicitFactualEvidence } from './factual-evidence.js';
import type { HandsIO, HandsReply, relevantLines } from './hands.js';
import { isPageInstruction } from './mind/extract.js';

interface Result { title: string; url: string }
interface Lookup { results: Result[] }

export function comparisonSearchQuestion(question: string): ParsedComparisonQuestion | null {
  const words = question.replace(/"[^"]*"|(?:^|\s)site:[^\s]+/giu, match => match.startsWith('"') ? match : ' ');
  return parseComparisonQuestion(words.trim());
}

function focusQuery(question: string, comparison: ParsedComparisonQuestion, subject: string): string | undefined {
  const attribute = comparison.attribute.words.exec(normalizeComparisonText(question))?.[0];
  const source = compileQuery(question);
  const quotedSubject = question.includes(`"${subject}"`) ? `"${subject}"` : subject;
  const wiki = /wikipedia|ويكيبيديا|ويكبيديا/iu.exec(question)?.[0];
  const focused = [quotedSubject, attribute, comparison.qualifier, ...source.sites.map(site => `site:${site}`),
    wiki && excludesWikipedia(source) ? `-${wiki}` : undefined].filter(Boolean).join(' ');
  try {
    compileQuery(focused);
    return focused;
  } catch {
    return undefined;
  }
}

async function withinSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let rejectOnAbort: () => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([stopped, work()]);
  } finally {
    signal.removeEventListener('abort', rejectOnAbort!);
  }
}

function sourceLine(page: AgentPage, lang: 'ar' | 'en'): string {
  const title = publicSearchText(page.title).replace(/[\n\r\[\]]/gu, ' ').trim() || siteName(page.url);
  return `**${lang === 'ar' ? 'المصدر' : 'Source'}:** [${siteName(page.url)} — ${title}](${page.url})`;
}

function partialExcerpts(
  question: string, comparison: ParsedComparisonQuestion, sources: readonly AgentPage[],
  reply: HandsReply | undefined, rank: typeof relevantLines,
): { evidence: AgentPage; text: string }[] {
  for (const evidence of sources) {
    const record = explicitFactualEvidence(evidence, question);
    if (record?.kind === 'answer') return [{ evidence, text: record.quote }];
  }

  const acceptedLines = (query: string) => sources.flatMap(evidence => rank(evidence, query, 3, true)
    .filter(text => checkAnswerLine(question, text).ok && (!reply?.lang || questionLanguage(text) === reply.lang)
      && !isPageInstruction(text) && publicSearchText(text) === text)
    .map(text => ({ evidence, text, subjects: mentionedComparisonSubjects(text.replace(/\([^)]*\)/gu, ' '), comparison.subjects) })));
  const ranked = acceptedLines(question);
  const best = comparison.subjects.flatMap(subject => {
    const names = (line: { subjects: string[] }) => line.subjects.includes(subject);
    const excerpt = ranked.find(names) ?? acceptedLines(subject).find(names);
    return excerpt ? [excerpt] : [];
  });
  return best.filter((excerpt, index) => best.findIndex(other => other.text === excerpt.text && other.evidence === excerpt.evidence) === index)
    .slice(0, reply?.sentences ?? best.length);
}

/** Search and cite read pages only. The retry is part of the admitted search step. */
export async function searchComparison(
  question: string,
  comparison: ParsedComparisonQuestion,
  lang: 'ar' | 'en',
  reply: HandsReply | undefined,
  io: HandsIO,
  lookup: (query: string, signal?: AbortSignal) => Promise<Lookup | { failed: string } | 'unavailable'>,
  spacing: number,
  rank: typeof relevantLines,
) {
  const sources: AgentPage[] = [];
  const results = new Map<string, Result>();
  const tried = new Set<string>();
  const readBatch = async (query: string, limit: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const found = await lookup(query, signal);
    signal?.throwIfAborted();
    if (found === 'unavailable' || 'failed' in found) return;
    const urls = found.results.flatMap(hit => {
      const url = safeResumeUrl(hit.url);
      if (!url) return [];
      results.set(url, hit);
      return tried.has(url) ? [] : [url];
    }).slice(0, limit);
    if (!urls.length || !io.read) return;
    await io.step(readingLabel(urls));
    signal?.throwIfAborted();
    for (const url of urls) tried.add(url);
    const reads = await Promise.allSettled(urls.map(url => signal ? io.read!(url, signal) : io.read!(url)));
    signal?.throwIfAborted();
    for (const read of reads) {
      if (read.status !== 'fulfilled' || read.value.kind !== 'page') continue;
      const { page } = read.value;
      if (!safeResumeUrl(page.url) || isDisambiguationPage(page) || sources.some(source => source.url === page.url)) continue;
      if (page.documentStatus != null && (page.documentStatus < 200 || page.documentStatus >= 300)) continue;
      if (page.signals.captcha || page.signals.password || page.signals.otp || page.signals.card) continue;
      sources.push(page);
    }
  };

  await readBatch(question, 3);
  io.turn?.signal.throwIfAborted();
  const first = checkComparisonCompleteness(comparison, '', sources);
  const retry = first.missingEvidenceSubjects.length === 1 ? focusQuery(question, comparison, first.missingEvidenceSubjects[0]!) : undefined;
  // Keep a provider-spacing interval for publication. The retry's search and reads
  // share one deadline and cannot use the rest of the turn after it expires.
  const remaining = io.turn ? io.turn.deadlineAt - Date.now() - spacing : Infinity;
  if (retry && remaining > spacing) {
    const timeout = Number.isFinite(remaining) ? AbortSignal.timeout(remaining) : undefined;
    const signal = io.turn && timeout ? AbortSignal.any([io.turn.signal, timeout]) : timeout;
    const tryAgain = async () => {
      if (io.pause) await io.pause(spacing);
      else await pauseFor(spacing, undefined, { signal });
      signal?.throwIfAborted();
      await io.step(lang === 'ar' ? `البحث عن «${retry}»` : `Searching for “${retry}”`);
      // The host keeps the five most recent read pages as evidence.
      await readBatch(retry, 2, signal);
    };
    try {
      if (signal) await withinSignal(signal, tryAgain);
      else await tryAgain();
    } catch (error) {
      io.turn?.signal.throwIfAborted();
      if (!timeout?.aborted) throw error;
    }
  }

  const passages = comparisonEvidencePassages(comparison, sources);
  const preferred = reply?.lang ? passages.filter(passage => questionLanguage(passage.text) === reply.lang) : passages;
  const ranked = [...preferred].sort((a, b) => b.subjects.length - a.subjects.length || b.conditions.length - a.conditions.length);
  const anchor = ranked.find(passage => comparison.subjects.every(subject => ranked.some(other => other.subjects.includes(subject)
    && other.attributes.some(attribute => passage.attributes.includes(attribute))))) ?? ranked[0];
  const paired = comparison.subjects.map(subject => ranked.find(passage => passage.subjects.includes(subject)
    && anchor?.attributes.some(attribute => passage.attributes.includes(attribute))) ?? ranked.find(passage => passage.subjects.includes(subject)));
  const selected = [...new Set([anchor, ...paired, ...ranked])].filter(passage => passage !== undefined).slice(0, reply?.sentences ?? 3);
  const excerpts = selected.length ? selected : partialExcerpts(question, comparison, sources, reply, rank);
  const cited = [...new Set(excerpts.map(excerpt => excerpt.evidence))];

  const content = [...excerpts.map(excerpt => excerpt.text), ...cited.map(page => sourceLine(page, lang))].join('\n\n');
  const complete = selected.length > 0 && checkComparisonCompleteness(comparison, content, sources).complete;
  const text = complete ? content : [comparisonPartialReply(comparison, lang), content].filter(Boolean).join('\n\n');
  const primary = cited[0];
  return {
    result: { kind: 'done' as const, comparison: true as const, status: complete ? 'completed' as const : 'partial' as const, text },
    results: [...results.values()],
    found: primary && { url: primary.url, title: primary.title,
      lines: excerpts.filter(excerpt => excerpt.evidence === primary).map(excerpt => excerpt.text), readAt: primary.observedAt },
  };
}
