import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { Decision } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-live-owner-access';
const PROJECT = 'e486089a-a74c-4aad-8072-eccdeea73785', SKILL = '5b43a480-6527-4f5b-a0c6-3d2637b91724';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
const cases: Array<{ tool: string; request: string; proposal: Script }> = [
  { tool: 'code_change', request: `Prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`,
    proposal: { tool: 'code_change', url: PROJECT, text: 'Add a synthetic documentation comment.' } },
  { tool: 'run_skill', request: `Prepare a skill run for ${SKILL}.`, proposal: { tool: 'run_skill', text: JSON.stringify({
    plan: { nodes: [{ id: 'fixtureNode', skillId: SKILL, inputs: {}, dependsOn: [] }], inputs: [] }, values: {},
  }) } },
  { tool: 'computer_view', request: 'Read the title of my current computer window.', proposal: { tool: 'computer_view' } },
];
const fixtures: Array<{ control: Awaited<ReturnType<typeof createCommandChatControl>>; database: Awaited<ReturnType<typeof createDatabase>> }> = [];

/** Only callback admission is recorded: no native input, Runtime, network or files. */
async function run(entry: (typeof cases)[number], downgradeDuringProvider: boolean) {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
  let fullAccess = true, modelCalls = 0, accountChecks = 0, forbiddenCalls = 0;
  const accessReads: boolean[] = [], ownerCallbacks: string[] = [];
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error('No actual external or mutation effect belongs to this role audit.'); };
  const ownerCallback = (kind: string, owner: string) => { expect(owner).toBe(OWNER); ownerCallbacks.push(kind); };
  const control = await createCommandChatControl(database.db, {
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
    recordExperiences: false,
    fullAccess: async () => { accessReads.push(fullAccess); return fullAccess; },
    accountActive: async () => { accountChecks++; return true; }, // A limited member remains an active account.
    tools: {
      computer: { async view(owner) { ownerCallback('computer_view', owner); return { title: 'Synthetic private current title',
        jpeg: '', elements: [], canAct: false, hasPasswordField: false }; }, perform: forbidden },
      work: { list: forbidden, approve: forbidden, cancel: forbidden, outcome: forbidden,
        async code(owner) { ownerCallback('code_change', owner); return { id: randomUUID(), label: 'Synthetic review only',
          prompt: 'Review the synthetic preparation?', detail: 'Callback record only; no Runtime task or project file was created.' }; } },
    },
    async runSkill(owner) { ownerCallback('run_skill', owner); return { id: randomUUID(), status: 'waiting_approval' }; },
    models: { fast: ['live-owner-access-fixture'], deep: ['live-owner-access-fixture'], vision: '' },
    searchProvider: { name: 'forbidden-live-owner-network', search: forbidden } as SearchProvider,
    createProvider: model => ({ id: 'live-owner-access-fixture', async generate() {
      if (++modelCalls > 4) throw new Error('Bounded live role script exhausted.');
      if (modelCalls === 1) {
        expect(fullAccess).toBe(true); expect(accessReads.length).toBeGreaterThanOrEqual(2);
        // The worker has already cached true. The account stays active; only
        // owner-only access changes DURING this current provider await.
        if (downgradeDuringProvider) fullAccess = false;
      }
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...(modelCalls === 1 ? entry.proposal
        : { tool: 'answer', text: 'The fixture has no further verified result.', outcome: 'partial' }) }) };
    } }),
  });
  fixtures.push({ database, control });
  const { id } = await control.create(OWNER, { goal: entry.request }); await control.settled(id);
  const detail = await control.detail(OWNER, id);
  expect(detail.error).toBeNull(); expect(forbiddenCalls).toBe(0); expect(accountChecks).toBeGreaterThan(0);
  expect(accessReads[0]).toBe(true); expect(accessReads[1]).toBe(true);
  return { tool: entry.tool, downgradeDuringProvider, currentFullAccess: fullAccess, accessReads, accountChecks, ownerCallbacks, modelCalls,
    status: detail.status };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown(); await f.database.close(); } });

describe('live owner-only access after the current configured-provider await', () => {
  it.each(cases)('does not admit $tool after owner-only access was removed during the provider await', async entry => {
    const result = await run(entry, true);
    expect(result.currentFullAccess).toBe(false);
    expect(result.ownerCallbacks, JSON.stringify(result)).toEqual([]);
  });
  it.each(cases)('retains the same requested $tool while owner-only access remains allowed', async entry => {
    const result = await run(entry, false);
    expect(result.currentFullAccess).toBe(true); expect(result.ownerCallbacks).toEqual([entry.tool]);
  });
});
