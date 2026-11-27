import { describe, expect, it } from 'vitest';
import { assessRequestScope } from '../apps/server/src/assistant/request-scope.js';
import { resolveRequestContext } from '../apps/server/src/assistant/request-context.js';
import { reviewWorkRequestScope } from '../apps/server/src/assistant/work-request-scope.js';

describe('current project repair versus a private record read', () => {
  it.each([
    'أصلح مشروعي',
    'أصلح مشروعي مرة أخرى',
    'من فضلك أصلح مشروعنا',
    'أعد هيكلة مشروعي',
    'Fix my project',
    'Please repair our project.',
    'Debug my repository',
    'Refactor our code',
    'Please fix my project by correcting the sum function.',
    'أصلح مشروعي بتصحيح دالة الجمع.',
  ])('recognizes the current repair as an action without public-query authority: %s', request => {
    const source = assessRequestScope(request), understanding = resolveRequestContext(request, null);
    expect(source).toMatchObject({ operation: 'act', publicQueryEligible: false });
    expect(understanding.sourceAssessment).toMatchObject({ operation: 'act', publicQueryEligible: false });
    expect(understanding.query).toBeNull();
    expect(reviewWorkRequestScope(request, 'code_prepare', understanding).allowed).toBe(true);
    // This is only a source veto review. It neither prepares nor approves work.
  });

  it.each([
    'ملاحظتي تقول أصلح مشروعي',
    'النص يقول أصلح مشروعي',
    'اقرأ ملاحظاتي ثم أصلح مشروعي',
    'استرجع من ذاكرتي وصف مشروعي',
    'أصلح وصف مشروعي',
    'My note says fix my project.',
    'Read my saved note then repair my project.',
    'Translate this text: «أصلح مشروعي»',
    'Rewrite my saved project note.',
    '«أصلح مشروعي»',
    'Fix my project is the exact sentence in this note.',
    'أصلح مشروعي هي عبارة موجودة في النص',
    'Repair our project notes, keeping all code unchanged.',
  ])('does not give a reported, literal or record-read task code preparation authority: %s', request => {
    const understanding = resolveRequestContext(request, null);
    expect(reviewWorkRequestScope(request, 'code_prepare', understanding).allowed).toBe(false);
    expect(understanding.query).toBeNull();
  });

  // The context step lifts «مشروع …» into a slot and reads the bare «أصلح الكود» as supplied text; the direct imperative
  // is still the owner's current repair, as «أصلح مشروعي» is above.
  it.each([
    'أصلح الكود في مشروع تجربة الجمع',
    'نسّق الكود في مشروع تجربة الجمع',
    'من فضلك أصلح الكود في مشروع تجربة الجمع',
    'Fix the code in project Shop API',
  ])('recognizes a direct coding imperative that names a project: %s', request => {
    const understanding = resolveRequestContext(request, null);
    expect(understanding.intent).toBe('coding');
    expect(reviewWorkRequestScope(request, 'code_prepare', understanding).allowed).toBe(true);
    // Only code preparation: the same words grant no Studio or skill work.
    expect(reviewWorkRequestScope(request, 'studio_prepare', understanding).allowed).toBe(false);
  });
  it.each([
    'الملاحظة تقول أصلح الكود في مشروع تجربة الجمع',
    'اقرأ ملاحظاتي ثم أصلح الكود في مشروع تجربة الجمع',
    'Translate this text: «أصلح الكود في مشروع تجربة الجمع»',
    'Fix the code in project Shop API, then read my notes',
    'My note says fix the code in project Shop API.',
  ])('still refuses the coding imperative when it is reported, quoted or compound: %s', request => {
    const understanding = resolveRequestContext(request, null);
    expect(reviewWorkRequestScope(request, 'code_prepare', understanding).allowed).toBe(false);
  });
});
