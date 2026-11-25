import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { parseDesktopCommand } from '@mohassan/desktop';
import { inspectCascade } from '../apps/server/src/assistant/deliberation/cascade.js';
import { projectRunDeliberation } from '../apps/server/src/assistant/deliberation/run-ledger.js';
import { configureDeliberation } from '../apps/server/src/assistant/deliberation/settings.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { gateRefusalText } from '../apps/server/src/assistant/run-plans.js';
import { createCommandChatControl, type CommandChatConfig, type DesktopChatPort } from '../apps/server/src/command-chat.js';
import corpus from './fixtures/deliberation/clinc150.json';

// Existing repository regression messages and CLINC150 utterances.
// These integration cases do not fit the calibration temperature.
const compound = 'What is the capital of France? Then what is its population?'; // assistant-web-sequence.test.ts
const privatePart = 'ما عاصمة فرنسا؟ ثم ما هو رقم جوالي؟'; // assistant-web-sequence.test.ts
const choiceRequest = 'can you tell me the meaning of fluctuate'; // CLINC150 test 106
const memoryRequest = 'Do not save anything. What is my depot code from memory?'; // assistant-runtime-constraints-chat.test.ts
const forbiddenMemory = 'Do not use memory. Calculate 28 * 3.'; // assistant-runtime-constraints-chat.test.ts
const missingWeather = corpus.development.find(row => row.id === 'clinc-val-2176')!.text;
const unsupportedRequest = corpus.benchmark.find(row => row.expected.kind === 'abstain')!.text;
const identityRequest = corpus.benchmark.find(row => row.text === 'who is your maker')!.text;
const owner = 'deliberation-test-owner';

let database: Awaited<ReturnType<typeof createDatabase>>;
const controls: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];

beforeAll(async () => { database = await createDatabase({}); await migrate(database.db); });
afterAll(async () => {
  for (const control of controls) await control.shutdown();
  await database.close();
});

async function isolated(options: Partial<CommandChatConfig> = {}, settings: Parameters<typeof configureDeliberation>[1] = {}) {
  configureDeliberation(database.db, settings);
  const external: string[] = [], browserCalls: string[] = [];
  const browser = {
    setCheckpointStore() {}, async bindAccount() { browserCalls.push('bind'); },
    async hasPage() { browserCalls.push('observe'); return false; }, async close() {},
    async act() { external.push('browser'); throw new Error('No browser action expected.'); },
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    searchProvider: { name: 'isolated-deliberation', async search(query) { external.push(query); return []; } },
    ...options,
  });
  controls.push(control);
  async function read(conversationId: string) {
    await control.settled(conversationId);
    const detail = await control.detail(owner, conversationId);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status'])
      .where('owner_id', '=', owner).where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    return { detail, ...projectRunDeliberation(run.state?.agentRun, true), routing: run.state?.routing, status: run.status };
  }
  return {
    control, external, browserCalls, read,
    async request(goal: string) {
      const { id } = await control.create(owner, { goal });
      return read(id);
    },
  };
}

