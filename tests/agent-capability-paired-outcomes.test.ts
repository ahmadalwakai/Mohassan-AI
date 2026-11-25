import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectOutcomes, parseCollectorArgs, writeUnusedReceipt } from '../scripts/agent-capability-bench/collect-paired-outcomes.js';
import type { CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import type { CapabilityTurnObservation } from '../scripts/agent-capability-bench/observe.js';

describe('paired outcome collector', () => {
  it('requires an explicit partition and an unused output path argument', () => {
    expect(parseCollectorArgs(['--sealed', 'payload.json', '--output', 'receipt.json', '--baseline', 'true'])).toEqual({
      mode: 'sealed', sealed: resolve('payload.json'), output: resolve('receipt.json'), baseline: true, observer: 'observe.ts',
    });
    expect(parseCollectorArgs(['--preflight', 'true', '--output', 'receipt.json', '--adapted-observer', 'true'])).toEqual({
      mode: 'preflight', output: resolve('receipt.json'), observer: 'by-branch-observe.ts',
    });
    expect(() => parseCollectorArgs(['--sealed', 'payload.json'])).toThrow('Expected --sealed');
    expect(() => parseCollectorArgs(['--preflight', 'true', '--output', 'receipt.json', '--sealed', 'payload.json'])).toThrow('Expected --sealed');
    expect(() => parseCollectorArgs(['--sealed', 'payload.json', '--output', 'receipt.json', '--baseline', 'false'])).toThrow('Expected --sealed');
    expect(() => parseCollectorArgs(['--sealed', 'payload.json', '--output', 'receipt.json', '--baseline', 'true', '--adapted-observer', 'true'])).toThrow('Expected --sealed');
    expect(() => parseCollectorArgs(['--preflight', 'true', '--output', 'receipt.json', '--output', 'another.json'])).toThrow('Expected --sealed');
  });

  it('observes each case once in order and retains only outcome keys and grouped aggregates', async () => {
    const first: CapabilityCase = { id: 'unit-01', area: 'calculation', language: 'en', variety: 'english',
      provenance: { author: '', source: '' }, turns: [{ text: 'unit input', expect: {
        status: ['completed'], requiredContent: [], forbiddenContent: [], maxSteps: 0, questionCount: 0,
      } }] };
    const second: CapabilityCase = { ...first, id: 'unit-02', area: 'factual', language: 'ar', variety: 'msa' };
    const turn: CapabilityTurnObservation = {
      answer: 'unit response', questionCount: 0, questionFields: [], status: 'completed', conversationStatus: 'idle',
      source: null, operation: null, route: null, handler: null, understanding: null, routeReason: null, steps: 0,
      toolCalls: [], boundaryCalls: [], planSteps: [], verdict: null,
      verification: { status: null, evidence: [], independentEvidence: [], reviewStatus: null },
      fixtureMisses: 0, modelCalls: 0, unexpectedEffects: 0, latencyMs: 1,
    };
    const finished: string[] = [];
    const observe = vi.fn(async ({ id }: CapabilityCase) => {
      if (id === second.id) expect(finished).toEqual([first.id]);
      await Promise.resolve();
      finished.push(id);
      return { setupMs: 1, turns: id === first.id ? [turn] : [] };
    });

    const receipt = await collectOutcomes([first, second], observe);
    expect(observe.mock.calls).toEqual([[first], [second]]);
    expect(receipt.outcomes).toEqual([
      { id: first.id, area: 'calculation', language: 'en', passed: true },
      { id: second.id, area: 'factual', language: 'ar', passed: false },
    ]);
    expect(receipt.summary.overall).toMatchObject({ passed: 1, total: 2 });
    expect(receipt.summary.byArea.factual).toMatchObject({ passed: 0, total: 1 });
    expect(receipt.summary.byLanguage.en).toMatchObject({ passed: 1, total: 1 });
    expect(JSON.stringify(receipt)).not.toMatch(/unit input|unit response/u);
  });

  it('reserves output exclusively before observing, preserves failed attempts and writes private receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capability-paired-outcomes-'));
    try {
      const output = join(directory, 'receipt.json');
      await writeUnusedReceipt(output, async () => ({ partition: 'unit' }));
      expect(await readFile(output, 'utf8')).toBe('{\n  "partition": "unit"\n}\n');
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      const replay = vi.fn(async () => ({}));
      await expect(writeUnusedReceipt(output, replay)).rejects.toThrow('The paired outcome receipt already exists.');

      const failed = join(directory, 'failed-receipt.json');
      await expect(writeUnusedReceipt(failed, async () => { throw new Error('test failure'); })).rejects.toThrow('test failure');
      expect(await readFile(failed, 'utf8')).toBe('');
      await expect(writeUnusedReceipt(failed, replay)).rejects.toThrow('The paired outcome receipt already exists.');
      expect(replay).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
