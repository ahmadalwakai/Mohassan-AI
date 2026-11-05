import { describe, expect, it, vi } from 'vitest';
import { type Capability, type PlanningResult, type RawCognitivePlan } from '@mohassan/contracts';
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from '@mohassan/providers';
import { ModelRouter, PlanningEngine, PlanningError, StrategyPlanner, verifyPlanningResult } from './index.js';

const capabilities: Capability[] = [
  { id: 'system.diagnostic', name: 'تشخيص', description: 'قراءة فقط', version: '1', risk: 'low', status: 'active', requiredScopes: ['diagnostic:read'] },
  { id: 'browser.research', name: 'بحث', description: 'غير متاح بعد', version: '1', risk: 'medium', status: 'planned', requiredScopes: ['browser:read'] },
  { id: 'ads.budget', name: 'ميزانية', description: 'تغيير مالي', version: '1', risk: 'high', status: 'active', requiredScopes: ['ads:budget'] },
];
function rawPlan(): RawCognitivePlan {
  return {
    summary: 'خطة لفحص مساحة العمل ومراجعة النتائج قبل أي تنفيذ إضافي.',
    goal: {
      objective: 'تحديد جاهزية مساحة العمل بأدلة فحص واضحة.',
      successCriteria: [{ id: 'criterion1', description: 'عرض حالة التخزين والقدرات.', evidence: 'نتيجة تشخيص موثقة وتاريخ ملاحظة.' }],
      constraints: ['لا تعديل ملفات أو حسابات خارجية.'], assumptions: [], clarifyingQuestions: [],
    },
    uncertainties: [], confidence: 0.9,
    steps: [
      { id: 'inspect', title: 'فحص الاتصال', description: 'اقترح تشخيصًا للقراءة فقط.', dependsOn: [], capabilityId: 'system.diagnostic', requiredScopes: ['diagnostic:read'], requiresApproval: false, acceptanceCriteria: ['نتيجة فحص قابلة للتحقق.'] },
      { id: 'preferences', title: 'جمع التفضيلات', description: 'راجع القيود مع المستخدم.', dependsOn: [], capabilityId: null, requiredScopes: [], requiresApproval: true, acceptanceCriteria: ['قيود موثقة.'] },
      { id: 'review', title: 'مراجعة النتيجة', description: 'قارن الأدلة بمعايير النجاح.', dependsOn: ['inspect', 'preferences'], capabilityId: null, requiredScopes: [], requiresApproval: true, acceptanceCriteria: ['تقرير يميز النتيجة عن الافتراض.'] },
    ],
  };
}
function responseFor(model: string, plan: RawCognitivePlan = rawPlan()): ModelResult {
  return { model, text: JSON.stringify(plan), usage: { inputTokens: 220, outputTokens: 380 } };
}
function harness(handler?: (model: string, request: ModelRequest) => Promise<ModelResult>) {
  const requests: { model: string; request: ModelRequest }[] = [];
  const factory = vi.fn((model: string): ModelProvider => ({
    id: 'groq', async generate(request) {
      requests.push({ model, request });
      return handler ? handler(model, request) : responseFor(model);
    },
  }));
  return { requests, factory, engine: new PlanningEngine({ providerForModel: factory, capabilities }) };
}
const simpleGoal = 'ضع خطة لفحص اتصال مساحة العمل ومراجعة النتائج.';

