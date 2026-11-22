import { describe, expect, it } from 'vitest';
import { parseUserRequestConstraints, requestCapabilityAllowed, assessRequestScope, requestScopeActionText,
  type ForbiddenRequestCapability } from '../apps/server/src/assistant/request-scope.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const capabilities = { browser: true, search: true, memory: true, computer: true, chatModel: true, writerModel: true };

describe('independent explicit prohibitions have independent literal spans', () => {
  it.each([
    ['Never search the internet and do not use my memory. Calculate 7 + 9.', ['public_search', 'memory_read', 'memory_write'],
      ['Never search the internet', 'do not use my memory']],
    ['لا تبحث في الويب ولا تستخدم الذاكرة. احسب ٧ + ٩.', ['public_search', 'memory_read', 'memory_write'],
      ['لا تبحث في الويب', 'لا تستخدم الذاكرة']],
    ['لا تَبْحَثْ في الويب وَلَا تَسْتَخْدِمْ الذاكرة. احسب ٧ + ٩.', ['public_search', 'memory_read', 'memory_write'],
      ['لا تَبْحَثْ في الويب', 'لَا تَسْتَخْدِمْ الذاكرة']],
    ["Don't save messages nor read my memory. Calculate 7 + 9.", ['memory_write'], null],
    ['Do not search the web for ﬃ ＡＮＤ do not use memory. Calculate 7 + 9.', ['public_search', 'memory_read', 'memory_write'],
      ['Do not search the web for ﬃ', 'do not use memory']],
    ["Don't open a website or don't read my documents. Calculate 7 + 9.", ['browser_navigation', 'knowledge_read'],
      ["Don't open a website", "don't read my documents"]],
    ['Do not search the web and please do not use memory. Calculate 7 + 9.', ['public_search', 'memory_read', 'memory_write'],
      ['Do not search the web', 'please do not use memory']],
  ] as const)('preserves each veto without classifying later nouns as the first destination: %s', (text, forbidden, clauses) => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints.forbiddenCapabilities).toEqual(forbidden);
    expect(constraints.prohibitions.map(item => text.slice(item.span.start, item.span.end))).toEqual(clauses ?? [text.slice(0, text.indexOf('.'))]);
    if (clauses) {
      expect(constraints.ambiguous).toBe(false);
      expect(requestScopeActionText(text)).toMatch(/Calculate 7 \+ 9|احسب ٧ \+ ٩/u);
    } else expect(constraints.ambiguous).toBe(true);
    for (const forbiddenCapability of forbidden) expect(requestCapabilityAllowed(constraints, forbiddenCapability)).toBe(false);
  });

  it('handles a positive clause before an attached negative conjunction without manufacturing an action', () => {
    const text = 'Retrieve my saved seating preference and do not save anything.';
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints).toMatchObject({ ambiguous: false, standalone: false, safeActionText: 'Retrieve my saved seating preference', forbiddenCapabilities: ['memory_write'] });
    expect(text.slice(constraints.positiveSpan!.start, constraints.positiveSpan!.end)).toBe(constraints.safeActionText);
    expect(requestCapabilityAllowed(constraints, 'memory_read')).toBe(true);
    expect(decideRequestRoute({ text, capabilities }).route).toBe('memory');
  });

  it.each([
    'Do not save anything; read my saved seating preference.',
    'Do not save anything; recall my saved seating preference.',
    'Do not save anything; retrieve my saved seating preference.',
    'لا تحفظ أي شيء؛ اقرأ تفضيل المقعد المحفوظ في ذاكرتي.',
    'لا تحفظ أي شيء؛ استرجع تفضيل المقعد المحفوظ في ذاكرتي.',
  ])('retains a clearly explicit independent private read after a write denial: %s', text => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints).toMatchObject({ ambiguous: false, forbiddenCapabilities: ['memory_write'] });
    expect(constraints.safeActionText).not.toBeNull(); expect(requestCapabilityAllowed(constraints, 'memory_read')).toBe(true);
  });

  it.each([
    'Do not search the web; use my memory.',
    'Do not use my memory or search the internet. What is the forecast in Oslo?',
    'Do not use my memory nor read my files. What is the forecast in Oslo?',
    'Do not search the web nor access memory. What is the forecast in Oslo?',
    'Do not use memory and click Confirm. What is a cache?',
    'Do not use memory and delete the file. What is a cache?',
    'Do not read my memory and send it elsewhere. What is 2 + 2?',
    'Do not search the web and also do not use memory. What is a cache?',
    'لا تستخدم الذاكرة وتبحث في الويب. ما الطقس في أوسلو؟',
    'لا تستخدم الذاكرة أو تقرأ ملفاتي. ما الطقس في أوسلو؟',
    'لا تستخدم الذاكرة وانقر على الزر. ما الطقس في أوسلو؟',
  ])('keeps carried negation and mixed unsupported clauses at zero authority: %s', text => {
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints.ambiguous).toBe(true); expect(constraints.safeActionText).toBeNull();
    for (const kind of ['public_search', 'memory_read', 'browser_navigation', 'computer_action'] as ForbiddenRequestCapability[])
      expect(requestCapabilityAllowed(constraints, kind)).toBe(false);
  });
  it('does not treat a conjunction of public names as an executable predicate', () => {
    const constraints = parseUserRequestConstraints('Do not search NASA and ESA. Calculate 7 + 9.')!;
    expect(constraints).toMatchObject({ ambiguous: false, forbiddenCapabilities: ['public_search'], safeActionText: 'Calculate 7 + 9' });
  });
  it('does not turn a coordinated noun into an implicit access predicate', () => {
    const constraints = parseUserRequestConstraints('Do not search processors and memory. Calculate 7 + 9.')!;
    expect(constraints).toMatchObject({ ambiguous: false, forbiddenCapabilities: ['public_search'], safeActionText: 'Calculate 7 + 9' });
  });

  it('retains literal transformation data and does not split its quoted conjunction', () => {
    const text = 'Do not search the internet and do not use memory. Translate "🙂 and do not open the browser" into Arabic.';
    const constraints = parseUserRequestConstraints(text)!;
    expect(constraints.prohibitions).toHaveLength(2);
    expect(constraints.safeActionText).toBe('Translate "🙂 and do not open the browser" into Arabic');
    expect(constraints.forbiddenCapabilities).toEqual(['public_search', 'memory_read', 'memory_write']);
    expect(assessRequestScope(text)).toMatchObject({ source: 'supplied_content', operation: 'transform', publicQueryEligible: false });
  });
});

