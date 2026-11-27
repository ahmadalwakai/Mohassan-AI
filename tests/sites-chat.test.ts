/**
 * The owner's sentence through the real chat, with no model: one card for what the sentence did not say,
 * the site composed from the answers, a preview link in the reply, then plain-language edits and a content
 * question that is answered in the next message. The sites control runs on the same embedded database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createSitesControl } from '../apps/server/src/sites.js';

const owner = 'isolated-sites-owner';
const member = 'isolated-sites-member';
// Site publish gate and existing copy, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/sites.ts#L310-L314
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/site-builder.ts#L73-L80
describe('a website through the real chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let sites: Awaited<ReturnType<typeof createSitesControl>>;
  const external = vi.fn(async () => { throw new Error('A website request is never a public lookup.'); });
  beforeAll(async () => {
    database = await createDatabase(); await migrate(database.db);
    sites = await createSitesControl(database.db, { tokenSecret: 'sites-chat-token-secret-000000000001' });
    control = await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
      models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'forbidden-site-search', search: external } as SearchProvider,
      fullAccess: async ownerId => ownerId === owner,
      sites: { createFromBrief: (ownerId, brief, options) => sites.create(ownerId, { brief, ...options }), command: (ownerId, siteId, input) => sites.command(ownerId, siteId, input), detail: (ownerId, siteId) => sites.detail(ownerId, siteId), roleOf: async ownerId => ownerId === member ? 'member' : 'owner' },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function settled(id: string, account: string) {
    await control.settled(id);
    const detail = await control.detail(account, id);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(external).not.toHaveBeenCalled();
    return { detail, run, text: detail.messages.at(-1)?.text ?? '' };
  }

  it.each([owner, member])('asks once, builds the site and edits it by sentence for %s', async account => {
    const { id } = await control.create(account, { goal: 'أريد موقعاً لمطعم «بيت الشام» في دمشق فيه الأسئلة الشائعة' });
    const first = await settled(id, account);
    expect(first.detail.status).toBe('waiting_user');
    const fields = first.detail.question!.fields!.map(field => field.id);
    expect(fields).toEqual(expect.arrayContaining(['items', 'contact', 'faq']));
    expect(fields).not.toContain('name');
    expect(fields).not.toContain('city');
    expect(first.detail.question!.prompt).toContain('بيت الشام');

    const answers: Record<string, string> = { items: 'شاورما لحم - 25\nفتوش - 12\nكنافة - 15', contact: '0933123456 واتساب', faq: 'هل يوجد توصيل؟\nنعم داخل المدينة.', hours: 'يومياً ١١ صباحاً - ١٢ منتصف الليل', colour: 'ذهبي' };
    await control.send(account, id, { text: 'الإجابات', questionId: first.detail.question!.id, answers: first.detail.question!.fields!.map(field => ({ fieldId: field.id, value: answers[field.id] ?? 'لا' })) });
    const built = await settled(id, account);
    expect(built.run.status).toBe('completed');
    expect(built.text).toContain('بيت الشام');
    expect(built.text).toMatch(/\/#sites=[0-9a-f-]{36}/);
    expect(built.text).toContain('ZIP');
    expect(built.text.includes('أو تنشره')).toBe(account === owner);
    const list = await sites.list(account);
    expect(list).toHaveLength(1);
    const site = await sites.detail(account, list[0]!.id);
    expect(site.brief.items).toHaveLength(3);
    expect(site.brief.whatsapp).toBe('0933123456');
    expect(site.brief.primary).toBe('#a16207');
    expect(site.brief.pages.flatMap(page => page.blocks.map(block => block.type))).toEqual(expect.arrayContaining(['hero', 'items', 'faq', 'hours', 'contact']));
    expect(site.checks.passed).toBe(true);

    await control.send(account, id, { text: 'غيّر اللون إلى أزرق' });
    const recoloured = await settled(id, account);
    expect(recoloured.run.status).toBe('completed');
    expect(recoloured.text).toContain('أزرق');
    expect((await sites.detail(account, site.id)).brief.primary).toBe('#1d4ed8');

    await control.send(account, id, { text: 'أضف قسم الفريق' });
    const asked = await settled(id, account);
    expect(asked.text).toContain('الفريق');
    await control.send(account, id, { text: 'أبو أحمد - الشيف\nسامر - مدير الصالة' });
    const team = await settled(id, account);
    expect(team.run.status).toBe('completed');
    const updated = await sites.detail(account, site.id);
    const teamBlock = updated.brief.pages.flatMap(page => page.blocks).find(block => block.type === 'team');
    expect(teamBlock && teamBlock.type === 'team' ? teamBlock.members.map(member => member.name) : []).toEqual(['أبو أحمد', 'سامر']);
    expect(updated.revision).toBeGreaterThan(site.revision);
  });

  it.each([owner, member])('asks for the name and contact in one card for %s', async account => {
    const { id } = await control.create(account, { goal: 'build me a website for my plumbing business' });
    const first = await settled(id, account);
    expect(first.detail.status).toBe('waiting_user');
    const fields = first.detail.question!.fields!.map(field => field.id);
    expect(fields).toEqual(expect.arrayContaining(['name', 'items', 'contact']));
    expect(fields.length).toBeLessThanOrEqual(6);
    await control.send(account, id, { text: 'answers', questionId: first.detail.question!.id, answers: first.detail.question!.fields!.map(field => ({ fieldId: field.id, value: ({ name: 'Swift Plumbing', items: 'Boiler servicing - £85\nLeak repairs', contact: '07700 900123 WhatsApp', city: 'Manchester', colour: 'teal' } as Record<string, string>)[field.id] ?? 'no' })) });
    const built = await settled(id, account);
    expect(built.run.status).toBe('completed');
    expect(built.text).toContain('Swift Plumbing');
    expect(built.text).toContain('Open the preview');
    expect(built.text).toContain('ZIP');
    expect(built.text.includes('or publish it')).toBe(account === owner);
  });
});
