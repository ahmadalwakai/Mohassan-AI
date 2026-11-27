import { describe, expect, it, vi } from 'vitest';
import { ModelRelationsManager, type ModelObservation, type TurnObservation } from './manager.js';
import type { ModelRunResult } from './runtime.js';

function observation(baseline: Partial<TurnObservation['baseline']> = {}): TurnObservation {
  return { id: 'opaque-turn-id', text: 'Private current turn', previousText: 'Private previous turn',
    baseline: { route: 'web_search', refusal: 'allow', speechAct: 'request', turnType: 'follow_up', ...baseline } };
}

function runner(outputs: Record<string, unknown> = {}, failures: Record<string, Omit<Extract<ModelRunResult, { ok: false }>, 'ok' | 'elapsedMs'>> = {}) {
  return { run: vi.fn(async (model: string, _input: unknown, _signal?: AbortSignal): Promise<ModelRunResult> => {
    if (model in failures) return { ok: false, elapsedMs: 0, ...failures[model] };
    return model in outputs ? { ok: true, output: outputs[model], elapsedMs: 0 } : { ok: false, reason: 'absent', elapsedMs: 0 };
  }) };
}

function outcomes(stages: { models: ModelObservation[] }[]) {
  return Object.fromEntries(stages.flatMap(stage => stage.models).map(model => [model.model, model]));
}

