import { expect, it } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { religionProviders, religionScholarNote } from './religion.js';

it('exposes both reference providers through the shared religion domain', () => {
  const providers = religionProviders(new SafeNetwork(), Date.now);
  expect(providers.map(provider => [provider.name, provider.planned.domains])).toEqual([
    ['AlQuran Cloud', ['religion']],
    ['HadeethEnc.com', ['religion']],
  ]);
});

it('provides the planner with a scholar note in either supported language', () => {
  expect(religionScholarNote('ar')).toContain('عالم مؤهل');
  expect(religionScholarNote('en')).toContain('consult a qualified scholar');
});
