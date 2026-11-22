import { describe, expect, it } from 'vitest';
import { resolveRequestContext } from '../apps/server/src/assistant/request-context.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const capabilities = { browser: true, search: true, memory: true, chatModel: true, writerModel: true };
describe('literal corrections and typed follow-up constraints', () => {
  it.each(['I mean in Linz today.', 'Instead in Linz, not Graz, today.'])('replaces a bound old place/time without publishing correction words: %s', text => {
    const context = resolveRequestContext('What is the weather in Graz tomorrow?').nextState;
    const result = decideRequestRoute({ text, context, capabilities });
    expect(result.publicQuery).toContain('Linz'); expect(result.publicQuery).toContain('today');
    expect(result.publicQuery).not.toMatch(/Graz|tomorrow|I mean|instead|not/iu);
    expect(result.resolution.topic).toBe('weather'); expect(result.resolution.resolved).toBe(text);
  });
  it('uses a new literal place in a terse correction without inferring a new time', () => {
    const context = resolveRequestContext('What is the weather in Graz tomorrow?').nextState;
    const result = decideRequestRoute({ text: 'Not Graz, Linz.', context, capabilities });
    expect(result.publicQuery).toBe('weather tomorrow Linz');
    expect(result.resolution.slots.find(slot => slot.kind === 'time')?.sourceTurnId).toBe(context!.slots.find(slot => slot.kind === 'time')?.sourceTurnId);
  });
  it('does not guess an excluded location without the required old literal binding', () => {
    const context = resolveRequestContext('What is the weather in Graz tomorrow?').nextState;
    for (const previous of [undefined, context]) {
      const result = decideRequestRoute({ text: 'Not Sofia, Linz.', context: previous, capabilities });
      expect(result.handler).toBe('clarify'); expect(result.publicQuery).toBeNull();
    }
  });
  it.each(['St. Johns', 'St.Johns'])('does not promote a partial old place match into a complete excluded entity: %s', city => {
    const context = resolveRequestContext(`What is the weather in ${city} tomorrow?`).nextState;
    const result = decideRequestRoute({ text: `Instead in Halifax, not ${city}, today.`, context, capabilities });
    expect(result.handler).toBe('clarify'); expect(result.publicQuery).toBeNull();
  });
  it('replaces multiple explicitly excluded Arabic slots together', () => {
    const context = resolveRequestContext('ما حالة الطقس في حلب بكرة؟').nextState;
    const text = 'طيب في حمص اليوم بدل حلب بكرة';
    const result = decideRequestRoute({ text, context, capabilities });
    expect(result.publicQuery).toBe('الطقس اليوم حمص'); expect(result.resolution.resolved).toBe(text);
    expect(result.resolution.slots.filter(slot => slot.kind === 'place').map(slot => slot.value)).toEqual(['حمص']);
    expect(result.resolution.slots.filter(slot => slot.kind === 'time').map(slot => slot.value)).toEqual(['اليوم']);
  });
  it('keeps language and output format out of geographic place values', () => {
    const context = resolveRequestContext('What is the weather in Graz tomorrow?').nextState;
    const result = decideRequestRoute({ text: 'And in Linz today in French as JSON?', context, capabilities });
    expect(result.publicQuery).toBe('weather today Linz');
    expect(result.resolution.slots.filter(slot => slot.kind === 'place').map(slot => slot.value)).toEqual(['Linz']);
    expect(result.resolution.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'language', value: 'French' }), expect.objectContaining({ kind: 'format', value: 'JSON' }),
    ]));
  });
  it('does not extract outer place/time/budget constraints from supplied transformation data', () => {
    const result = resolveRequestContext('Translate in French: Meet in Graz tomorrow with budget 25 GBP.');
    expect(result.sourceAssessment).toMatchObject({ source: 'supplied_content', operation: 'transform' });
    expect(result.slots).toEqual([expect.objectContaining({ kind: 'language', value: 'French' })]);
    expect(result.query).toBeNull();
  });
  it('does not erase a trusted active subject when merely acknowledging a prohibition', () => {
    const context = resolveRequestContext('What is the weather in Graz tomorrow?').nextState;
    const result = decideRequestRoute({ text: 'Do not search.', context, capabilities });
    expect(result.handler).toBe('local_conversation'); expect(result.publicQuery).toBeNull();
    expect(result.resolution.nextState?.topic).toBe(context?.topic); expect(result.resolution.nextState?.intent).toBe(context?.intent);
  });
});
