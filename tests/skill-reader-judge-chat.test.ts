import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { buildSkillSource } from '../packages/skills/src/importer.ts';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createSkillReader, type SkillReader, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

const owner = 'isolated-skill-judge-owner';

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

// The skill reader and the pre-send judge on one reply path: the judge's fix and withhold are on for the owner, and a
// skill answer still reaches the owner word for word. A skill reply quotes no web page, so the page checks are not its judge.
describe('a skill answer under the pre-send judge, through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createJudgeShadow>;
  const search = vi.fn<SearchProvider['search']>(async () => []);
  const composed: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-skill-judge-chat-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'shadow.jsonl') });
    database = await createDatabase(); await migrate(database.db);
    const { candidates, bodies } = await shippedSkills();
    const reader = createSkillReader({ candidates: async () => candidates, instructions: async (_ownerId, id) => bodies.get(id) ?? null });
    // What the reader composed, before the judge and the stored message.
    const skillAnswer: SkillReader = async (ownerId, request, options) => { const read = await reader(ownerId, request, options); if (read) composed.push(read.text); return read; };
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'recorded-search', search } as SearchProvider,
      skillAnswer, fullAccess: async () => true, judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  async function run(goal: string) {
    composed.length = 0;
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const row = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    await shadow.flush();
    const verdicts = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine).filter(line => line.conversationId === id);
    return { stored: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', error: detail.error, status: row.status,
      mode: /\((advice|writing|fallback)\)/u.exec(((row.state.trail ?? []) as { action: string; result: string }[]).find(entry => entry.action === 'skill_read')?.result ?? '')?.[1] ?? null, verdicts };
  }

  it.each([
    ['advice', 'كيف أكتب مقال سيو يتصدر جوجل؟'],
    ['writing', 'اكتب مقال سيو عن القهوة المختصة'],
    ['fallback', 'راجع لي جودة الكود قبل الدمج'],
  ])('sends the %s answer exactly as the reader composed it, with one verdict', async (mode, goal) => {
    const result = await run(goal);
    expect(result.error).toBeNull();
    expect(result.mode).toBe(mode);
    expect(composed).toHaveLength(1);
    expect(result.stored).toBe(composed[0]);
    expect(result.stored).toContain('المصدر: مهارة «');
    expect(result.status).toBe('completed');
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({ decision: 'send', applied: false, sourced: false, codes: [], reply: composed[0]!.slice(0, 4000) });
    expect(search).not.toHaveBeenCalled();
  });
});
