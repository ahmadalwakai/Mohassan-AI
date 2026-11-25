import { describe, expect, it, vi } from 'vitest';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const capabilities = { search: true, browser: true, memory: true, adsModel: true };
const route = (text: string) => decideRequestRoute({ text, capabilities }, null);

describe('standalone factual question routing', () => {
  it.each([
    'What is the material of the tall stone footbridge that Rika could inspect?',
    'How long was the tram in service before it retired?',
    'How wet does it get during summer on Beryl Island?',
    'During the late summer, which bird nests near marshes?',
    'The west gate was built in what year?',
    'Have the Willowmere caves reopened?',
    'Which ships reached the harbour on 5/17?',
    'What percentage of Canadian households use district heating?',
    'How did the Northbridge Campaign end?',
    'Where was the National Museum of Memory founded?',
    'خلال عام ١٩٧٥، كم محطة قطار افتتحت في الرباط؟',
    'في أيّة محافظة يقع مرصد الحور؟',
    'أي مشروع هو الأقدم في سجل البلدية؟',
    'ما اسم الحديقة والتي ينمو فيها نبات البردي؟',
    'مما صُنعت بوابة الحصن؟',
    'ميناء خيالي يتبع إداريًا أي مدينة؟',
  ])('sends the complete standalone question to public lookup: %s', text => {
    expect(route(text)).toMatchObject({ route: 'web_search', handler: 'search', publicQuery: text,
      resolution: { kind: 'new' }, sourceAssessment: { source: 'public_lookup', operation: 'lookup' } });
  });

  it.each([
    'How long was it in service before it retired?',
    'Where is that footbridge?',
    'Have the repairs on that road finished?',
    'أيها هو الأقدم؟',
  ])('leaves an unbound reference outside public lookup: %s', text => {
    expect(route(text)).toMatchObject({ route: 'clarify', publicQuery: null });
  });

  it('preserves private memories, explicit advertising actions and arithmetic', () => {
    expect(route('Do you remember the supplier I gave you?')).toMatchObject({ route: 'memory', publicQuery: null });
    expect(route('Where is my saved advertising campaign budget?')).toMatchObject({ route: 'memory', publicQuery: null });
    expect(route('Please draft a campaign for my furniture repair shop.')).toMatchObject({ route: 'ads', publicQuery: null });
    expect(route('What is 18/6?')).toMatchObject({ route: 'compute', handler: 'local_computation', publicQuery: null });
    expect(route('Delete the work log that was for which client?').publicQuery).toBeNull();
    expect(route('احذف تقرير الورشة التابع لأي مقاول؟').publicQuery).toBeNull();
  });

  it('uses factual lookup for degree questions while extractive explanation is enabled', () => {
    vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
    try {
      expect(route('How strong is the magnetic field near a pulsar?')).toMatchObject({ handler: 'search' });
      expect(route('How wet does it get during summer on Beryl Island?')).toMatchObject({ handler: 'search' });
      expect(route('How does water pass through a reed bed?')).toMatchObject({ handler: 'writing' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
