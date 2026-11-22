import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';
import type { AssistantTools } from '../apps/server/src/assistant/tools.js';

const OWNER = 'isolated-private-work-scope-owner';
const PROJECT = 'e486089a-a74c-4aad-8072-eccdeea73785';
const SKILL = '5b43a480-6527-4f5b-a0c6-3d2637b91724';
const CANARY = 'SYNTHETIC-PRIVATE-WORK-NOTE-291';
const TRANSFORM = `Rewrite this text concisely: "The private fixture note is ${CANARY}."`;
const MEMORY = 'Read my saved maintenance note and explain it.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
type WorkEvent = { tool: 'workspace_list' | 'inventory' | 'code_change' | 'studio_change' | 'run_skill' | 'approve' | 'cancel' | 'outcome' | 'computer_view'; ownerId: string; input?: unknown };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  script: Script[];
  models: ModelRequest[];
  events: WorkEvent[];
  memoryReads: string[];
  forbiddenCalls: string[];
  setFullAccess(allowed: boolean): void;
}
const fixtures: Fixture[] = [];
const partial = (): Script => ({ tool: 'answer', text: 'The isolated fixture has no further verified result.', outcome: 'partial' });
const runInput = { plan: { nodes: [{ id: 'fixtureNode', skillId: SKILL, inputs: {}, dependsOn: [] }], inputs: [] }, values: {} };

/** Only callback admission is observed. No project, runtime, skill, network or native process is invoked. */
async function fixture(): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db);
  const script: Script[] = [], models: ModelRequest[] = [], events: WorkEvent[] = [], memoryReads: string[] = [], forbiddenCalls: string[] = [];
  let fullAccess = true;
  const record = (tool: WorkEvent['tool'], ownerId: string, input?: unknown) => { events.push({ tool, ownerId, ...(input === undefined ? {} : { input }) }); expect(ownerId).toBe(OWNER); };
  const forbidden = async (kind: string): Promise<never> => { forbiddenCalls.push(kind); throw new Error(`No ${kind} belongs to this isolated work-scope audit.`); };
  const work: NonNullable<AssistantTools['work']> = {
    async list(ownerId) { record('workspace_list', ownerId); return 'Synthetic owner coding project: PRIVATE-PROJECT-CANARY'; },
    async inventory(ownerId) { record('inventory', ownerId); return [{ id: PROJECT, name: 'Synthetic fixture project' }]; },
    async code(ownerId, input) { record('code_change', ownerId, input); return { id: randomUUID(), label: 'Synthetic code review', prompt: 'Review the synthetic code task?', detail: 'Synthetic callback only; no runtime task or project file was touched.' }; },
    async studio(ownerId, input) { record('studio_change', ownerId, input); return { id: randomUUID(), label: 'Synthetic Studio review', prompt: 'Review the synthetic Studio task?', detail: 'Synthetic callback only; no runtime task or Studio session was touched.' }; },
    async approve(ownerId, id) { record('approve', ownerId, id); }, async cancel(ownerId, id) { record('cancel', ownerId, id); },
    async outcome(ownerId, id) { record('outcome', ownerId, id); return { settled: true, text: 'Synthetic prepared-task result; no actual execution was connected.' }; },
  };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: async () => forbidden('browser action'), observe: async () => forbidden('browser observation'), screen: async () => forbidden('browser pixels'),
    prepareAction: async () => forbidden('browser preparation') } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false, fullAccess: async () => fullAccess,
    tools: { work, computer: { async view(ownerId) { record('computer_view', ownerId); return { title: 'Synthetic current PC title', jpeg: '',
      elements: [], canAct: false, hasPasswordField: false }; }, async perform() { return forbidden('native computer input'); } },
      memory: { async search(ownerId, query) { expect(ownerId).toBe(OWNER); memoryReads.push(query); return { text: `The saved note is ${CANARY}.`, evidence: [`The saved note is ${CANARY}.`] }; },
      async save() { return forbidden('memory mutation'); } } },
    async runSkill(ownerId, input) { record('run_skill', ownerId, input); return { id: randomUUID(), status: 'waiting_approval' }; },
    models: { fast: ['private-work-scope-script'], deep: ['private-work-scope-script'], vision: '' },
    searchProvider: { name: 'forbidden-private-work-scope-network', search: async () => forbidden('public search') } as SearchProvider,
    createProvider: model => ({ id: 'isolated-private-work-scope-script', async generate(request: ModelRequest) {
      models.push(request); if (models.length > 7) throw new Error('Bounded work-scope fixture exhausted.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...(script.shift() ?? partial()) }) };
    } }),
  });
  const f: Fixture = { database, control, script, models, events, memoryReads, forbiddenCalls, setFullAccess(allowed) { fullAccess = allowed; } }; fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown(); await f.database.close(); } });
