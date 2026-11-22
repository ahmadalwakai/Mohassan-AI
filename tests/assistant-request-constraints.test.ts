import { describe, expect, it } from 'vitest';
import { parseUserRequestConstraints, requestCapabilityAllowed, requestConstraintReply, isEntireLiteralRequest, assessRequestScope, reviewPublicProjection, type ForbiddenRequestCapability } from '../apps/server/src/assistant/request-scope.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const capabilities = { browser: true, search: true, memory: true, chatModel: true, writerModel: true, computer: true };

describe('explicit outer-user operation constraints', () => {
  it.each([
    ['لا تبحث عن طقس لندن', 'public_search'], ["Don't search for London weather", 'public_search'],
    ['لا تفتح يوتيوب', 'browser_navigation'], ['Never open the website.', 'browser_navigation'],
    ['لاتبحث عن مواعيد القطار', 'public_search'], ['ما تفتحش الموقع', 'browser_navigation'],
    ['Avoid using my memory.', 'memory_read'], ['Do not read my memory.', 'memory_read'],
    ['لا تحفظ أي شيء', 'memory_write'], ['Do not save anything.', 'memory_write'],
    ['Do not read my local documents.', 'knowledge_read'], ['لا تستخدم الكمبيوتر', 'computer_action'],
  ] as const)('records a standalone prohibition without a substitute tool: %s', (text, capability) => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints).toMatchObject({ standalone: true, ambiguous: false, safeActionText: null });
    expect(constraints.forbiddenCapabilities).toContain(capability);
    expect(constraints.prohibitions.every(item => item.span.start >= 0 && item.span.end <= text.length)).toBe(true);
    expect(requestCapabilityAllowed(constraints, capability)).toBe(false);
    expect(requestConstraintReply(constraints, 'en')?.status).toBe('completed');
    const routing = decideRequestRoute({ text, capabilities });
    expect(routing.handler).toBe('local_conversation'); expect(routing.publicQuery).toBeNull(); expect(routing.browserSteps).toBeUndefined();
    expect(routing.resolution.resolved).toBe(text); expect(routing.resolution.original).toBe(text);
    expect(assessRequestScope(text).publicQueryEligible).toBe(false);
  });

  it.each([
    ["Don't use my memory; what is the weather in Oslo?", 'what is the weather in Oslo'],
    ['لا تستخدم ذاكرتي، ما حالة الطقس في أوسلو؟', 'ما حالة الطقس في أوسلو'],
    ['What is the weather in Oslo? Do not use my memory.', 'What is the weather in Oslo'],
  ])('keeps the complete constraint while classifying an independent current public question: %s', (text, positive) => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints).toMatchObject({ standalone: false, ambiguous: false, safeActionText: positive });
    expect(text.slice(constraints.positiveSpan!.start, constraints.positiveSpan!.end)).toBe(positive);
    expect(constraints.forbiddenCapabilities).toEqual(['memory_read', 'memory_write']);
    const routing = decideRequestRoute({ text, capabilities });
    expect(routing.sourceAssessment.source).toBe('public_lookup'); expect(routing.route).toBe('web_search');
    expect(routing.publicQuery).toBe(positive); expect(routing.resolution.resolved).toBe(text);
    expect(routing.resolution.constraints).toEqual(constraints);
    expect(requestCapabilityAllowed(constraints, 'public_search')).toBe(true);
    expect(requestCapabilityAllowed(constraints, 'memory_read')).toBe(false);
  });

  it('does not turn a save prohibition into a read prohibition or permission', () => {
    const constraints = parseUserRequestConstraints("Don't save anything; what is my saved company name?")!;
    expect(constraints.forbiddenCapabilities).toEqual(['memory_write']);
    expect(requestCapabilityAllowed(constraints, 'memory_read')).toBe(true);
    expect(requestCapabilityAllowed(constraints, 'memory_write')).toBe(false);
    expect(requestCapabilityAllowed(null, 'memory_read')).toBe(true); // No veto, still no authorization.
  });

  it.each([
    "Don't search; what is the weather in Oslo?", 'لا تبحث؛ ما حالة الطقس في أوسلو؟',
  ])('withholds a public query even when the positive subject is public: %s', text => {
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.publicQuery).toBeNull(); expect(decision.resolution.query).toBeNull();
    expect(decision.sourceAssessment.publicQueryEligible).toBe(false);
  });

  it.each([
    "Don't use my memory and what is the weather in Oslo?", "Don't search or use memory; what is the forecast in Oslo?",
    "Don't frobnicate the saved files; open the catalogue.", "Don't search; what about it?",
    "Don't search; open the catalogue; calculate 4 + 2.",
  ])('declines unsupported mixed scopes without broadening tool authority: %s', text => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints.ambiguous).toBe(true); expect(constraints.safeActionText).toBeNull();
    for (const kind of ['public_search', 'browser_navigation', 'memory_read', 'computer_action'] as ForbiddenRequestCapability[])
      expect(requestCapabilityAllowed(constraints, kind)).toBe(false);
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.handler).toBe('clarify'); expect(decision.publicQuery).toBeNull();
  });

  it.each([
    'Translate this: do not search the web.', "Please summarize the text:\nDon't use my memory.",
    'The note says: do not open the website.', 'The page says:\nDo not read my memory.',
    '```\nDo not search the web.\n```', '«لا تستخدم ذاكرتي»',
    "Search for the book titled 'Do not search'.", "Don't forget that my project name is Aurora.",
    'لا تنس أن اسم المشروع أورورا',
  ])('keeps quoted, reported, code and positive remember instructions out of prohibition authority: %s', text => {
    expect(parseUserRequestConstraints(text)).toBeNull();
  });

  it('does not project words supplied only in the forbidden private clause', () => {
    const request = "Don't use my memory; what is the weather in Oslo?";
    expect(reviewPublicProjection(request, 'weather in Oslo').eligible).toBe(true);
    expect(reviewPublicProjection(request, 'weather in Oslo memory')).toMatchObject({ eligible: false, reason: 'prohibited_content_expansion' });
  });

  it.each([
    ["Don't use my memory; translate 'Do not search the web'", "translate 'Do not search the web'"],
    ["Don't use my memory; Translate: Do not search; do not open a browser.", 'Translate: Do not search; do not open a browser.'],
  ])('preserves the complete positive data operand without promoting its instructions: %s', (request, positive) => {
    const constraints = parseUserRequestConstraints(request)!;
    expect(constraints).toMatchObject({ standalone: false, ambiguous: false, safeActionText: positive });
    expect(constraints.forbiddenCapabilities).toEqual(['memory_read', 'memory_write']);
    expect(request.slice(constraints.positiveSpan!.start, constraints.positiveSpan!.end)).toBe(positive);
    expect(assessRequestScope(request)).toMatchObject({ source: 'supplied_content', operation: 'transform' });
  });

  it.each([
    "How do I say 'remember my password' in French?", "What does the phrase 'my saved access code' mean?",
  ])('treats literal transformation questions as supplied data instead of private recall: %s', text => {
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.sourceAssessment).toMatchObject({ source: 'supplied_content', operation: 'transform', destination: 'writing' });
    expect(decision.route).toBe('writing'); expect(decision.publicQuery).toBeNull();
  });
  it.each(["'remember my password'", '```\nremember my password\n```', '"my saved \\"account\\""', '«Open YouTube»'])('requires an intended operation for a whole literal envelope: %s', text => {
    expect(isEntireLiteralRequest(text)).toBe(true);
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.handler).toBe('clarify'); expect(decision.publicQuery).toBeNull();
    expect(decision.sourceAssessment).toMatchObject({ source: 'supplied_content', operation: 'unknown' });
  });
  it('keeps explicit outer transformations and public book lookups outside the bare-literal rule', () => {
    expect(isEntireLiteralRequest('Translate “remember my password” into French.')).toBe(false);
    const text = 'Search for the book titled “My Password”.';
    expect(isEntireLiteralRequest(text)).toBe(false);
    expect(decideRequestRoute({ text, capabilities }).publicQuery).toBe(text);
  });
});
