import { BrowserError } from '@mohassan/browser';
import type { Frame, Mind, MindDeps, MindReply } from './contract.js';
import { buildFrame } from './frame.js';
import { route } from './route.js';
import { compute } from './compute.js';
import { recall } from './recall.js';
import { askForDetails, limits, notAvailable } from './limits.js';
import { answerSite, type SiteRead } from './site-check.js';
import { answerResearch, EVIDENCE_LIMIT_MS } from './evidence.js';
import { composeReply } from './compose.js';
import { critiqueReply, type CriticContext } from './critic.js';

export function guardMemorySave(
  state: { memorySaves?: number },
  maximum: number,
  active: () => Promise<void>,
  save: (text: string) => Promise<void>,
): NonNullable<MindDeps['saveMemory']> {
  return async (text, signal) => {
    signal.throwIfAborted();
    await active();
    signal.throwIfAborted();
    if ((state.memorySaves ?? 0) >= maximum) {
      throw new BrowserError('ASSISTANT_MEMORY_LIMIT', 'Enough was saved for this request. Use answer now.', 409);
    }
    state.memorySaves = (state.memorySaves ?? 0) + 1;
    await save(text);
  };
}

type Draft = Omit<MindReply, 'frame' | 'timings'>;
type ChosenReply = { reply: Draft; local: boolean; comparisonReads?: readonly SiteRead[] };

async function chooseReply(
  frame: Frame,
  request: string,
  deps: MindDeps,
  signal: AbortSignal,
  resumed: boolean,
  deadline: number,
): Promise<ChosenReply> {
  if (frame.missing.length) return { reply: resumed ? notAvailable(frame) : askForDetails(frame), local: true };

  const sources = route(frame);
  if (sources.includes('fixed')) return { reply: limits(frame), local: true };
  if (sources.includes('computed')) {
    const result = compute(frame, deps.now());
    if (result) return { reply: result, local: true };
  }
  if (sources.includes('memory') || sources.includes('knowledge')) {
    const result = await recall(frame, request, deps, signal);
    if (result) return { reply: result, local: true };
  }
  let site: Draft | undefined;
  if (sources.includes('site')) {
    site = await answerSite(frame, deps, signal, { deadline });
    if (site.status === 'completed' || !sources.includes('web') || performance.now() >= deadline) {
      return { reply: site, local: false };
    }
  }
  if (sources.includes('web')) {
    const { comparisonReads, ...reply } = await answerResearch(frame, deps, signal, { deadline, skipDirect: Boolean(site) });
    if (reply.status === 'blocked' && site?.evidence.length) return { reply: site, local: false };
    return { reply, local: false, comparisonReads };
  }
  return { reply: notAvailable(frame), local: true };
}

function observeDependencies(deps: MindDeps) {
  const pages: Awaited<ReturnType<MindDeps['read']>>[] = [];
  const memories: string[] = [];
  const documents: Awaited<ReturnType<NonNullable<MindDeps['knowledge']>>> = [];
  const snapshots: NonNullable<CriticContext['indexedReads']>[number][] = [];
  const context: CriticContext = { pages, memory: memories, knowledge: documents, indexedReads: snapshots, searches: 0, startedAt: deps.now() };
  const { memory, knowledge, siteSnapshot } = deps;
  const observed: MindDeps = {
    ...deps,
    async read(url, signal) {
      const result = await deps.read(url, signal);
      const page = { ...result, fetchedAt: deps.now().toISOString() };
      pages.push({ ...page, headers: { ...page.headers } });
      return page;
    },
    async search(query, limit, signal) {
      context.searches = (context.searches ?? 0) + 1;
      return deps.search(query, limit, signal);
    },
    ...(memory && { async memory(query) {
      const results = await memory(query);
      memories.push(...results);
      return results;
    } }),
    ...(knowledge && { async knowledge(query) {
      const results = await knowledge(query);
      for (const result of results) documents.push({ ...result });
      return results;
    } }),
    ...(siteSnapshot && { async siteSnapshot(url) {
      const snapshot = await siteSnapshot(url);
      if (snapshot) snapshots.push({ ...snapshot, url });
      return snapshot;
    } }),
  };
  return { observed, context };
}

export function createMind(): Mind {
  return {
    async handle(request, deps, signal, resume) {
      signal.throwIfAborted();
      const started = performance.now();
      const input = resume ? `${request.trimEnd()} ${resume.answer.trim()}` : request;
      const frame = buildFrame(input);
      if (resume) frame.lang = resume.frame.lang;
      const parsed = performance.now();
      const { observed, context } = observeDependencies(deps);
      const outcome = await chooseReply(frame, input, observed, signal, Boolean(resume), started + EVIDENCE_LIMIT_MS);
      signal.throwIfAborted();
      const resolved = performance.now();
      context.endedAt = deps.now();
      if (outcome.local) context.trustedLocal = structuredClone(outcome.reply);
      else context.comparisonReads = outcome.comparisonReads;
      const timings = { frame: parsed - started, reply: resolved - parsed };
      const checked = critiqueReply(composeReply({ ...outcome.reply, frame, timings }), context);
      return { ...checked, timings: { ...timings, critic: performance.now() - resolved } };
    },
  };
}
