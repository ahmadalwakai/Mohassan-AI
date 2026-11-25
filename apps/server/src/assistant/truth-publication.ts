import type { CommandChatConfig } from '../command-chat.js';
import { requestedSites } from './goal-integrity.js';
import { LIVE } from './hands.js';
import { judge, resolvedQuestion, type JudgeEvidence } from './judge.js';
import type { JudgeShadowInput } from './judge-shadow.js';
import { ownFactQuestion } from './own-fact-question.js';
import { buildTruthQuestion } from './truth-agreement-question.js';
import { citedTruthUrl, judgeTruth, type TruthInput } from './truth-judge.js';
import { createTruthSecondSource } from './truth-second-source.js';

interface CurrentRun {
  ownerId: string;
  controller: AbortController;
  full: boolean;
  request?: string;
  previousRequest?: string | null;
  truthModelAnswer?: boolean;
  page?: { url: string };
  state?: {
    handsResults?: readonly { url: string }[] | null;
    handsFound?: { url: string } | null;
    requestResolution?: { scope: string } | null;
    trail: readonly { action: string }[];
  };
}
interface Asked { question: string; previous: string | null; pageQuestion?: string }

type Config = Pick<CommandChatConfig, 'judgeShadow' | 'judgeFixForOwner' | 'judgeWithholdForOwner' | 'judgeLogText' | 'readPage'>;

export function createTruthReplyJudge<T extends CurrentRun>(
  config: Config,
  currentRun: () => T | undefined,
  runEvidence: (current: T) => JudgeEvidence[],
  assertPublicRead: (question: string, current: T) => void,
  scrubReply: (conversationId: string, reply: string) => string = (_id, reply) => reply,
) {
  const lookup = createTruthSecondSource({ readPage: config.readPage });
  return async (conversationId: string, runId: string, reply: string, status: string, allowChange = false, asked?: Asked) => {
    const unchanged = { text: reply, withheld: false };
    const shadow = config.judgeShadow;
    if (!shadow) return unchanged;
    const current = currentRun();
    const request = current?.request;
    const question = asked?.question ?? request;
    if (!question) return unchanged;

    const evidence = current ? runEvidence(current) : [];
    const input: JudgeShadowInput = {
      conversationId, runId, question, reply, status, evidence,
      previous: asked ? asked.previous : current?.previousRequest ?? null,
      keepText: Boolean(current) && (config.judgeLogText !== 'owner' || Boolean(current?.full)),
    };
    let legacy;
    try { legacy = judge(input); } catch { return unchanged; }

    const applyFix = Boolean(allowChange && config.judgeFixForOwner && current?.full
      && legacy.decision === 'fix' && legacy.fixedReply?.trim());
    const applyWithhold = Boolean(allowChange && config.judgeWithholdForOwner && current?.full
      && legacy.decision === 'withhold' && legacy.withholdText?.trim());
    const legacyText = applyWithhold ? legacy.withholdText! : applyFix ? legacy.fixedReply! : reply;

    const selectedQuestion = asked?.pageQuestion ?? resolvedQuestion(question, input.previous);
    const action = current?.state?.trail.at(-1)?.action;
    const citedUrl = citedTruthUrl(reply);
    const primaryUrl = citedUrl ?? (asked?.pageQuestion ? current?.page?.url : undefined);
    const factualSkill = action === 'skill_read' && ['fact_question', 'identity'].includes(legacy.frame.intent);
    const publicModelFact = current?.truthModelAnswer && current.state?.requestResolution?.scope === 'public'
      && legacy.frame.intent === 'fact_question' && ['answer', 'quote', 'list'].includes(legacy.kind);
    const pageFact = asked?.pageQuestion && legacy.kind === 'quote' && buildTruthQuestion(selectedQuestion).answerType !== null;
    let scope: TruthInput['scope'] = 'other';
    if (current && status !== 'blocked' && !status.startsWith('waiting_') && action !== 'shorten_previous_answer') {
      if (factualSkill || citedUrl && ownFactQuestion(selectedQuestion)) scope = 'ungrounded_fact';
      else if (legacy.sourced && (legacy.kind === 'answer' || legacy.kind === 'quote') || publicModelFact || pageFact) scope = 'factual';
    }

    const pages = evidence.flatMap(item => item.kind === 'page' && item.url ? [{ url: item.url, quote: item.text, title: item.title }] : []);
    const candidates = current?.state?.handsResults;
    const searchedHere = current?.state?.trail.some(step => step.action.startsWith('search '));
    let supplemental: ReturnType<typeof lookup> | undefined;
    const corroborate: TruthInput['lookup'] = current && request && candidates?.length && searchedHere && !asked?.pageQuestion
      && !requestedSites(request).length && primaryUrl && current.state?.handsFound?.url === primaryUrl
      ? async supporting => {
          assertPublicRead(selectedQuestion, current);
          return supplemental ??= lookup({ ownerId: current.ownerId, signal: current.controller.signal, live: LIVE.test(selectedQuestion),
            pages: supporting, candidates, observedUrls: pages.map(page => page.url) });
        }
      : undefined;
    const truthInput = { question: selectedQuestion, reply, pages, primaryUrl, scope, lookup: corroborate };
    const evaluate = (candidate: string) => judgeTruth({ ...truthInput, reply: candidate })
      .catch(() => judgeTruth({ ...truthInput, scope: scope === 'other' ? 'other' : 'ungrounded_fact' }));
    const truth = await evaluate(reply);
    const enforce = allowChange && shadow.truthEnabled && !applyWithhold;
    const effective = enforce && truth.decision === 'send' && applyFix
      ? await evaluate(legacyText)
      : truth;
    const applied = Boolean(enforce && effective.replacement && effective.decision !== 'send');
    const { replacement: _replacement, ...facts } = truth;
    shadow.observe({ ...input, applyFix: applyFix && !applied, applyWithhold,
      truth: { ...facts, applied, ...(applied ? { appliedDecision: effective.decision } : {}) } }, legacy);

    if (applied) return { text: scrubReply(conversationId, effective.replacement!), withheld: effective.decision === 'withhold' };
    return { text: legacyText, withheld: applyWithhold };
  };
}
