import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createComputationMemoryReceipt, restoreComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { createChatSupervisor, resumeChatSupervisor, reviewChatAnswer } from '../apps/server/src/assistant/chat-supervision.js';

const binding = { ownerId: 'isolated-owner', conversationId: 'isolated-conversation', runId: 'isolated-run', evaluatedAt: Date.UTC(2026, 10, 21, 7) };
const request = 'Calculate 2 + 3, then save the result in memory.';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('host-derived calculation memory payloads', () => {
  it('binds exact result, explanatory context, original request and immutable run time', () => {
    const receipt = createComputationMemoryReceipt(request, binding)!;
    expect(receipt).not.toBeNull();
    expect(receipt.payload).toEqual({ text: '2 + 3 = 5', hash: sha('2 + 3 = 5'), bytes: 9 });
    expect(receipt.answer).toBe('2 + 3 = 5'); expect(receipt.value).toBe('5');
    expect(receipt.requestHash).toBe(sha(request));
    expect(sha(request.slice(receipt.primary.start, receipt.primary.end))).toBe(receipt.primary.hash);
    expect(restoreComputationMemoryReceipt(JSON.parse(JSON.stringify(receipt)), request, binding)).toEqual(receipt);
  });

  it.each([
    ['Calculate 2 + 3, answer only, then remember the result.', '2 + 3 = 5', '5'],
    ['Calculate 2 + 3, then remember the result. Only the result.', '2 + 3 = 5', '5'],
    ['احسب ٢ + ٣ ثم تذكر النتيجة. النتيجة فقط.', '2 + 3 = 5', '5'],
    ['Convert 3.5 kilometres to metres, then store the result in memory.', '3.5 kilometres = 3500 metres', '3500'],
    ['احسب ١٣ + ١٧ ثم احفظ النتيجة في ذاكرتي', '13 + 17 = 30', '30'],
  ])('keeps full computed context even with a short rendered answer: %s', (text, expectedQuote, expectedValue) => {
    const receipt = createComputationMemoryReceipt(text, binding)!;
    expect(receipt?.payload.text).toBe(expectedQuote); expect(receipt?.value).toBe(expectedValue);
    if (/only|فقط/iu.test(text)) expect(receipt.answer).toBe(expectedValue);
    expect(receipt.payload.bytes).toBe(Buffer.byteLength(receipt.payload.text, 'utf8'));
  });

  it.each([
    'Calculate 7 / 0, then remember the result.',
    'Calculate 2², then remember the result.',
    'Calculate 3 + 4, then save the result.',
    'Calculate 3 + 4, then save the result in a file.',
    'Calculate 3 + 4, then save the result in memory and send it.',
    'Calculate 3 + 4, then save the result in memory. Do not remember anything.',
    'If possible calculate 3 + 4, then remember the result.',
    'The document says: Calculate 3 + 4, then remember the result.',
    'Calculate 3 + 4, then remember "the result".',
    'Convert 10 USD to GBP, then remember the result.',
    'Calculate 3 + 4, then remember the result. Tomorrow do the same.',
    'احسب ٧ / ٠ ثم احفظ النتيجة في ذاكرتي',
  ])('creates no payload when wording or complete supported calculation is absent: %s', text => {
    expect(createComputationMemoryReceipt(text, binding)).toBeNull();
  });

  it('pins implicit-date/time calculations to the trusted run instant through later restores', () => {
    const text = 'Convert 10:00 London to Tokyo, then remember the result.';
    const receipt = createComputationMemoryReceipt(text, binding)!;
    expect(receipt.payload.text).toBe('10:00 London = 19:00 Tokyo (2026-11-21)');
    expect(restoreComputationMemoryReceipt(receipt, text, binding)).toEqual(receipt);
    expect(restoreComputationMemoryReceipt(receipt, text, { ...binding, evaluatedAt: binding.evaluatedAt + 86400000 })).toBeNull();
    const summer = createComputationMemoryReceipt(text, { ...binding, evaluatedAt: Date.UTC(2026, 6, 21, 7) })!;
    expect(summer.value).toBe('18:00'); expect(summer.operationKey).not.toBe(receipt.operationKey);
  });

  it.each(['ownerId', 'conversationId', 'runId'] as const)('rejects a receipt from another %s', key => {
    const receipt = createComputationMemoryReceipt(request, binding)!;
    expect(restoreComputationMemoryReceipt(receipt, request, { ...binding, [key]: 'different' })).toBeNull();
    expect(createComputationMemoryReceipt(request, { ...binding, [key]: 'different' })?.operationKey).not.toBe(receipt.operationKey);
  });

  it('rejects modified operands, whitespace, request tail, pinned time and every result field', () => {
    const receipt = createComputationMemoryReceipt(request, binding)!;
    for (const changedRequest of [request.replace('2 + 3', '8 + 3'), ` ${request}`, request.replace('save', 'store')])
      expect(restoreComputationMemoryReceipt(receipt, changedRequest, binding)).toBeNull();
    const mutations = [
      { ...receipt, version: 2 }, { ...receipt, engine: 'model' }, { ...receipt, answer: '6' }, { ...receipt, value: '6' },
      { ...receipt, primary: { ...receipt.primary, start: receipt.primary.start + 1 } },
      { ...receipt, evaluatedAt: receipt.evaluatedAt + 1 }, { ...receipt, evidenceHash: '0'.repeat(64) },
      { ...receipt, operationKey: '0'.repeat(64) }, { ...receipt, requestHash: '0'.repeat(64) },
      { ...receipt, payload: { text: '2 + 3 = 6', hash: sha('2 + 3 = 6'), bytes: 9 } },
      { ...receipt, note: 'A model claims success' },
    ];
    for (const mutation of mutations) expect(restoreComputationMemoryReceipt(mutation, request, binding)).toBeNull();
  });

  it('rejects malformed or oversized persisted data and invalid trusted bindings', () => {
    const receipt = createComputationMemoryReceipt(request, binding)!;
    for (const value of [null, [], {}, 'saved', { ...receipt, payload: { ...receipt.payload, text: 'x'.repeat(20001) } }])
      expect(restoreComputationMemoryReceipt(value, request, binding)).toBeNull();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(restoreComputationMemoryReceipt(circular, request, binding)).toBeNull();
    for (const evaluatedAt of [NaN, Infinity, -1, 1.5]) expect(createComputationMemoryReceipt(request, { ...binding, evaluatedAt })).toBeNull();
    expect(createComputationMemoryReceipt(request, { ...binding, ownerId: ' owner ' })).toBeNull();
    expect(createComputationMemoryReceipt(request + '\ud800', binding)).toBeNull();
  });

  it('declares both full-goal criteria before execution and keeps the same contract across later wall times', () => {
    const supervisor = createChatSupervisor(binding.runId, request, undefined, binding.evaluatedAt, binding);
    expect(supervisor.contract.criteria.map(item => [item.id, item.kind])).toEqual([
      ['computed-answer', 'answer_evidence'], ['computed-memory-save', 'effect'],
    ]);
    expect(reviewChatAnswer(supervisor, '2 + 3 = 5', binding.evaluatedAt).allowCompletion).toBe(false);
    const resumed = resumeChatSupervisor(binding.runId, request, supervisor, undefined, binding.evaluatedAt + 60_000, binding);
    expect(resumed.contract).toEqual(supervisor.contract); expect(resumed.startedAt).toBe(binding.evaluatedAt);
    const invalidBinding = createChatSupervisor('other-run', request, undefined, binding.evaluatedAt, binding);
    expect(invalidBinding.contract.criteria.some(item => item.kind === 'effect')).toBe(false);
  });
});