describe('phase 1 deliberation on command chat', () => {
  it('collects competing cascade matches without mutating the host snapshot', () => {
    const state = Object.freeze({ trail: Object.freeze([]) as unknown as [], steps: 0 });
    const configured = Object.freeze({ ads: true, skills: true, knowledge: true });
    const routing = decideRequestRoute({ text: compound, capabilities: { browser: true, search: true, planner: true } });
    const inspected = inspectCascade({ text: compound, state, configured, routing });
    expect(inspected.legacy).toEqual({ action: 'ask' });
    expect(inspected.predicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ handler: 'missing_reference', matched: true }),
      expect.objectContaining({ handler: 'web_sequence', matched: true, eligible: true }),
    ]));
    expect(state).toEqual({ trail: [], steps: 0 });
  });

  it.each([false, true])('keeps an unsteerable first-match question (enabled %s)', async enabled => {
    const { request, external } = await isolated({}, { enabled });
    const { detail, deliberation } = await request(compound);
    expect(detail.status).toBe('waiting_user');
    expect(detail.run?.deliberation).toBeUndefined();
    expect(deliberation).toMatchObject({ enforced: false, legacyObserved: false, legacy: { action: 'ask' },
      disagrees: true, chosen: { action: 'act', route: 'compound', handler: 'web_sequence' } });
    expect(external).toEqual([]);
  });

  it('asks for the missing location before any browser or search operation', async () => {
    const { request, external, browserCalls } = await isolated({}, { enabled: true });
    const { detail, deliberation } = await request(missingWeather);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.prompt).toContain('Which location');
    expect(deliberation).toMatchObject({ chosen: { action: 'ask' }, enforced: true });
    expect(external).toEqual([]);
    expect(browserCalls).toEqual([]);
  });

  it('abstains at intake before tool-backed paths when an action is unsupported', async () => {
    const { request, external, browserCalls } = await isolated({}, { enabled: true });
    const { status, deliberation } = await request(unsupportedRequest);
    expect(status).toBe('blocked');
    expect(deliberation).toMatchObject({ chosen: { action: 'abstain' }, enforced: true });
    expect(external).toEqual([]);
    expect(browserCalls).toEqual([]);
  });

  it('lets the configured desktop parser identify and dispatch a local read', async () => {
    const goal = 'Inspect my local bench inventory.';
    expect(parseDesktopCommand(goal)).toBeNull();
    const command = { kind: 'file_list', path: 'instrument-locker' } as const;
    const execute = vi.fn<DesktopChatPort['execute']>(async () => ({ status: 'completed', text: 'Found an instrument index.' }));
    const { request, external, browserCalls } = await isolated({ desktop: {
      parse: text => text === goal ? { command, text, mutating: false, lang: 'en' } : null,
      describe: () => 'Read the inventory directory', execute,
    } }, { enabled: true });

    const { detail, deliberation, status } = await request(goal);
    expect(status).toBe('completed');
    expect(detail.messages.at(-1)?.text).toContain('Found an instrument index.');
    expect(deliberation).toMatchObject({ enforced: false, legacy: { action: 'act', handler: 'desktop', route: 'pc' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(command, expect.objectContaining({ approved: false }));

    const rejected = 'List files in Documents.';
    expect(parseDesktopCommand(rejected)).not.toBeNull();
    const refused = await request(rejected);
    expect(refused.deliberation?.candidates.map(candidate => candidate.handler)).not.toContain('desktop');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(external).toEqual([]);
    expect(browserCalls).toEqual([]);
  });

  it('keeps a recognized desktop mutation on the host approval path', async () => {
    const execute = vi.fn<DesktopChatPort['execute']>(async (_command, { approved }) => approved
      ? { status: 'completed', text: 'Moved the preset to the recycle bin.' }
      : { status: 'needs_approval', text: 'This needs approval.', approval: {
        prompt: 'Move the outdated preset to the recycle bin?', detail: 'The file will stay recoverable.', label: 'Move preset',
      } });
    const { request, read, control, external } = await isolated({ desktop: {
      parse: parseDesktopCommand, describe: () => 'Move the preset to the recycle bin', execute,
    } }, { enabled: true });

    const waiting = await request('Delete the file stale-preset.ini in Documents.');
    expect(waiting.detail.status).toBe('waiting_approval');
    expect(waiting.detail.question).toBeNull();
    expect(waiting.deliberation).toMatchObject({ enforced: false, legacy: { action: 'act', handler: 'desktop', route: 'pc' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'file_delete', path: 'stale-preset.ini' }),
      expect.objectContaining({ approved: false }));
    const { approval } = waiting.detail;
    if (!approval) throw new Error('Expected a desktop approval card.');
    await control.approve(owner, waiting.detail.id, { approvalId: approval.id, approved: true });

    const finished = await read(waiting.detail.id);
    expect(finished.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'file_delete', path: 'stale-preset.ini' }),
      expect.objectContaining({ approved: true }));
    expect(external).toEqual([]);
  });

  it('explains an account restriction without dispatching a tool', async () => {
    const execute = vi.fn<DesktopChatPort['execute']>(async () => { throw new Error('A restricted account cannot use this adapter.'); });
    const { request, external, browserCalls } = await isolated({ fullAccess: async () => false, desktop: {
      parse: parseDesktopCommand, describe: () => 'Read the local settings file', execute,
    } }, { enabled: true });

    const { detail, deliberation, status } = await request('Read the file panel-layout.txt on my computer.');
    expect(status).toBe('blocked');
    expect(detail.question).toBeNull();
    expect(detail.messages.at(-1)?.text).toBe(gateRefusalText('actor_not_allowed', 'en'));
    expect(deliberation).toMatchObject({ enforced: true, chosen: { action: 'abstain' }, reasons: ['restricted'] });
    expect(execute).not.toHaveBeenCalled();
    expect(external).toEqual([]);
    expect(browserCalls).toEqual([]);
  });

  it('leaves document fields and document-specific limits to the host', async () => {
    const documentIO = vi.fn(async () => { throw new Error('These PDF requests need an answer before any I/O.'); });
    const { request, external } = await isolated({ documents: {
      control: { create: documentIO, edit: documentIO, list: documentIO, content: documentIO, readLocal: documentIO, info: documentIO },
      link: id => `/api/documents/${id}/content`,
    } }, { enabled: true });

    const draft = await request('Make a PDF about instrument maintenance.');
    expect(draft.detail.status).toBe('waiting_user');
    expect(draft.detail.question?.fields?.map(field => field.id)).toEqual(['title', 'content', 'style']);
    expect(draft.deliberation).toMatchObject({ enforced: false });

    const edit = await request('Delete pages from the latest PDF.');
    expect(edit.status).toBe('blocked');
    expect(edit.detail.messages.at(-1)?.text).toContain('Name their numbers');
    expect(edit.deliberation).toMatchObject({ enforced: false });
    expect(documentIO).not.toHaveBeenCalled();
    expect(external).toEqual([]);
  });

  it('keeps a mixed private sequence out of public search', async () => {
    const { request, external } = await isolated({}, { enabled: true });
    const { deliberation } = await request(privatePart);
    expect(deliberation?.chosen).not.toMatchObject({ action: 'act', route: 'compound' });
    expect(external).toEqual([]);
  });

  it('reviews the unchanged calculation reply and status at publication', async () => {
    const { request, external } = await isolated({}, { enabled: true });
    const { detail, status, deliberation } = await request('Calculate 28 * 3.'); // assistant-runtime-constraints-chat.test.ts
    expect(deliberation).toMatchObject({ enforced: false, chosen: { action: 'act', handler: 'local_computation' },
      review: { checkedParts: 1, answeredParts: 1, findings: [], revision: 'none' } });
    expect(detail.messages.at(-1)?.text).toContain('84');
    expect(status).toBe('completed');
    expect(external).toEqual([]);
  });

  it.each([false, true])('keeps existing resolution and projects only an authorized route preference (full access %s)', async fullAccess => {
    const { request, external } = await isolated({ fullAccess: async () => fullAccess }, { enabled: true });
    const { detail, deliberation, routing } = await request(identityRequest);
    expect(detail.messages.at(-1)?.text).toContain('Ahmad Alwakai');
    expect(deliberation).toMatchObject({ enforced: false, chosen: { action: 'act', route: 'chat', handler: 'self_question' } });
    expect(deliberation?.routePreference).toBe(fullAccess ? 'chat' : undefined);
    expect(routing.route).toBe(fullAccess ? 'chat' : 'web_search');
    expect(external).toEqual([]);
  });

  it('shows candidate choices and never dispatches a different tool after confirmation', async () => {
    const called: string[] = [];
    const { request, read, control, external } = await isolated({
      async knowledgeSearch() { called.push('knowledge'); return []; },
      async skillAnswer() { called.push('skill'); return null; },
    }, { enabled: true });
    const { detail, deliberation } = await request(choiceRequest);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.options.map(choice => choice.id)).toEqual(['deliberation-knowledge', 'deliberation-skill']);
    expect(deliberation).toMatchObject({ chosen: { action: 'ask' }, enforced: true });
    expect(called).toEqual([]);
    const { question } = detail;
    if (!question) throw new Error('Expected a candidate choice card.');
    await control.respond(owner, detail.id, { questionId: question.id, optionId: 'deliberation-skill' });
    const confirmed = await read(detail.id);
    expect(called).toEqual([]);
    expect(external).toEqual([]);
    expect(confirmed.detail.status).toBe('waiting_user');
    expect(confirmed.detail.question?.prompt).toContain('full request');
    expect(confirmed.deliberation).toMatchObject({ chosen: { action: 'ask' }, enforced: true });
    expect(confirmed.earlierDeliberation?.at(-1)?.chosen).toEqual({ action: 'ask' });
    await control.send(owner, detail.id, { text: choiceRequest });
    const capped = await read(detail.id);
    expect(capped.detail.question).toBeNull();
    expect(capped.status).toBe('blocked');
    expect(capped.deliberation).toMatchObject({ chosen: { action: 'abstain' }, enforced: true });
    expect(called).toEqual([]);
  });

  it('uses the boolean memory hit only for an eligible read and keeps the value off the trace', async () => {
    const hintCalls: string[] = [];
    const { request } = await isolated({
      tools: { memory: {
        async search() { return { text: 'Explicit evidence', evidence: ['The depot code is FR-46.'] }; },
        async save() { throw new Error('No write is authorized.'); },
      } },
    }, { async memoryHit(_owner, query) { hintCalls.push(query); return true; } });
    const recalled = await request(memoryRequest);
    expect(hintCalls).toHaveLength(1);
    expect(recalled.deliberation?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ handler: 'memory_recall', evidence: expect.arrayContaining(['memory_hit']) }),
    ]));
    expect(JSON.stringify(recalled.deliberation)).not.toContain('FR-46');
    await request(forbiddenMemory);
    expect(hintCalls).toHaveLength(1);
  });
});
