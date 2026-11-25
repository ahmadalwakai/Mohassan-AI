import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { runHands, webQuestion, type HandsIO } from '../apps/server/src/assistant/hands.js';

/**
 * Page choice (hands.ts): a page whose title names none of the question's words answers only with a sentence that carries
 * nearly all of them. Regression for the live miss of 2026-11-22 06:13 and 07:44: «What is the best time to visit Japan?»
 * was answered from the film article «The Third Murder» because its sentence shared «visit» and «time».
 */
const pageOf = (address: string, title: string, text: string): AgentPage => {
  const url = new URL(address).href;
  return {
    id: url, url, title, text, elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T08:00:00.000Z',
  };
};
const by = (...pages: AgentPage[]) => Object.fromEntries(pages.map(page => [page.url, page]));
type Hit = { title: string; url: string; snippet?: string };
function io(pages: Record<string, AgentPage>, hits: Hit[] | ((query: string) => Hit[])): HandsIO {
  return {
    page: async () => null,
    search: async (query: string) => (Array.isArray(hits) ? hits : hits(query)).map(hit => ({ ...hit, snippet: hit.snippet ?? hit.title })),
    read: async url => pages[url] ? { kind: 'page', page: pages[url] } : { kind: 'unreadable' },
    act: async (action: AgentAction) => pages[action.text ?? ''] ?? pageOf(action.text ?? 'https://none.example/', '', ''),
    prepare: async () => null,
    settle: async page => page,
    step: async () => {},
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
}
const text = (outcome: Awaited<ReturnType<typeof runHands>>) => outcome.kind === 'done' ? outcome.text : '';

// The film page as the encyclopedia search returned it live: its snippet carries «visit» and «time», its title nothing.
const film = pageOf('https://en.wikipedia.org/wiki/The_Third_Murder', 'The Third Murder - Wikipedia',
  'The Third Murder is a 2017 Japanese legal drama film. The trio visit Misumi again, this time showing him a magazine he may have come across that includes an article about a wife that paid a man to murder her husband for insurance.');
const filmHit = { title: film.title, url: film.url, snippet: 'The trio visit Misumi again, this time showing him a magazine' };

describe('page choice: a title that names nothing of the question', () => {
  it('reads a reference about electric current while screening it out for a live request', async () => {
    const relay = pageOf('https://en.wikipedia.org/wiki/Atlas_relay', 'Atlas relay',
      'The Atlas relay has a direct current rating of 6 amperes across both terminals.');
    const answer = await runHands({ steps: webQuestion('What is the direct current rating of the Atlas relay?')!, next: 0, lang: 'en' },
      io(by(relay), [{ title: relay.title, url: relay.url }]));
    expect(answer).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(answer)).toContain('6 amperes');

    const fresh = await runHands({ steps: webQuestion('What is the current price of the Atlas relay?')!, next: 0, lang: 'en' },
      io(by(relay), [{ title: relay.title, url: relay.url }]));
    expect(fresh).toMatchObject({ kind: 'done', status: 'blocked' });
    expect(text(fresh)).not.toContain('6 amperes');
  });

  it('does not answer a travel question from a film whose sentence shares only «visit» and «time»', async () => {
    const outcome = await runHands({ steps: webQuestion('What is the best time to visit Japan?')!, next: 0, lang: 'en' }, io(by(film), [filmHit]));
    expect(outcome).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(outcome)).not.toMatch(/Misumi/u);
  });

  it('answers from a page about the subject when the search also returns one', async () => {
    const travel = pageOf('https://en.wikipedia.org/wiki/Tourism_in_Japan', 'Tourism in Japan - Wikipedia',
      'Tourism in Japan is a major industry. The best time to visit Japan is spring, from March to May, when the cherry blossoms bloom.');
    const outcome = await runHands({ steps: webQuestion('What is the best time to visit Japan?')!, next: 0, lang: 'en' },
      io(by(film, travel), [filmHit, { title: travel.title, url: travel.url, snippet: 'The best time to visit Japan is spring' }]));
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(outcome).split('\n')[0]).toBe('The best time to visit Japan is spring, from March to May, when the cherry blossoms bloom.');
  });

  it('keeps a title-less page whose sentence carries the whole question: «طوكيو» for «ما عاصمة اليابان»', async () => {
    const tokyo = pageOf('https://ar.wikipedia.org/wiki/طوكيو', 'طوكيو - ويكيبيديا', 'طوكيو هي عاصمة اليابان وأكبر مدنها، وتقع على خليج طوكيو.');
    const outcome = await runHands({ steps: webQuestion('ما عاصمة اليابان؟')!, next: 0, lang: 'ar' },
      io(by(tokyo), query => /يابان|اليابان/u.test(query) ? [{ title: tokyo.title, url: tokyo.url, snippet: 'طوكيو هي عاصمة اليابان' }] : []));
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(outcome).split('\n')[0]).toBe('طوكيو هي عاصمة اليابان وأكبر مدنها، وتقع على خليج طوكيو.');
  });

  it('reads relevant search hits before retrying under the subject name', async () => {
    const guide = pageOf('https://museum.example/glassmaking', 'An introduction to old crafts',
      'Glassblowing is a technique for shaping molten glass by inflating it through a long tube.');
    const events: string[] = [];
    const input = io(by(guide), query => {
      events.push(`search:${query}`);
      return [{ title: guide.title, url: guide.url, snippet: 'Glassblowing technique' }];
    });
    const read = input.read!;
    input.read = url => { events.push(`read:${url}`); return read(url); };
    const result = await runHands({ steps: webQuestion('What is glassblowing?')!, next: 0 }, input);
    expect(result).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(result)).toContain('shaping molten glass');
    expect(events.filter(event => event.startsWith('search:'))).toEqual(['search:What is glassblowing']);
    expect(events).toContain(`read:${guide.url}`);
  });

  it('retries by subject after reading an initial result without an answer', async () => {
    const fair = pageOf('https://museum.example/art-fair', 'Annual arts fair',
      'The fair opens on Saturday with student exhibits in the courtyard and refreshments in the hall.');
    const article = pageOf('https://museum.example/glassblowing', 'Glassblowing',
      'Glassblowing is a technique for shaping molten glass by inflating it through a long tube.');
    const events: string[] = [];
    const input = io(by(fair, article), query => {
      events.push(`search:${query}`);
      return query === 'glassblowing'
        ? [{ title: article.title, url: article.url }]
        : [{ title: fair.title, url: fair.url, snippet: 'Glassblowing technique demonstrations' }];
    });
    const read = input.read!;
    input.read = url => { events.push(`read:${url}`); return read(url); };
    const result = await runHands({ steps: webQuestion('What is glassblowing?')!, next: 0 }, input);
    expect(result).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(result)).toContain('shaping molten glass');
    expect(events.filter(event => !event.includes('wikipedia.org'))).toEqual([
      'search:What is glassblowing', `read:${fair.url}`, 'search:glassblowing', `read:${article.url}`,
    ]);
  });

  it('does not answer a train-ticket question from a rail operator whose sentence names two of seven words (rq036)', async () => {
    const operator = pageOf('https://en.wikipedia.org/wiki/CrossCountry', 'CrossCountry - Wikipedia',
      'CrossCountry is a train operating company. 2 trains per day extends to and from Glasgow Central, calling at Haymarket and Motherwell.');
    const outcome = await runHands({ steps: webQuestion('find train teckit from glasgow to london tomorow')!, next: 0, lang: 'en' },
      io(by(operator), [{ title: operator.title, url: operator.url, snippet: 'trains to and from Glasgow Central' }]));
    expect(text(outcome)).not.toMatch(/Haymarket/u);
  });
});
