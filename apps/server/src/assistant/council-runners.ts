import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelAdapter } from '../../../../packages/model-relations/src/adapters.js';
import type { ModelEntry, ResolvedModel } from '../../../../packages/model-relations/src/registry.js';
import type { ModelAdapter, ModelAdapterContext } from '../../../../packages/model-relations/src/runtime.js';
import { checkGoal } from '../../../../scripts/ads-training/goal.js';
import { pointerToGoal, renderGoalPointerPrompt } from '../../../../scripts/ads-training/pointer.js';
import type { CouncilRunner } from './model-council.js';
import { readerPrompt } from './council-passage.js';
import type { CouncilRole } from './council-scheduler.js';
import { isFollowUp } from './hands.js';
import { rulesRoute } from './router.js';

type Passage = { text: string; title?: string; url?: string };
type Verdict = 'supports' | 'contradicts' | 'unsure';

export interface CouncilRunContext {
  question: string;
  previous?: string | null;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  passage?: Passage | null;
  passages?: readonly Passage[];
  images?: readonly Uint8Array[];
  previousRoute?: string;
  pendingReply?: boolean;
  requestedField?: string;
  checkAnswer?: string;
  monitorInput?: unknown;
  codeTask?: { capability: string; fields: Record<string, unknown> };
}

export interface CouncilRunnerOutput {
  text?: string;
  label?: string;
  hypotheses?: readonly { label: 'date' | 'place'; text: string; startUtf16: number; endUtf16: number }[];
  verdict?: Verdict;
  ranking?: readonly { index: number; score: number }[];
}

type RunnerResult = Awaited<ReturnType<CouncilRunner['run']>>;

const readerAbstention = /غير\s+مذكور|لا\s+يذكر|لم\s+يذكر|لا\s+يوجد\s+في\s+النص|ليس\s+في\s+النص|not\s+(?:mentioned|stated|given|in\s+the\s+(?:text|passage))|unanswerable|no\s+answer|cannot\s+be\s+answered/iu;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const bilingual = (id: string) => id === 'ads-code-foundation' || id.startsWith('ads-bilingual-code-');

function candidatePassages(context: CouncilRunContext): string[] {
  const passages = context.passages?.length ? context.passages : context.passage ? [context.passage] : [];
  return passages.slice(0, 16).map(item => item.text.slice(0, 8_000));
}

function modelInput(entry: ModelEntry, role: CouncilRole, context: CouncilRunContext): unknown {
  const { id } = entry;
  const { question, passage } = context;
  const text = question.slice(0, 8_000);
  if (role === 'understanding') {
    if (id === 'monitor-context-head') return context.monitorInput;
    if (id === 'router-context-history') {
      const inferredPrior = context.previous ? rulesRoute(context.previous, null) : undefined;
      const previousRoute = context.previousRoute ?? (inferredPrior === 'memory_ads_pc' ? undefined : inferredPrior);
      return { text, previousRoute, pendingReply: context.pendingReply, requestedField: context.requestedField,
        ...(context.previous && isFollowUp(text) && { source: 'prior_conversation', scope: 'private' }) };
    }
    if (id.startsWith('scratch-')) return { text, ...(context.previous ? { previousText: context.previous.slice(0, 8_000) } : {}) };
    if (entry.dependencies.some(dependency => dependency.id === 'chat-v5')) {
      const history = context.history?.slice(0, -1).slice(-16).map(turn => turn.content.slice(0, 8_000));
      if (id === 'question-edit') {
        const candidates = [text, context.previous ? `${context.previous}\n${text}`.slice(0, 8_000) : ''];
        return context.previous ? { text, history, candidates } : undefined;
      }
      return { text, history };
    }
    return { text };
  }
  if (role === 'extractor') return passage ? { text: passage.text.slice(0, 8_000) } : undefined;
  if (role === 'calculator') return { text };
  if (role === 'ads-tagger' && id === 'google-ads-pointer') return { text };
  if (role === 'ads-tagger' || (role === 'code' && !context.codeTask && bilingual(id))) {
    return { ...(id.startsWith('ads-v4-') ? { prompt: renderGoalPointerPrompt(text) } : { text: renderGoalPointerPrompt(text) }), maxNewTokens: 96 };
  }
  if (role === 'code') return context.codeTask;
  if (id === 'reading-dense-retriever') {
    const passages = context.passages?.slice(0, 16).map(item => item.text.slice(0, 1_200));
    return passages?.length ? { question: text, passages } : undefined;
  }
  if (id === 'reading-abstain-verifier') {
    return passage && context.checkAnswer ? { question: text, passage: passage.text, answer: context.checkAnswer } : undefined;
  }
  if (id === 'head-sufficiency') return passage ? { text, history: candidatePassages(context) } : undefined;
  if (id === 'head-answer-sentence') return passage ? { text, candidates: candidatePassages(context) } : undefined;
  if (role === 'reader') return passage ? { prompt: readerPrompt(text, passage.text), maxNewTokens: 20 } : undefined;
  if (role === 'generator') return passage ? { prompt: readerPrompt(text, passage.text), maxNewTokens: 48 } : { text, maxNewTokens: 48 };
  return undefined;
}

