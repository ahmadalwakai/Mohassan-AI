import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserError, type AgentBrowser, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';
import type { ComputerScreen, ComputerStep } from '../apps/server/src/assistant/tools.js';
import { actionOperandHash, actionRequestHash, compileActionCompletionContract, createActionCompletionLedger,
  recordActionCompletionEvent, type ActionCompletionLedger } from '../apps/server/src/assistant/action-completion.js';

const OWNER = 'isolated-action-completion-owner';
const MEMORY = 'Remember that my fixture seating preference is aisle.';
const CLICK = 'Click the Confirm button in the current PC window.';
const TYPE = 'Type AUDIT-TEXT into the current Notepad window.';
const READ = 'Search my memory for the seating preference and explain it.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
type State = BrainState & { actionCompletion?: ActionCompletionLedger };
type Options = { saveMode?: 'normal' | 'commit_then_unknown'; pcMode?: 'normal' | 'unknown' };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  domain: ReturnType<typeof createMemoryControl>;
  script: Script[]; requests: ModelRequest[]; inputs: ComputerStep[]; counters: { domainWrites: number };
  search(ownerId: string, query: string): Promise<{ text: string; evidence: string[] }>;
  save(ownerId: string, text: string, request: string): Promise<string>;
  view(ownerId: string): Promise<ComputerScreen>;
  perform(ownerId: string, step: ComputerStep): Promise<string>;
  forbiddenNetwork(): Promise<never>;
}
const fixtures: Fixture[] = [];
const done = (text: string): Script => ({ tool: 'answer', text, outcome: 'done' });

