import { describe, expect, it } from 'vitest';
import { decideRequestRoute, projectDeliberationRoute } from '../apps/server/src/assistant/routing-decision.js';
import corpus from './fixtures/deliberation/clinc150.json';

const lookup = corpus.development.find(row => row.intent === 'exchange_rate')!.text;
const capabilities = { browser: true, search: true };

describe('phase 1 route projection', () => {
  it('updates the route fields without changing host scope, context or availability', () => {
    const original = decideRequestRoute({ text: lookup, capabilities });
    const projected = projectDeliberationRoute(original, { action: 'act', route: 'pc', handler: 'local_computer' });
    expect(projected).toMatchObject({ route: 'pc', intent: 'pc', handler: 'computer', publicQuery: null });
    expect(projected.sourceAssessment).toBe(original.sourceAssessment);
    expect(projected.resolution).toBe(original.resolution);
    expect(projected.availability).toBe(original.availability);
    expect(projected.browserSteps).toBeUndefined();
    expect(original.route).toBe('web_search');
  });

  it('leaves routes outside the host contract and non-act decisions to intake', () => {
    const original = decideRequestRoute({ text: lookup, capabilities });
    expect(projectDeliberationRoute(original, { action: 'act', route: 'compound' })).toBe(original);
    expect(projectDeliberationRoute(original, { action: 'ask' })).toBe(original);
  });

  it('preserves restrictions and refuses a public lookup when the source is private', () => {
    // Existing assistant-runtime-constraints-chat.test.ts input.
    const calculation = 'Do not use memory. Calculate 28 * 3.';
    const original = decideRequestRoute({ text: calculation, capabilities });
    expect(original.sourceAssessment.publicQueryEligible).toBe(false);
    expect(projectDeliberationRoute(original, { action: 'act', route: 'web_search' })).toBe(original);
    const restricted = { ...original, availability: 'restricted' as const };
    expect(projectDeliberationRoute(restricted, { action: 'act', route: 'writing' })).toBe(restricted);
  });
});
