import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { inspectCascade } from '../apps/server/src/assistant/deliberation/cascade.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import { createSitesControl } from '../apps/server/src/sites.js';
import { runScenario, SCENARIOS } from '../packages/sites/fixtures/scenarios.ts';

// Existing repository regression messages and a CLINC150 test utterance.
// These end-to-end fixtures are not calibration data.
const compound = 'What is the capital of France? Then what is its population?'; // assistant-web-sequence.test.ts
const privatePart = 'ما عاصمة فرنسا؟ ثم ما هو رقم جوالي؟'; // assistant-web-sequence.test.ts
const choiceRequest = 'can you tell me the meaning of fluctuate'; // CLINC150 test 106
const memoryRequest = 'Do not save anything. What is my depot code from memory?'; // assistant-runtime-constraints-chat.test.ts
const forbiddenMemory = 'Do not use memory. Calculate 28 * 3.'; // assistant-runtime-constraints-chat.test.ts
const owner = 'deliberation-test-owner';

let database: Awaited<ReturnType<typeof createDatabase>>;
const controls: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];

beforeAll(async () => { database = await createDatabase({}); await migrate(database.db); });
afterAll(async () => {
  for (const control of controls) await control.shutdown();
  await database.close();
});

async function isolated(options: Partial<CommandChatConfig> = {}) {
  const external: string[] = [];
  const browserLifecycle: string[] = [];
  const page = { title: 'France', url: 'https://example.org/france',
    snippet: 'France is a country. The capital of France is Paris. The population of France is 68 million.' };
  const browser = {
    setCheckpointStore() {}, async bindAccount() { browserLifecycle.push('bind'); },
    async hasPage() { browserLifecycle.push('observe'); return false; }, async close() {},
    async act() { external.push('browser'); throw new Error('No browser action expected.'); },
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    searchProvider: { name: 'isolated-deliberation', async search(query) { external.push(query); return [page]; } },
    async readPage() { return { ...page, text: page.snippet, status: 200 }; },
    ...options,
  });
  controls.push(control);
  return {
    control, external, browserLifecycle,
    async request(goal: string) {
      const { id } = await control.create(owner, { goal });
      await control.settled(id);
      return control.detail(owner, id);
    },
  };
}