describe('model relations manager', () => {
  it('records the host image reader without rerunning it or logging image text', async () => {
    const runtime = runner();
    const manager = new ModelRelationsManager(runtime);
    const log = await manager.inspect(observation({ route: 'image', imageReadMs: 45, answer: 'Private image reading' }));
    expect(runtime.run).not.toHaveBeenCalled();
    expect(outcomes(log.stages)).toMatchObject({ ocr: { outcome: 'ok', attempted: true, elapsedMs: 45, returned: { label: 'read' } } });
    expect(JSON.stringify(log)).not.toContain('Private');
  });

  it('keeps the existing publication decision while logging refusal, speech and router conflicts', async () => {
    const runtime = runner({ refusal: { label: 'unsafe' }, 'scratch-refusal': { label: 'allow' },
      'scratch-speech-act': { label: 'smalltalk' }, 'router-b2': { route: 'compute' }, 'scratch-route': { label: 'web_search' } });
    const manager = new ModelRelationsManager(runtime, { hashKey: 'test-key' });
    const first = await manager.inspect(observation());
    expect(first.arbitration).toMatchObject({ winner: 'existing-rules', reason: 'shadow',
      proposal: { source: 'refusal', route: { label: 'unsupported' } } });
    expect(outcomes(first.stages)).toMatchObject({ refusal: { disagreed: true }, 'scratch-refusal': { disagreed: false },
      'scratch-speech-act': { disagreed: true }, 'router-b2': { disagreed: true } });
    expect(runtime.run).toHaveBeenCalledWith('refusal', { text: 'Private current turn' }, expect.any(AbortSignal));
    expect(runtime.run).toHaveBeenCalledWith('router-b2', { text: 'Private current turn' }, expect.any(AbortSignal));
    expect(runtime.run).toHaveBeenCalledWith('scratch-route', { text: 'Private current turn', previousText: 'Private previous turn' }, expect.any(AbortSignal));
    expect(runtime.run.mock.calls.map(([id]) => id)).not.toContain('router-b0');
    expect((await manager.inspect(observation({ refusal: 'refuse' }))).arbitration.reason).toBe('host-refusal');
    expect((await manager.inspect(observation({ route: 'chat', speechAct: 'smalltalk' }))).arbitration.reason).toBe('host-smalltalk');
    expect(manager.summary()).toMatchObject({ turns: 3, models: expect.arrayContaining([expect.objectContaining({ model: 'refusal',
      attempted: 3, compared: 3, disagreements: 2, disagreementRate: 2 / 3 })]) });
  });

  it('labels only the current request by its Arabic and Latin letters', async () => {
    const manager = new ModelRelationsManager(runner({ refusal: { label: 'allow' } }));
    for (const [text, language] of [['\u0633 123', 'ar'], ['A \u0661', 'en'], ['A \u0633', 'mixed'], ['1 + 2', 'en']]) {
      const log = await manager.inspect({ ...observation(), text, previousText: 'A \u0633' });
      expect(log.language).toBe(language);
    }
    expect(manager.summary()).toMatchObject({ turns: 4, turnsByLanguage: { ar: 1, en: 2, mixed: 1, unknown: 0 },
      models: expect.arrayContaining([expect.objectContaining({ model: 'refusal', byLanguage: {
        ar: expect.objectContaining({ compared: 1, disagreements: 0, outcomes: { ok: { numerator: 1, denominator: 1 } } }),
        en: expect.objectContaining({ compared: 2, disagreements: 0, outcomes: { ok: { numerator: 2, denominator: 2 } } }),
        mixed: expect.objectContaining({ compared: 1, disagreements: 0, outcomes: { ok: { numerator: 1, denominator: 1 } } }),
      } })]) });
  });

  it('uses the next router proposal and protects the baseline on absence, health failures and abstention', async () => {
    const runtime = runner({ refusal: { label: 'allow' }, 'scratch-refusal': { abstained: true },
      'router-b0': { route: 'news' }, 'scratch-route': { label: 'chat' } }, {
      'router-b2': { reason: 'absent' }, 'scratch-speech-act': { reason: 'unhealthy', detail: 'untrusted error details' },
      'scratch-follow-up': { reason: 'gpu-locked' },
    });
    const manager = new ModelRelationsManager(runtime);
    const log = await manager.inspect(observation());
    expect(log.arbitration).toMatchObject({ winner: 'existing-rules', proposal: { source: 'router-b0', route: { label: 'news' } } });
    expect(outcomes(log.stages)).toMatchObject({
      'router-b2': { outcome: 'absent', fallback: 'existing-rules' },
      'scratch-speech-act': { outcome: 'unhealthy', fallback: 'existing-rules' },
      'scratch-follow-up': { outcome: 'gpu-locked', fallback: 'existing-rules' },
      'scratch-refusal': { outcome: 'abstained', fallback: 'existing-rules' },
    });
    expect(JSON.stringify(log)).not.toContain('untrusted error details');
    expect(manager.summary().models.find(model => model.model === 'router-b2')).toMatchObject({ fallbacks: 1, disagreementRate: null });
  });

  it('feeds the selected rewrite into evidence, sentence selection and judge without publishing it', async () => {
    const runtime = runner({ 'scratch-follow-up': { label: 'follow_up' }, 'question-edit': { selectedIndex: 1 },
      'head-sufficiency': { label: 'sufficient' }, 'head-answer-sentence': { selectedIndex: 1 } });
    const judge = vi.fn(() => 'withhold' as const);
    const manager = new ModelRelationsManager(runtime, { judge });
    const turn = observation({ question: 'Private rule question', evidenceSufficiency: 'sufficient', answer: 'Private rule answer',
      judge: 'send', evidence: [{ kind: 'page', text: 'Private sentence one. Private sentence two.' }] });
    const log = await manager.inspect(turn);
    expect(runtime.run).toHaveBeenCalledWith('question-edit', { text: turn.text, history: [turn.previousText], candidates: [turn.baseline.question, turn.text] }, expect.any(AbortSignal));
    expect(runtime.run).toHaveBeenCalledWith('head-sufficiency', { text: turn.text, history: [turn.baseline.evidence![0].text] }, expect.any(AbortSignal));
    expect(runtime.run).toHaveBeenCalledWith('head-answer-sentence', { text: turn.text, candidates: ['Private sentence one.', 'Private sentence two.'] }, expect.any(AbortSignal));
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ question: turn.text, reply: 'Private sentence two.' }));
    expect(outcomes(log.stages)['head-answer-sentence'].disagreed).toBeUndefined();
    expect(log.stages.find(stage => stage.stage === 'reply-judge')).toMatchObject({ winner: 'existing-rules',
      rule: { label: 'send' }, review: { verdict: { label: 'withhold' }, disagreed: true } });
    expect(JSON.stringify(log)).not.toMatch(/Private|opaque-turn-id/u);
  });

  it('treats arbitrary model labels and indices as invalid and passes only the host question and answer to the judge', async () => {
    const runtime = runner({ 'router-b2': { route: 'raw personal model payload' }, 'question-edit': { selectedIndex: 9 },
      'head-sufficiency': { label: 'insufficient' } });
    const judge = vi.fn(() => 'send' as const);
    const manager = new ModelRelationsManager(runtime, { judge });
    const log = await manager.inspect(observation({ question: 'Expanded rule question', answer: 'Final rule reply',
      evidence: [{ kind: 'page', text: 'A sentence. Another sentence.' }] }));
    expect(log.arbitration.proposal).toBeUndefined();
    expect(outcomes(log.stages)).toMatchObject({ 'router-b2': { outcome: 'invalid-output', fallback: 'existing-rules' },
      'question-edit': { outcome: 'invalid-output', fallback: 'existing-rules' } });
    expect(judge).toHaveBeenCalledOnce();
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ question: 'Expanded rule question', reply: 'Final rule reply' }));
    expect(runtime.run.mock.calls.map(([id]) => id)).not.toContain('head-answer-sentence');
    expect(JSON.stringify(log)).not.toContain('raw personal model payload');
  });

  it('bounds a turn with a hung model and marks later requests as unattempted fallbacks', async () => {
    const aborted = vi.fn();
    const runtime = { run: vi.fn((_model: string, _input: unknown, signal?: AbortSignal) => {
      signal?.addEventListener('abort', aborted, { once: true });
      return new Promise<ModelRunResult>(() => {});
    }) };
    const manager = new ModelRelationsManager(runtime, { maxTurnMs: 10 });
    const log = await manager.inspect(observation());
    expect(runtime.run).toHaveBeenCalledOnce();
    expect(aborted).toHaveBeenCalledOnce();
    expect(outcomes(log.stages)).toMatchObject({ refusal: { outcome: 'timeout', attempted: true, fallback: 'existing-rules' },
      'router-b2': { outcome: 'timeout', attempted: false, fallback: 'existing-rules' } });
    expect(log.arbitration.winner).toBe('existing-rules');
  });

  it('shadows arithmetic on an allowed computation and records its value only as a hash', async () => {
    const runtime = runner({ arithmetic: { value: '987654', expression: 'private computation' } });
    const manager = new ModelRelationsManager(runtime);
    const turn = observation({ route: 'compute', arithmeticValue: '987653' });
    const { stages } = await manager.inspect(turn);
    expect(runtime.run).toHaveBeenCalledWith('arithmetic', { text: turn.text }, expect.any(AbortSignal));
    expect(outcomes(stages).arithmetic).toMatchObject({ outcome: 'ok', disagreed: true });
    expect(JSON.stringify(stages)).not.toMatch(/98765[34]|private computation/u);
    runtime.run.mockClear();
    await manager.inspect(observation({ route: 'compute', refusal: 'refuse' }));
    expect(runtime.run.mock.calls.map(([id]) => id)).not.toContain('arithmetic');
  });
});
