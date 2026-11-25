import { describe, expect, it, vi } from 'vitest';
import {
  createStructuredEvidenceShadow,
  type StructuredEvidenceShadowInput,
  type StructuredEvidenceShadowReport,
} from '../apps/server/src/assistant/structured-evidence-shadow.js';

const input = {
  conversationId: 'conversation-1',
  runId: 'run-1',
  answer: 'The population was 2,500.',
  target: { entity: 'Hilltown', attribute: 'population', unit: 'count', kind: 'population' },
  pages: [{
    url: 'https://example.org/census',
    title: 'Hilltown population census',
    fetchedAt: '2026-11-25T08:00:00Z',
    text: 'Hilltown had a population of 1,250 people in 2024.',
  }],
  options: { now: '2026-11-25T08:00:00Z' },
} satisfies StructuredEvidenceShadowInput;

describe('structured evidence shadow', () => {
  it('logs the supplied answer and the extracted result together after observation', async () => {
    const log = vi.fn<(line: StructuredEvidenceShadowReport) => void>();
    const shadow = createStructuredEvidenceShadow({ log, now: () => new Date('2026-11-25T08:00:00Z') });

    expect(shadow.observe(input)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    await shadow.flush();

    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      at: '2026-11-25T08:00:00.000Z',
      conversationId: 'conversation-1',
      runId: 'run-1',
      answer: 'The population was 2,500.',
      target: input.target,
      result: expect.objectContaining({
        status: 'value',
        top: expect.objectContaining({ value: { kind: 'number', value: 1250, unit: 'count' } }),
      }),
    }));
  });

  it('keeps logging after a sink throws or rejects', async () => {
    const log = vi.fn<(line: StructuredEvidenceShadowReport) => void | Promise<void>>()
      .mockImplementationOnce(() => { throw new Error('synchronous sink failure'); })
      .mockRejectedValueOnce(new Error('asynchronous sink failure'));
    const shadow = createStructuredEvidenceShadow({ log });

    shadow.observe(input);
    shadow.observe({ ...input, runId: 'run-2' });
    shadow.observe({ ...input, runId: 'run-3', pages: [] });
    await expect(shadow.flush()).resolves.toBeUndefined();

    expect(log.mock.calls.map(([report]) => report.runId)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(log.mock.calls[2]?.[0].result).toMatchObject({ status: 'gap', top: null, read: [] });
  });

  it('uses the observation time for freshness even if the queued comparison runs later', async () => {
    const log = vi.fn<(line: StructuredEvidenceShadowReport) => void>();
    let now = new Date('2024-12-31T23:00:00Z');
    const shadow = createStructuredEvidenceShadow({ log, now: () => now });

    shadow.observe({ ...input, options: undefined });
    shadow.observe({ ...input, options: { now: '2028-01-01T00:00:00Z' } });
    now = new Date('2028-01-01T00:00:00Z');
    await shadow.flush();

    expect(log.mock.calls.map(([report]) => [report.at, report.result.top?.freshness])).toEqual([
      ['2024-12-31T23:00:00.000Z', 'fresh'],
      ['2024-12-31T23:00:00.000Z', 'possibly-stale'],
    ]);
  });
});
