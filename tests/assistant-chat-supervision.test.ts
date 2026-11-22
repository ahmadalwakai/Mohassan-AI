import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { createChatSupervisor, observeChatLocalAnswer, observeChatTool, resumeChatSupervisor, reviewChatAnswer } from '../apps/server/src/assistant/chat-supervision.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';

const started = Date.parse('2026-11-21T05:00:00Z');
const page = (changes: Partial<AgentPage> = {}): AgentPage => ({
  id: 'actual-page', hash: 'a'.repeat(24), url: 'https://example.test/prices', title: 'Prices', text: 'Prices', documentStatus: 200,
  signals: { captcha: false, password: false, otp: false, card: false }, elements: [],
  scroll: { top: 0, height: 100, viewport: 100 }, observedAt: new Date(started + 100).toISOString(), ...changes,
});

describe('chat supervision adapters', () => {
  it('declares a direct navigation goal before seeing its result', () => {
    const state = createChatSupervisor('r1', 'open https://example.test/prices', undefined, started);
    expect(reviewChatAnswer(state, 'Done', started).status).toBe('unverified');
    observeChatTool(state, { tool: 'open', startedAt: started + 10, result: 'opened', page: page(), now: started + 200 });
    expect(reviewChatAnswer(state, 'Opened', started + 300).status).toBe('verified');
  });

  it.each([
    { url: 'https://example.test/login' },
    { documentStatus: 404 },
    { hash: 'unverified-fixture-hash' },
    { observedAt: new Date(started - 1).toISOString() },
  ])('does not certify navigation from unsuitable observations %j', changes => {
    const state = createChatSupervisor('r1', 'open https://example.test/prices', undefined, started);
    observeChatTool(state, { tool: 'open', startedAt: started + 10, result: 'opened', page: page(changes), now: started + 200 });
    expect(reviewChatAnswer(state, 'Done', started + 300).status).not.toBe('verified');
  });

  it('keeps screenshot capture unverified when the API supplies bytes without an observation receipt', () => {
    const state = createChatSupervisor('r1', 'افتح https://example.test/prices واعرض لقطة الصفحة', undefined, started);
    observeChatTool(state, { tool: 'open', startedAt: started + 10, result: 'opened', page: page(), screenshot: Buffer.from('image'), now: started + 200 });
    const review = reviewChatAnswer(state, 'Done', started + 300);
    expect(review.status).toBe('partial');
    expect(review.missingCriteria).toContain('screenshot');
  });

  it('binds a computed answer to its actual source text and final answer', () => {
    const request = 'Calculate 12.5 percent of 480.';
    const state = createChatSupervisor('r1', request, undefined, started);
    const computed = evaluateLocalComputation(request, new Date(started))!;
    observeChatLocalAnswer(state, { source: 'computation', ...computed, startedAt: started + 10, now: started + 200 });
    expect(reviewChatAnswer(state, computed.text, started + 300).status).toBe('verified');
    expect(reviewChatAnswer(state, 'The answer is 600', started + 300).status).toBe('unverified');
  });

  it('refuses a local-looking answer that does not preserve the computed source', () => {
    const request = 'Calculate 12.5 percent of 480.';
    const state = createChatSupervisor('r1', request, undefined, started);
    const computed = evaluateLocalComputation(request, new Date(started))!;
    const forged = 'The answer is 600';
    observeChatLocalAnswer(state, { source: 'computation', ...computed, text: forged,
      claims: computed.claims.map(claim => ({ ...claim, text: forged })), startedAt: started + 10, now: started + 200 });
    expect(reviewChatAnswer(state, forged, started + 300).status).toBe('unverified');
  });

  it('checks quoted memory and scalar answers against their retrieved statements', async () => {
    for (const request of ['What is my bay code from memory?', 'From my memory, return the bay code only.']) {
      const state = createChatSupervisor('r1', request, undefined, started);
      const remembered = (await evaluateLocalRecall(request, { memory: async () => ['The bay code is RX-85.'] }, new AbortController().signal))!;
      observeChatLocalAnswer(state, { source: 'memory-read', ...remembered, startedAt: started + 10, now: started + 200 });
      expect(reviewChatAnswer(state, remembered.text, started + 300).status).toBe('verified');
    }
  });

  it('retains progress only for new host-observed content', () => {
    const state = createChatSupervisor('r1', 'Inspect my workspace', undefined, started);
    for (let i = 0; i < 4; i++) observeChatTool(state, { tool: 'workspace_list', startedAt: started + i * 100,
      result: 'the same projects', now: started + i * 100 + 50 });
    expect(state.stagnantSteps).toBe(3);
    expect(reviewChatAnswer(state, 'Here is the list', started + 500).status).toBe('unscoped');
  });

  it('does not confuse a supported company name with the requested company address', () => {
    const request = 'What is my company address in memory?';
    const state = createChatSupervisor('r1', request, undefined, started);
    const quote = 'The company name is Lantern Logistics';
    const text = `From memory: «${quote}»`;
    observeChatLocalAnswer(state, { source: 'memory-read', text, status: 'completed',
      claims: [{ text, support: ['m1'], status: 'single_source' }],
      evidence: [{ id: 'm1', source: 'memory', quote }], startedAt: started + 10, now: started + 200 });
    expect(reviewChatAnswer(state, text, started + 300)).toMatchObject({ status: 'unverified', allowCompletion: false });
  });

  it('restores a valid ledger and rejects one for another objective', () => {
    const state = createChatSupervisor('r1', 'open https://example.test/prices', undefined, started);
    observeChatTool(state, { tool: 'open', startedAt: started + 10, result: 'opened', page: page(), now: started + 200 });
    expect(resumeChatSupervisor('r1', state.contract.objective, JSON.parse(JSON.stringify(state)), undefined, started + 300).steps).toHaveLength(1);
    const changed = resumeChatSupervisor('r1', 'open https://example.test/contact', state, undefined, started + 300);
    expect(changed.steps).toHaveLength(0);
    expect(reviewChatAnswer(changed, 'Done', started + 400).status).toBe('unverified');
  });
});
