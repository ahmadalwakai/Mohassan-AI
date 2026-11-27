import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BrowserError, LocalPublicIndex, migrateSearch, RobotsPolicy, SafeNetwork, SearchEngine, SqlSearchStore,
  type AgentBrowser, type SafeResponse, type SearchOutcome } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createHttpPageReader } from '../../apps/server/src/assistant/http-page-reader.js';
import { createJudgeShadow } from '../../apps/server/src/assistant/judge-shadow.js';
import { firstLine, LIVE_QUESTION_SPACING_MS, QUESTIONS, setSha256 } from './council-question-set.js';

export interface RecordedSearch { query: string; limit: number; outcome: SearchOutcome }
export interface RecordedPage {
  requestedUrl: string;
  url: string;
  title: string;
  text: string;
  status: number | null;
  fetchedAt: string;
  outcome: 'page' | 'rate-limited' | 'disallowed' | 'unreadable';
  retryAfterMs?: number;
  links?: readonly string[];
}
export interface RecordedQuestion { id: string; question: string; searches: RecordedSearch[]; pages: RecordedPage[] }
export interface WebEvidenceManifest {
  version: 1;
  kind: 'live' | 'synthetic';
  recordedAt: string;
  setSha256: string;
  sha256: { 'cassette.json': string };
  sources: string[];
}

// Keep the HTTP status even when the production reader returns null (for example, for a 404).
const pageRequest = new AsyncLocalStorage<{ response?: Pick<SafeResponse, 'url' | 'status'> }>();
class RecordingNetwork extends SafeNetwork {
  override async request(url: string, options?: Parameters<SafeNetwork['request']>[1]) {
    const response = await super.request(url, options);
    const current = pageRequest.getStore();
    if (current && new URL(url).pathname !== '/robots.txt') current.response = { url: response.url, status: response.status };
    return response;
  }
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
  throw new Error('Usage: npx tsx scripts/quality/record-web-evidence.ts [--out <directory>]');
}
const out = args[1] ? resolve(args[1]) : fileURLToPath(new URL('../../tests/fixtures/web-evidence/', import.meta.url));
// Use the controller's existing model-free test path, including suppression of scratch classifier shadow inference.
process.env.VITEST = '1';
process.env.MOHASSAN_SCRATCH_CLASSIFIERS = '0';
const { createCommandChatControl } = await import('../../apps/server/src/command-chat.js');
const temporary = await mkdtemp(join(tmpdir(), 'mohassan-web-evidence-'));
const database = await createDatabase();
const judge = createJudgeShadow({ logFile: join(temporary, 'judge.jsonl') });
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
const rows: RecordedQuestion[] = [];
let correct = 0;
try {
  await migrate(database.db);
  await migrateSearch(database.db);
  const network = new RecordingNetwork();
  const read = createHttpPageReader(network, new RobotsPolicy(network), { sectioned: true });
  const store = new SqlSearchStore(database.db);
  let current: RecordedQuestion;
  class RecordingSearch extends SearchEngine {
    override async execute(...args: Parameters<SearchEngine['execute']>) {
      const [query, limit] = args;
      const outcome = await super.execute(...args);
      current.searches.push({ query, limit, outcome });
      return outcome;
    }
  }
  const searchProvider = new RecordingSearch(network, { store, admission: store, localIndex: new LocalPublicIndex(database.db, network), publicWeb: false });
  let browserAttempt: BrowserError | undefined;
  const denyBrowser = () => {
    browserAttempt = new BrowserError('BROWSER_FETCH_FAILED', 'The web evidence recorder only captures HTTP reads.', 502);
    throw browserAttempt;
  };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: denyBrowser, observe: denyBrowser, prepareAction: denyBrowser } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    browser, searchProvider, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    fullAccess: async () => true, judgeShadow: judge, judgeFixForOwner: true, judgeWithholdForOwner: true,
    readPage: (...args) => pageRequest.run({}, async () => {
      const requestedUrl = args[0];
      const result = await read(...args);
      const response = pageRequest.getStore()?.response;
      const metadata = { requestedUrl, url: response?.url ?? requestedUrl, title: '', text: '', status: response?.status ?? null,
        fetchedAt: new Date().toISOString() };
      if (result === null || result === 'disallowed') current.pages.push({ ...metadata, outcome: result ?? 'unreadable' });
      else if ('kind' in result) current.pages.push({ ...metadata, retryAfterMs: result.retryAfterMs, outcome: result.kind });
      else current.pages.push({ ...metadata, ...result, outcome: 'page' });
      return result;
    }),
  });
  const owner = 'web-evidence-recorder';
  for (const [index, question] of QUESTIONS.entries()) {
    if (index) await delay(LIVE_QUESTION_SPACING_MS);
    current = { id: question.id, question: question.text, searches: [], pages: [] };
    browserAttempt = undefined;
    const { id } = await control.create(owner, { goal: question.text });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    if (browserAttempt || detail.error || !current.searches.length || !current.pages.some(page => page.outcome === 'page')) {
      throw new Error(`Incomplete HTTP evidence for ${question.id}. Existing cassette left in place.`, { cause: browserAttempt });
    }
    rows.push(current);
    const reply = detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
    const pass = question.expected.test(firstLine(reply));
    if (pass) correct++;
    console.log(`${question.id} ${pass ? 'pass' : 'fail'} · ${current.searches.length} searches · ${current.pages.length} page reads`);
  }
  const cassette = `${JSON.stringify(rows, null, 2)}\n`;
  const sources = [...new Set(rows.flatMap(question => [
    ...question.searches.flatMap(search => search.outcome.hits.map(hit => hit.url)),
    ...question.pages.filter(page => page.outcome === 'page').map(page => page.url),
  ]))].sort();
  const manifest: WebEvidenceManifest = { version: 1, kind: 'live', recordedAt: new Date().toISOString(), setSha256, sources,
    sha256: { 'cassette.json': createHash('sha256').update(cassette).digest('hex') } };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'cassette.json'), cassette);
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Recorded ${rows.length} questions in ${out}. Frozen council regex score ${correct}/${rows.length}.`);
} finally {
  await control?.shutdown();
  await judge.flush();
  await database.close();
  await rm(temporary, { recursive: true, force: true });
}