describe('planning structure, routing and trusted policy', () => {
  it('creates a structured Arabic planning request and verifies parallel dependency batches', async () => {
    const { engine, requests } = harness();
    const progress = vi.fn(async () => {});
    const result = await engine.generate(simpleGoal, { onProgress: progress });
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('openai/gpt-oss-20b');
    expect(requests[0].request).toMatchObject({ maxTokens: 4096, structured: { name: 'mohassan_cognitive_plan' } });
    expect(requests[0].request.system).toContain('خطة فقط');
    expect(result.executionBatches).toEqual([['inspect', 'preferences'], ['review']]);
    expect(result.executionAllowed).toBe(false);
    expect(result.verification).toMatchObject({ passed: true, scope: 'structure_and_policy' });
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 380 });
    expect(verifyPlanningResult(result, capabilities)).toEqual(result);
    expect(progress.mock.calls).toHaveLength(5);
  });

  it('routes complex goals deterministically to the reasoning model', () => {
    const router = new ModelRouter();
    const goal = 'صمم معمارية متعددة المراحل مع قاعدة بيانات وصلاحيات وتزامن.';
    expect(router.route(goal).model).toBe('openai/gpt-oss-120b');
    expect(router.route(goal)).toEqual(router.route(goal));
    expect(router.route('أ'.repeat(601)).model).toBe('openai/gpt-oss-120b');
  });

  it('replaces model permissions, approval and availability with registry policy', () => {
    const raw = rawPlan();
    raw.steps[0].requiredScopes = ['ads:budget', 'code:publish'];
    raw.steps[0].requiresApproval = true;
    raw.steps[1].capabilityId = 'ads.budget';
    raw.steps[1].requiresApproval = false;
    raw.steps[2].capabilityId = 'browser.research';
    raw.steps[2].requiredScopes = ['device:control'];
    raw.steps[2].requiresApproval = false;
    const { plan } = new StrategyPlanner().normalize(raw, capabilities);
    expect(plan.steps[0]).toMatchObject({ requiredScopes: ['diagnostic:read'], requiresApproval: false, availability: 'available' });
    expect(plan.steps[1]).toMatchObject({ requiredScopes: ['ads:budget'], requiresApproval: true, availability: 'available' });
    expect(plan.steps[2]).toMatchObject({ requiredScopes: ['browser:read'], requiresApproval: true, availability: 'unavailable' });
  });

  it('fails closed for an unknown registry while preserving a manual plan', () => {
    const { plan } = new StrategyPlanner().normalize(rawPlan());
    expect(plan.steps[0]).toMatchObject({ requiredScopes: [], requiresApproval: true, availability: 'unavailable' });
    expect(plan.steps[1]).toMatchObject({ requiredScopes: [], requiresApproval: true, availability: 'manual' });
  });

  const invalidGraphs: { name: string; mutate: (plan: RawCognitivePlan) => void }[] = [
    { name: 'duplicate step ids', mutate: (plan) => { plan.steps[1].id = 'inspect'; } },
    { name: 'missing dependency', mutate: (plan) => { plan.steps[0].dependsOn = ['missing']; } },
    { name: 'self dependency', mutate: (plan) => { plan.steps[0].dependsOn = ['inspect']; } },
    { name: 'duplicate dependency', mutate: (plan) => { plan.steps[2].dependsOn = ['inspect', 'inspect']; } },
    { name: 'cyclic dependency', mutate: (plan) => { plan.steps[0].dependsOn = ['review']; } },
    { name: 'duplicate success criteria ids', mutate: (plan) => { plan.goal.successCriteria.push({ ...plan.goal.successCriteria[0] }); } },
  ];
  it.each(invalidGraphs)('rejects $name without calling another model', async ({ mutate }) => {
    const plan = rawPlan(); mutate(plan);
    const { engine, requests } = harness(async (model) => responseFor(model, plan));
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'INVALID_PLAN', usage: { inputTokens: 220, outputTokens: 380 } });
    expect(requests).toHaveLength(1);
  });

  it.each(['confidence', 'critical_unknown', 'question', 'missing_capability'])('requires clarification for %s without claiming factual verification', async (condition) => {
    const plan = rawPlan();
    if (condition === 'confidence') plan.confidence = 0.4;
    if (condition === 'critical_unknown') plan.uncertainties = [{ description: 'لا توجد أدلة على جودة التحويل.', impact: 'high', resolution: 'افحص مصدر التتبع.' }];
    if (condition === 'question') plan.goal.clarifyingQuestions = ['ما نطاق الموارد المسموح؟'];
    if (condition === 'missing_capability') plan.steps[0].capabilityId = 'future.not_installed';
    const { engine } = harness(async (model) => responseFor(model, plan));
    const result = await engine.generate(simpleGoal);
    expect(result.needsClarification).toBe(true);
    expect(result.executionAllowed).toBe(false);
    expect(result.verification.scope).toBe('structure_and_policy');
  });
});

