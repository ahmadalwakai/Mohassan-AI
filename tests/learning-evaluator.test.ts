import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createIsolatedLearningEvaluator } from '../apps/server/src/learning-evaluator.js';
import { assessLearningComparison, LEARNING_CONTEXT_POLICY, selectKnowledgeChunks, knowledgeContextEntry, serializeLearningContext, type EvaluationCase, type LearningEvaluationSubject } from '@mohassan/learning';
import type { ModelRequest, ModelResult } from '@mohassan/providers';

const cases: EvaluationCase[] = [
  { id: 'isolated-content-delivery', category: 'chat', split: 'holdout', safety: false, prompt: 'ما يوم التسليم؟ أجب باليوم فقط.', expected: { answer: { exact: 'الثلاثاء' } }, reference: { answer: 'الثلاثاء' } },
  { id: 'isolated-content-arithmetic', category: 'chat', split: 'holdout', safety: true, prompt: 'كم حاصل اثنين واثنين؟ أجب بالكلمة فقط.', expected: { answer: { exact: 'أربعة' } }, reference: { answer: 'أربعة' } },
];
const subject: LearningEvaluationSubject = { kind: 'lesson', id: 'local-lesson', ownerId: 'owner-never-sent', hash: 'a'.repeat(64), text: 'موعد التسليم المعروف هو الثلاثاء.' };
const answer = (text: string): ModelResult => ({ model: 'local-test', provider: 'ollama', usage: { inputTokens: 1, outputTokens: 1 },
  text: JSON.stringify({ thought: null, plan: null, note: null, tool: 'answer', url: null, ref: null, text, submit: null, options: null, sensitive: null, outcome: 'done' }) });

describe('isolated learning replay', () => {
  it('runs actual chat control with separate baseline and candidate contexts and independent verdicts', async () => {
    const requests: ModelRequest[] = [];
    const evaluate = createIsolatedLearningEvaluator({ model: 'local-test', cases, maxModelCalls: 4, maxDurationMs: 60_000,
      createProvider: () => ({ id: 'ollama', generate: async request => {
        requests.push(request);
        if (request.goal.includes('حاصل اثنين واثنين')) return answer('أربعة');
        return answer(request.goal.includes('evaluated_lessons_and_knowledge') ? 'الثلاثاء' : 'لا أعرف');
      } }),
    });
    const comparison = await evaluate(subject);
    expect(comparison.cases).toHaveLength(2);
    expect(assessLearningComparison(comparison, true)).toMatchObject({ passed: true, improved: 1, regressions: 0, safetyPassed: true });
    expect(requests).toHaveLength(4);
    expect(requests.slice(0, 2).every(request => !request.goal.includes(subject.text))).toBe(true);
    expect(requests.slice(2).every(request => request.goal.includes(subject.text))).toBe(true);
    expect(requests.every(request => !request.goal.includes(subject.ownerId))).toBe(true);
  }, 90_000);

  it('does not silently truncate a candidate or enable a cloud evaluator', async () => {
    const factory = vi.fn(() => ({ id: 'groq', generate: async () => answer('أربعة') }));
    const evaluate = createIsolatedLearningEvaluator({ model: 'local-test', cases, createProvider: factory });
    await expect(evaluate({ ...subject, text: 'x'.repeat(3600) })).rejects.toThrow('EVAL_CONTEXT_LIMIT');
    await expect(evaluate({ ...subject, text: '<'.repeat(1000) })).rejects.toThrow('EVAL_CONTEXT_LIMIT');
    expect(factory).not.toHaveBeenCalled();
    await expect(evaluate(subject)).rejects.toThrow('EVAL_LOCAL_PROVIDER_REQUIRED');
  });

  it('evaluates a long document through the same query-selected context used at runtime', async () => {
    const text = 'مقدمة عن تنظيم السجلات وأرشفتها.\n'.repeat(300) + '\nموعد التسليم المعروف هو الثلاثاء.\n';
    const hash = createHash('sha256').update(text).digest('hex');
    const knowledge: LearningEvaluationSubject = { ...subject, kind: 'knowledge', id: 'long-document', title: 'دليل الإجراءات', source: 'knowledge:long-document:2', sourceHash: hash, hash, text };
    const requests: ModelRequest[] = [];
    const evaluate = createIsolatedLearningEvaluator({ model: 'local-test', cases, maxModelCalls: 4, maxDurationMs: 60_000,
      createProvider: () => ({ id: 'ollama', generate: async request => {
        requests.push(request);
        return answer(request.goal.includes('حاصل اثنين واثنين') ? 'أربعة' : request.goal.includes('موعد التسليم المعروف هو الثلاثاء.') ? 'الثلاثاء' : 'لا أعرف');
      } }),
    });
    const result = await evaluate(knowledge);
    expect(result.contextPolicy).toBe(LEARNING_CONTEXT_POLICY);
    expect(assessLearningComparison(result, false)).toMatchObject({ passed: true, improved: 1, contextPolicy: LEARNING_CONTEXT_POLICY });
    const runtime = serializeLearningContext(selectKnowledgeChunks([{ id: knowledge.id, version: 2, title: knowledge.title!, text, contentHash: hash, sourceHash: hash, source: knowledge.source }], cases[0].prompt, 3).map(knowledgeContextEntry));
    expect(runtime).toContain('موعد التسليم المعروف هو الثلاثاء.');
    expect(runtime).toContain(hash);
    expect(requests[2].goal).toContain(runtime);
    expect(requests[2].goal).not.toContain(text);
    expect(requests[3].goal).not.toContain('موعد التسليم المعروف هو الثلاثاء.');
    await expect(evaluate({ ...knowledge, hash: 'a'.repeat(64) })).rejects.toThrow('EVAL_DOCUMENT_HASH_MISMATCH');
  }, 90_000);

  it('rejects a cancelled evaluation before opening fixtures or making a model request', async () => {
    const controller = new AbortController(); controller.abort();
    const factory = vi.fn(() => ({ id: 'ollama', generate: async () => answer('أربعة') }));
    const evaluate = createIsolatedLearningEvaluator({ model: 'local-test', cases, createProvider: factory, signal: controller.signal });
    await expect(evaluate(subject)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('cancels an in-flight provider request when its operator signal is revoked', async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const evaluate = createIsolatedLearningEvaluator({ model: 'local-test', cases, signal: controller.signal,
      createProvider: () => ({ id: 'ollama', generate: request => {
        providerSignal = request.signal;
        return new Promise<ModelResult>((_resolve, reject) => {
          const abort = () => reject(new DOMException('cancelled', 'AbortError'));
          request.signal?.addEventListener('abort', abort, { once: true });
          if (request.signal?.aborted) abort();
        });
      } }),
    });
    const result = evaluate(subject).catch(error => error);
    await vi.waitFor(() => expect(providerSignal).toBeDefined(), { timeout: 20_000 });
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(providerSignal?.aborted).toBe(true);
  }, 30_000);
});
