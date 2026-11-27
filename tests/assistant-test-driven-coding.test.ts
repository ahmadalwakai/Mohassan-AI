import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { parseTestDrivenCodingRequest } from '../apps/server/src/assistant/test-driven-coding/request.js';
import { answerTestDrivenCoding } from '../apps/server/src/assistant/test-driven-coding/reply.js';

const prompt = [
  'Implement a Python function to add two signed amounts.',
  '',
  '```python',
  'assert combine_amounts(13, -4) == 9',
  'assert combine_amounts(-8, -5) == -13',
  'assert combine_amounts(0, 67) == 67',
  '```',
].join('\n');

afterEach(() => vi.unstubAllEnvs());

function systemPythonSkipReason(): string | undefined {
  const executable = '/usr/bin/python3';
  const metadata = statSync(executable, { throwIfNoEntry: false });
  if (!metadata?.isFile()) return `requires system Python at ${executable}`;
  if (metadata.uid !== 0 || (metadata.mode & 0o6000) !== 0) {
    return `requires a root-owned Python without set-ID bits at ${executable} (found UID ${metadata.uid})`;
  }

  // Check the host prerequisite independently so launcher regressions still fail the tests.
  const version = execFileSync(executable, ['-I', '-B', '-S', '--version'], {
    env: {}, encoding: 'utf8', timeout: 2_500,
  });
  const match = /^Python (\d+)\.(\d+)/u.exec(version);
  if (!match) throw new Error(`Could not read the system Python version at ${executable}`);
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 11)) {
    return `requires Python 3.11 or newer at ${executable} (found ${major}.${minor})`;
  }
}

describe('routing requests that supply Python assertions', () => {
  it('preserves the assertions and never uses them as a public query', () => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    expect(parseTestDrivenCodingRequest(prompt)).toEqual({
      description: 'Implement a Python function to add two signed amounts.',
      assertions: 'assert combine_amounts(13, -4) == 9\nassert combine_amounts(-8, -5) == -13\nassert combine_amounts(0, 67) == 67',
    });
    expect(decideRequestRoute({ text: prompt })).toMatchObject({
      route: 'coding', handler: 'local_coding', availability: 'ready', publicQuery: null,
      resolution: { intent: 'coding', query: null, scope: 'private', sourceAssessment: { source: 'supplied_content' } },
    });
  });

  it('leaves quoted material, ordinary writing, and project tools on their existing paths', () => {
    const examples = '\nassert label(65) == "green"';
    expect(parseTestDrivenCodingRequest(`Summarize this Python function guide.${examples}`)).toBeNull();
    expect(parseTestDrivenCodingRequest(`Write a letter about a test run.${examples}`)).toBeNull();
    expect(decideRequestRoute({ text: 'Debug the code in my repository.', capabilities: { coding: true } })).toMatchObject({
      route: 'coding', handler: 'coding', availability: 'ready',
    });
  });

  it('keeps synthesis disabled by default, independently of project tool availability', () => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', undefined);
    expect(decideRequestRoute({ text: prompt, capabilities: { coding: true } })).toMatchObject({
      route: 'coding', handler: 'local_coding', availability: 'missing_capability',
    });
    expect(decideRequestRoute({ text: prompt, fullAccess: false })).toMatchObject({ availability: 'restricted' });
  });

  it.skipIf(process.platform !== 'linux' || process.geteuid?.() === 0)('reports when the verifier cannot start without publishing a declaration', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', '/dev/null/python3');
    const reply = await answerTestDrivenCoding(prompt, {
      accountId: randomUUID(), authorized: true, signal: new AbortController().signal,
      originalHash: createHash('sha256').update(prompt).digest('hex'), scrub: text => text,
    });
    expect(reply.status).toBe('blocked');
    expect(reply.verification).toEqual({ reason: 'worker-start-failed' });
    expect(reply.text).toContain('can’t verify Python assertions');
    expect(reply.text).not.toMatch(/\bdef\s+\w+/u);
  });
});

describe.skipIf(process.platform !== 'linux' || process.geteuid?.() === 0)('verified code through the command chat controller', () => {
  const forbiddenIO = vi.fn(async () => { throw new Error('This request uses only its assertion examples'); });
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let missingPython: string | undefined;

  beforeAll(async () => {
    missingPython = systemPythonSkipReason();
    database = await createDatabase({});
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      act: forbiddenIO, observe: forbiddenIO, screen: forbiddenIO, async close() {},
    } as unknown as AgentBrowser;
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', undefined);
    try {
      control = await createCommandChatControl(database.db, {
        browser, searchProvider: { name: 'python-no-network', search: forbiddenIO } as SearchProvider,
        models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  beforeEach(() => {
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', undefined);
  });

  afterAll(async () => {
    await control?.shutdown();
    await database?.close();
  });

  async function ask(text: string) {
    const owner = randomUUID();
    const conversation = await control.create(owner, { goal: text });
    await control.settled(conversation.id);
    const detail = await control.detail(owner, conversation.id);
    const run = await database.db.selectFrom('chat_runs').select(['status', 'state']).where('id', '=', detail.run!.id).executeTakeFirstOrThrow();
    expect(run.state.routing).toMatchObject({ route: 'coding', handler: 'local_coding' });
    expect(detail.run?.engine.modelCalls).toBe(0);
    expect(forbiddenIO).not.toHaveBeenCalled();
    return { status: run.status, text: detail.messages.at(-1)?.text, verification: run.state.codingVerification };
  }

  it('publishes a verified function when enabled', async ({ skip }) => {
    if (missingPython) skip(missingPython);
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const result = await ask(` ${prompt}\n`);
    expect(result.status).toBe('completed');
    expect(result.verification).toEqual({ reason: 'passed' });
    expect(result.text).toContain('passed all supplied assertions');
    expect(result.text).toMatch(/```python\ndef combine_amounts\([^)]*\):\n/u);
  });

  it('withholds a declaration on contradictory assertions', async ({ skip }) => {
    if (missingPython) skip(missingPython);
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const contradicts = 'Write a Python function that offsets an integer.\nassert displace(28) == 31\nassert displace(28) == 32';
    const rejected = await ask(contradicts);
    expect(rejected.status).toBe('blocked');
    expect(rejected.verification).toEqual({ reason: 'assertion-failed' });
    expect(rejected.text).toContain('assertion');
    expect(rejected.text).toContain('Please share');
    expect(rejected.text).not.toMatch(/\bdef\s+\w+/u);
  });

  it('withholds a declaration when the verifier is disabled', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'false');
    expect(await ask(prompt)).toEqual({
      status: 'blocked', text: 'I can’t verify Python assertions in an isolated process in this session.', verification: { reason: 'disabled' },
    });
  });

  it('does not discard an unsupported assertion before supported examples', async ({ skip }) => {
    if (missingPython) skip(missingPython);
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const request = prompt.replace('assert combine_amounts(13, -4)', 'assert False\nassert combine_amounts(13, -4)');
    const result = await ask(request);
    expect(result.status).toBe('blocked');
    expect(result.verification).toEqual({ reason: 'unsupported-assertion' });
    expect(result.text).toContain('assertion 1');
    expect(result.text).not.toMatch(/\bdef\s+\w+/u);
  });

  it('withholds code if the stored text does not match the original request', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const result = await ask(prompt.replace('== 9', '== 9 # password=example-placeholder'));
    expect(result.status).toBe('blocked');
    expect(result.verification).toEqual({ reason: 'request-hash-mismatch' });
    expect(result.text).toContain('original assertion text');
    expect(result.text).not.toMatch(/\bdef\s+\w+/u);
  });
});
