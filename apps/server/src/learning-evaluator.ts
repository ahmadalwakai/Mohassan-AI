import { createHash } from 'node:crypto';
import type { ModelProvider } from '@mohassan/providers';
import { EVALUATION_SUITE_VERSION, evaluationCases, LEARNING_CONTEXT_POLICY, selectKnowledgeChunks, knowledgeContextEntry, lessonContextEntry, serializeLearningContext,
  type EvaluationCase, type LearningContentEvaluator, type LearningEvaluationSubject } from '@mohassan/learning';
import { replayLearningCases } from '../../../scripts/learning-eval.js';

export interface IsolatedLearningEvaluatorOptions {
  model: string;
  /** Server-owned provider; never supplied by an activation HTTP request. */
  createProvider: (model: string) => ModelProvider;
  cases?: readonly EvaluationCase[];
  maxCases?: number;
  maxModelCalls?: number;
  caseTimeoutMs?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
}

function candidateContext(subject: Readonly<LearningEvaluationSubject>): (request: string) => string {
  if (subject.kind === 'knowledge') {
    // Pin the entire redacted document, then run the same per-query retrieval
    // policy as runtime. This evaluates selected chunks, not every future query.
    if (createHash('sha256').update(subject.text).digest('hex') !== subject.hash) throw new Error('EVAL_DOCUMENT_HASH_MISMATCH');
    const document = { id: subject.id, version: Number(subject.source?.match(/:(\d+)$/)?.[1] ?? 1), title: subject.title ?? '', text: subject.text,
      contentHash: subject.hash, sourceHash: subject.sourceHash ?? subject.hash, source: subject.source ?? `knowledge:${subject.id}:1` };
    return request => serializeLearningContext(selectKnowledgeChunks([document], request, 3).map(knowledgeContextEntry));
  }
  const context = serializeLearningContext([lessonContextEntry(subject)]);
  if (!context) throw new Error('EVAL_CONTEXT_LIMIT');
  return () => context;
}

/**
 * Replays the fixed holdout twice in isolated fixtures, once without the subject
 * and once with it. Returns observations only: the learning package computes the
 * verdict with its independent oracle. It never activates content or updates a
 * production database. Configure it explicitly; importing it performs no work.
 */
export function createIsolatedLearningEvaluator(options: IsolatedLearningEvaluatorOptions): LearningContentEvaluator {
  const cases = structuredClone(options.cases ?? evaluationCases.filter(test => test.split === 'holdout'));
  const maxCalls = options.maxModelCalls ?? 240;
  const maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
  if (cases.some(test => test.split !== 'holdout') || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 960 ||
      !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 3_600_000) throw new Error('EVAL_CONFIGURATION_INVALID');
  const suiteHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
  let running = false;
  return async subject => {
    if (running) throw new Error('EVAL_ALREADY_RUNNING');
    const context = candidateContext(subject);
    options.signal?.throwIfAborted();
    const provider = options.createProvider(options.model);
    // Local only: no cloud evaluator exists (owner decision 2026-11-10).
    if (provider.id !== 'ollama') throw new Error('EVAL_LOCAL_PROVIDER_REQUIRED');
    const signal = AbortSignal.any([AbortSignal.timeout(maxDurationMs), ...(options.signal ? [options.signal] : [])]);
    let calls = 0;
    const createProvider = (model: string): ModelProvider => {
      if (model !== options.model) throw new Error('EVAL_MODEL_CHANGED');
      return { id: provider.id, generate: request => {
        signal.throwIfAborted();
        if (++calls > maxCalls) throw new Error('EVAL_MODEL_CALL_LIMIT');
        return provider.generate(request);
      } };
    };
    running = true;
    try {
      const replay = { model: options.model, createProvider, cases, maxCases: options.maxCases,
        caseTimeoutMs: options.caseTimeoutMs, signal };
      const baseline = await replayLearningCases(replay);
      const candidate = await replayLearningCases({ ...replay, learningContext: context });
      if (candidate.length !== baseline.length || candidate.some((result, index) => result.test.id !== baseline[index]?.test.id)) throw new Error('EVAL_CASES_CHANGED');
      return { suiteId: `${EVALUATION_SUITE_VERSION}-isolated-content-v1`, suiteHash, model: options.model, contextPolicy: LEARNING_CONTEXT_POLICY,
        cases: baseline.map((result, index) => ({ test: result.test, baseline: result.observation, candidate: candidate[index]!.observation })) };
    } finally { running = false; }
  };
}