describe('negative search destinations are bound to their predicate operands', () => {
  it.each([
    ['Do not search the web for memory techniques.', ['public_search']],
    ['Do not search for memory techniques.', ['public_search']],
    ['Do not search in my memory for browser history.', ['memory_read']],
    ['Never search local files for memory techniques.', ['knowledge_read']],
    ['لا تبحث في الويب عن الذاكرة.', ['public_search']],
    ['لا تبحث في ذاكرتي عن أخبار المتصفح.', ['memory_read']],
    ['لا تبحث داخل ملفاتي عن الذاكرة.', ['knowledge_read']],
    ['Do not search for my saved notes.', ['public_search', 'memory_read']],
    ['Do not search memory allocation methods.', ['public_search', 'memory_read']],
  ] as const)('uses the immediate source and retains conservative vetoes for ambiguous private objects: %s', (text, forbidden) => {
    expect(parseUserRequestConstraints(text)?.forbiddenCapabilities).toEqual(forbidden);
  });
});

describe('negative predicates retain the capability of their immediate target', () => {
  it.each([
    ['Do not use the browser for memory training.', ['public_search', 'browser_navigation', 'browser_action']],
    ['Do not access my memory for browser examples.', ['memory_read', 'memory_write']],
    ['Do not use local documents about computer architecture.', ['knowledge_read']],
    ['Do not access the computer for memory demonstrations.', ['computer_read', 'computer_action']],
    ['Do not read the browser page about memory.', ['public_search', 'browser_navigation', 'browser_action']],
    ['Do not read my documents about memory.', ['knowledge_read']],
    ['Do not read my PC screen about memory.', ['computer_read']],
    ['Do not open the browser for file comparisons.', ['browser_navigation']],
    ['Do not open a file about the browser.', ['computer_action']],
    ['لا تستخدم المتصفح لدروس الذاكرة.', ['public_search', 'browser_navigation', 'browser_action']],
    ['لا تقرأ ذاكرتي بحثا عن الويب.', ['memory_read']],
    ['لا تفتح المتصفح من أجل مقارنة ملف.', ['browser_navigation']],
    ['لا تستخدم الكمبيوتر لدروس الذاكرة.', ['computer_read', 'computer_action']],
  ] as const)('does not let later explanatory nouns replace the prohibited source: %s', (text, forbidden) => {
    expect(parseUserRequestConstraints(text)?.forbiddenCapabilities).toEqual(forbidden);
  });
});

describe('descriptions distinguish supplied literal data from a live computer surface', () => {
  it.each([
    'Describe the following sentence: "My shared terminal window shows a password prompt."',
    'صف هذا النص: "شاشة الكمبيوتر الحالية تعرض رسالة عن ذاكرتي."',
    'Describe "my current PC window".',
    'Describe `my currently shared PC window`.',
  ])('uses actual supplied text without observing a private surface: %s', text => {
    expect(assessRequestScope(text)).toMatchObject({ source: 'supplied_content', operation: 'transform', destination: 'writing', publicQueryEligible: false });
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.resolution.kind).toBe('new'); expect(decision.publicQuery).toBeNull();
  });
  it('keeps a long literal private as supplied data even if the context topic bound requires clarification', () => {
    const text = `Describe "${'x'.repeat(2200)} my currently shared PC window".`;
    expect(assessRequestScope(text)).toMatchObject({ source: 'supplied_content', operation: 'transform', destination: 'writing', publicQueryEligible: false });
    expect(decideRequestRoute({ text, capabilities }).publicQuery).toBeNull();
  });
  it.each(['Describe the current PC window.', 'صف نافذة الكمبيوتر الحالية.'])('keeps an explicit live surface observation private and local: %s', text => {
    expect(assessRequestScope(text)).toMatchObject({ source: 'local_state', operation: 'lookup', destination: 'pc', publicQueryEligible: false });
  });
  it.each(['Describe a stack data structure.', 'Describe how a PC window works.'])('leaves ordinary definitions available to prose generation: %s', text => {
    const decision = decideRequestRoute({ text, capabilities });
    expect(decision.resolution.kind).toBe('new');
    expect(decision.sourceAssessment.source).not.toBe('local_state');
    expect(decision.sourceAssessment.reasons).not.toContain('unresolved_reference');
  });
  it('does not infer a missing literal from the words this text', () => {
    const text = 'Describe this text.';
    expect(assessRequestScope(text)).toMatchObject({ source: 'unresolved', operation: 'transform', reasons: ['unresolved_reference'] });
    expect(decideRequestRoute({ text, capabilities }).handler).toBe('clarify');
  });
});
