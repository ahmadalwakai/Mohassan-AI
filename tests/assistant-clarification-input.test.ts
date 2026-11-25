import { describe, expect, it } from 'vitest';
import { missingRequestInput } from '../apps/server/src/assistant/clarify/missing-input.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const capabilities = { search: true, browser: true, planner: true, memory: true };

function prompt(text: string, language: 'ar' | 'en' = 'en') {
  const routing = decideRequestRoute({ text, fullAccess: true, capabilities });
  return missingRequestInput(text, language, routing.resolution, routing)?.prompt ?? null;
}

describe('clarification for missing request inputs', () => {
  it.each([
    ['Compute the perimeter.', 'en', /shape.*dimensions/iu],
    ['Convert 8 kg into', 'en', /from which unit to which unit/iu],
    ['Could you halve that figure?', 'en', /which number/iu],
    ['How many did I settle on?', 'en', /which subject/iu],
    ['كم سعر السيارة؟', 'ar', null],
    ['قديش رصيده؟', 'ar', null],
    ['ما رصيد تبعها؟', 'ar', /الموضوع/u],
  ] as const)('checks whether %s names the required inputs', (text, language, expected) => {
    if (expected) expect(prompt(text, language)).toMatch(expected);
    else expect(prompt(text, language)).toBeNull();
  });

  it.each([
    'Calculate the volume of 3 by 5 by 7.',
    'Convert 18 inches into centimetres.',
    'Convert the attached chart to a table.',
    'Convert 3².',
    'How much did we agree to pay for the renovation?',
    'Inspect https://example.org/help.',
  ])('leaves a complete input or unrelated task on its ordinary route (%s)', text => {
    expect(prompt(text)).toBeNull();
  });

  it('leaves an already resolved follow-up on its ordinary route', () => {
    const previous = decideRequestRoute({ text: 'ما مواصفات سامسونج؟', capabilities });
    const text = 'وكم سعره في تونس؟';
    const routing = decideRequestRoute({ text, capabilities, context: previous.resolution.nextState });
    expect(routing.resolution.kind).toBe('follow_up');
    expect(missingRequestInput(text, 'ar', routing.resolution, routing)).toBeNull();
  });

  it('asks only for the units when the quantity is supplied', () => {
    const text = 'Please convert 12.5 for us.';
    const routing = decideRequestRoute({ text, capabilities });
    expect(missingRequestInput(text, 'en', routing.resolution, routing)).toEqual({
      kind: 'conversion', prompt: 'Which units should I convert from and to?',
    });
  });
});
