import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { ADVISORY_BUDGET_MS, deliberateAdvisory, fenceAdvisoryRecord, withAdvisoryBudget } from '../apps/server/src/assistant/council-advisory.js';
import type { CouncilOutcome, CouncilTurn } from '../apps/server/src/assistant/model-council.js';

const pipeline = 'pipeline';
const brief = 'Ask for the campaign goal.';
const record = {
  version: 1, chosen: pipeline, changed: false, reason: brief, elapsedMs: 0, members: [],
} as const satisfies CouncilOutcome['council'];

function fixture() {
  const deliberate = vi.fn(async (turn: CouncilTurn): Promise<CouncilOutcome> => ({
    ...turn.pipeline, chosen: pipeline, changed: false, council: record,
  }));
  const config = {
    modelCouncil: { deliberate },
    fullAccess: vi.fn(async (_ownerId: string) => true),
    accountFullAccess: vi.fn(async (_ownerId: string, _tx: Kysely<any>) => true),
  };
  const input = {
    ownerId: 'advisory-owner',
    question: 'Start a campaign for my shop.',
    reply: brief,
    baseline: { route: 'chat', refusal: 'allow', turnType: 'new', speechAct: 'request' } as const,
    signal: new AbortController().signal,
  };
  return { config, deliberate, input };
}

describe('owner publications with council advice', () => {
  it('consults the image models only after checking the owner', async () => {
    const { config, deliberate, input } = fixture();
    const images = vi.fn(() => [Buffer.from('fixture bytes')]);
    const turn = { ...input, route: 'image' as const, images };
    config.fullAccess.mockResolvedValueOnce(false);
    expect(await deliberateAdvisory(config, turn)).toBeUndefined();
    expect(images).not.toHaveBeenCalled();
    expect(deliberate).not.toHaveBeenCalled();

    expect(await deliberateAdvisory(config, turn)).toEqual(record);
    expect(images).toHaveBeenCalledOnce();
    expect(deliberate).toHaveBeenCalledWith(expect.objectContaining({
      question: input.question, images: images.mock.results[0]?.value, evidence: [], advisory: true,
      baseline: { ...input.baseline, route: 'image' }, pipeline: { text: brief, status: 'completed' },
    }));
  });

  it('passes the current Ads turn and rechecks owner access in its publishing transaction', async () => {
    const { config, deliberate, input } = fixture();
    const previous = 'The shop opens next week.';
    const result = await deliberateAdvisory(config, { ...input, route: 'ads', previous });
    expect(deliberate).toHaveBeenCalledWith(expect.objectContaining({
      question: input.question, previous, advisory: true, signal: expect.any(AbortSignal),
      baseline: { ...input.baseline, route: 'ads' }, pipeline: { text: brief, status: 'partial' },
    }));

    const tx = {} as Kysely<any>;
    config.accountFullAccess.mockResolvedValueOnce(false);
    expect(await fenceAdvisoryRecord(config, tx, input.ownerId, result)).toBeUndefined();
    expect(config.accountFullAccess).toHaveBeenCalledWith(input.ownerId, tx);
    expect(await fenceAdvisoryRecord(config, tx, input.ownerId, result)).toEqual(record);
  });

  it('lets the original reply publish when council advice fails or attempts to replace it', async () => {
    const { config, deliberate, input } = fixture();
    const turn = { ...input, route: 'ads' as const };
    deliberate.mockRejectedValueOnce(new Error('fixture council failure'));
    expect(await deliberateAdvisory(config, turn)).toBeUndefined();
    deliberate.mockResolvedValueOnce({ text: 'fixture replacement', status: 'completed', chosen: 'fake-model', changed: true, council: record });
    expect(await deliberateAdvisory(config, turn)).toBeUndefined();
  });

  it('ends the wait exactly at the shared deadline when owner lookup and stalled advice consume the budget', async () => {
    vi.useFakeTimers();
    try {
      const { config, deliberate, input } = fixture();
      let allow!: (allowed: boolean) => void;
      config.fullAccess.mockImplementationOnce(() => new Promise(resolve => { allow = resolve; }));
      deliberate.mockImplementationOnce(() => new Promise(() => {}));
      const publish = vi.fn();
      const publication = deliberateAdvisory(config, { ...input, route: 'ads' }).then(publish);
      const firstHalf = Math.floor(ADVISORY_BUDGET_MS / 2);
      await vi.advanceTimersByTimeAsync(firstHalf);
      expect(deliberate).not.toHaveBeenCalled();
      allow(true);
      await vi.advanceTimersByTimeAsync(ADVISORY_BUDGET_MS - firstHalf - 1);
      const signal = deliberate.mock.calls[0]?.[0].signal;
      expect(signal?.aborted).toBe(false);
      expect(publish).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await publication;
      expect(publish).toHaveBeenCalledWith(undefined);
      expect(signal?.aborted).toBe(true);
      expect(input.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops stalled advice immediately when the caller cancels', async () => {
    const controller = new AbortController();
    const work = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
    const result = withAdvisoryBudget(controller.signal, work);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(work.mock.calls[0]?.[0].aborted).toBe(true);
  });
});
