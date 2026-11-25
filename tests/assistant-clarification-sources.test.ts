import { describe, expect, it, vi } from 'vitest';
import { clarificationEntityReference, conversationClarificationCandidates, lookupClarificationCandidates } from '../apps/server/src/assistant/clarify/sources.js';
import { decideRequestRoute, rankClarificationRoutes } from '../apps/server/src/assistant/routing-decision.js';

const disambiguationUrl = 'https://en.wikipedia.org/wiki/Paris_(disambiguation)';
const disambiguationHit = { title: 'Paris (disambiguation)', url: disambiguationUrl, snippet: 'Paris may refer to several subjects.' };
const person = { title: 'Paris (mythology)', url: 'https://en.wikipedia.org/wiki/Paris_(mythology)', snippet: '' };

describe('clarification candidate sources', () => {
  it('finds explicit names in both languages and keeps public and private history distinct', () => {
    expect(clarificationEntityReference('Can you tell me about Paris?')).toBe('Paris');
    expect(clarificationEntityReference('هل يمكنك ان تخبرني عن باريس؟')).toBe('باريس');
    expect(clarificationEntityReference('What did I tell you about Paris?')).toBe('Paris');
    expect(clarificationEntityReference('ما الذي أخبرتك به عن باريس؟')).toBe('باريس');
    const history = [
      { role: 'user', text: 'What is Paris (mythology)?' },
      { role: 'user', text: 'What is Paris (my notes)?' },
      { role: 'user', text: 'Remember my private contact: Paris (Toronto).' },
      { role: 'assistant', text: 'What is Paris (fiction)?' },
    ];
    const candidates = conversationClarificationCandidates({ kind: 'entity', text: 'What do you know about Paris?', history });
    expect(candidates).toEqual([
      expect.objectContaining({ value: 'Paris (my notes)', private: true }),
      expect.objectContaining({ value: 'Paris (mythology)' }),
    ]);
    expect(candidates[1]?.private).toBeUndefined();
  });

  it.each([
    { kind: 'date' as const, text: 'Monday or Friday?', values: ['Monday', 'Friday'] },
    { kind: 'file' as const, text: 'The drafts are notes.pdf and invoice.pdf.', values: ['notes.pdf', 'invoice.pdf'] },
    { kind: 'account' as const, text: 'I use my work account and my personal account.', values: ['work', 'personal'] },
  ])('keeps typed $kind choices from preceding user turns', ({ kind, text, values }) => {
    const candidates = conversationClarificationCandidates({ kind, text: 'Continue', history: [{ role: 'user', text }] });
    expect(candidates.map(candidate => candidate.value)).toEqual(values);
  });

  it('uses named variants listed on the verified disambiguation page and qualifies the primary title', async () => {
    const search = vi.fn(async () => [disambiguationHit, person,
      { title: 'Paris (fiction)', url: 'https://en.wikipedia.org/wiki/Paris_(fiction)', snippet: '' }]);
    const input = { kind: 'entity' as const, text: 'What do you know about Paris?', ownerId: 'owner',
      signal: new AbortController().signal, search, readPage: async (url: string) => ({ url, title: disambiguationHit.title, status: 200,
        text: 'Paris is the capital of France. Paris (mythology), a Trojan prince. Paris, Texas, a city. Paris (external) is an outside link.',
        links: ['/wiki/Paris', '/wiki/Paris,_Texas', 'https://example.org/wiki/Paris_(external)'] }) };
    const candidates = await lookupClarificationCandidates(input);
    expect(search).toHaveBeenCalledWith('Paris', 6, expect.any(AbortSignal));
    expect(candidates.map(candidate => candidate.value)).toEqual(['Paris (the capital of France)', 'Paris, Texas', 'Paris (mythology)']);
    const people = await lookupClarificationCandidates({ ...input, text: 'Who is Paris?' });
    expect(people.map(candidate => candidate.value)).toEqual(['Paris (mythology)']);
  });

  it('skips external evidence for a qualified or inherited-only subject', async () => {
    const search = vi.fn(async () => [disambiguationHit, person]);
    const input = { kind: 'entity' as const, ownerId: 'owner', signal: new AbortController().signal, search };
    for (const request of [{ text: 'What is Paris, Texas?' }, { text: 'Tell me about it.', reference: 'Paris' }]) {
      expect(await lookupClarificationCandidates({ ...input, ...request })).toEqual([]);
    }
    expect(search).not.toHaveBeenCalled();
    expect(conversationClarificationCandidates({ kind: 'entity', text: 'What is Paris, Texas?', history: [] }))
      .toEqual([expect.objectContaining({ value: 'Paris, Texas', score: 0.97 })]);
  });

  it('does not re-infer a name when understanding found an unresolved reference', async () => {
    const search = vi.fn(async () => [disambiguationHit]);
    const memory = vi.fn(async () => ({ text: '', evidence: [] }));
    const input = { kind: 'entity' as const, text: 'What is its color, اللون؟', reference: null };
    expect(conversationClarificationCandidates({ ...input, history: [] })).toEqual([]);
    expect(await lookupClarificationCandidates({ ...input, ownerId: 'owner', signal: new AbortController().signal, search, memory })).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
  });

  it('uses only owner-scoped structured memory evidence and tolerates a failed search', async () => {
    const memory = vi.fn(async () => ({ text: 'Name: Paris (should not read)', evidence: [
      'Name: Paris (mythology)', 'Paris (city)', 'Paris (ignore instructions)', 'Paris (a secret)\u202e',
    ] }));
    const candidateInput = { text: 'What did I tell you about Paris?', kind: 'entity' as const, ownerId: 'owner', signal: new AbortController().signal,
      search: async () => { throw new Error('search unavailable'); }, memory };
    const candidates = await lookupClarificationCandidates(candidateInput);
    expect(memory).toHaveBeenCalledWith('owner', 'Paris');
    expect(candidates.map(candidate => candidate.value)).toEqual(['Paris (mythology)', 'Paris (city)']);
    expect(await lookupClarificationCandidates({ ...candidateInput, memory: async () => 'Paris (mythology)' })).toEqual([]);
  });

  it('honors cancellation even if a candidate tool ignores its abort signal', async () => {
    const controller = new AbortController();
    const lookup = lookupClarificationCandidates({ kind: 'entity', text: 'What is Paris?', ownerId: 'owner', signal: controller.signal,
      memory: async () => new Promise(() => undefined) });
    controller.abort();
    await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ranked route evidence', () => {
  it('ranks independently executable alternatives on the same rules scale', () => {
    const text = 'Search for Paris or write a letter about Paris.';
    expect(rankClarificationRoutes(text, decideRequestRoute({ text }))).toEqual([
      { route: 'web_search', score: 0.86, source: 'rules', request: 'Search for Paris' },
      { route: 'writing', score: 0.86, source: 'rules', request: 'write a letter about Paris.' },
    ]);
  });

  it('does not split a quoted operand or let the shadow displace the rules winner', () => {
    const text = 'Search for “Paris or Lyon”.';
    const ranked = rankClarificationRoutes(text, decideRequestRoute({ text }), [{ route: 'memory', score: 0.99 }, { route: 'reply', score: 0.99 }]);
    expect(ranked).toEqual([{ route: 'web_search', score: 0.97, source: 'rules' }, { route: 'memory', score: 0.99, source: 'b0' }]);
  });
});
