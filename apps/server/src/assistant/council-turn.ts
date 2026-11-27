import { performance } from 'node:perf_hooks';
import type { ModelCouncilMember } from '@mohassan/contracts';
import { modelRoots, resolveModelInRoots, type ModelEntry } from '../../../../packages/model-relations/src/registry.js';
import type { ModelRunResult } from '../../../../packages/model-relations/src/runtime.js';
import {
  councilModelReply, decideCouncilDiscussion, proposeCouncilAnswers, uncertainCouncilReply,
  type CouncilCheck, type CouncilProposal,
} from './council-deliberation.js';
import { readerPrompt, selectPassage } from './council-passage.js';
import { councilWeight, type CouncilDomain, type CouncilLanguage } from './council-receipts.js';
import { runCouncilMember, type CouncilRunContext } from './council-runners.js';
import { councilRole, createCouncilSchedule, type CouncilRole, type CouncilRun } from './council-scheduler.js';
import { comparable, judge, type JudgeEvidence } from './judge.js';
import { buildFrame } from './mind/frame.js';
import type { CouncilOutcome, CouncilTurn, ModelCouncilOptions } from './model-council.js';
import { questionLanguage } from './reply-check.js';

const PIPELINE = 'pipeline';
const V5 = 'chat-v5';
const WEB_SEARCH = 'web-search';
const WEB_ROUTES = new Set(['web_search', 'news']);
const ABSTAIN = /غير\s+مذكور|لا\s+يذكر|لم\s+يذكر|لا\s+يوجد\s+في\s+النص|ليس\s+في\s+النص|not\s+(?:mentioned|stated|given|in\s+the\s+(?:text|passage))|unanswerable|no\s+answer|cannot\s+be\s+answered/iu;
const POPULATION = /\b(?:population|inhabitants|how\s+many\s+people\s+live)\b|(?:^|[^\p{L}])(?:عدد\s+السكان|عدد\s+سكان|تعداد\s+السكان)(?!\p{L})/iu;

type SignalOutput = {
  text?: string;
  label?: string;
  route?: string;
  abstained?: boolean;
  verdict?: CouncilCheck['verdict'];
  hypotheses?: readonly { label: string; text: string }[];
  ranking?: readonly { index: number; score: number }[];
};
type Answer = { member: string; answer: string };
type CheckResult = { checks: CouncilCheck[]; failure?: Extract<ModelRunResult, { ok: false }> };
type Passage = NonNullable<CouncilRunContext['passage']>;
const roundMs = (elapsed: number) => Math.min(600_000, Math.max(0, Math.round(elapsed)));
const short = (value: string, length: number) => value.slice(0, length);

function output(result: ModelRunResult): SignalOutput {
  return result.ok && result.output && typeof result.output === 'object' ? result.output as SignalOutput : {};
}

function record<R>(run: CouncilRun<R>, round: ModelCouncilMember['round']): ModelCouncilMember {
  const base = { model: run.entry.id, label: run.entry.id, round, elapsedMs: roundMs(run.ms) };
  if (run.status === 'ok') return { ...base, outcome: 'ok' };
  const outcome = run.status === 'timeout' ? 'timeout' : run.status === 'skipped' ? 'abstained' : 'failed';
  return { ...base, outcome, note: short(`${run.status}: ${run.reason}`, 240) };
}

function modelResult(run: CouncilRun<ModelRunResult>, round: ModelCouncilMember['round'], text?: string): ModelCouncilMember {
  const member = record(run, round);
  if (run.status !== 'ok') return member;
  if (!run.value.ok) return {
    ...member, outcome: run.value.reason === 'timeout' ? 'timeout' : 'failed',
    note: short([run.value.reason, run.value.detail].filter(Boolean).join(': '), 240),
  };
  return text ? { ...member, output: short(text, 600) } : { ...member, outcome: 'abstained' };
}

function domainFor(turn: CouncilTurn, evidence: readonly JudgeEvidence[]): CouncilDomain {
  if (turn.images?.length) return 'image';
  if (turn.baseline.route === 'ads') return 'ads';
  if (turn.baseline.route === 'coding') return 'code';
  if (turn.baseline.route === 'compute') return 'arithmetic';
  const { answerType } = buildFrame(turn.question);
  if (answerType === 'date' || answerType === 'place') return answerType;
  if (answerType === 'number' && POPULATION.test(turn.question)) return 'population';
  return evidence.some(page => page.kind === 'page') || WEB_ROUTES.has(turn.baseline.route) ? 'reading' : 'general';
}

