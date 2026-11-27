import { createHash } from 'node:crypto';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SafeNetwork, SearchEngine, type AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { articleUrl, entitySurface, entityWords, wikiTerms } from '../apps/server/src/assistant/hands.js';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { firstLine, QUESTIONS, setSha256 } from '../scripts/quality/council-question-set.js';
import type { RecordedQuestion, WebEvidenceManifest } from '../scripts/quality/record-web-evidence.js';

const directory = new URL('./fixtures/web-evidence/', import.meta.url);
const owner = 'offline-web-evidence-owner';
const expectedFailures = new Set(['d5', 'e1']); // fix/event-bound-dates owns these event-to-date errors.
// The answer must name the fall date, not merely share a year with a chronology of other events.
// Berlin's published historical account, retrieved 2026-11-27:
// https://www.berlin.de/en/history/8482274-8619314-opening-and-fall-of-the-berlin-wall.en.html
const berlinWallFallDate = /\b(?:9 November|November 9),? 1989\b/iu;
// Egypt, location 818, 2026 Medium variant TPopulation1July in thousands, retrieved 2026-11-27.
// https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES/WPP2024_Demographic_Indicators_Medium.csv.gz
const egyptPopulation = Math.round(120_101.175 * 1000);
const egyptPopulationDisplay = new Intl.NumberFormat('en-US').format(egyptPopulation);
const egyptPopulationMillions = Math.round(egyptPopulation / 1_000_000);

function matchesCurrentEgyptEstimate(lead: string, reply: string) {
  return /\b2026\b/u.test(lead) && reply.includes('https://en.wikipedia.org/wiki/Egypt)')
    && (lead.includes(egyptPopulationDisplay) || new RegExp(`\\b${egyptPopulationMillions} million\\b`, 'iu').test(lead));
}

let cassette: RecordedQuestion[];
let scratch: string;
let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;
let judge: ReturnType<typeof createJudgeShadow>;
let current: RecordedQuestion;
const missing = vi.fn((message: string): never => { throw new Error(message); });
const network = vi.fn((): never => { throw new Error('Network is forbidden during a web evidence replay'); });

class ReplaySearch extends SearchEngine {
  override async execute(query: string, limit: number) {
    const index = current.searches.findIndex(item => item.query === query && item.limit === limit);
    if (index < 0) return missing(`Unrecorded search for ${current.id}: ${query} (limit ${limit})`);
    return current.searches.splice(index, 1)[0]!.outcome;
  }
}

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as WebEvidenceManifest;
  const data = await readFile(new URL('cassette.json', directory));
  expect(manifest).toMatchObject({ version: 1, setSha256,
    sha256: { 'cassette.json': createHash('sha256').update(data).digest('hex') } });
  cassette = JSON.parse(data.toString('utf8')) as RecordedQuestion[];
  expect(cassette.map(({ id, question }) => [id, question])).toEqual(QUESTIONS.map(({ id, text }) => [id, text]));
  vi.stubEnv('MOHASSAN_SCRATCH_CLASSIFIERS', '0');
  vi.stubGlobal('fetch', network);
  vi.spyOn(SafeNetwork.prototype, 'request').mockImplementation(network);
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(network);
  vi.spyOn(dns, 'lookup').mockImplementation(network);
  vi.spyOn(dnsPromises, 'lookup').mockImplementation(network);
  syncBuiltinESMExports();
  scratch = await mkdtemp(join(tmpdir(), 'mohassan-web-replay-'));
  database = await createDatabase();
  await migrate(database.db);
  judge = createJudgeShadow({ logFile: join(scratch, 'judge.jsonl') });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: network, observe: network, prepareAction: network } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    browser, searchProvider: new ReplaySearch(new SafeNetwork(), { providers: [] }),
    models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    fullAccess: async () => true, judgeShadow: judge, judgeFixForOwner: true, judgeWithholdForOwner: true,
    readPage: async requestedUrl => {
      const index = current.pages.findIndex(item => item.requestedUrl === requestedUrl);
      if (index < 0) return missing(`Unrecorded page read for ${current.id}: ${requestedUrl}`);
      const { outcome, url, title, text, status, fetchedAt, retryAfterMs, links } = current.pages.splice(index, 1)[0]!;
      if (outcome === 'disallowed') return 'disallowed';
      if (outcome === 'unreadable') return null;
      if (outcome === 'rate-limited' && retryAfterMs !== undefined) return { kind: outcome, retryAfterMs };
      if (outcome === 'page' && status !== null) return { url, title, text, status, fetchedAt, links };
      return missing(`Malformed page read for ${current.id}: ${requestedUrl}`);
    },
  });
  expect(network).not.toHaveBeenCalled();
});

