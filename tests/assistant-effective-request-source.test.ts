import { describe, expect, it, vi } from 'vitest';
import { createClarifiedRequestSource, resolveEffectiveRequestSource, type EffectiveRequestSourceInput } from '../apps/server/src/assistant/effective-request-source.js';

const request = 'Convert 12:00 Europe/London to UTC, then remember the result in my memory.';
const input: EffectiveRequestSourceInput = { ownerId: 'source-owner', conversationId: 'source-conversation', createdAt: 1000,
  goal: 'What about it?', now: 4000, state: { clarifiedRequest: request, clarifiedRequestSource: createClarifiedRequestSource(request, 'source-message') } };
const message = { id: 'source-message', ownerId: input.ownerId, conversationId: input.conversationId, role: 'user', text: request, createdAt: 3000 };

describe('trusted effective user-request timestamp', () => {
  it('uses the exact host user message time and returns no metadata-derived clock', async () => {
    const load = vi.fn(async () => message), source = await resolveEffectiveRequestSource(input, load);
    expect(source).toEqual({ request, evaluatedAt: 3000, source: 'clarification_message' });
    expect(load).toHaveBeenCalledExactlyOnceWith({ ownerId: input.ownerId, conversationId: input.conversationId, messageId: message.id });
    expect(input.state).toEqual({ clarifiedRequest: request, clarifiedRequestSource: createClarifiedRequestSource(request, message.id) });
  });
  it.each([{}, { clarifiedRequest: request }])('retains legacy created-time binding without a message read: %j', async state => {
    const load = vi.fn(async () => { throw new Error('Legacy source must not load a message.'); });
    expect(await resolveEffectiveRequestSource({ ...input, state }, load)).toEqual({ request: 'clarifiedRequest' in state ? request : input.goal,
      evaluatedAt: input.createdAt, source: 'run_created' });
    expect(load).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, { version: 1, messageId: message.id, requestHash: '0'.repeat(64) },
    { ...createClarifiedRequestSource(request, message.id), createdAt: 3000 }])('rejects malformed/new source metadata without legacy fallback: %j', async pointer => {
    const load = vi.fn(async () => message);
    expect(await resolveEffectiveRequestSource({ ...input, state: { clarifiedRequest: request, clarifiedRequestSource: pointer } }, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...message, id: 'other-message' }, { ...message, ownerId: 'other-owner' }, { ...message, conversationId: 'other-conversation' },
    { ...message, role: 'assistant' }, { ...message, text: `${request} Extra instruction.` }, { ...message, createdAt: 999 },
    { ...message, createdAt: 4001 }, { ...message, createdAt: NaN }, { ...message, createdAt: '3000' },
  ])('rejects deleted, foreign, tampered or out-of-time messages: %j', async value => {
    expect(await resolveEffectiveRequestSource(input, async () => value)).toBeNull();
  });
  it('does not recover a new pointer when no clarified primary exists', async () => {
    const load = vi.fn(async () => message);
    expect(await resolveEffectiveRequestSource({ ...input, state: { clarifiedRequestSource: createClarifiedRequestSource(request, message.id) } }, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it('requires sane host input and rejects a loader failure', async () => {
    expect(await resolveEffectiveRequestSource(input, async () => { throw new Error('Deleted/unavailable message'); })).toBeNull();
    for (const change of [{ createdAt: 4001 }, { now: 999 }, { goal: 'x'.repeat(4001) }, { state: null }])
      expect(await resolveEffectiveRequestSource({ ...input, ...change }, async () => message)).toBeNull();
  });
  it('does not execute accessors in deserialized-source state', async () => {
    let reads = 0;
    const state = { clarifiedRequest: request };
    Object.defineProperty(state, 'clarifiedRequestSource', { enumerable: true, get() { reads++; throw new Error('No accessor reads.'); } });
    expect(await resolveEffectiveRequestSource({ ...input, state }, async () => message)).toBeNull(); expect(reads).toBe(0);
  });
  it('does not execute accessors in pointers or loader projections', async () => {
    let reads = 0;
    const pointer = { ...createClarifiedRequestSource(request, message.id) };
    Object.defineProperty(pointer, 'messageId', { enumerable: true, get() { reads++; throw new Error('No pointer accessor.'); } });
    expect(await resolveEffectiveRequestSource({ ...input, state: { clarifiedRequest: request, clarifiedRequestSource: pointer } }, async () => message)).toBeNull();
    const projected = { ...message };
    Object.defineProperty(projected, 'createdAt', { enumerable: true, get() { reads++; throw new Error('No message accessor.'); } });
    expect(await resolveEffectiveRequestSource(input, async () => projected)).toBeNull(); expect(reads).toBe(0);
  });
});