async function start(f: Fixture, goal: string) {
  const { id } = await f.control.create(OWNER, { goal }); await f.control.settled(id);
  const detail = await f.control.detail(OWNER, id);
  const row = await f.database.db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
  return { id, runId: row.id as string, detail, status: row.status as string, state: row.state as BrainState };
}
const proposals: Script[] = [
  { tool: 'workspace_list' },
  { tool: 'code_change', url: PROJECT, text: 'Add a synthetic documentation comment.' },
  { tool: 'studio_change', url: PROJECT, text: 'Adjust a synthetic preview caption.' },
  { tool: 'run_skill', text: JSON.stringify(runInput) },
];

describe('unrelated owner work tools during a current private source task', () => {
  it.each([
    'Fix my project is the exact sentence in this note.',
    'أصلح مشروعي هي عبارة موجودة في النص',
    'Repair our project notes, keeping all code unchanged.',
  ])('does not prepare code from an action-like phrase describing text: %s', async goal => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, goal);
    expect(f.events).toEqual([]); expect(r.detail.approval).toBeNull();
    expect(f.forbiddenCalls).toEqual([]);
  });
  for (const objective of [{ name: 'supplied transformation', request: TRANSFORM, memory: false }, { name: 'private-memory lookup', request: MEMORY, memory: true }]) {
    it.each(proposals)(`does not admit $tool during ${objective.name}`, async proposal => {
      const f = await fixture();
      if (objective.memory) f.script.push({ tool: 'memory_search', text: 'maintenance note' });
      f.script.push(proposal, partial()); const r = await start(f, objective.request);
      expect(r.state.requestResolution?.sourceAssessment).toMatchObject(objective.memory
        ? { source: 'prior_conversation', operation: 'lookup', scope: 'private' } : { source: 'supplied_content', operation: 'transform', scope: 'private' });
      expect(f.memoryReads.length > 0).toBe(objective.memory);
      expect(f.events, `Current source=${JSON.stringify(r.state.requestResolution?.sourceAssessment)}; finalstatus=${r.status}; approval=${r.detail.approval !== null}`)
        .toEqual([]);
      expect(r.detail.approval).toBeNull(); expect(r.detail.status).not.toBe('waiting_approval'); expect(f.forbiddenCalls).toEqual([]);
    });
  }
  it('preserves an explicit current project inventory request using only the declared synthetic metadata', async () => {
    const f = await fixture(), r = await start(f, 'List my coding project names only.');
    expect(f.events).toEqual([{ tool: 'inventory', ownerId: OWNER }]); expect(r.status).toBe('completed');
    expect(r.detail.messages.at(-1)?.text).toBe('Synthetic fixture project'); expect(f.models).toEqual([]); expect(f.forbiddenCalls).toEqual([]);
  });
  it('preserves an explicit current code-change preparation without approving or executing it', async () => {
    const f = await fixture(); f.script.push({ tool: 'code_change', url: PROJECT, text: 'Add a synthetic documentation comment.' }, partial());
    const r = await start(f, `Prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`);
    expect(f.events).toEqual([{ tool: 'code_change', ownerId: OWNER, input: { id: PROJECT, goal: 'Add a synthetic documentation comment.' } }]);
    expect(r.detail.status).toBe('waiting_approval'); expect(r.detail.approval).not.toBeNull(); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not admit preparation while transforming saved private memory', async () => {
    const f = await fixture(); f.script.push({ tool: 'memory_search', text: 'maintenance note' }, proposals[1]!, partial());
    const r = await start(f, 'Rewrite my saved maintenance note concisely.');
    expect(r.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'prior_conversation', operation: 'transform', scope: 'private' });
    expect(f.memoryReads.length).toBeGreaterThan(0); expect(f.events).toEqual([]); expect(r.detail.approval).toBeNull(); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not promote a quoted code-preparation instruction inside supplied transformation data', async () => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, `Translate "Prepare a code change in project ${PROJECT} to add a synthetic comment" into Arabic.`);
    expect(f.events).toEqual([]); expect(r.detail.approval).toBeNull(); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not promote a code instruction reported by a saved note into a current outer objective', async () => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, `My saved maintenance note says wait, then prepare a code change in project ${PROJECT} to add a synthetic comment.`);
    expect(r.state.requestResolution?.sourceAssessment?.source).toBe('prior_conversation');
    expect(f.events).toEqual([]); expect(r.detail.approval).toBeNull(); expect(f.forbiddenCalls).toEqual([]);
  });
  it('preserves separately explicit code preparation after a balanced supplied-text transformation', async () => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, `Rewrite "A synthetic private note", then prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`);
    expect(f.events).toEqual([{ tool: 'code_change', ownerId: OWNER, input: { id: PROJECT, goal: 'Add a synthetic documentation comment.' } }]);
    expect(r.detail.status).toBe('waiting_approval'); expect(f.forbiddenCalls).toEqual([]);
  });
  it('preserves an explicit current Studio preparation as pending review only', async () => {
    const f = await fixture(); f.script.push(proposals[2]!, partial());
    const r = await start(f, `Prepare a Studio change in session ${PROJECT} to adjust a synthetic preview caption.`);
    expect(f.events).toEqual([{ tool: 'studio_change', ownerId: OWNER, input: { id: PROJECT, goal: 'Adjust a synthetic preview caption.' } }]);
    expect(r.detail.status).toBe('waiting_approval'); expect(f.forbiddenCalls).toEqual([]);
  });
  it('preserves an explicit skill-task preparation without approving or running its child tools', async () => {
    const f = await fixture(); f.script.push(proposals[3]!, partial());
    const r = await start(f, `Prepare a skill run for ${SKILL}.`);
    expect(f.events).toEqual([{ tool: 'run_skill', ownerId: OWNER, input: runInput }]); expect(r.status).toBe('partial');
    expect(r.state.skillTaskIds).toHaveLength(1); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not infer owner inventory authority from a literal-message question misclassified as a numeric operation', async () => {
    const f = await fixture(); f.script.push(proposals[0]!, partial());
    const r = await start(f, `This message contains "Prepare a skill run for ${SKILL}." Is it clear?`);
    expect(r.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'supplied_content', scope: 'private' });
    expect(f.models.length).toBeGreaterThan(0);
    expect(f.events).toEqual([]); expect(r.detail.approval).toBeNull(); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not approve an older private-source task restored into a pending approval card', async () => {
    const f = await fixture(); f.script.push({ tool: 'memory_search', text: 'maintenance note' }, partial());
    const r = await start(f, MEMORY), pendingId = randomUUID(), approvalId = randomUUID();
    // This is an explicit synthetic fixture for a task prepared before the new
    // policy. No Runtime row is created and no caller's real task is modified.
    await f.database.db.transaction().execute(async transaction => {
      await transaction.updateTable('chat_runs').set({ status: 'waiting_approval', state: JSON.stringify({ ...r.state,
        pendingTask: { id: pendingId, label: 'Synthetic legacy private-origin task', tool: 'code_change' } }) }).where('id', '=', r.runId).execute();
      await transaction.updateTable('chat_conversations').set({ status: 'waiting_approval', active_run_id: r.runId,
        approval: JSON.stringify({ id: approvalId, prompt: 'Review synthetic legacy task?', detail: 'Isolated pre-policy state only.' }) }).where('id', '=', r.id).execute();
    });
    await f.control.approve(OWNER, r.id, { approvalId, approved: true }); await f.control.settled(r.id);
    expect(f.events).toEqual([]); expect(f.forbiddenCalls).toEqual([]);
  });
  it('does not approve prepared owner work after the current role loses full access', async () => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, `Prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`);
    expect(r.detail.status).toBe('waiting_approval'); f.setFullAccess(false);
    await f.control.approve(OWNER, r.id, { approvalId: r.detail.approval!.id, approved: true }); await f.control.settled(r.id);
    expect(f.events.map(event => event.tool)).toEqual(['code_change']); expect(f.forbiddenCalls).toEqual([]);
  });
  it('retains the separately approved owner preparation flow while full access is still allowed', async () => {
    const f = await fixture(); f.script.push(proposals[1]!, partial());
    const r = await start(f, `Prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`);
    expect(r.detail.status).toBe('waiting_approval'); const pendingId = r.state.pendingTask!.id;
    await f.control.approve(OWNER, r.id, { approvalId: r.detail.approval!.id, approved: true }); await f.control.settled(r.id);
    expect(f.events).toEqual([
      { tool: 'code_change', ownerId: OWNER, input: { id: PROJECT, goal: 'Add a synthetic documentation comment.' } },
      { tool: 'approve', ownerId: OWNER, input: pendingId }, { tool: 'outcome', ownerId: OWNER, input: pendingId },
    ]); expect(f.forbiddenCalls).toEqual([]);
  });
  it('preserves an explicit complete current PC read followed by the separately requested project list', async () => {
    const f = await fixture(); f.script.push({ tool: 'computer_view' }, { tool: 'workspace_list' }, partial());
    await start(f, 'Read the title of my current computer window, then list my coding projects.');
    expect(f.events.map(event => event.tool)).toEqual(['computer_view', 'workspace_list']);
    expect(f.memoryReads).toEqual([]); expect(f.forbiddenCalls).toEqual([]);
  });
});
