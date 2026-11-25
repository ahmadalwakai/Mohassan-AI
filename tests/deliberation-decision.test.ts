import { describe, expect, it, vi } from 'vitest';
import { ThoughtRecordSchema } from '@mohassan/contracts';
import { collectCandidates } from '../apps/server/src/assistant/deliberation/candidates.js';
import { confidenceForMargin, deliberate, leastCostAction, sameDecision } from '../apps/server/src/assistant/deliberation/decision.js';
import { conversationEvidence } from '../apps/server/src/assistant/deliberation/conversation-evidence.js';
import { createMemoryHitReader } from '../apps/server/src/assistant/deliberation/memory-evidence.js';
import { requestsUnsupportedServiceAction } from '../apps/server/src/assistant/deliberation/public-evidence.js';
import { topRouterCandidates } from '../apps/server/src/assistant/deliberation/router-evidence.js';
import type { DeliberationInput } from '../apps/server/src/assistant/deliberation/types.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import corpus from './fixtures/deliberation/clinc150.json';

const developmentText = (intent: string) => corpus.development.find(row => row.intent === intent)!.text;
const now = new Date('2026-11-25T12:00:00Z');

describe('deliberation policy', () => {
  it('makes different decisions at the same confidence according to action cost', () => {
    expect(leastCostAction('conversation', 0.9)).toBe('act');
    expect(leastCostAction('ads', 0.9)).toBe('ask');
    expect(leastCostAction('ads', 0.2)).toBe('abstain');
    expect(leastCostAction('ads', 0.99)).toBe('act');
  });

  it('keeps interpretations separate and uses routing evidence to beat an earlier predicate', () => {
    const text = developmentText('exchange_rate');
    const routed = decideRequestRoute({ text, now, capabilities: { browser: true, search: true } });
    const input: DeliberationInput = {
      text,
      routing: { ...routed, route: 'web_search', availability: 'ready' },
      predicates: [
        { route: 'browser_command', handler: 'browser_direct', matched: true },
        { route: 'web_search', handler: 'web_search', matched: true },
        { route: 'skill', handler: 'skill', matched: false },
      ],
      legacy: { action: 'act', route: 'browser_command', handler: 'browser_direct' },
    };
    const result = deliberate(input);
    expect(result.candidates.map(candidate => candidate.route)).toEqual(['web_search', 'browser_command']);
    expect(result.readings.map(reading => reading.route)).toEqual(['web_search', 'browser_command']);
    expect(result.readings.every(reading => reading.spans[0]?.end === text.length)).toBe(true);
    expect(result.outcome).toEqual({ action: 'act', route: 'web_search', handler: 'web_search' });
    expect(result.trace.disagrees).toBe(true);
    expect(ThoughtRecordSchema.safeParse(result.trace).success).toBe(true);
    expect(JSON.stringify(result.trace)).not.toContain(text);
  });

  it('uses memory, card and B0 evidence without making unsupported routes executable', () => {
    const text = developmentText('greeting');
    const routing = decideRequestRoute({ text, now });
    const inputs: DeliberationInput = {
      text, routing, followUp: true, pendingCard: true, memoryHit: true,
      b0: [{ route: 'ads', score: 0.9 }, { route: 'memory', score: 0.1 }],
      predicates: [
        { route: 'memory', handler: 'memory_recall', matched: true },
        { route: 'resume', handler: 'pending_action', matched: true },
      ],
    };
    const result = deliberate(inputs);
    expect(result.outcome).toMatchObject({ action: 'act', route: 'resume' });
    expect(result.candidates.find(candidate => candidate.route === 'memory')?.evidence).toContain('memory_hit');
    expect(result.candidates.find(candidate => candidate.route === 'ads')).toMatchObject({ eligible: false, evidence: ['router_top'] });
    expect(collectCandidates(inputs)).toEqual(result.candidates);
  });

  it('ranks B0 probabilities and temperature-scales confidence without altering runtime decisions', () => {
    expect(topRouterCandidates(['ads', 'chat', 'memory'], [0, 3, 1]).map(candidate => candidate.route)).toEqual(['chat', 'memory', 'ads']);
    expect(topRouterCandidates(['ads'], [Number.POSITIVE_INFINITY])).toEqual([]);
    expect(confidenceForMargin(3, 2)).toBeLessThan(confidenceForMargin(3, 1));
    const text = developmentText('greeting');
    const routing = decideRequestRoute({ text, now });
    const input: DeliberationInput = { text, routing, predicates: [{ route: 'chat', handler: 'local_conversation', matched: true }] };
    const first = deliberate({ ...input, temperature: 1 });
    const second = deliberate({ ...input, temperature: 2 });
    expect(sameDecision(first.outcome, second.outcome)).toBe(true);
    expect(first.confidence).toBeGreaterThan(second.confidence);
  });

  it('asks for a weather location when v2 finds a weather question with no entity', () => {
    const observed = corpus.development.filter(row => row.intent === 'weather' && row.expected.kind === 'ask')
      .map(row => ({ row, evidence: conversationEvidence(row.text, row.id) })).find(({ evidence }) => evidence.missingLocation)!;
    const { row, evidence } = observed;
    const routing = decideRequestRoute({ text: row.text, now, capabilities: { browser: true, search: true } });
    const result = deliberate({ text: row.text, routing, ...evidence,
      predicates: [{ route: 'web_search', handler: 'web_search', matched: true }] });
    expect(result.outcome).toEqual({ action: 'ask' });
    expect(result.trace.reasons).toContain('missing_context');
  });

  it('eliminates the public-search fallback for a personal service command', () => {
    const row = corpus.development.find(example => example.intent === 'next_song' && requestsUnsupportedServiceAction(example.text))!;
    const routing = decideRequestRoute({ text: row.text, now, capabilities: { browser: true, search: true } });
    const result = deliberate({ text: row.text, routing,
      predicates: [{ route: 'web_search', handler: 'web_search', matched: true }] });
    expect(result.outcome).toEqual({ action: 'abstain' });
    expect(result.candidates.find(candidate => candidate.handler === 'web_search'))
      .toMatchObject({ eligible: false, evidence: expect.arrayContaining(['unsupported_operation']) });
  });

  it('reads only one owner-scoped memory hit and returns presence only', async () => {
    const search = vi.fn().mockResolvedValue({ items: [Symbol()] });
    const read = createMemoryHitReader({ search });
    const query = developmentText('greeting').repeat(100);
    await expect(read('owner-id', query)).resolves.toBe(true);
    expect(search).toHaveBeenCalledWith('owner-id', { query: query.slice(0, 500), limit: 1 }, { readOnly: true });
  });
});
