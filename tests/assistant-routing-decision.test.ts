import { describe, expect, it, vi } from 'vitest';
import { decideRequestRoute, type RequestRoutingInput } from '../apps/server/src/assistant/routing-decision.js';
import { bootstrapRequestContext, resolveRequestContext } from '../apps/server/src/assistant/request-context.js';

const now = new Date('2026-11-21T09:00:00Z');
const route = (text: string, input: Omit<RequestRoutingInput, 'text'> = {}) => decideRequestRoute({ text, now, ...input });

describe('read-only routing decision contract', () => {
  it('uses local arithmetic and fixed identity independently of model or search availability', () => {
    expect(route('Calculate (3 + 7) * 4.')).toMatchObject({ route: 'compute', handler: 'local_computation', availability: 'ready', missingCapabilities: [], localReply: { status: 'completed', text: expect.stringContaining('40') } });
    expect(route('من صنعك؟')).toMatchObject({ route: 'chat', handler: 'local_conversation', availability: 'ready', publicQuery: null });
  });

  it('keeps live exchange-rate requests out of the local calculator', () => {
    const decision = route('What is 27 USD in GBP?', { capabilities: { search: true, browser: true } });
    expect(decision).toMatchObject({ route: 'web_search', handler: 'search', availability: 'ready', resolution: { intent: 'web_search', scope: 'public', nextState: { intent: 'web_search' } } });
    expect(decision.localReply).toBeUndefined();
    expect(decision.publicQuery).toContain('27 USD');
  });

  it('does not confuse collecting news with arithmetic addition', () => {
    const decision = route('اجمع ثلاثة أخبار اقتصادية حديثة واذكر تاريخ كل خبر', { capabilities: { search: true, browser: true } });
    expect(decision).toMatchObject({ route: 'news', handler: 'search', availability: 'ready' });
    expect(decision.localReply).toBeUndefined();
  });

  it('returns explicit capability gaps without turning memory or computer requests into public search', () => {
    const memory = route('What is my saved company name?');
    expect(memory).toMatchObject({ route: 'memory', handler: 'memory', availability: 'missing_capability', missingCapabilities: ['memory'], publicQuery: null });
    const pc = route('Read the title of the window on my computer.');
    expect(pc).toMatchObject({ route: 'pc', availability: 'missing_capability', missingCapabilities: ['computer'], publicQuery: null });
    expect(route('Remind me to call the supplier tomorrow.')).toMatchObject({ route: 'reminder', availability: 'missing_capability', missingCapabilities: ['reminders'], publicQuery: null });
  });

  it('retains a private destination across a follow-up and returns no public projection', () => {
    const context = bootstrapRequestContext([{ text: 'What is my saved company name?', id: 'first' }]);
    const decision = route('What about its address?', { context, capabilities: { memory: true, browser: true, search: true } });
    expect(decision).toMatchObject({ route: 'memory', handler: 'memory', availability: 'ready', reason: 'context_destination', publicQuery: null, resolution: { scope: 'private', intent: 'memory' } });
  });

  it('routes a host-owned pending answer to resume without granting action permission', () => {
    const context = bootstrapRequestContext([{ text: 'Prepare a campaign for a bicycle repair shop in York.' }]);
    const decision = route('GBP 30 per day', { context, pendingQuestion: { id: 'budget-question', route: 'ads', fields: ['budget'] } });
    expect(decision).toMatchObject({ route: 'reply', intent: 'ads', handler: 'resume', availability: 'ready', publicQuery: null });
    expect(decision).not.toHaveProperty('permission');
    expect(decision).not.toHaveProperty('approval');
  });

  it('does not resume a previous question for a self-contained new command', () => {
    const context = bootstrapRequestContext([{ text: 'Draft an apology letter.' }]);
    expect(route('Calculate 8 * 9.', { context, pendingQuestion: { id: 'tone-question', route: 'writing' } })).toMatchObject({ route: 'compute', handler: 'local_computation' });
  });

  it('proposes deterministic browser steps without executing them', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NO_NETWORK'); });
    try {
      const decision = route('افتح يوتيوب وابحث عن زراعة الريحان', { capabilities: { browser: true } });
      expect(decision).toMatchObject({ route: 'browser_command', handler: 'browser', availability: 'ready', publicQuery: null });
      expect(decision.browserSteps?.length).toBeGreaterThan(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('uses the same greeting-stripped action text as the real controller', () => {
    const decision = route('Hello, open https://fern.example', { capabilities: { browser: true, chatModel: false } });
    expect(decision).toMatchObject({ route: 'browser_command', handler: 'browser', availability: 'ready', publicQuery: null,
      browserSteps: [{ kind: 'open', url: 'https://fern.example' }] });
  });

  it('does not treat discourse filler before an explicit new action as an unresolved reference', () => {
    const original = 'طيب افتح https://maple.example';
    const decision = route(original, { capabilities: { browser: true, chatModel: false } });
    expect(decision).toMatchObject({ route: 'browser_command', handler: 'browser', availability: 'ready',
      resolution: { original, resolved: original }, sourceAssessment: { source: 'public_lookup', operation: 'act' } });
    expect(decision.browserSteps).toMatchObject([{ kind: 'open', url: 'https://maple.example' }]);
  });

  it('does not let a greeting or identity request swallow a following action', () => {
    for (const text of ['Hello, open https://fern.example', 'من أنت؟ ثم افتح https://fern.example', 'Thanks, calculate 2 + 3 and send the answer to my neighbour.']) {
      const decision = route(text, { capabilities: { browser: true, chatModel: true } });
      expect(decision.handler).not.toBe('local_conversation');
      expect(decision.handler).not.toBe('local_computation');
      expect(decision.localReply).toBeUndefined();
    }
  });

  it('separates a template letter from a request needing a writer model', () => {
    expect(route('Write an apology letter to a customer.')).toMatchObject({ route: 'writing', handler: 'writing', availability: 'ready' });
    expect(route('Translate into Arabic: The meeting starts at noon.')).toMatchObject({ route: 'writing', availability: 'missing_capability', missingCapabilities: ['writerModel'] });
    expect(route('Translate into Arabic: The meeting starts at noon.', { capabilities: { chatModel: true } })).toMatchObject({ route: 'writing', handler: 'model', availability: 'ready', reason: 'local_model_fallback' });
  });

  it('keeps owner-only routes restricted even when a host advertises the tool', () => {
    expect(route('Open the settings window on my computer.', { fullAccess: false, capabilities: { computer: true, chatModel: true } })).toMatchObject({ route: 'pc', availability: 'restricted', reason: 'account_restriction' });
    expect(route('Debug the code in my repository.', { fullAccess: false, capabilities: { coding: true } })).toMatchObject({ route: 'coding', availability: 'restricted' });
    expect(route('Prepare ads for my flower shop.', { fullAccess: false, capabilities: { adsModel: true } })).toMatchObject({ route: 'ads', availability: 'restricted' });
  });

  it('does not convert an unavailable special capability into a web fallback', () => {
    const decision = route('Draft a search campaign for my bakery.', { capabilities: { browser: true, search: true } });
    expect(decision).toMatchObject({ route: 'ads', availability: 'missing_capability', missingCapabilities: ['adsModel'], publicQuery: null });
  });

  it('asks for missing references and malformed input without guessing a target', () => {
    expect(route('What about it?')).toMatchObject({ route: 'clarify', availability: 'needs_context', publicQuery: null });
    expect(route('افتحه الآن')).toMatchObject({ route: 'clarify', availability: 'needs_context', publicQuery: null });
    expect(route('Calculate')).toMatchObject({ route: 'clarify', availability: 'needs_context' });
    expect(route('x'.repeat(8001))).toMatchObject({ route: 'clarify', availability: 'needs_context', reason: 'invalid_request' });
    expect(route('Yes', { pendingQuestion: { id: '' } })).toMatchObject({ route: 'clarify', reason: 'invalid_request' });
  });

  it('does not mutate host-persisted context and reconciles a specialist destination', () => {
    const context = resolveRequestContext('How tall is the library building?', undefined, { turnId: 'first' }).nextState;
    const original = structuredClone(context);
    const decision = route('Calculate 6 * 7.', { context });
    expect(context).toEqual(original);
    expect(decision.resolution).toMatchObject({ intent: 'compute', scope: 'private', query: null, nextState: { intent: 'compute', scope: 'private' } });
  });

  it('requires all declared public lookup capabilities and never fabricates completion', () => {
    const missing = route('What are the opening hours of Bristol Central Library?', { capabilities: { search: true } });
    expect(missing).toMatchObject({ route: 'web_search', availability: 'missing_capability', missingCapabilities: ['browser'] });
    expect(missing).not.toHaveProperty('completed');
    expect(route('What are the opening hours of Bristol Central Library?', { capabilities: { search: true, browser: true } })).toMatchObject({ route: 'web_search', availability: 'ready', handler: 'search' });
  });

  it.each([
    'Which booking reference did I give you last Friday?',
    'ما اسم العميل الذي أخبرتُك به سابقًا؟',
    'Read the warning visible in the shared inventory application window.',
    'Rewrite this note: The supplier needs a new delivery address.',
  ])('keeps private, local and supplied sources out of the public projection: %s', text => {
    const decision = route(text, { capabilities: { browser: true, search: true } });
    expect(decision.publicQuery).toBeNull();
    expect(decision.sourceAssessment.scope).toBe('private');
    expect(decision.route).not.toBe('web_search');
  });

  it('keeps an unsupported numeric task on compute instead of using web fallback', () => {
    const decision = route('Find the area of a rectangle 11 metres long and 6 metres wide.', { capabilities: { browser: true, search: true } });
    expect(decision).toMatchObject({ route: 'compute', handler: 'model', availability: 'missing_capability', missingCapabilities: ['chatModel'], publicQuery: null, sourceAssessment: { operation: 'compute' } });
  });

  it('starts a new public task after a private one without including the earlier private subject', () => {
    const context = bootstrapRequestContext([{ text: 'What is my saved supplier reference for Luma Grove?' }]);
    const text = 'Search the public web for ferry times in Dover.';
    const decision = route(text, { context, capabilities: { search: true, browser: true } });
    expect(decision).toMatchObject({ route: 'web_search', publicQuery: text, sourceAssessment: { source: 'public_lookup' } });
    expect(decision.publicQuery).not.toContain('Luma');
    expect(decision.publicQuery).not.toContain('supplier');
  });

  it('allows a quoted public title while keeping quoted transformation content private', () => {
    const publicTitle = route('Search for the book titled "My Saved Notes".', { capabilities: { browser: true, search: true } });
    expect(publicTitle).toMatchObject({ route: 'web_search', availability: 'ready', sourceAssessment: { source: 'public_lookup' } });
    expect(publicTitle.publicQuery).toContain('My Saved Notes');
    const supplied = route('Rewrite "My saved notes contain our meeting time" more clearly.', { capabilities: { browser: true, search: true } });
    expect(supplied).toMatchObject({ route: 'writing', publicQuery: null, sourceAssessment: { source: 'supplied_content' } });
  });

  it('reconciles exact local conversions to a carryable non-public computation state', () => {
    const original = 'Convert 2.75 kilometres to metres. Only the result.';
    const decision = route(original, { turnId: 'conversion-turn' });
    expect(decision).toMatchObject({ route: 'compute', handler: 'local_computation', publicQuery: null,
      sourceAssessment: { source: 'supplied_content', operation: 'compute', publicQueryEligible: false },
      resolution: { original, resolved: original, kind: 'new', intent: 'compute', scope: 'private', query: null, ambiguities: [],
        nextState: { intent: 'compute', scope: 'private', topicSourceTurnId: 'conversion-turn', sourceAssessment: { operation: 'compute', publicQueryEligible: false } } } });
    expect(decision.localReply?.text).toContain('2750');
  });

  it('keeps a prior task context when an intrinsic acknowledgement is answered locally', () => {
    const context = bootstrapRequestContext([{ text: 'What is my saved supplier address?' }]);
    const decision = route('Thank you.', { context });
    expect(decision).toMatchObject({ route: 'chat', handler: 'local_conversation', publicQuery: null,
      sourceAssessment: { publicQueryEligible: false }, resolution: { nextState: { intent: 'memory', scope: 'private' } } });
  });
  it('continues the full compound objective with a model instead of terminally consuming a calculated fragment', () => {
    const original = 'How many days between 2024-02-28 and 2024-03-01? Then save the result.';
    const modeled = route(original, { capabilities: { chatModel: true, memory: true } });
    expect(modeled).toMatchObject({ route: 'compute', handler: 'model', availability: 'ready', reason: 'local_model_fallback', publicQuery: null,
      resolution: { original, resolved: original, kind: 'new', scope: 'private' } });
    expect(modeled.localReply).toBeUndefined();
    expect(route(original).localReply?.status).toBe('partial');
  });

  it('uses local model fallback for a self-contained request without a public projection', () => {
    const decision = route('Describe a queue data structure.', { capabilities: { chatModel: true } });
    expect(decision).toMatchObject({ handler: 'model', reason: 'local_model_fallback', availability: 'ready', publicQuery: null });
    expect(route('Summarise the file I mean.', { capabilities: { chatModel: true } })).toMatchObject({ route: 'clarify', availability: 'needs_context', publicQuery: null });
  });
});