describe('deliberation on command chat', () => {
  it('collects the competing cascade matches without mutating the host snapshot', () => {
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

  it('records a disagreement and leaves the first-match question intact by default', async () => {
    const { request, external } = await isolated();
    const detail = await request(compound);
    expect(detail.status).toBe('waiting_user');
    expect(detail.run?.deliberation).toMatchObject({ enforced: false, legacy: { action: 'ask' }, disagrees: true,
      chosen: { action: 'act', route: 'compound', handler: 'web_sequence' } });
    expect(external).toEqual([]);
  });

  it('uses the selected later handler and reviews both answers when enabled', async () => {
    const { request, external } = await isolated({ deliberationEnabled: true });
    const detail = await request(compound);
    expect(detail.status).toBe('idle');
    expect(detail.messages.at(-1)?.text).toContain('The capital of France is Paris.');
    expect(detail.messages.at(-1)?.text).toContain('The population of France is 68 million.');
    expect(external).toEqual(['What is the capital of France', 'what is the population of France']);
    expect(detail.run?.deliberation).toMatchObject({ enforced: true, legacy: { action: 'ask' }, disagrees: true,
      chosen: { action: 'act', route: 'compound', handler: 'web_sequence' },
      review: { checkedParts: 2, answeredParts: 2, findings: [] } });
  });

  it('keeps a mixed private sequence out of public search', async () => {
    const { request, external } = await isolated({ deliberationEnabled: true });
    const detail = await request(privatePart);
    expect(detail.run?.deliberation?.chosen).not.toMatchObject({ action: 'act', route: 'compound' });
    expect(external).toEqual([]);
  });

  it('does not start browser preflight for an opted-in local calculation', async () => {
    const appliedFixes: (boolean | undefined)[] = [];
    const { request, browserLifecycle } = await isolated({
      deliberationEnabled: true, judgeFixForOwner: true,
      judgeShadow: { logFile: '', observe(input) { appliedFixes.push(input.applyFix); return null; }, async flush() {} },
    });
    const detail = await request('Calculate 28 * 3.'); // assistant-runtime-constraints-chat.test.ts
    expect(detail.run?.deliberation).toMatchObject({ enforced: true, chosen: { action: 'act', handler: 'local_computation' } });
    expect(detail.messages.at(-1)?.text).toContain('84');
    expect(browserLifecycle).toEqual([]);
    expect(appliedFixes).toEqual([false]);
  });

  it('asks once with candidate buttons, then dispatches the confirmed handler', async () => {
    const called: string[] = [];
    const { request, control, external } = await isolated({
      deliberationEnabled: true,
      async knowledgeSearch() { called.push('knowledge'); return []; },
      async skillAnswer() {
        called.push('skill');
        return { lang: 'en', text: 'Fluctuate means to change irregularly.', terms: [], related: [], score: 3,
          skill: { id: 'glossary', name: 'Glossary', slug: 'glossary', description: '', category: '', version: '1', contentHash: 'fixture' } };
      },
    });
    const detail = await request(choiceRequest);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.options.map(choice => choice.id)).toEqual(['deliberation-knowledge', 'deliberation-skill']);
    expect(detail.run?.deliberation?.chosen).toEqual({ action: 'ask' });
    expect(called).toEqual([]);
    expect(external).toEqual([]);
    await control.respond(owner, detail.id, { questionId: detail.question!.id, optionId: 'deliberation-skill' });
    await control.settled(detail.id);
    const answered = await control.detail(owner, detail.id);
    expect(called).toEqual(['skill']);
    expect(external).toEqual([]);
    expect(answered.messages.at(-1)?.text).toBe('Fluctuate means to change irregularly.');
    expect(answered.run?.deliberation).toMatchObject({ enforced: true,
      chosen: { action: 'act', route: 'skill', handler: 'skill' }, reasons: ['clarified_choice'] });
    expect(answered.run?.earlierDeliberation?.at(-1)?.chosen).toEqual({ action: 'ask' });
  });

  it('uses the boolean memory hit only for an eligible read and keeps its contents off the trace', async () => {
    const hintCalls: string[] = [];
    const { request } = await isolated({
      async deliberationMemoryHit(_owner, query) { hintCalls.push(query); return true; },
      tools: { memory: {
        async search() { return { text: 'Explicit evidence', evidence: ['The depot code is FR-46.'] }; },
        async save() { throw new Error('No write is authorized.'); },
      } },
    });
    const recalled = await request(memoryRequest);
    expect(hintCalls).toHaveLength(1);
    expect(recalled.run?.deliberation?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ handler: 'memory_recall', evidence: expect.arrayContaining(['memory_hit']) }),
    ]));
    expect(JSON.stringify(recalled.run?.deliberation)).not.toContain('FR-46');
    await request(forbiddenMemory);
    expect(hintCalls).toHaveLength(1);
  });

  it('records the stop decision in the stopped run without altering its previous decision', async () => {
    const { request, control } = await isolated();
    const detail = await request(compound);
    const stopped = await control.cancel(owner, detail.id);
    expect(stopped.status).toBe('idle');
    expect(stopped.run?.deliberation?.chosen).toEqual({ action: 'act', route: 'resume', handler: 'stop_run' });
    expect(stopped.run?.earlierDeliberation?.at(-1)?.chosen).toMatchObject({ action: 'act', handler: 'web_sequence' });
  });

  it('keeps a site edit and the subsequent site content with the existing site', async () => {
    const sites = await createSitesControl(database.db, { tokenSecret: 'local-deliberation-integration-fixture' });
    const { request, control, external } = await isolated({
      deliberationEnabled: true,
      sites: {
        createFromBrief: (ownerId, brief, options) => sites.create(ownerId, { brief, conversationId: options.conversationId }),
        command: sites.command,
        detail: sites.detail,
      },
    });
    const { id } = await request(forbiddenMemory);
    const brief = runScenario(SCENARIOS.find(scenario => scenario.id === 'services-ar')!).brief;
    const site = await sites.create(owner, { brief, conversationId: id });
    const run = await database.db.selectFrom('chat_runs').select(['id', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    await database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...run.state, siteId: site.id }) }).where('id', '=', run.id).execute();
    for (const text of ['أضف قسم الفريق', 'أبو أحمد - الشيف\nسامر - مدير الصالة']) {
      await control.send(owner, id, { text });
      await control.settled(id);
      const detail = await control.detail(owner, id);
      if (detail.question) {
        expect(detail.question.options.map(choice => choice.id)).toEqual(['deliberation-site_edit']);
        await control.respond(owner, id, { questionId: detail.question.id, optionId: 'deliberation-site_edit' });
        await control.settled(id);
      }
    }
    const updated = await sites.detail(owner, site.id);
    const team = updated.brief.pages.flatMap(page => page.blocks).find(block => block.type === 'team');
    expect(team?.type === 'team' && team.members.map(member => member.name)).toEqual(['أبو أحمد', 'سامر']);
    expect(external).toEqual([]);
  });
});