function capFor(role: CouncilRole, entry: ModelEntry, options: ModelCouncilOptions): number {
  const caps = options.memberMs;
  if (role === 'understanding') return caps?.understanding ?? 4_000;
  if (entry.id === V5) return caps?.v5 ?? 20_000;
  if (role === 'generator') return caps?.v4 ?? 25_000;
  if (role === 'reader' || entry.id === 'reading-abstain-verifier') return caps?.reader ?? 25_000;
  if (role === 'calculator') return caps?.arithmetic ?? 5_000;
  if (role === 'ads-tagger' && entry.runtime !== 'node-cpu') return caps?.v4 ?? 25_000;
  return entry.resources.latencyMs;
}

function usablePage(page: JudgeEvidence): page is JudgeEvidence & { url: string } {
  return page.kind === 'page' && Boolean(page.url && /^https?:\/\//iu.test(page.url) && page.text.trim());
}

async function searchTurn(turn: CouncilTurn, search: NonNullable<CouncilTurn['search']>, budgetMs: number) {
  const started = performance.now();
  const signal = AbortSignal.any([turn.signal, AbortSignal.timeout(Math.max(0, Math.floor(budgetMs)))]);
  let onAbort: (() => void) | undefined;
  let pages: readonly JudgeEvidence[] = [];
  let note: string | undefined;
  if (!signal.aborted && budgetMs > 0) {
    const stop = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([search(turn.question, signal), stop]);
      pages = result?.pages.filter(usablePage) ?? [];
      note = result?.note;
    } catch {
      note = 'Public search failed.';
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  const member: ModelCouncilMember = {
    model: WEB_SEARCH, label: 'البحث في الويب', round: 'search',
    outcome: pages.length ? 'ok' : signal.aborted || budgetMs <= 0 ? 'timeout' : 'failed',
    elapsedMs: roundMs(performance.now() - started),
    ...(pages.length && { output: short(pages.map(page => page.title || page.url).join(' · '), 600) }),
    ...(note && { note: short(note, 240) }),
  };
  return { pages, member };
}

function taggerCheck(run: SignalOutput, proposal: CouncilProposal, domain: CouncilDomain): CouncilCheck['verdict'] {
  const answer = comparable(proposal.answer);
  return run.hypotheses?.some(span => span.label === domain && comparable(span.text) === answer
    && proposal.evidenceQuote?.includes(span.text)) ? 'supports' : 'unsure';
}

export async function deliberateCouncilTurn(options: ModelCouncilOptions, turn: CouncilTurn): Promise<CouncilOutcome> {
  const started = performance.now();
  const deadline = started + (options.budgetMs ?? 45_000);
  const language = questionLanguage(turn.question);
  const receiptLanguage: CouncilLanguage = /[\p{L}&&[^\p{Script=Latin}\p{Script=Arabic}]]/v.test(turn.question) ? 'other' : language;
  const mayPropose = turn.baseline.refusal === 'allow';
  let evidence = turn.evidence;
  let domain = domainFor(turn, evidence);
  const receipt = options.weight ?? councilWeight;
  const members: ModelCouncilMember[] = [];
  const roles = new Map<string, CouncilRole>();
  const pipelineText = turn.pipeline.text.trim();
  const pipelineJudge = judge({
    question: turn.question, previous: turn.previous, reply: pipelineText,
    status: turn.pipeline.status, ...(evidence.length && { evidence }),
  });
  const pipelineStands = Boolean(pipelineText && turn.pipeline.status === 'completed' && pipelineJudge.decision !== 'withhold');
  const resolve = options.resolve ?? (entry => resolveModelInRoots(entry, modelRoots(process.cwd()), process.env, false));
  const schedule = createCouncilSchedule({
    registry: options.registry, signal: turn.signal, deadline,
    resolve: entry => entry.id === V5 && options.v5 && (options.v5Ready?.() ?? true)
      ? Promise.resolve({ entry, state: entry.state, artifacts: [] }) : resolve(entry),
    capMs: (role, entry) => capFor(role, entry, options),
    weight: (entry, role) => receipt(entry.id, role, receiptLanguage, domain).weight,
  });
  const context: CouncilRunContext = {
    question: turn.question, previous: turn.previous, history: turn.history, images: turn.images, codeTask: turn.codeTask,
  };
  const run = (entry: ModelEntry, role: CouncilRole, signal: AbortSignal) =>
    runCouncilMember(options.runner, entry, role, context, signal);

  const understood = await schedule.run(['understanding'], entry =>
    entry.id === 'monitor-context-head' ? 'No monitor decision context on this turn' : true,
    run, started + (options.memberMs?.understanding ?? 4_000));
  for (const result of understood) {
    const value = result.status === 'ok' ? output(result.value) : {};
    const text = value.abstained ? undefined : value.label ?? value.route ?? value.text;
    const member = modelResult(result, 'understanding', text);
    if (text && /routing|route labels|route classification/iu.test(result.entry.task)) {
      member.agreesWithRules = text === turn.baseline.route;
    }
    members.push(member);
  }

  const search = turn.search ?? options.search;
  if (search && !turn.advisory && mayPropose && !evidence.length && !pipelineStands && WEB_ROUTES.has(turn.baseline.route)) {
    const searched = await searchTurn(turn, search, Math.min(deadline - performance.now(), options.memberMs?.search ?? 15_000));
    evidence = searched.pages;
    domain = domainFor(turn, evidence);
    members.push(searched.member);
  }
  const pages = evidence.filter(usablePage);
  context.passage = selectPassage(turn.question, pages);
  context.passages = pages.map(page => selectPassage(turn.question, [page]) ?? {
    text: short(page.text, 1_200), url: page.url, title: page.title,
  });
  if (mayPropose && context.passages.length && !turn.advisory) {
    const retrieved = await schedule.run(['reader'], entry => entry.id === 'reading-dense-retriever', run);
    for (const result of retrieved) {
      const ranking = result.status === 'ok' ? output(result.value).ranking : undefined;
      const selected = ranking?.[0] && context.passages[ranking[0].index];
      if (selected) context.passage = selected;
      members.push(modelResult(result, 'answer', selected?.title || selected?.url));
    }
  }

  const answers: Answer[] = [{ member: PIPELINE, answer: pipelineText }];
  members.push({
    model: PIPELINE, label: 'المحرك (القواعد والصفحات)', round: 'answer', elapsedMs: 0,
    outcome: pipelineText ? 'ok' : 'abstained', ...(pipelineText && { output: short(pipelineText, 600) }),
    judge: pipelineJudge.decision,
  });
  const answering = await schedule.run(['reader', 'generator', 'calculator', 'image-reader', 'ads-tagger', 'code'], (entry, role) => {
    if (!mayPropose) return false;
    if (role === 'reader') return !turn.advisory && entry.id !== 'reading-dense-retriever' && pages.length > 0
      && (Boolean(context.passage) || 'No relevant passage');
    if (role === 'generator') return !turn.advisory && (entry.id !== V5
      || (options.v5 && (options.v5Ready?.() ?? true) && turn.history.at(-1)?.role === 'user') === true
      || 'Resident v5 worker or chat history unavailable');
    if (role === 'calculator') return !turn.advisory && language === 'en' && /\d/u.test(turn.question);
    if (role === 'image-reader') return domain === 'image';
    if (role === 'ads-tagger') return domain === 'ads';
    if (role !== 'code') return false;
    const historicalAdsCode = entry.task.startsWith('Historical') && entry.task.includes('Ads and code');
    if (domain === 'ads') return historicalAdsCode;
    if (domain !== 'code') return false;
    if (!turn.codeTask) return 'No supported typed executor input';
    return !historicalAdsCode || turn.codeTask.capability === 'typescript.implement.v1:null-safe-delta';
  }, async (entry, role, signal): Promise<ModelRunResult> => {
    if (entry.id !== V5) return run(entry, role, signal);
    const history = context.passage
      ? [...turn.history.slice(0, -1), { role: 'user' as const, content: readerPrompt(turn.question, context.passage.text) }]
      : turn.history;
    const text = await options.v5?.(history, signal);
    return { ok: true, output: { text }, elapsedMs: 0 };
  });
  for (const result of answering) {
    roles.set(result.entry.id, result.role);
    const value = result.status === 'ok' ? output(result.value) : {};
    const raw = value.text?.trim();
    const answer = raw && !value.abstained && !ABSTAIN.test(raw) ? raw : '';
    if (result.status === 'ok' && result.value.ok) answers.push({ member: result.entry.id, answer });
    members.push(modelResult(result, 'answer', answer));
  }

  const proposals = proposeCouncilAnswers(answers, pages);
  const checkable = proposals.filter(proposal => proposal.answer && proposal.evidenceQuote);
  const verify = await schedule.run(['verifier', 'extractor'], (entry, role) => {
    if (!mayPropose || turn.advisory || !pages.length) return false;
    if (role === 'extractor' && domain !== 'date' && domain !== 'place') return false;
    if (!checkable.length) return 'No cited answer to check';
    if (entry.id === 'reading-abstain-verifier' && !checkable.some(proposal => proposal.member === 'reading-v3-last')) {
      return 'No cited reading-v3-last proposal for this verifier';
    }
    return true;
  }, async (entry, role, signal): Promise<CheckResult> => {
    const checks: CouncilCheck[] = [];
    let failure: CheckResult['failure'];
    for (const proposal of checkable) {
      if (signal.aborted) break;
      if (entry.id === 'reading-abstain-verifier' && proposal.member !== 'reading-v3-last') continue;
      const passage: Passage = { text: proposal.evidenceQuote ?? '', url: proposal.evidenceUrl };
      const result = await runCouncilMember(options.runner, entry, role, {
        ...context, checkAnswer: proposal.answer, passage: role === 'extractor' ? passage : context.passage,
        requestedField: domain,
      }, signal);
      const model = output(result);
      const verdict = role === 'extractor' ? taggerCheck(model, proposal, domain) : model.verdict ?? 'unsure';
      if (!result.ok) failure ??= result;
      checks.push({ checker: entry.id, member: proposal.member, verdict, ...(!result.ok && { note: result.reason }) });
    }
    return { checks, failure };
  });
  const checks: CouncilCheck[] = [];
  for (const result of verify) {
    const member = record(result, 'answer');
    if (result.status === 'ok') {
      checks.push(...result.value.checks);
      const failure = result.value.failure;
      if (failure) {
        member.outcome = failure.reason === 'timeout' ? 'timeout' : 'failed';
        member.note = failure.reason;
      } else {
        member.output = result.value.checks.map(check => `${check.member}: ${check.verdict}`).join(' · ').slice(0, 600);
      }
    }
    members.push(member);
  }

  const keepPipeline = Boolean(pipelineText && (turn.advisory || !mayPropose || pipelineJudge.kind === 'question'
    || (turn.pipeline.status !== 'completed' && (turn.pipeline.status === 'partial' || !pages.length))));
  const discussion = decideCouncilDiscussion({
    question: turn.question, previous: turn.previous, evidence: pages, proposals, checks, pipelineStands, keepPipeline,
    allowReplacement: !turn.advisory && mayPropose,
    vote: member => receipt(member, member === PIPELINE ? 'pipeline' : roles.get(member)!, receiptLanguage, domain),
  });
  const chosen = discussion.decision.chosen;
  const winner = proposals.find(proposal => proposal.member === chosen);
  const text = chosen === PIPELINE ? turn.pipeline.text : winner
    ? councilModelReply(winner, language) : uncertainCouncilReply(language, pages);
  for (const member of members) {
    if (member.round !== 'answer') continue;
    if (member.model === chosen) member.chosen = true;
    const evidenceCheck = discussion.checks.find(check => check.checker === 'evidence' && check.member === member.model);
    if (pages.length && evidenceCheck) member.inEvidence = evidenceCheck.verdict === 'supports';
    const judgeCheck = discussion.checks.find(check => check.checker === 'judge' && check.member === member.model);
    if (!member.judge && judgeCheck) member.judge = judgeCheck.verdict === 'contradicts' ? 'withhold'
      : judgeCheck.verdict === 'supports' ? 'send' : undefined;
  }
  return {
    text, chosen, changed: text !== turn.pipeline.text,
    status: chosen === PIPELINE ? turn.pipeline.status : winner ? 'completed' : 'partial',
    council: {
      version: 1, chosen, changed: text !== turn.pipeline.text, reason: discussion.decision.reasonAr,
      elapsedMs: roundMs(performance.now() - started), members: members.slice(0, 48), discussion,
    },
  };
}
