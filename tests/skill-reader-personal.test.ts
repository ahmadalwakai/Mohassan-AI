import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { buildSkillSource } from '../packages/skills/src/importer.ts';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { LocalKnowledgeDocument } from '../apps/server/src/assistant/local-knowledge.js';
import { createSkillReader, skillReadable, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

describe('the personal reading mode', () => {
  it('reads a how-to about the owner’s own things', () => {
    for (const request of ['كيف أعمل تحليل SWOT لمشروعي؟', 'كيف أسعّر منتجي الجديد؟', 'ساعدني في تجهيز عرض تقديمي لمشروعي', 'من فضلك كيف أسوّق لمتجري؟',
      'how do I improve my resume?', 'how should I price my product?', 'help me plan my team’s sprint']) {
      expect(skillReadable(request, 'personal'), request).toBe(true);
    }
  });

  it('leaves a question about a stored fact to the owner’s memory and documents, whatever words follow', () => {
    for (const request of ['ما خطة مشروعي؟', 'ما ميزانية حملتي؟', 'ما هي خطة مشروعي؟', 'كم راتبي الشهري؟', 'هل دفعت فاتورة موقعي؟', 'وش اسم شركتي؟', 'من هو رئيس فريقي؟', 'متى موعدي مع الطبيب؟',
      'what is my project plan?', 'which pricing plan does my company use?', 'where is my business plan document?', 'how much did my store earn last month?', 'is my website domain renewed?']) {
      expect(skillReadable(request, 'personal'), request).toBe(false);
    }
  });

  it('answers no question about a stored fact of the owner from a skill, in any mode but writing', () => {
    for (const mode of ['advice', 'fallback', 'personal'] as const) {
      for (const request of ['ما هو بريدي الإلكتروني؟', 'ما خطة مشروعي؟', 'ما ميزانية حملتي؟', 'what is my project plan?', 'who is my project manager?']) {
        expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(false);
      }
    }
    // The same question words about a public subject stay readable where they were, and a writing task stays a writing task.
    expect(skillReadable('متى أستخدم present perfect في الإنجليزي', 'fallback')).toBe(true);
    expect(skillReadable('هل هذه الحجة منطقية ولا فيها مغالطة؟', 'fallback')).toBe(true);
    expect(skillReadable('اكتب مقالاً عن متجري', 'writing')).toBe(true);
  });

  it('needs a how-to cue, and never reads a live question', () => {
    expect(skillReadable('عرض تقديمي عن مشروعي للمستثمرين', 'personal')).toBe(false);
    expect(skillReadable('كيف حال طقس مدينتي اليوم؟', 'personal')).toBe(false);
  });

  it('reads a how-to that opens with a question word or names a day, and still refuses a stored fact or a live value', () => {
    // A question word followed by what to do, and a time word inside a how-to, ask for a method (both refused until 2026-11-22).
    for (const request of ['ماذا أفعل بعد اختراق حسابي؟', 'ما الخطوات بعد اختراق موقعنا؟', 'وش أسوي إذا انسرق جوالي؟', 'what should I check before I tell my team the bug is fixed',
      'what do I do if my laptop gets ransomware', 'our website got hacked, what should we do now?', 'عندي مقابلة عمل بكره كيف أستعد؟', 'how do I install the latest version of node']) {
      for (const mode of ['advice', 'personal'] as const) expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(true);
    }
    // No first-person verb or modal after the question word: a stored fact. A value asked with a time word, or a time word without a how-to: live.
    for (const request of ['وش كتبت في ملاحظاتي أمس؟', 'متى موعد اجتماع فريقي؟', 'ما هي خطة مشروعي؟', 'what did my manager say in the last email?', 'what time is my dentist appointment?',
      'which pricing plan does my company use?', 'كيف أعرف سعر الدولار اليوم؟', 'لخّص لي أهم أخبار اليوم', 'ذكرني بموعد الطبيب بكرة', 'كيف الجو اليوم؟', 'كيف الطقس غدا في الرياض؟',
      'what is the latest version of node', 'what is the weather tomorrow', 'وش نتيجة مباراة الاتحاد اليوم؟', 'how much is silver today']) {
      for (const mode of ['advice', 'fallback', 'personal'] as const) expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(false);
    }
  });
});

/** The shipped skills, served as if they were the owner's active, inspected skills. */
async function shippedSkills(): Promise<{ candidates: SkillReaderCandidate[]; bodies: Map<string, string> }> {
  const root = resolve('skills'), bodies = new Map<string, string>(), candidates: SkillReaderCandidate[] = [];
  for (const slug of (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const content = await readFile(join(root, slug, 'SKILL.md'), 'utf8');
    const { contract } = buildSkillSource([{ path: 'SKILL.md', content }], { root: `github:owner/skills:skills/${slug}`, defaultSlug: slug });
    candidates.push({ id: `id-${slug}`, slug, name: contract.name, description: contract.description, category: contract.category, version: contract.version, contentHash: 'c'.repeat(64) });
    bodies.set(`id-${slug}`, content.replace(/^---[\s\S]*?\n---\n/u, ''));
  }
  return { candidates, bodies };
}

// A request about «مشروعي» or "my store" is private: it goes to the owner's memory and evaluated documents and never to a
// public search. When those hold nothing, a how-to is answered by the skill that covers it; a question about a stored fact is not.
describe('a private how-to that memory and documents did not answer', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let withSkills: Awaited<ReturnType<typeof createCommandChatControl>>, withoutSkills: Awaited<ReturnType<typeof createCommandChatControl>>;
  let documents: LocalKnowledgeDocument[] = [];
  const search = vi.fn<SearchProvider['search']>(async () => { throw new Error('A private request must not be searched publicly.'); });
  const memory = vi.fn(async () => ({ text: 'no matching memory', evidence: [] as string[] }));
  const knowledge = vi.fn(async (_ownerId: string, _query: string) => documents);
  const reads: string[] = [];
  const owner = 'isolated-personal-skill-owner';

  beforeAll(async () => {
    database = await createDatabase(); await migrate(database.db);
    const { candidates, bodies } = await shippedSkills();
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    const base = { browser, models: { fast: [], deep: [], vision: '' }, knowledgeSearch: knowledge, searchProvider: { name: 'forbidden-public-search', search } as SearchProvider,
      tools: { memory: { search: memory, async save() { throw new Error('This check never saves memory.'); } } } };
    withSkills = await createCommandChatControl(database.db, { ...base,
      skillAnswer: createSkillReader({ candidates: async () => candidates, instructions: async (_ownerId, id) => { reads.push(id); return bodies.get(id) ?? null; } }) });
    withoutSkills = await createCommandChatControl(database.db, base);
  });
  beforeEach(() => { documents = []; reads.length = 0; vi.clearAllMocks(); });
  afterAll(async () => { await withSkills?.shutdown(); await withoutSkills?.shutdown(); await database?.close(); });

  async function run(control: typeof withSkills, goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const row = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { text: detail.messages.at(-1)?.text ?? '', error: detail.error, status: row.status, trail: (row.state.trail ?? []) as { action: string; result: string }[] };
  }

  it('answers the how-to from the matching skill, after the private sources and without a public search', async () => {
    const result = await run(withSkills, 'كيف أعمل تحليل SWOT لمشروعي؟');
    expect(result.error).toBeNull();
    expect(result.trail.find(entry => entry.action === 'skill_read')?.result).toMatch(/^swot-analysis \S+ \(personal\)/u);
    expect(reads).toEqual(['id-swot-analysis']);
    expect(result.text.startsWith('**تحليل SWOT**')).toBe(true);
    expect(result.text).toContain('المصدر: مهارة «تحليل SWOT» (swot-analysis)');
    expect(knowledge).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  // Refused by both reader gates until 2026-11-22: a question word before the how-to, or a day named inside it.
  it.each(['ما الخطوات لعمل تحليل SWOT لمشروعي؟', 'what should I include in a SWOT analysis of my project?', 'كيف أجهز تحليل SWOT لمشروعي قبل اجتماع بكرة؟'])(
    'answers the how-to «%s» from the matching skill through the private path', async goal => {
      const result = await run(withSkills, goal);
      expect(result.error).toBeNull();
      expect(result.trail.find(entry => entry.action === 'skill_read')?.result).toMatch(/^swot-analysis \S+ \(personal\)/u);
      expect(reads).toEqual(['id-swot-analysis']);
      expect(knowledge).toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    });

  it.each(['ما خطة مشروعي؟', 'ما ميزانية حملتي؟', 'كم سعر منتجي؟', 'ما هو بريدي الإلكتروني؟'])('leaves the stored-fact question «%s» to the private sources', async goal => {
    const result = await run(withSkills, goal);
    expect(result.error).toBeNull();
    expect(result.trail.map(entry => entry.action)).not.toContain('skill_read');
    expect(reads).toEqual([]);
    expect(result.text).not.toContain('المصدر: مهارة');
    expect(result.status).not.toBe('completed');
    expect(search).not.toHaveBeenCalled();
  });

  it('never answers a request for a named document from a skill', async () => {
    const result = await run(withSkills, 'كيف أسعّر منتجي حسب دليلي المحفوظ؟');
    expect(result.trail.map(entry => entry.action)).not.toContain('skill_read');
    expect(reads).toEqual([]);
    expect(result.text).not.toContain('المصدر: مهارة');
    expect(search).not.toHaveBeenCalled();
  });

  it('gives the same reply as before while no skill reader is configured', async () => {
    const result = await run(withoutSkills, 'كيف أعمل تحليل SWOT لمشروعي؟');
    expect(result.trail.map(entry => entry.action)).not.toContain('skill_read');
    expect(result.text).not.toContain('المصدر: مهارة');
    expect(result.status).toBe('blocked');
    expect(search).not.toHaveBeenCalled();
  });
});