describe('bounded provider calls and paid-response accounting', () => {
  it.each([429, 503])('allows one fallback after a confirmed HTTP %s rejection', async (status) => {
    const { engine, requests } = harness(async (model) => {
      if (model === 'openai/gpt-oss-20b') throw new ProviderError('TEMPORARY_REJECTION', 'رفض مؤقت', true, status);
      return responseFor(model);
    });
    const result = await engine.generate(simpleGoal);
    expect(requests.map((entry) => entry.model)).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 380 });
  });

  it('stops after two confirmed rejections', async () => {
    const { engine, requests } = harness(async () => { throw new ProviderError('TEMPORARY_REJECTION', 'رفض', true, 503); });
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', httpStatus: 503 });
    expect(requests).toHaveLength(2);
  });

  it.each([
    new ProviderError('NETWORK_ERROR', 'نتيجة الشبكة غير محسومة', true),
    new ProviderError('UPSTREAM_ERROR', 'خطأ خادم غير محدد', true, 500),
    new ProviderError('ABORTED', 'انتهت المهلة', false),
  ])('does not repeat an ambiguous or unapproved provider failure ($code)', async (error) => {
    const { engine, requests } = harness(async () => { throw error; });
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', providerCode: error.code });
    expect(requests).toHaveLength(1);
  });

  it('retains known usage for invalid paid JSON without retaining the response', async () => {
    const fakeCredential = `gsk_${'f'.repeat(32)}`;
    const { engine, requests } = harness(async (model) => ({ ...responseFor(model), text: fakeCredential }));
    let failure: unknown;
    try { await engine.generate(simpleGoal); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PlanningError);
    expect(failure).toMatchObject({ code: 'INVALID_PLAN', usage: { inputTokens: 220, outputTokens: 380 } });
    expect(JSON.stringify(failure)).not.toContain(fakeCredential);
    expect(String(failure)).not.toContain(fakeCredential);
    expect(requests).toHaveLength(1);
  });

  it('preserves a provider usage receipt when paid generation is truncated', async () => {
    const error = new ProviderError('INCOMPLETE_RESPONSE', 'انتهى حد المخرجات.');
    error.usage = { inputTokens: 700, outputTokens: 4096 };
    const { engine, requests } = harness(async () => { throw error; });
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE', providerCode: 'INCOMPLETE_RESPONSE',
      model: 'openai/gpt-oss-20b', usage: { inputTokens: 700, outputTokens: 4096 },
    });
    expect(requests).toHaveLength(1);
  });

  it('never treats an error with a paid receipt as a clean 503 fallback rejection', async () => {
    const error = new ProviderError('UPSTREAM_ERROR', 'حدث فشل بعد معالجة الطلب.', true, 503);
    error.usage = { inputTokens: 700, outputTokens: 100 };
    const { engine, requests } = harness(async () => { throw error; });
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE', httpStatus: 503, usage: { inputTokens: 700, outputTokens: 100 },
    });
    expect(requests).toHaveLength(1);
  });

  it('retains a provider receipt even when cancellation coincides with the provider error', async () => {
    const controller = new AbortController();
    const error = new ProviderError('INCOMPLETE_RESPONSE', 'توقفت الاستجابة.');
    error.usage = { inputTokens: 80, outputTokens: 50 };
    const { engine } = harness(async () => { controller.abort(); throw error; });
    await expect(engine.generate(simpleGoal, { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED', usage: { inputTokens: 80, outputTokens: 50 },
    });
  });

  it('rejects a successful response without valid usage instead of inventing a receipt', async () => {
    const { engine } = harness(async (model) => ({ ...responseFor(model), usage: { inputTokens: Number.NaN, outputTokens: 12 } }));
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'INVALID_USAGE', usage: undefined });
  });

  it('rejects mismatched model receipts and excessive reported output with known usage', async () => {
    const mismatch = harness(async () => responseFor('unexpected-model'));
    await expect(mismatch.engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'MODEL_MISMATCH', usage: { inputTokens: 220, outputTokens: 380 } });
    const excessive = harness(async (model) => ({ ...responseFor(model), usage: { inputTokens: 10, outputTokens: 4097 } }));
    await expect(excessive.engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', usage: { inputTokens: 10, outputTokens: 4097 } });
  });

  it('does not create a mock success when the provider is unconfigured', async () => {
    const factory = vi.fn(() => { throw new ProviderError('NOT_CONFIGURED', 'المزود غير معد.'); });
    const engine = new PlanningEngine({ providerForModel: factory, capabilities });
    await expect(engine.generate(simpleGoal)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', providerCode: 'NOT_CONFIGURED' });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('redaction, cancellation and independent result verification', () => {
  it('redacts recognizable credentials before sending the goal and before returning the plan', async () => {
    const fakeCredential = `gsk_${'x'.repeat(32)}`;
    const plan = rawPlan();
    plan.summary = `راجع إعداد المفتاح ${fakeCredential} دون تنفيذه.`;
    plan.goal.successCriteria[0].evidence = `استبعد Bearer ${'a'.repeat(32)} من الأدلة.`;
    const { engine, requests } = harness(async (model) => responseFor(model, plan));
    const result = await engine.generate(`${simpleGoal} المفتاح ${fakeCredential}`);
    expect(requests[0].request.goal).not.toContain(fakeCredential);
    expect(JSON.stringify(result)).not.toContain(fakeCredential);
    expect(result.summary).toContain('[REDACTED]');
    expect(result.plan.goal.successCriteria[0].evidence).toContain('[REDACTED]');
  });

  it('aborts before spending when already cancelled', async () => {
    const { engine, requests } = harness();
    const controller = new AbortController(); controller.abort();
    await expect(engine.generate(simpleGoal, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(requests).toHaveLength(0);
  });

  it('keeps a usage receipt when cancelled after receiving a paid response', async () => {
    const { engine, requests } = harness();
    const controller = new AbortController();
    await expect(engine.generate(simpleGoal, {
      signal: controller.signal, onProgress: async (stage) => { if (stage === 'response_received') controller.abort(); },
    })).rejects.toMatchObject({ code: 'ABORTED', usage: { inputTokens: 220, outputTokens: 380 } });
    expect(requests).toHaveLength(1);
  });

  it('retains paid usage if durable progress recording fails', async () => {
    const { engine } = harness();
    await expect(engine.generate(simpleGoal, {
      onProgress: async (stage) => { if (stage === 'response_received') throw new Error('database disconnected'); },
    })).rejects.toMatchObject({ code: 'PLANNING_FAILED', usage: { inputTokens: 220, outputTokens: 380 } });
  });

  it('rejects tampered permissions, scheduling, gates or execution claims independently', async () => {
    const { engine } = harness();
    const original = await engine.generate(simpleGoal);
    const mutations: ((value: PlanningResult) => void)[] = [
      (value) => { value.plan.steps[0].requiredScopes = ['ads:budget']; },
      (value) => { value.plan.steps[0].requiresApproval = true; },
      (value) => { value.plan.steps[0].availability = 'manual'; },
      (value) => { value.executionBatches = [['review'], ['inspect', 'preferences']]; },
      (value) => { value.needsClarification = true; },
      (value) => { value.summary = 'خطة أخرى.'; },
      (value) => { value.verification.checks = ['model_says_success']; },
      (value) => { (value as unknown as { executionAllowed: boolean }).executionAllowed = true; },
      (value) => { value.verifiedAt = new Date(Date.now() + 60_000).toISOString(); },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(original); mutate(tampered);
      expect(verifyPlanningResult(tampered, capabilities)).toBeNull();
    }
    expect(verifyPlanningResult({ verification: { passed: true } }, capabilities)).toBeNull();
  });

  it('rejects oversized goals and ambiguous registry configuration before requesting a model', async () => {
    const { engine, requests, factory } = harness();
    await expect(engine.generate('أ'.repeat(4001))).rejects.toMatchObject({ code: 'INVALID_GOAL' });
    expect(requests).toHaveLength(0);
    expect(() => new PlanningEngine({ providerForModel: factory, capabilities: [capabilities[0], capabilities[0]] })).toThrow(PlanningError);
  });
});