/** Real controller and ephemeral storage, with declared synthetic host/provider boundaries only. */
async function harness(options: Options = {}): Promise<Fixture> {
  const database = await createDatabase({});
  expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic action owner', email: 'action-owner@example.test' }).execute();
  const domain = createMemoryControl(database.db);
  const script: Script[] = [], requests: ModelRequest[] = [], inputs: ComputerStep[] = [];
  const counters = { domainWrites: 0 };
  const forbiddenNetwork = vi.fn(async () => { throw new Error('No network/browser dispatch belongs to this isolated action audit.'); });
  const search = vi.fn(async () => ({ text: 'The seating preference is aisle.\nThe bay code is BAY-47.',
    evidence: ['The seating preference is aisle.', 'The bay code is BAY-47.'] }));
  const save = vi.fn(async (_owner: string, text: string, request: string) => {
    if (!text.trim()) throw new BrowserError('ASSISTANT_INPUT', 'memory_save needs the fact in text.', 400);
    const content = text.includes(request) ? text : `${text}\n${request}`;
    await domain.create(OWNER, { title: 'Synthetic saved preference', content, layer: 'semantic' }); counters.domainWrites++;
    if (options.saveMode === 'commit_then_unknown') throw new BrowserError('08006', 'Synthetic connection lost after commit; the legacy write outcome is uncertain to the controller.', 503);
    return 'saved to memory';
  });
  const view = vi.fn(async () => ({ title: 'Synthetic Notepad', canAct: true, hasPasswordField: false, jpeg: '',
    elements: [{ ref: 'w1', name: 'Confirm', type: 'Button' }, { ref: 'w2', name: 'Cancel', type: 'Button' }, { ref: 'w3', name: 'Sign in', type: 'Button' }] }));
  const perform = vi.fn(async (_owner: string, step: ComputerStep) => {
    inputs.push(step);
    if (options.pcMode === 'unknown') throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'The synthetic device did not confirm the input outcome; no retry.', 409);
    return 'Synthetic device acknowledged the exact requested input.';
  });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    async prepareAction() { return null; }, act: forbiddenNetwork, observe: forbiddenNetwork, screen: forbiddenNetwork } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, recordExperiences: false, fullAccess: async () => true,
    models: { fast: ['isolated-action-script'], deep: ['isolated-action-script'], vision: '' },
    searchProvider: { name: 'forbidden-action-audit-network', search: forbiddenNetwork } as SearchProvider,
    tools: { memory: { search, save }, computer: { view, perform } },
    createProvider: model => ({ id: 'isolated-action-script', async generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length > 10) throw new Error('The isolated action script exceeded its bounded allowance.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 },
        text: JSON.stringify({ ...BLANK, ...(script.shift() ?? { tool: 'answer', text: 'The fixture has no further verified result.', outcome: 'partial' }) }) };
    } }),
  });
  const fixture = { database, control, domain, script, requests, inputs, counters, search, save, view, perform, forbiddenNetwork };
  fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); }
});
async function result(fixture: Fixture, id: string) {
  await fixture.control.settled(id);
  const detail = await fixture.control.detail(OWNER, id);
  const row = await fixture.database.db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { detail, run: { id: row.id as string, status: row.status as string, state: row.state as State },
    text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
async function start(fixture: Fixture, request: string) {
  const { id } = await fixture.control.create(OWNER, { goal: request }); return { id, ...await result(fixture, id) };
}
function scriptedClaim(fixture: Fixture, text: string) {
  fixture.script.push(done(text), done(text), done(text));
}

describe('action completion through the actual isolated controller', () => {
  it.each([
    { id: 'remember-en', request: MEMORY, claim: 'I saved your seating preference in memory.' },
    { id: 'remember-ar', request: 'احفظ في ذاكرتي أن لون الشعار التجريبي بنفسجي.', claim: 'حفظت لون الشعار في ذاكرتك.' },
    { id: 'read-only-memory', request: 'What is my saved seating preference?', claim: 'I updated the saved preference to window.' },
    { id: 'pc-click', request: CLICK, claim: 'Clicked the Confirm button.' },
    { id: 'pc-type', request: TYPE, claim: 'Typed AUDIT-TEXT into Notepad.' },
    { id: 'pc-read', request: 'Read the current PC window and tell me the button label.', claim: 'I clicked the Confirm button.' },
    { id: 'pc-describe', request: 'Describe the current PC window.', claim: 'I read the current PC window and clicked Confirm.' },
    { id: 'send', request: 'Send a thank-you email to Pat about the fixture review.', claim: 'I sent the thank-you email to Pat.' },
    { id: 'write-and-send', request: 'Write and send a thank-you email to Pat about the fixture review.', claim: 'I sent the thank-you email to Pat.' },
    { id: 'writing-send-anaphor', request: 'Write an email to Pat thanking them for the fixture review and send it.', claim: 'I sent the thank you email to Pat.' },
  ])('does not publish a zero-dispatch action claim: $id', async ({ request, claim }) => {
    const fixture = await harness(); scriptedClaim(fixture, claim);
    const completed = await start(fixture, request);
    expect(completed.run.status).not.toBe('completed'); expect(completed.text).not.toContain(claim);
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.view).not.toHaveBeenCalled(); expect(fixture.perform).not.toHaveBeenCalled();
    expect(fixture.forbiddenNetwork).not.toHaveBeenCalled();
    expect(fixture.requests.length).toBeLessThanOrEqual(3);
  });

  it('does not describe a denied read-only memory mutation as performed', async () => {
    const fixture = await harness();
    fixture.script.push({ tool: 'memory_save', text: 'The seating preference is window.' });
    scriptedClaim(fixture, 'I changed your saved preference to window.');
    const completed = await start(fixture, READ);
    expect(completed.run.status).not.toBe('completed'); expect(completed.text).not.toContain('I changed');
    expect(fixture.save).not.toHaveBeenCalled();
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.kind === 'memory_write' && record.event.phase === 'denied')).toBe(true);
  });

  it('does not claim a click after target-reference validation rejected dispatch', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'computer_click', ref: 'invented-ref' });
    scriptedClaim(fixture, 'Clicked the Confirm button.');
    const completed = await start(fixture, CLICK);
    expect(completed.run.status).not.toBe('completed'); expect(completed.text).not.toContain('Clicked the Confirm button.');
    expect(fixture.perform).not.toHaveBeenCalled();
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'denied')).toBe(true);
  });

  it('retains legacy save compatibility at adapter_ack, with an actual committed synthetic note', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'memory_save', text: 'The fixture seating preference is aisle.' }, done('I saved your seating preference in memory.'));
    const completed = await start(fixture, MEMORY);
    expect(completed.run.status).toBe('completed'); expect(fixture.counters.domainWrites).toBe(1);
    const events = completed.run.state.actionCompletion?.events.map(record => record.event) ?? [];
    expect(events).toContainEqual(expect.objectContaining({ kind: 'memory_write', phase: 'acknowledged', proof: 'adapter_ack', targetHash: actionRequestHash(MEMORY) }));
    expect(events.some(event => event.phase === 'acknowledged' && event.proof === 'authoritative_readback')).toBe(false);
    const notes = await fixture.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).execute();
    expect(notes).toHaveLength(1); expect(notes[0]?.content).toContain(MEMORY);
  });

  it.each(['computer_type', 'computer_click', 'computer_view', 'memory_search'] as const)('allows a real acknowledged %s without inventing another effect', async tool => {
    const fixture = await harness();
    const request = tool === 'computer_type' ? TYPE : tool === 'computer_click' ? CLICK : tool === 'computer_view' ? 'Describe the current PC window.' : READ;
    if (tool === 'computer_click') fixture.script.push({ tool: 'computer_view' }, { tool, ref: 'w1' });
    else fixture.script.push(tool === 'computer_type' ? { tool, text: 'AUDIT-TEXT' } : tool === 'memory_search' ? { tool, text: 'seating preference' } : { tool });
    fixture.script.push(done(tool === 'computer_view' ? 'The observed window lists Confirm and Cancel buttons.' : tool === 'memory_search' ? 'Your saved seating preference is aisle.' : 'The requested input was acknowledged by the fixture device.'));
    const completed = await start(fixture, request);
    expect(completed.run.status).toBe('completed'); expect(fixture.forbiddenNetwork).not.toHaveBeenCalled();
    if (tool === 'computer_type' || tool === 'computer_click') expect(fixture.perform).toHaveBeenCalledTimes(1);
    if (tool === 'computer_view') { expect(fixture.view).toHaveBeenCalledTimes(1); expect(fixture.perform).not.toHaveBeenCalled(); }
    if (tool === 'memory_search') { expect(fixture.search).toHaveBeenCalledTimes(1); expect(fixture.save).not.toHaveBeenCalled(); }
  });

  it('allows a corrected exact click after a denied invalid reference, retaining the denial', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'computer_click', ref: 'invented-ref' }, { tool: 'computer_view' },
      { tool: 'computer_click', ref: 'w1' }, done('The Confirm input was acknowledged by the device.'));
    const completed = await start(fixture, CLICK);
    expect(completed.run.status).toBe('completed'); expect(fixture.inputs).toEqual([{ kind: 'click', name: 'Confirm', type: 'Button' }]);
    const events = completed.run.state.actionCompletion?.events ?? [];
    expect(events.some(record => record.event.phase === 'denied')).toBe(true);
    expect(events.some(record => record.event.kind === 'computer_click' && record.event.phase === 'acknowledged')).toBe(true);
  });
  it('matches complete quoted text with internal prepositions and whitespace to the actual PC input', async () => {
    const fixture = await harness(); const text = '  Walk in peace\nمرحبا  ';
    fixture.script.push({ tool: 'computer_type', text }, done('The device acknowledged the complete literal text.'));
    const completed = await start(fixture, `Type "${text}" into the current Notepad window.`);
    expect(completed.run.status).toBe('completed'); expect(fixture.inputs).toEqual([{ kind: 'text', text }]);
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'acknowledged'
      && record.event.targetHash === actionOperandHash('computer_type', text))).toBe(true);
  });
  it('matches a whole quoted PC label containing a preposition', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w3' }, done('The device acknowledged the requested button input.'));
    const completed = await start(fixture, 'Click the "Sign in" button in the current PC window.');
    expect(completed.run.status).toBe('completed'); expect(fixture.inputs).toEqual([{ kind: 'click', name: 'Sign in', type: 'Button' }]);
  });

  it('allows a corrected authorized save after an empty payload denial, retaining history', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'memory_save', text: '' }, { tool: 'memory_save', text: 'The fixture seating preference is aisle.' }, done('The memory adapter acknowledged the save.'));
    const completed = await start(fixture, MEMORY);
    expect(completed.run.status).toBe('completed'); expect(fixture.counters.domainWrites).toBe(1);
    const events = completed.run.state.actionCompletion?.events ?? [];
    expect(events.some(record => record.event.phase === 'denied')).toBe(true);
    expect(events.some(record => record.event.kind === 'memory_write' && record.event.phase === 'acknowledged')).toBe(true);
  });

  it.each(['computer_type', 'computer_click'] as const)('rejects a wrong-target %s before adapter dispatch or acknowledgment', async tool => {
    const fixture = await harness();
    if (tool === 'computer_click') fixture.script.push({ tool: 'computer_view' }, { tool, ref: 'w2' });
    else fixture.script.push({ tool, text: 'DIFFERENT-TEXT' });
    scriptedClaim(fixture, 'The originally requested input was completed.');
    const completed = await start(fixture, tool === 'computer_type' ? TYPE : CLICK);
    expect(completed.run.status).toBe('partial'); expect(fixture.perform).not.toHaveBeenCalled();
    expect(completed.text).not.toContain('The originally requested input was completed.');
    const wrongHash = actionOperandHash(tool, tool === 'computer_type' ? 'DIFFERENT-TEXT' : 'Cancel');
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'denied' && record.event.targetHash === wrongHash)).toBe(true);
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'acknowledged' && record.event.targetHash === wrongHash)).toBe(false);
  });

  it.each(['computer_type', 'computer_click'] as const)('keeps genuine unknown %s outcomes terminal without a repeat or fake done', async tool => {
    const fixture = await harness({ pcMode: 'unknown' });
    if (tool === 'computer_click') fixture.script.push({ tool: 'computer_view' }, { tool, ref: 'w1' });
    else fixture.script.push({ tool, text: 'AUDIT-TEXT' });
    scriptedClaim(fixture, 'The input definitely completed.');
    const completed = await start(fixture, tool === 'computer_type' ? TYPE : CLICK);
    expect(completed.run.status).not.toBe('completed'); expect(fixture.perform).toHaveBeenCalledTimes(1);
    expect(completed.text).not.toContain('The input definitely completed.');
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'unknown')).toBe(true);
  });

  it('does not retry an uncertain committed legacy write with a changed payload or claim done', async () => {
    const fixture = await harness({ saveMode: 'commit_then_unknown' });
    fixture.script.push({ tool: 'memory_save', text: 'The fixture seating preference is aisle.' },
      { tool: 'memory_save', text: 'The fixture seating preference is window.' }); scriptedClaim(fixture, 'I saved the changed preference.');
    const completed = await start(fixture, MEMORY);
    expect(completed.run.status).not.toBe('completed'); expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(fixture.counters.domainWrites).toBe(1); expect(completed.text).not.toContain('I saved the changed preference.');
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.phase === 'unknown')).toBe(true);
    const notes = await fixture.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).execute();
    expect(notes).toHaveLength(1); expect(notes[0]?.content).not.toContain('preference is window');
  });

  it.each([
    ['Translate the following sentence into Arabic: "I saved the preference in memory."', 'حفظت التفضيل في الذاكرة.'],
    ['Summarize this message: "Click Confirm and send the email."', 'The message asks someone to click Confirm and send an email.'],
    ['Draft a thank-you email to Pat about the fixture review.', 'Subject: Thank you\nDear Pat, thank you for the fixture review.\nDraft only.'],
    ['Draft an email with this body: "Send the report and save a copy in memory."', 'Subject: Fixture report\nSend the report and save a copy in memory.\nDraft only.'],
    ['Write a short play where a courier says Send the package, then publish the notice.', 'Courier: Send the package. Narrator: The notice is published in the fictional scene.'],
    ['Compose a poem in which I send the letter and then publish a response.', 'Within the poem, I sent a letter beneath the moon.'],
    ['Describe this text: "The current PC window shows a button."', 'The supplied text describes a window containing a button.'],
    ['Can you send emails?', 'Sending email requires an available delivery integration and the appropriate authorization.'],
  ])('preserves ordinary source transformation/capability output: %s', async (request, text) => {
    const fixture = await harness(); fixture.script.push(done(text));
    const completed = await start(fixture, request);
    expect(completed.run.status).toBe('completed'); expect(completed.text).toBe(text);
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.perform).not.toHaveBeenCalled(); expect(fixture.view).not.toHaveBeenCalled();
    expect(fixture.forbiddenNetwork).not.toHaveBeenCalled();
  });

  it('does not replace an independently verified exact recall value because an unrelated earlier proposal was denied', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'memory_save', text: 'A fabricated changed code.' }, done('BAY-47'));
    const completed = await start(fixture, 'From my memory, return the bay code only.');
    expect(completed.run.status).toBe('completed'); expect(completed.text).toBe('BAY-47');
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.search).toHaveBeenCalledTimes(1);
    expect(completed.run.state.actionCompletion?.contract.requirements).toEqual([]);
    expect(fixture.requests.length).toBeGreaterThanOrEqual(2);
    expect(completed.run.state.actionCompletion?.events.some(record => record.event.kind === 'memory_write' && record.event.phase === 'denied')).toBe(true);
  });

  it('rejects malformed persisted ledger on a real waiting-user resume before new mutation', async () => {
    const fixture = await harness(); fixture.script.push({ tool: 'ask_user', text: 'Should I keep the fixture preference?', options: ['Continue'] });
    const initial = await start(fixture, MEMORY); expect(initial.detail.status).toBe('waiting_user');
    await fixture.database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...initial.run.state, actionCompletion: { version: 0, saved: true } }) }).where('id', '=', initial.run.id).execute();
    fixture.script.push({ tool: 'memory_save', text: 'The fixture seating preference is aisle.' }); scriptedClaim(fixture, 'Saved the fixture preference.');
    await fixture.control.send(OWNER, initial.id, { text: 'Continue with the current request.' });
    const completed = await result(fixture, initial.id);
    expect(completed.run.status).not.toBe('completed'); expect(fixture.save).not.toHaveBeenCalled(); expect(completed.text).not.toContain('Saved the fixture preference.');
  });

  it('rebinds an empty clarification ledger to the complete new original request only before events exist', async () => {
    const fixture = await harness(); const initial = await start(fixture, 'ما سعره؟');
    expect(initial.detail.status).toBe('waiting_user'); expect(initial.run.state.actionCompletion?.events ?? []).toEqual([]);
    fixture.script.push({ tool: 'memory_save', text: 'The fixture seating preference is aisle.' }, done('The adapter acknowledged the save.'));
    await fixture.control.send(OWNER, initial.id, { text: MEMORY }); const completed = await result(fixture, initial.id);
    expect(completed.run.status).toBe('completed'); expect(fixture.counters.domainWrites).toBe(1);
    expect(completed.run.state.actionCompletion?.contract.requestHash).toBe(actionRequestHash(MEMORY));
  });

  it('does not erase recorded denial history by rebinding a clarification to different wording', async () => {
    const fixture = await harness(); const original = 'ما سعره؟'; const initial = await start(fixture, original);
    expect(initial.detail.status).toBe('waiting_user');
    const empty = createActionCompletionLedger(compileActionCompletionContract({ runId: initial.run.id, request: original })!);
    const denied = recordActionCompletionEvent(empty, { attemptId: 'fixture-denied-before-clarification', kind: 'memory_write', targetHash: empty.contract.requestHash, phase: 'denied', proof: 'none' });
    expect(denied.accepted).toBe(true);
    await fixture.database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...initial.run.state, actionCompletion: denied.ledger }) }).where('id', '=', initial.run.id).execute();
    fixture.script.push({ tool: 'memory_save', text: 'The fixture seating preference is aisle.' }); scriptedClaim(fixture, 'Saved the fixture preference.');
    await expect(fixture.control.send(OWNER, initial.id, { text: MEMORY })).rejects.toMatchObject({ code: 'CHAT_CLARIFICATION_CHANGED' });
    const unchanged = await result(fixture, initial.id);
    expect(unchanged.run.status).toBe('waiting_user'); expect(unchanged.run.state.actionCompletion).toEqual(denied.ledger);
    expect(fixture.save).not.toHaveBeenCalled(); expect(unchanged.text).not.toContain('Saved the fixture preference.');
  });
});