afterEach(() => {
  // The controller can catch a transport throwable to give an honest reply. Those attempts still fail replay.
  try {
    expect(network).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
  } finally {
    network.mockClear();
    missing.mockClear();
  }
});

afterAll(async () => {
  try {
    await control?.shutdown();
    await judge?.flush();
    await database?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

async function replay(evidence: RecordedQuestion) {
  current = structuredClone(evidence);
  const { id } = await control.create(owner, { goal: evidence.question });
  await control.settled(id);
  const detail = await control.detail(owner, id);
  expect(detail.status).toBe('idle');
  expect(detail.error).toBeNull();
  expect(current.searches.map(search => search.query)).toEqual([]);
  expect(current.pages.map(page => page.requestedUrl)).toEqual([]);
  await judge.flush();
  const verdicts = (await readFile(judge.logFile, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as JudgeShadowLine).filter(verdict => verdict.conversationId === id);
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!.evidence).toBeGreaterThan(0);
  const reply = detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
  expect(reply).toBeTruthy();
  return { detail, reply, verdict: verdicts[0]! };
}

it.each(QUESTIONS.map(question => ({ ...question, expectation: expectedFailures.has(question.id) ? 'expected failure' : 'pass' })))
  ('$id ($expectation) $text', async question => {
    const { reply } = await replay(cassette.find(row => row.id === question.id)!);
    const lead = firstLine(reply);
    const matchesFrozen = question.expected.test(lead) && (question.id !== 'e1' || berlinWallFallDate.test(lead));
    const matches = matchesFrozen || question.id === 'p2' && matchesCurrentEgyptEstimate(lead, reply);
    expect(matches, `First answer line: ${lead}`).toBe(!expectedFailures.has(question.id));
  });

it('replays a judge rejection and corrects from the next recorded source', async () => {
  // Synthetic case from assistant-agent-cycle-chat.test.ts at 29448ae (retrieved 2026-11-27).
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/assistant-agent-cycle-chat.test.ts
  const query = 'What is the best time to visit Japan';
  const fetchedAt = new Date(0).toISOString();
  const sources = [
    { url: 'https://agent-cycle-fixtures.test/museum-visits', title: 'Best time to visit museums',
      text: 'The best time to visit the museum is early on a weekday morning, when the halls are quiet. Guided tours start at ten.' },
    { url: 'https://agent-cycle-fixtures.test/japan-travel', title: 'Japan travel notes',
      text: 'The best time to visit Japan is spring, from late March to early April, when the cherry trees bloom. Autumn brings clear skies and red leaves across Japan.' },
  ];
  const direct = articleUrl(entitySurface(query, entityWords(query)) || wikiTerms(query), 'en');
  const search = { query, limit: 6, outcome: { hits: sources.map(({ url, title, text }, index) => ({ url, title,
    snippet: text, providers: ['synthetic'], relevance: 'lexical' as const, score: sources.length - index })),
  fetchedAt, freshness: 'fresh' as const, coverage: 'web_sources' as const, failures: [], limitations: [] } };
  const failedDirect = { requestedUrl: direct, url: direct, title: '', text: '', status: null, fetchedAt, outcome: 'unreadable' as const };
  const page = (source: typeof sources[number]) => ({ ...source, requestedUrl: source.url, fetchedAt, status: 200, outcome: 'page' as const });
  const { detail, reply, verdict } = await replay({ id: 'correction', question: `${query}?`, searches: [search, search],
    pages: [failedDirect, ...sources.map(page), failedDirect, page(sources[1]!)], });
  expect(detail.run?.repairs.used).toBe(1);
  expect(firstLine(reply)).toMatch(/^The best time to visit Japan is spring/u);
  expect(reply).toContain(sources[1]!.url);
  expect(verdict).toMatchObject({ decision: 'send', applied: false, sourced: true });
});
