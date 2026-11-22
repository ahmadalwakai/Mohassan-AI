import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { buildSkillSource } from '../packages/skills/src/importer.ts';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createSkillReader, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

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

describe('active skills in the model-free conversation', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let withSkills: Awaited<ReturnType<typeof createCommandChatControl>>, withoutSkills: Awaited<ReturnType<typeof createCommandChatControl>>;
  const search = vi.fn<SearchProvider['search']>(async () => []);
  const reads: string[] = [];
  const owner = 'isolated-skill-owner';

  beforeAll(async () => {
    database = await createDatabase(); await migrate(database.db);
    const { candidates, bodies } = await shippedSkills();
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    const base = { browser, models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'recorded-search', search } as SearchProvider };
    withSkills = await createCommandChatControl(database.db, { ...base,
      skillAnswer: createSkillReader({ candidates: async () => candidates, instructions: async (_ownerId, id) => { reads.push(id); return bodies.get(id) ?? null; } }) });
    withoutSkills = await createCommandChatControl(database.db, base);
  });
  beforeEach(() => { search.mockClear(); reads.length = 0; });
  afterAll(async () => { await withSkills?.shutdown(); await withoutSkills?.shutdown(); await database?.close(); });

  async function run(control: typeof withSkills, goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const row = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { text: detail.messages.at(-1)?.text ?? '', error: detail.error, status: row.status, trail: (row.state.trail ?? []) as { action: string; result: string }[] };
  }

  it('answers a how-to question from the matching skill before any web search', async () => {
    const result = await run(withSkills, 'كيف أكتب مقال سيو يتصدر جوجل؟');
    expect(result.error).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(reads).toEqual(['id-arabic-seo-article']);
    expect(result.trail.map(entry => entry.action)).toContain('skill_read');
    expect(result.text.startsWith('**كتابة مقال متوافق مع محركات البحث**')).toBe(true);
    expect(result.text).toContain('**الخطوات**');
    expect(result.text).toContain('**تحقق قبل التسليم**');
    expect(result.text).toContain('المصدر: مهارة «كتابة مقال متوافق مع محركات البحث» (arabic-seo-article)');
    expect(['completed', 'partial']).toContain(result.status);
  });

  it('gives the method of an article it cannot write in full, saying so, instead of «unsupported»', async () => {
    const result = await run(withSkills, 'اكتب مقال سيو عن القهوة المختصة');
    expect(result.error).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(result.text).toMatch(/^لا أكتب نصًا حرًا كاملًا دون نموذج لغوي، لكن مهارة «كتابة مقال متوافق مع محركات البحث»/u);
    expect(result.text).toContain('القهوة المختصة');
  });

  it('answers a request no other path handles from the skill that covers it', async () => {
    const result = await run(withSkills, 'راجع لي جودة الكود قبل الدمج');
    expect(result.error).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(result.text.startsWith('**مراجعة الكود البرمجي**')).toBe(true);
    expect(result.trail.find(entry => entry.action === 'skill_read')?.result).toContain('code-review');
  });

  it('leaves a plain fact question to the web search', async () => {
    const result = await run(withSkills, 'ما عاصمة اليابان؟');
    expect(result.trail.map(entry => entry.action)).not.toContain('skill_read');
    expect(reads).toEqual([]);
    expect(search).toHaveBeenCalled();
  });

  it('changes nothing while no skill reader is configured', async () => {
    const result = await run(withoutSkills, 'كيف أكتب مقال سيو يتصدر جوجل؟');
    expect(result.trail.map(entry => entry.action)).not.toContain('skill_read');
    expect(result.text).not.toContain('المصدر: مهارة');
    expect(search).toHaveBeenCalled();
  });
});