function normalizeOutput(entry: ModelEntry, role: CouncilRole, context: CouncilRunContext, output: unknown): CouncilRunnerOutput {
  const data = asRecord(output);
  if (data.abstained === true) return {};
  if (role === 'understanding') return { label: asString(data.label) ?? asString(data.route) };
  if (role === 'extractor') return { hypotheses: Array.isArray(data.hypotheses) ? data.hypotheses as CouncilRunnerOutput['hypotheses'] : [] };
  if (entry.id === 'reading-dense-retriever') return { ranking: Array.isArray(data.ranking) ? data.ranking as CouncilRunnerOutput['ranking'] : [] };
  if (entry.id === 'head-sufficiency') return { verdict: data.label === 'insufficient' ? 'contradicts' : 'unsure' };
  if (role === 'verifier') return { verdict: data.verdict === 'supports' || data.verdict === 'contradicts' ? data.verdict : 'unsure' };
  if (role === 'calculator') return { text: asString(data.value) };
  if (role === 'ads-tagger' || (role === 'code' && !context.codeTask && bilingual(entry.id))) {
    const raw = asString(data.selection) ?? asString(data.text);
    const goal = raw ? pointerToGoal(context.question, raw.split('\n', 1)[0]!) : null;
    return goal && !checkGoal(context.question, goal).length ? { text: JSON.stringify(goal), label: goal.intent } : {};
  }
  if (entry.id === 'head-answer-sentence' && typeof data.selectedIndex === 'number') {
    return { text: candidatePassages(context)[data.selectedIndex] };
  }
  const raw = asString(data.text);
  const text = role === 'reader' ? raw?.split('\n', 1)[0]?.trim() : raw;
  if (!text || (role === 'reader' && readerAbstention.test(text))) return {};
  return { text };
}

async function readCouncilImages(runner: CouncilRunner, entry: ModelEntry, images: readonly Uint8Array[], signal: AbortSignal): Promise<RunnerResult> {
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-council-image-'));
  try {
    const path = join(directory, 'image');
    const texts: string[] = [];
    for (const bytes of images) {
      signal.throwIfAborted();
      await writeFile(path, bytes, { mode: 0o600 });
      const result = await runner.run(entry.id, { path }, signal);
      if (!result.ok) return result;
      const text = asString(asRecord(result.output).text);
      if (text) texts.push(text);
    }
    return { ok: true, elapsedMs: performance.now() - started, output: { text: texts.join('\n\n') } satisfies CouncilRunnerOutput };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCouncilMember(runner: CouncilRunner, entry: ModelEntry, role: CouncilRole, context: CouncilRunContext, signal: AbortSignal): Promise<RunnerResult> {
  signal.throwIfAborted();
  if (role === 'image-reader' && context.images?.length) return readCouncilImages(runner, entry, context.images, signal);
  const input = modelInput(entry, role, context);
  if (input === undefined) return { ok: false, elapsedMs: 0, reason: 'invalid-input', detail: 'No matching turn evidence or task input' };
  const result = await runner.run(entry.id, input, signal);
  return result.ok ? { ...result, output: normalizeOutput(entry, role, context, result.output) } : result;
}

export async function loadCouncilModelAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const { id } = model.entry;
  if (id === 'router-b1' || id === 'router-context-text' || id === 'router-context-history') {
    const { loadCouncilRouterAdapter } = await import('../../../../packages/model-relations/src/council-router-adapter.js');
    return loadCouncilRouterAdapter(model, context);
  }
  if (/^(?:reading|ads)-v4-(?:head|lora|last2)$/u.test(id)) {
    const { loadCouncilDeltaAdapter } = await import('../../../../packages/model-relations/src/council-delta-adapter.js');
    return loadCouncilDeltaAdapter(model, context);
  }
  if (id === 'reading-abstain-verifier' || id === 'reading-dense-retriever' || id === 'execution' || id.startsWith('execution-')) {
    const { loadCouncilNativeAdapter } = await import('../../../../packages/model-relations/src/council-native-adapter.js');
    return loadCouncilNativeAdapter(model, context);
  }
  if (bilingual(id)) {
    const { loadCouncilBilingualAdapter } = await import('../../../../packages/model-relations/src/council-native-adapter.js');
    return loadCouncilBilingualAdapter(model, context);
  }
  return loadModelAdapter(model, context);
}
