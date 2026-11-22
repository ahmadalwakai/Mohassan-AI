import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { parseDesktopCommand, describeDesktopCommand, type DesktopCommand, type DesktopOutcome } from '@mohassan/desktop';
import { createCommandChatControl, type DesktopChatPort } from '../apps/server/src/command-chat.js';

/**
 * The chat's desktop path without a model: a plain sentence about the owner's computer
 * reaches the desktop port once, deleting waits for a yes, and a refusal stops the run.
 * The port is synthetic; no file, window or process is touched here.
 */
const OWNER = 'isolated-desktop-chat-owner';
interface Fixture { database: Awaited<ReturnType<typeof createDatabase>>; control: Awaited<ReturnType<typeof createCommandChatControl>>; execute: ReturnType<typeof vi.fn>; forbidden: ReturnType<typeof vi.fn> }
const fixtures: Fixture[] = [];

async function fixture(options: { restricted?: boolean; withoutDesktop?: boolean } = {}): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db);
  await sql`CREATE TABLE fixture_desktop_account(owner_id text PRIMARY KEY, active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_desktop_account').values({ owner_id: OWNER, active: true }).execute();
  const forbidden = vi.fn(async (..._args: unknown[]): Promise<never> => { throw new Error('The desktop path must not touch the browser, search, memory or a model.'); });
  const execute = vi.fn(async (command: DesktopCommand, options: { approved: boolean; lang: 'ar' | 'en' }): Promise<DesktopOutcome> => {
    if (command.kind === 'file_delete' && !options.approved) return { status: 'needs_approval', text: 'سأنقل الملف إلى سلة المحذوفات. هل أتابع؟', approval: { prompt: `أريد نقل الملف «${command.path}» إلى سلة المحذوفات. هل أتابع؟`, detail: 'لا حذف نهائي.', label: `حذف ${command.path}` } };
    if (command.kind === 'file_delete') return { status: 'completed', text: `نقلت الملف \`${command.path}\` إلى سلة المحذوفات.` };
    if (command.kind === 'project_create') return { status: 'completed', text: `أنشأت مشروع **${command.name}** (${command.template}) في \`~\\Mohassan Projects\\${command.name}\`.` };
    if (command.kind === 'window_list') return { status: 'completed', text: 'النوافذ المفتوحة (1):\n- ▶ **Fixture window** — fixture' };
    return { status: 'blocked', text: `unsupported fixture command ${command.kind}` };
  });
  const desktop: DesktopChatPort = { parse: text => parseDesktopCommand(text), describe: (command, lang) => describeDesktopCommand(command, lang), execute: execute as unknown as DesktopChatPort['execute'] };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async dropHeld() {}, async close() {}, act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false, leaseMs: 60000,
    fullAccess: async () => !options.restricted,
    accountActive: async (ownerId, transaction) => Boolean(await transaction.selectFrom('fixture_desktop_account').select('owner_id').where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    tools: { memory: { search: forbidden, save: forbidden } },
    ...(options.withoutDesktop ? {} : { desktop }),
    searchProvider: { name: 'forbidden-desktop-network', search: forbidden } as SearchProvider,
    models: { fast: [], deep: [], vision: '' },
  });
  const built: Fixture = { database, control, execute, forbidden };
  fixtures.push(built);
  return built;
}

async function settled(control: Fixture['control'], id: string, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const conversation = await control.detail(OWNER, id);
    if (conversation.status !== 'running') return conversation;
    if (Date.now() > until) throw new Error(`conversation ${id} still running: ${JSON.stringify(conversation.steps)}`);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

afterEach(async () => { for (const built of fixtures.splice(0)) { await built.control.shutdown(); await built.database.close(); } });

describe('desktop commands in the chat', () => {
  it('runs a plain project sentence through the desktop port once and reports its text', async () => {
    const built = await fixture();
    const { id } = await built.control.create(OWNER, { goal: 'أنشئ مشروع ويب اسمه متجري' });
    const conversation = await settled(built.control, id);
    expect(conversation.status).toBe('idle');
    expect(built.execute).toHaveBeenCalledTimes(1);
    expect(built.execute.mock.calls[0]![0]).toMatchObject({ kind: 'project_create', name: 'متجري', template: 'web' });
    expect(built.execute.mock.calls[0]![1]).toMatchObject({ approved: false, lang: 'ar' });
    const reply = conversation.messages.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.text).toContain('أنشأت مشروع **متجري**');
    expect(conversation.steps.map(step => step.text)).toContain('إنشاء مشروع متجري');
    expect(built.forbidden).not.toHaveBeenCalled();
  });

  it('asks before deleting, then deletes only after the owner approves', async () => {
    const built = await fixture();
    const { id } = await built.control.create(OWNER, { goal: 'احذف ملف old.txt من سطح المكتب' });
    const waiting = await settled(built.control, id);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval?.prompt).toContain('سلة المحذوفات');
    expect(built.execute).toHaveBeenCalledTimes(1);
    await built.control.approve(OWNER, id, { approvalId: waiting.approval!.id, approved: true });
    const done = await settled(built.control, id);
    expect(done.status).toBe('idle');
    expect(built.execute).toHaveBeenCalledTimes(2);
    expect(built.execute.mock.calls[1]![1]).toMatchObject({ approved: true });
    expect(done.messages.at(-1)!.text).toContain('سلة المحذوفات');
    expect(built.forbidden).not.toHaveBeenCalled();
  });

  it('stops without acting when the owner refuses', async () => {
    const built = await fixture();
    const { id } = await built.control.create(OWNER, { goal: 'delete the file old.txt in Downloads' });
    const waiting = await settled(built.control, id);
    expect(waiting.status).toBe('waiting_approval');
    await built.control.approve(OWNER, id, { approvalId: waiting.approval!.id, approved: false });
    const done = await settled(built.control, id);
    expect(done.status).toBe('idle');
    expect(built.execute).toHaveBeenCalledTimes(1);
    expect(done.messages.at(-1)!.text).toContain('did not perform');
  });

  it('keeps the desktop closed to a restricted account and to a server without the engine', async () => {
    const restricted = await fixture({ restricted: true });
    const first = await restricted.control.create(OWNER, { goal: 'ما النوافذ المفتوحة؟' });
    const refused = await settled(restricted.control, first.id);
    expect(refused.status).toBe('idle');
    expect(restricted.execute).not.toHaveBeenCalled();
    const absent = await fixture({ withoutDesktop: true });
    const second = await absent.control.create(OWNER, { goal: 'ما النوافذ المفتوحة؟' });
    const unavailable = await settled(absent.control, second.id);
    expect(unavailable.status).toBe('idle');
    expect(absent.execute).not.toHaveBeenCalled();
  });
});
