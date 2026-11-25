import type { CommandChatConfig } from '../command-chat.js';
import type { BrowserRequestCapability } from './browser-request-scope.js';
import { requestedSites } from './goal-integrity.js';
import { LIVE, parseHands } from './hands.js';
import { judge, resolvedQuestion } from './judge.js';
import type { JudgeShadowInput, TruthShadowVerdict } from './judge-shadow.js';
import { ownFactQuestion } from './own-fact-question.js';
import { buildTruthQuestion } from './truth-agreement-question.js';
import { citedTruthUrl, prepareTruth, type TruthInput, type TruthVerdict } from './truth-judge.js';
import { createTruthSecondSource } from './truth-second-source.js';

interface RunState {
  handsResults?: readonly { url: string }[] | null;
  handsFound?: { url: string } | null;
  trail: readonly { action: string }[];
}
interface CurrentRun<State extends RunState> {
  ownerId: string;
  controller: AbortController;
  request?: string;
  page?: { url: string };
  state?: State;
}
interface PublicationOptions<State extends RunState> {
  allowChange: boolean;
  assertPublicSearch: (request: string, query: string, state: State, generated: boolean) => void;
  assertBrowserRequestScope: (request: string, capability: BrowserRequestCapability, state: State) => void;
  scrub: (reply: string) => string;
}
type Config = Pick<CommandChatConfig, 'judgeShadow' | 'readPage'>;

const readers = new WeakMap<Config, ReturnType<typeof createTruthSecondSource>>();

function reader(config: Config) {
  const existing = readers.get(config);
  if (existing) return existing;
  const read = createTruthSecondSource({ readPage: config.readPage });
  readers.set(config, read);
  return read;
}

function metadata({ replacement: _replacement, ...facts }: TruthVerdict) {
  return facts;
}

/** Runs at the original synchronous judge boundary. Cold HTTP reads can only inform the shadow record. */
export function publishTruthReply<State extends RunState>(
  config: Config, current: CurrentRun<State>, input: JudgeShadowInput, options: PublicationOptions<State>,
) {
  const shadow = config.judgeShadow;
  if (!shadow) return null;
  const legacy = judge(input);
  const legacyFix = input.applyFix && legacy.decision === 'fix' && legacy.fixedReply?.trim() ? legacy.fixedReply : null;
  const legacyWithhold = input.applyWithhold && legacy.decision === 'withhold' && legacy.withholdText?.trim() ? legacy.withholdText : null;
  const legacyText = legacyWithhold ?? legacyFix ?? input.reply;

  const { request, state } = current;
  const step = request && legacy.kind === 'quote' ? parseHands(request)?.at(-1) : null;
  const pageQuestion = step?.kind === 'ask_page' ? step.question : undefined;
  const selectedQuestion = pageQuestion ?? resolvedQuestion(input.question, input.previous);
  const citedUrl = citedTruthUrl(input.reply);
  const primaryUrl = citedUrl ?? (pageQuestion ? current.page?.url : undefined);
  const factualSkill = state?.trail.at(-1)?.action === 'skill_read' && ['fact_question', 'identity'].includes(legacy.frame.intent);
  const pageFact = pageQuestion && buildTruthQuestion(selectedQuestion).answerType !== null;
  let scope: TruthInput['scope'] = 'other';
  if (input.status !== 'blocked' && !input.status?.startsWith('waiting_')) {
    if (factualSkill || citedUrl && ownFactQuestion(selectedQuestion)) scope = 'ungrounded_fact';
    else if (legacy.sourced && (legacy.kind === 'answer' || legacy.kind === 'quote') || pageFact) scope = 'factual';
  }

  const pages = (input.evidence ?? []).flatMap(item =>
    item.kind === 'page' && item.url ? [{ url: item.url, quote: item.text, title: item.title }] : []);
  const candidates = state?.handsResults;
  const searchedHere = state?.trail.some(item => item.action.startsWith('search '));
  const lookup: TruthInput['lookup'] = config.readPage && state && request && candidates?.length && searchedHere && !pageQuestion
    && !requestedSites(request).length && primaryUrl && state.handsFound?.url === primaryUrl
    ? async supporting => {
        options.assertPublicSearch(request, selectedQuestion, state, true);
        options.assertBrowserRequestScope(request, 'browser_navigation', state);
        return reader(config)({ ownerId: current.ownerId, signal: current.controller.signal, live: LIVE.test(selectedQuestion),
          pages: supporting, candidates, observedUrls: pages.map(page => page.url) });
      }
    : undefined;

  const truthInput = { question: selectedQuestion, reply: input.reply, pages, primaryUrl, scope, lookup };
  const evaluate = (reply: string, supplemental = false) => {
    try { return prepareTruth({ ...truthInput, reply, lookup: supplemental ? lookup : undefined }); }
    catch { return prepareTruth({ ...truthInput, reply, lookup: undefined, scope: scope === 'other' ? 'other' : 'ungrounded_fact' }); }
  };
  const review = evaluate(input.reply, true);
  const truth = review.verdict;
  const enforce = options.allowChange && shadow.truthEnabled && !legacyWithhold;
  const effective = enforce && truth.decision === 'send' && legacyFix ? evaluate(legacyFix).verdict : truth;
  const replacement = enforce ? effective.replacement : null;
  const text = replacement ? options.scrub(replacement) : legacyText;
  const shadowTruth: TruthShadowVerdict = {
    ...metadata(truth), applied: Boolean(replacement), ...(replacement ? { appliedDecision: effective.decision } : {}),
  };
  const comparison = review.withLookup?.().then(supplemental => ({ ...shadowTruth, supplemental: metadata(supplemental) }), () => shadowTruth);
  shadow.observe({ ...input, applyFix: Boolean(input.applyFix && !replacement), truth: comparison ?? shadowTruth }, legacy);

  return { text, withheld: replacement ? effective.decision === 'withhold' : Boolean(legacyWithhold) };
}
