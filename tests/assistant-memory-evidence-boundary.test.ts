import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools, type AssistantTools } from '../apps/server/src/assistant/tools.js';
import { reviewMemoryRecallEvidence } from '../apps/server/src/assistant/memory-recall-evidence.js';

const PREF = 'From my memory, return my preferred language only.';
const PAIR = 'ارجع إلى ذاكرتي لقراءة دفعة بذور المشتل. أعد JSON بالمفتاحين «الكمية» و«اليوم» فقط.';
describe('the actual memory adapter preserves complete bounded source evidence', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>, domain: ReturnType<typeof createMemoryControl>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>, tools: AssistantTools;
  let ownerSerial = 0, reads = 0, writes = 0, reconciles = 0, legacyWrites = 0;
  let boundaryItems: Array<{ title: string; content: string; layer: string }> | undefined;
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('No external model/network/browser/work/input belongs to this synthetic audit.'); });
  beforeAll(async () => {
    database = await createDatabase({}); expect(database.mode).toBe('embedded');
    await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
    domain = createMemoryControl(database.db);
    tools = createAssistantTools({ memory: {
      async search(owner, input, options) { reads++; expect(options).toEqual({ readOnly: true });
        expect(input).toMatchObject({ limit: 5 }); return boundaryItems ? { items: boundaryItems } : domain.search(owner, input, options); },
      async create(owner, input) { legacyWrites++; return domain.create(owner, input); },
      async writeExact(owner, input, options) { writes++; return domain.writeExact(owner, input, options); },
      async reconcileExact(owner, input, options) { reconciles++; return domain.reconcileExact(owner, input, options); },
    }, coding: { available: false, workspace: forbidden }, studio: { workspace: forbidden, detail: forbidden }, studioChange: false,
    runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden },
    windows: { enabled: false, view: forbidden, act: forbidden, command: forbidden } });
    control = await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
        act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
      tools: { memory: tools.memory }, recordExperiences: false, fullAccess: async () => true,
      models: { fast: [], deep: [], vision: '' }, createProvider: () => ({ id: 'forbidden-provider', generate: forbidden }),
      searchProvider: { name: 'forbidden-network', search: forbidden } as SearchProvider,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function owner() {
    const id = `synthetic-memory-evidence-owner-${++ownerSerial}`;
    await database.db.insertInto('user').values({ id, name: 'Synthetic evidence owner', email: `${id}@example.test` }).execute(); return id;
  }
  async function lookup(id: string, query = 'synthetic note') {
    const before = reads, value = await tools.memory!.search(id, query);
    expect(reads - before).toBe(1); if (typeof value === 'string') throw new Error(value); return value;
  }
  async function ask(id: string, request: string) {
    const { id: conversation } = await control.create(id, { goal: request }); await control.settled(conversation);
    const detail = await control.detail(id, conversation), row = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', conversation).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); return { status: row.status, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }
  it.each([
    { id: '377-character preferred-language counter', source: 'I prefer Arabic' + ' '.repeat(350) + 'and English.', request: PREF, proposed: 'Arabic' },
    { id: 'quantity/day hidden conditional tail', source: 'عدد أكياس دفعة بذور المشتل 12 وموعد تسليمها الثلاثاء' + ' '.repeat(350) + 'إذا نجح الفحص.', request: PAIR, proposed: '{"الكمية":12,"اليوم":"الثلاثاء"}' },
    { id: 'home-city hidden conditional tail', source: 'My home city is Bristol' + ' '.repeat(350) + 'only if the move happens.', request: 'From my memory, return my home city only.', proposed: 'Bristol' },
    { id: 'home-city JSON hidden conditional tail', source: 'My home city is Bristol' + ' '.repeat(350) + 'only if the move happens.', request: 'From my memory, return my home city as JSON only with key "city" as a string.', proposed: '{"city":"Bristol"}' },
  ])('never turns an incomplete adapter prefix into complete proof: $id', async entry => {
    const id = await owner(); await domain.create(id, { title: 'synthetic note', layer: 'semantic', content: entry.source });
    const raw = await reviewMemoryRecallEvidence(entry.request, entry.proposed, [entry.source], new AbortController().signal);
    expect(raw.status).toBe('partial');
    const actual = await lookup(id), reviewed = await reviewMemoryRecallEvidence(entry.request, entry.proposed, actual.evidence, new AbortController().signal);
    expect(reviewed.status, JSON.stringify({ raw: raw.status, adapted: reviewed.status, lengths: actual.evidence.map(note => note.length) })).toBe('partial');
    expect(actual.evidence).toEqual([entry.source]); expect(actual.text).not.toContain(entry.source.slice(350));
  });
  it.each([
    { request: 'Remember that I prefer Arabic.', payload: 'I prefer Arabic.', question: PREF, expected: 'Arabic' },
    { request: 'تذكر أنني أفضل العربية', payload: 'أنني أفضل العربية', question: 'من ذاكرتي، أعد لغتي المفضلة فقط.', expected: 'العربية' },
    { request: 'Remember that my home city is Bristol.', payload: 'my home city is Bristol.', question: 'From my memory, return my home city only.', expected: 'Bristol' },
  ])('keeps exact-factory save and real-controller recall working with one read: $request', async entry => {
    const id = await owner(), before = { reads, writes, reconciles, legacyWrites };
    const saved = await ask(id, entry.request); expect(saved.status).toBe('completed');
    const records = await database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', id).execute();
    expect(records).toHaveLength(1); expect(records[0]?.content).toBe(entry.payload);
    const recalled = await ask(id, entry.question); expect(recalled).toEqual({ status: 'completed', text: entry.expected });
    expect(reads - before.reads).toBe(1); expect(writes - before.writes).toBe(1); expect(reconciles - before.reconciles).toBe(1);
    expect(legacyWrites - before.legacyWrites).toBe(0);
    expect(await database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', id).execute()).toEqual(records);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('preserves exactly4000 characters, omits a4001-character note whole, and keeps the five-item/read budget', async () => {
    const id = await owner(), accepted = 'x'.repeat(4000), oversized = 'y'.repeat(4001);
    // The normal domain rejects4001-char create input. An explicitly injected
    // legacy/malformed port result verifies the adapter boundary independently.
    const supplied = [oversized, 'Valid second note.', accepted, 'small3', 'small4', 'must not escape the five-item cap'];
    boundaryItems = supplied.map((content, index) => ({ title: `synthetic${index}`, layer: 'semantic', content }));
    try {
      const actual = await lookup(id);
      expect(actual.evidence).toEqual(supplied.slice(1, 5));
      expect(actual.text).toContain(`synthetic0: ${oversized.slice(0, 300)}`);
      expect(actual.text).toContain('synthetic1: Valid second note.');
      expect(actual.text).not.toContain(supplied[5]);
      expect(actual.evidence).not.toContain(oversized); expect(actual.evidence).not.toContain(oversized.slice(0, 300));
      expect(Buffer.byteLength(actual.evidence.join(''), 'utf8')).toBeLessThan(128 * 1024);
    } finally { boundaryItems = undefined; }
    const exactOwner = await owner(); await domain.create(exactOwner, { title: 'synthetic note', layer: 'semantic', content: accepted });
    expect((await lookup(exactOwner)).evidence).toEqual([accepted]);
  });
});
