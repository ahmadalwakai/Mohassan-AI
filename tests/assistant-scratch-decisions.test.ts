import { describe, expect, it, vi } from 'vitest';
import type { ScratchHead, ScratchPrediction } from '@mohassan/scratch-classifiers';
import { evaluateLocalConversation } from '../apps/server/src/assistant/local-conversation.js';
import { bootstrapRequestContext } from '../apps/server/src/assistant/request-context.js';
import { decideRequestRoute, type RequestRoutingInput } from '../apps/server/src/assistant/routing-decision.js';
import type { ScratchDecisionPolicy } from '../apps/server/src/assistant/scratch-decisions.js';

const capabilities = { search: true, browser: true };

function policy(labels: Partial<Record<ScratchHead, string>>, enabled = true): ScratchDecisionPolicy {
  const predict = (head: ScratchHead): ScratchPrediction => {
    const label = labels[head];
    return { label, abstained: label === undefined, topK: label === undefined ? [] : [{ label, score: 0.97 }] };
  };
  return {
    enabled,
    predictAll: vi.fn(() => ({ refusal: predict('refusal'), speechAct: predict('speechAct'), route: predict('route'), followUp: predict('followUp') })),
    report: vi.fn(),
  };
}

describe('scratch classifier request decisions', () => {
  it('observes all four predictions once in shadow and emits no request or history text', () => {
    const input: RequestRoutingInput = {
      text: 'What is happening around the world this morning?', capabilities, turnId: 'test-turn',
      context: bootstrapRequestContext([{ text: 'How tall is the building in Port Briar?' }]),
    };
    const shadow = policy({ refusal: 'refuse', route: 'news', speechAct: 'smalltalk', followUp: 'follow_up' }, false);
    const baseline = decideRequestRoute(input, null);
    expect(decideRequestRoute(input, shadow)).toEqual(baseline);
    expect(shadow.predictAll).toHaveBeenCalledOnce();
    expect(shadow.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'scratch_classifiers', turnId: 'test-turn', enabled: false,
      decisions: {
        refusal: expect.objectContaining({ rule: 'allow', selected: 'allow', model: expect.objectContaining({ label: 'refuse' }) }),
        route: expect.objectContaining({ rule: 'web_search', selected: 'web_search', model: expect.objectContaining({ label: 'news' }) }),
        speechAct: expect.objectContaining({ rule: 'request', selected: 'request' }),
        followUp: expect.objectContaining({ rule: baseline.resolution.kind, selected: baseline.resolution.kind }),
      },
    }));
    const trace = JSON.stringify(vi.mocked(shadow.report).mock.calls);
    expect(trace).not.toContain(input.text);
    expect(trace).not.toContain('Port Briar');
  });

  it('keeps the rule result when models abstain or prediction fails', () => {
    const input = { text: 'What is the largest moon of Saturn?', capabilities };
    const baseline = decideRequestRoute(input, null);
    expect(decideRequestRoute(input, policy({}))).toEqual(baseline);
    const failing = policy({});
    vi.mocked(failing.predictAll).mockImplementation(() => { throw new Error('model unavailable'); });
    expect(decideRequestRoute(input, failing)).toEqual(baseline);
    expect(failing.report).not.toHaveBeenCalled();
  });

  it('answers a learned social turn locally through the same reply function the worker calls', () => {
    const input = { text: 'How has your day been treating you?', capabilities };
    const active = policy({ speechAct: 'smalltalk' });
    const decision = decideRequestRoute(input, active);
    expect(decision).toMatchObject({ route: 'chat', handler: 'local_conversation', reason: 'scratch_speech_act', publicQuery: null });
    expect(evaluateLocalConversation(input.text, decision)).toMatchObject({ status: 'completed', text: 'Hello! How can I help?' });
  });

  it.each([['refuse', 'scratch_refuse'], ['out_of_scope', 'scratch_out_of_scope']] as const)('serves a learned %s as a blocked local reply even with an own chat model', (label, reason) => {
    const input = { text: 'Could you summon a parade of paper lanterns?', capabilities: { ...capabilities, chatModel: true } };
    const decision = decideRequestRoute(input, policy({ refusal: label }));
    expect(decision).toMatchObject({ route: 'unsupported', handler: 'unsupported', reason, publicQuery: null, localReply: { status: 'blocked' } });
    expect(evaluateLocalConversation(input.text, decision)).toEqual(decision.localReply);
  });

  it('can select the existing news step when the host only has a nominal fallback', () => {
    const input = { text: 'Central European shipping update', capabilities };
    const decision = decideRequestRoute(input, policy({ route: 'news' }));
    expect(decision).toMatchObject({ route: 'news', handler: 'search', reason: 'scratch_route', publicQuery: input.text,
      browserSteps: [{ kind: 'news', source: { name: 'BBC News' } }],
    });
  });

  it.each([
    'Who designed the Sydney Opera House?',
    'متى افتُتح متحف الفن الإسلامي في الدوحة؟',
    'Which is longer, the Seine or the Loire?',
    'Height of Mount Taranaki',
  ])('preserves the supported lookup for %s despite confident incompatible predictions', text => {
    const input = { text, capabilities };
    const baseline = decideRequestRoute(input, null);
    expect(baseline).toMatchObject({ route: 'web_search', handler: 'search', publicQuery: text });
    for (const labels of [{ refusal: 'refuse' }, { refusal: 'out_of_scope' }, { route: 'news' }, { speechAct: 'smalltalk' }]) {
      expect(decideRequestRoute(input, policy(labels))).toEqual(baseline);
    }
  });

  it('can refuse an unsupported action when its only rule match is the nominal search fallback', () => {
    const input = { text: 'Reroute the office phone', capabilities };
    expect(decideRequestRoute(input, null)).toMatchObject({ sourceAssessment: { reasons: ['nominal_public_subject'] }, route: 'web_search' });
    expect(decideRequestRoute(input, policy({ refusal: 'out_of_scope' }))).toMatchObject({
      route: 'unsupported', reason: 'scratch_out_of_scope', publicQuery: null,
    });
  });

  it('lets a learned continuation use the existing public topic and slot resolver', () => {
    const context = bootstrapRequestContext([{ text: 'What is the weather in London today?', id: 'first' }]);
    const input = { text: 'Brighton instead?', context, capabilities };
    expect(decideRequestRoute(input, null).resolution.kind).toBe('new');
    const decision = decideRequestRoute(input, policy({ followUp: 'follow_up' }));
    expect(decision.resolution).toMatchObject({ kind: 'follow_up', scope: 'public' });
    expect(decision.resolution.query).toContain('Brighton');
  });

  it('can start a new request after a discourse lead without inheriting the previous place', () => {
    const context = bootstrapRequestContext([{ text: 'What is the weather in London today?' }]);
    const input = { text: 'طيب لماذا السماء زرقاء؟', context, capabilities };
    expect(decideRequestRoute(input, null).resolution.kind).toBe('follow_up');
    const decision = decideRequestRoute(input, policy({ followUp: 'new' }));
    expect(decision.resolution.kind).toBe('new');
    expect(decision.resolution.query).toBe(input.text);
  });

  it('keeps private, explicit, pending and account-restricted decisions under the existing guards', () => {
    const active = policy({ refusal: 'refuse', speechAct: 'smalltalk', route: 'news', followUp: 'follow_up' });
    const privateContext = bootstrapRequestContext([{ text: 'What is my saved company name?' }]);
    const requests: RequestRoutingInput[] = [
      { text: 'What about its address?', context: privateContext, capabilities },
      { text: 'Search the web for the ferry timetable.', capabilities },
      { text: 'Open the settings window on my computer.', fullAccess: false, capabilities: { computer: true } },
      { text: 'GBP 30 per day', context: privateContext, pendingQuestion: { id: 'budget', fields: ['budget'] } },
      { text: 'Calculate 7 * 12.', capabilities },
    ];
    for (const request of requests) expect(decideRequestRoute(request, active)).toEqual(decideRequestRoute(request, null));
  });
});
