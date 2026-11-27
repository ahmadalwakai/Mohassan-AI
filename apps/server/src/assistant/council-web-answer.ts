import { performance } from 'node:perf_hooks';
import type { ModelCouncil, ModelCouncilMember } from '@mohassan/contracts';
import { uncertainCouncilReply, usableCouncilPage } from './council-deliberation.js';
import { selectPassage } from './council-passage.js';
import { factualPassage } from './factual-evidence.js';
import { comparable, type JudgeEvidence } from './judge.js';
import { extractQuote } from './mind/extract.js';
import { buildFrame } from './mind/frame.js';
import type { CouncilTurn, ModelCouncilService } from './model-council.js';
import { questionLanguage } from './reply-check.js';

// Use the council v2 default as the budget for search and deliberation together.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/fcee968542583480de063e44b9e35d111adf4119/apps/server/src/assistant/model-council.ts (retrieved 2026-11-27)
export const COUNCIL_WEB_BUDGET_MS = 45_000;
const FINAL_DECISION_RESERVE_MS = 100;

interface CouncilWebInput extends Pick<CouncilTurn, 'question' | 'previous' | 'history' | 'baseline' | 'signal'> {
  search: NonNullable<CouncilTurn['search']>;
  deliberate: ModelCouncilService['deliberate'];
  progress: (phase: 'search' | 'council') => void | Promise<unknown>;
  startedAt?: number;
  budgetMs?: number;
}

interface CouncilWebReply {
  text: string;
  status: 'completed' | 'partial';
  council?: ModelCouncil;
}

type WebPage = JudgeEvidence & { url: string };
const elapsedMs = (startedAt: number) => Math.min(600_000, Math.max(0, Math.round(performance.now() - startedAt)));
const copy = {
  en: {
    checked: 'Checked by the model council after a web search.',
    empty: 'I could not find usable evidence in the web search.',
    searchFailed: 'I could not complete the web search to verify an answer.',
    disagreement: 'I searched the web, but the model council could not agree on a verified answer.',
    unavailable: 'I searched the web, but the model council could not complete its review.',
    timeout: 'Time limit reached. The model council could not verify an answer in time.',
    bestVerified: 'Time limit reached. This is the best answer the model council could verify from the web search in time.',
  },
  ar: {
    checked: 'تحقّق مجلس النماذج من الجواب بعد البحث في الويب.',
    empty: 'لم أجد في البحث على الويب أدلة صالحة للتحقق من الجواب.',
    searchFailed: 'تعذّر إكمال البحث في الويب للتحقق من الجواب.',
    disagreement: 'بحثت في الويب، ولم يتفق مجلس النماذج على جواب موثّق.',
    unavailable: 'بحثت في الويب، وتعذّر على مجلس النماذج إكمال المراجعة.',
    timeout: 'انتهت المهلة قبل أن يتمكّن مجلس النماذج من التحقق من الجواب.',
    bestVerified: 'انتهت المهلة. هذا أفضل جواب تمكّن مجلس النماذج من التحقق منه من البحث في الويب خلال المهلة.',
  },
} as const;

/** The deterministic pipeline proposes only claims from the same pages it submits to the council. */
function pipelineFromEvidence(question: string, pages: readonly WebPage[]) {
  const frame = buildFrame(question);
  const candidates = new Map<string, { answer: string; citation: { url: string; quote: string } }>();
  for (const page of pages) {
    const direct = factualPassage({ text: page.text, title: page.title ?? '' }, question);
    const passage = direct ? undefined : selectPassage(question, [page]);
    const extracted = direct ?? (passage && extractQuote(passage.text, frame));
    const answer = extracted?.value ?? extracted?.quote;
    if (!answer || !extracted?.quote) continue;
    const key = comparable(answer);
    if (key && !candidates.has(key)) candidates.set(key, { answer, citation: { url: page.url, quote: extracted.quote } });
    if (candidates.size > 1) return undefined;
  }
  return candidates.values().next().value;
}

export async function runCouncilWebAnswer(input: CouncilWebInput): Promise<CouncilWebReply> {
  const { question, previous, history, baseline } = input;
  const startedAt = input.startedAt ?? performance.now();
  const budgetMs = input.budgetMs ?? COUNCIL_WEB_BUDGET_MS;
  const deadline = startedAt + budgetMs;
  const language = questionLanguage(question);
  const messages = copy[language];
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let pages: WebPage[] = [];
  let searchFailed = false;

  const uncertain = (message: string, council?: ModelCouncil): CouncilWebReply => ({
    text: uncertainCouncilReply(language, pages, message), status: 'partial', ...(council && { council }),
  });

  async function progress(phase: 'search' | 'council') {
    try { await input.progress(phase); } catch { /* Progress must not change the answer. */ }
    signal.throwIfAborted();
  }

  async function work(): Promise<CouncilWebReply> {
    await progress('search');
    const searchStartedAt = performance.now();
    let note: string | undefined;
    try {
      const found = await input.search(question, signal);
      signal.throwIfAborted();
      pages = found.pages.filter(usableCouncilPage);
      note = found.note;
    } catch {
      signal.throwIfAborted();
      searchFailed = true;
    }
    const search: ModelCouncilMember = {
      model: 'web-search', label: language === 'ar' ? 'البحث في الويب' : 'Web search', round: 'search',
      elapsedMs: elapsedMs(searchStartedAt), outcome: pages.length ? 'ok' : 'failed',
      ...(pages.length && { output: pages.map(page => page.title || page.url).join(' · ').slice(0, 600) }),
      ...(note && { note: note.slice(0, 240) }),
    };

    await progress('council');
    const proposal = pipelineFromEvidence(question, pages);
    if (performance.now() >= deadline) return uncertain(messages.timeout);
    const outcome = await input.deliberate({
      question, previous, history, baseline, evidence: pages, signal,
      pipeline: proposal ? { text: proposal.answer, status: 'completed' } : { text: '', status: 'blocked' },
      // The schedule stops waiting for members early enough for the judge to make its decision.
      webDeliberation: { deadline: deadline - Math.min(FINAL_DECISION_RESERVE_MS, budgetMs / 10), pipelineCitation: proposal?.citation },
    });
    signal.throwIfAborted();
    const council = { ...outcome.council, elapsedMs: elapsedMs(startedAt), members: [search, ...outcome.council.members].slice(0, 48) };
    if (outcome.status !== 'completed' || outcome.chosen === 'uncertain' || !outcome.text.trim() || !pages.length) {
      const message = outcome.timeLimited ? messages.timeout
        : pages.length ? messages.disagreement : searchFailed ? messages.searchFailed : messages.empty;
      return uncertain(message, council);
    }
    const footer = outcome.timeLimited ? messages.bestVerified : messages.checked;
    return { text: `${outcome.text}\n\n${footer}`, status: 'completed', council };
  }

  input.signal.throwIfAborted();
  const remaining = deadline - performance.now();
  if (remaining <= 0) return uncertain(messages.timeout);
  let stop!: () => void;
  const stopped = new Promise<undefined>(resolve => {
    stop = () => {
      controller.abort();
      resolve(undefined);
    };
  });
  const timer = setTimeout(stop, Math.floor(remaining));
  input.signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await Promise.race([work(), stopped]);
    input.signal.throwIfAborted();
    return result && performance.now() < deadline ? result : uncertain(messages.timeout);
  } catch {
    input.signal.throwIfAborted();
    return uncertain(signal.aborted ? messages.timeout
      : pages.length ? messages.unavailable : searchFailed ? messages.searchFailed : messages.empty);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', stop);
  }
}
