import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createMind } from '../apps/server/src/assistant/mind/index.js';
import { clearFeedbackPolicy, listFeedback, reviewFeedback } from '../apps/server/src/feedback-store.js';

const primary = 'https://first.example.test/capital-of-japan';
const alternative = 'https://second.example.test/capital-of-japan';
const question = 'What is the capital of Japan?';
const parisQuestion = 'What is the capital of France?';
const parisPrimary = 'https://first.example.test/capital-of-france';
const parisAlternative = 'https://second.example.test/capital-of-france';
const searchHits = (sources: string[], title: string, snippet: string) => sources.map(url => ({ title, url, snippet }));
const japanHits = searchHits([primary, alternative], 'Capital of Japan', 'Tokyo is the capital of Japan and its largest city. Tokyo is located on the eastern coast of Honshu.');
const franceHits = searchHits([parisPrimary, parisAlternative], 'Capital of France', 'Paris is the capital of France and its largest city. The city of Paris lies along the Seine River.');
const owner = { id: 'feedback-runtime-owner', role: 'owner' } as const;
const firstMember = { id: 'feedback-runtime-first-member', role: 'member' } as const;
const secondMember = { id: 'feedback-runtime-second-member', role: 'member' } as const;

let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;
const reads: string[] = [];
let redirectPrimary = false;
let holdRead: (() => Promise<void>) | undefined;
const hits = (query: string) => /france/iu.test(query) ? franceHits : japanHits;

beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
  } as unknown as AgentBrowser;
  const readPage = async (url: string) => {
    reads.push(url);
    if (url === parisPrimary) await holdRead?.();
    const found = [...japanHits, ...franceHits].find(hit => hit.url === url);
    if (!found) return null;
    return { url: redirectPrimary && url === parisPrimary ? parisAlternative : url, status: 200, title: found.title, text: found.snippet };
  };
  control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    searchProvider: { name: 'feedback-runtime-search', async search(query) { return hits(query); } } as SearchProvider,
    readPage, fullAccess: async id => id === owner.id, mind: createMind(),
    mindDeps: () => ({
      async search(query) { return hits(query); }, async read(url) {
        const page = await readPage(url);
        if (!page) throw new Error('No fixture page');
        return { ...page, html: '', headers: {} };
      },
      now: () => new Date('2026-11-25T00:00:00Z'),
    }),
  });
});

afterAll(async () => {
  await control?.shutdown();
  await database?.close();
});

async function ask(userId: string, goal = question) {
  const { id } = await control.create(userId, { goal });
  await control.settled(id);
  const response = await control.detail(userId, id);
  expect(response.error).toBeNull();
  const answer = response.messages.findLast(message => message.role === 'assistant');
  if (!answer) throw new Error('No assistant reply');
  return { id, answer };
}

it('blocks a reported Hands source on a normalized repeat, preserves member isolation, and applies owner decisions', async () => {
  const initial = await ask(firstMember.id);
  expect(initial.answer.text).toContain(`](${primary})`);
  await control.feedback(firstMember.id, initial.id, { messageId: initial.answer.id, verdict: 'wrong', note: 'This source is wrong.' });
  const [rating] = await listFeedback(database.db, firstMember);
  expect(rating).toMatchObject({ question, reply: initial.answer.text, note: 'This source is wrong.', route: 'hands', evidenceUrls: [primary], judgeDecision: 'send' });
  expect(await listFeedback(database.db, secondMember)).toEqual([]);

  reads.length = 0;
  const sameClass = await ask(firstMember.id, 'WHAT IS THE CAPITAL OF JAPAN!');
  expect(sameClass.answer.text).toContain(`**Source:** [second.example.test — Capital of Japan](${alternative})`);
  expect(sameClass.answer.text).not.toContain(primary);
  expect(reads).not.toContain(primary);
  const otherAccount = await ask(secondMember.id);
  expect(otherAccount.answer.text).toContain(`**Source:** [first.example.test — Capital of Japan](${primary})`);

  const wrong = await reviewFeedback(database.db, owner, rating!.id, 'wrong');
  const confirmed = await ask(secondMember.id);
  expect(confirmed.answer.text).toContain(alternative);
  expect(confirmed.answer.text).not.toContain(primary);

  const ownerAnswer = await ask(owner.id);
  expect(ownerAnswer.answer.text).toContain(alternative);
  expect(ownerAnswer.answer.text).not.toContain(primary);
  await control.feedback(owner.id, ownerAnswer.id, { messageId: ownerAnswer.answer.id, verdict: 'useful' });
  const [ownerRating] = await listFeedback(database.db, owner, { pendingOnly: true });
  expect(ownerRating).toMatchObject({ evidenceUrls: [alternative] });
  await reviewFeedback(database.db, owner, ownerRating!.id, 'correct');
  const ownerBlock = wrong.policies.find(policy => policy.active && policy.kind === 'block');
  expect(ownerBlock).toBeDefined();
  await clearFeedbackPolicy(database.db, owner, ownerBlock!.id);
  const pinned = await ask(secondMember.id);
  expect(pinned.answer.text).toContain(`**Source:** [second.example.test — Capital of Japan](${alternative})`);
});

it('rejects an HTTP redirect into a blocked page', async () => {
  redirectPrimary = true;
  try {
    const initial = await ask(firstMember.id, parisQuestion);
    expect(initial.answer.text).toContain(parisAlternative);
    await control.feedback(firstMember.id, initial.id, { messageId: initial.answer.id, verdict: 'wrong' });
    const rerun = await ask(firstMember.id, parisQuestion);
    expect(rerun.answer.text).not.toContain(`**Source:** [second.example.test — Capital of France](${parisAlternative})`);
    expect(rerun.answer.text).not.toContain('Paris is the capital of France');
  } finally {
    redirectPrimary = false;
  }
});


function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('withholds a source that was blocked while the answer was being read', async () => {
  const userId = 'feedback-runtime-racing-member';
  const initial = await ask(userId, parisQuestion);
  expect(initial.answer.text).toContain(parisPrimary);
  const reached = gate();
  const release = gate();
  holdRead = async () => {
    reached.resolve();
    await release.promise;
  };
  const { id } = await control.create(userId, { goal: parisQuestion });
  try {
    await reached.promise;
    await control.feedback(userId, initial.id, { messageId: initial.answer.id, verdict: 'wrong' });
  } finally {
    holdRead = undefined;
    release.resolve();
  }
  await control.settled(id);
  const response = await control.detail(userId, id);
  expect(response.error).toBeNull();
  expect(response.messages.at(-1)?.text).toBe('I did not verify another source after excluding a page flagged for review.');
  expect(response.run?.verdict?.status).toBe('partial');
});
