import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { isCurrentComputerReadRequest } from '../apps/server/src/assistant/computer-request-language.js';
import { assessRequestScope, reviewPublicProjection } from '../apps/server/src/assistant/request-scope.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const OWNER = 'isolated-current-pc-read-owner';
const questions = ['ماذا يظهر على كمبيوتري؟', 'What does the current PC window show?', 'What is currently visible on my PC screen?',
  'What is on my computer screen?', 'Read the current PC window.', 'What is the title of the current PC window?'];
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  calls: { queries: string[]; browser: number; pc: number };
}
const fixtures: Fixture[] = [];
async function harness(computer: boolean): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
  const calls = { queries: [] as string[], browser: 0, pc: 0 };
  const noBrowser = async () => { calls.browser++; throw new Error('A current PC read must not reach the public browser.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: noBrowser, observe: noBrowser, screen: noBrowser, prepareAction: noBrowser } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    searchProvider: { name: 'isolated-current-pc-public', async search(query) {
      calls.queries.push(query); return [{ title: 'Synthetic public source', url: 'https://current-pc-source-fixture.test', snippet: 'Public data does not describe a private current PC window.' }];
    } } as SearchProvider,
    ...(computer ? { tools: { computer: {
      async view() { calls.pc++; return { title: 'Synthetic current PC window', canAct: false, hasPasswordField: false, elements: [], jpeg: '' }; },
      async perform() { calls.pc++; throw new Error('A read question cannot authorize input.'); },
    } } } : {}),
  });
  const fixture: Fixture = { database, control, calls }; fixtures.push(fixture); return fixture;
}
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); } });

describe('closed current-computer read language has private source provenance', () => {
  it.each(questions)('never emits a public query even when execution capabilities are absent: %s', request => {
    expect(isCurrentComputerReadRequest(request)).toBe(true);
    expect(assessRequestScope(request)).toMatchObject({ source: 'local_state', operation: 'lookup', destination: 'pc', scope: 'private', publicQueryEligible: false });
    expect(reviewPublicProjection(request, request)).toMatchObject({ eligible: false, reason: 'source_not_public' });
    for (const computer of [false, true]) {
      const route = decideRequestRoute({ text: request, capabilities: { computer, browser: true, search: true, chatModel: false } });
      expect(route.publicQuery).toBeNull(); expect(route.resolution.query).toBeNull(); expect(route.resolution.original).toBe(request);
      expect(route.sourceAssessment).toMatchObject({ source: 'local_state', scope: 'private', publicQueryEligible: false });
      expect(['computer', 'clarify']).toContain(route.handler);
    }
  });
  it.each([
    '"What does the current PC window show?"', 'The note says: What does the current PC window show?',
    'Describe this text: "What does the current PC window show?"', 'Translate: What does the current PC window show?',
    'What is a PC window?', 'Explain how a computer screen works.', 'Read the current PC window, then delete the file.',
    'What does my saved note about a PC say?', 'What is on my computer screen? Then press Enter.',
  ])('does not turn data, definitions or additional operations into a complete read: %s', request => {
    expect(isCurrentComputerReadRequest(request)).toBe(false);
  });
  it('preserves transformation, whole-literal and current-constraint precedence', () => {
    expect(assessRequestScope('Describe this text: "What does the current PC window show?"'))
      .toMatchObject({ source: 'supplied_content', operation: 'transform' });
    expect(assessRequestScope('"What does the current PC window show?"')).toMatchObject({ source: 'supplied_content', operation: 'unknown' });
    expect(assessRequestScope('Do not use my PC. What does the current PC window show?'))
      .toMatchObject({ source: 'local_state', operation: 'lookup', publicQueryEligible: false, constraints: { forbiddenCapabilities: ['computer_read', 'computer_action'] } });
  });
  it('retains public definitions and bounds without broadening the grammar', () => {
    expect(assessRequestScope('What is a PC window?')).toMatchObject({ source: 'public_lookup' });
    for (const value of [null, undefined, {}, '', 'x'.repeat(4001), 'What is on my PC?\u0000']) expect(isCurrentComputerReadRequest(value)).toBe(false);
  });
});

describe('no-model current PC reads do not fall back to public search', () => {
  it.each([false, true])('keeps private outcomes and reads only the available host text (computer=%s)', async computer => {
    const fixture = await harness(computer);
    let reads = 0;
    for (const request of questions.slice(0, 4)) {
      const conversation = await fixture.control.create(OWNER, { goal: request }); await fixture.control.settled(conversation.id);
      const detail = await fixture.control.detail(OWNER, conversation.id);
      const row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
      const state = row.state as BrainState;
      expect(state.requestResolution?.sourceAssessment).toMatchObject({ source: 'local_state', operation: 'lookup', destination: 'pc', scope: 'private', publicQueryEligible: false });
      expect(state.requestResolution?.query).toBeNull(); expect(state.routing?.route).not.toBe('web_search');
      if (computer) {
        reads++;
        expect(row.status).toBe('partial'); expect(detail.messages.at(-1)?.text).toContain('Synthetic current PC window');
      } else {
        expect(row.status).toBe('blocked'); expect(detail.messages.at(-1)?.text).not.toContain('Synthetic current PC window');
      }
      expect(fixture.calls).toEqual({ queries: [], browser: 0, pc: reads });
    }
  });
});
