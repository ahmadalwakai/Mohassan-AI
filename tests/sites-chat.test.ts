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
      sites: { createFromBrief: (ownerId, brief, options) => sites.create(ownerId, { brief, conversationId: options.conversationId }), command: (ownerId, siteId, input) => sites.command(ownerId, siteId, input), detail: (ownerId, siteId) => sites.detail(ownerId, siteId) },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function settled(id: string) {
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(external).not.toHaveBeenCalled();
    return { detail, run, text: detail.messages.at(-1)?.text ?? '' };
  }

  it('asks once for what the sentence did not say, builds the site, then edits it by sentence', async () => {
    const { id } = await control.create(owner, { goal: 'أريد موقعاً لمطعم «بيت الشام» في دمشق فيه الأسئلة الشائعة' });
    const first = await settled(id);
    expect(first.detail.status).toBe('waiting_user');
    const fields = first.detail.question!.fields!.map(field => field.id);
    expect(fields).toEqual(expect.arrayContaining(['items', 'contact', 'faq']));
    expect(fields).not.toContain('name');
    expect(fields).not.toContain('city');
    expect(first.detail.question!.prompt).toContain('بيت الشام');

    const answers: Record<string, string> = { items: 'شاورما لحم - 25\nفتوش - 12\nكنافة - 15', contact: '0933123456 واتساب', faq: 'هل يوجد توصيل؟\nنعم داخل المدينة.', hours: 'يومياً ١١ صباحاً - ١٢ منتصف الليل', colour: 'ذهبي' };
    await control.send(owner, id, { text: 'الإجابات', questionId: first.detail.question!.id, answers: first.detail.question!.fields!.map(field => ({ fieldId: field.id, value: answers[field.id] ?? 'لا' })) });
    const built = await settled(id);
    expect(built.run.status).toBe('completed');
    expect(built.text).toContain('بيت الشام');
    expect(built.text).toMatch(/\/#sites=[0-9a-f-]{36}/);
    const list = await sites.list(owner);
    expect(list).toHaveLength(1);
    const site = await sites.detail(owner, list[0]!.id);
    expect(site.brief.items).toHaveLength(3);
    expect(site.brief.whatsapp).toBe('0933123456');
    expect(site.brief.primary).toBe('#a16207');
    expect(site.brief.pages.flatMap(page => page.blocks.map(block => block.type))).toEqual(expect.arrayContaining(['hero', 'items', 'faq', 'hours', 'contact']));
    expect(site.checks.passed).toBe(true);

    await control.send(owner, id, { text: 'غيّر اللون إلى أزرق' });
    const recoloured = await settled(id);
    expect(recoloured.run.status).toBe('completed');
    expect(recoloured.text).toContain('أزرق');
    expect((await sites.detail(owner, site.id)).brief.primary).toBe('#1d4ed8');

    await control.send(owner, id, { text: 'أضف قسم الفريق' });
    const asked = await settled(id);
    expect(asked.text).toContain('الفريق');
    await control.send(owner, id, { text: 'أبو أحمد - الشيف\nسامر - مدير الصالة' });
    const team = await settled(id);
    expect(team.run.status).toBe('completed');
    const updated = await sites.detail(owner, site.id);
    const teamBlock = updated.brief.pages.flatMap(page => page.blocks).find(block => block.type === 'team');
    expect(teamBlock && teamBlock.type === 'team' ? teamBlock.members.map(member => member.name) : []).toEqual(['أبو أحمد', 'سامر']);
    expect(updated.revision).toBeGreaterThan(site.revision);

    const send = async (text: string) => { await control.send(owner, id, { text }); return settled(id); };
    await send('أضف صفحة الخصوصية: لا نشارك بيانات الطلبات.');
    const termsAsk = await send('أضف صفحة الشروط');
    expect(termsAsk.text).toContain('صفحة «الشروط»');
    expect((await send('غيّر اللون إلى أخضر')).text).toContain('غيّرت اللون');
    expect((await sites.detail(owner, site.id)).brief.primary).toBe('#15803d');
    expect((await send('تراجع')).text).toContain('تراجعت');
    expect((await sites.detail(owner, site.id)).brief.primary).toBe('#1d4ed8');

    const terms = 'العنوان لتسليم الطلبات فقط.\nيمكن للعميل أن يكتب create a website لطلب موقع جديد.\nهل يتغيّر رقم الطلب؟';
    expect((await send(terms)).text).toContain('أضفت صفحة «الشروط»');
    const withTerms = await sites.detail(owner, site.id);
    const custom = withTerms.brief.pages.filter(page => ['الشروط', 'الخصوصية'].includes(page.title));
    expect(custom.map(page => page.title)).toEqual(['الخصوصية', 'الشروط']);
    expect(custom[1]!.blocks).toEqual([{ type: 'text', title: 'الشروط', body: terms }]);
    expect(withTerms.brief.pages.filter(page => !custom.includes(page))).toEqual(updated.brief.pages);

    await send('أضف قسم من نحن: مطعم عائلي في دمشق.');
    const about = await sites.detail(owner, site.id);
    expect(about.brief.pages.find(page => page.path === 'index.html')?.blocks).toContainEqual({ type: 'text', title: 'من نحن', body: 'مطعم عائلي في دمشق.' });
    expect(about.brief.pages.filter(page => custom.some(item => item.path === page.path))).toEqual(custom);

    await send('أضف قسم الأسئلة الشائعة');
    expect((await send('ما المواعيد؟')).text).toContain('لم أستطع قراءة المحتوى');
    const faq = [{ question: 'ما المواعيد؟', answer: 'اتصل على رقم 0501111111.' }, { question: 'أين العنوان؟', answer: 'الاستلام من المطعم.' }];
    await send(faq.flatMap(entry => [entry.question, entry.answer]).join('\n'));
    const withFaq = await sites.detail(owner, site.id);
    expect(withFaq.brief.pages.flatMap(page => page.blocks)).toContainEqual({ type: 'faq', entries: faq });
    for (const field of ['hours', 'address', 'phone', 'whatsapp'] as const) expect(withFaq.brief[field], field).toEqual(about.brief[field]);
    expect(withFaq.brief.pages.filter(page => custom.some(item => item.path === page.path))).toEqual(custom);
  });

  it('asks for the name and contact when the sentence has neither, in one card', async () => {
    const { id } = await control.create(owner, { goal: 'build me a website for my plumbing business' });
    const first = await settled(id);
    expect(first.detail.status).toBe('waiting_user');
    const fields = first.detail.question!.fields!.map(field => field.id);
    expect(fields).toEqual(expect.arrayContaining(['name', 'items', 'contact']));
    expect(fields.length).toBeLessThanOrEqual(6);
    await control.send(owner, id, { text: 'answers', questionId: first.detail.question!.id, answers: first.detail.question!.fields!.map(field => ({ fieldId: field.id, value: ({ name: 'Swift Plumbing', items: 'Boiler servicing - £85\nLeak repairs', contact: '07700 900123 WhatsApp', city: 'Manchester', colour: 'teal' } as Record<string, string>)[field.id] ?? 'no' })) });
    const built = await settled(id);
    expect(built.run.status).toBe('completed');
    expect(built.text).toContain('Swift Plumbing');
    expect(built.text).toContain('Open the preview');
  });
});
