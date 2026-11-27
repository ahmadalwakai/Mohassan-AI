import { expect, it } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { travelProviders } from './travel.js';

it('exposes only travel providers and routes legacy queries to the relevant source', () => {
  const providers = travelProviders(new SafeNetwork(), Date.now);
  const supported = (question: string) => providers.filter(provider => provider.supports(compileQuery(question))).map(provider => provider.name);
  expect(providers.map(provider => provider.planned.domains)).toEqual([['travel'], ['travel'], ['travel']]);
  expect(supported('Things to do in Paris')).toEqual(['Wikivoyage (English)']);
  expect(supported('كيف أصل إلى القاهرة من المطار؟')).toEqual(['Wikivoyage (Arabic)']);
  expect(supported('أين تقع القاهرة؟')).toEqual(['OpenStreetMap Nominatim']);
  expect(supported('Latest JavaScript version')).toEqual([]);
});
