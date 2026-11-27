import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDatabase } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryLayer } from '@mohassan/memory';

const clock = new Date('2026-11-24T04:00:00.000Z');
const future = new Date('2027-11-24T04:00:00.000Z');
const past = new Date('2026-11-23T04:00:00.000Z');
const readOnly = { readOnly: true };

interface FixtureNote {
  id?: string;
  title?: string;
  content?: string;
  layer?: MemoryLayer;
  taskId?: string;
  updatedAt?: Date;
  expiresAt?: Date;
  status?: 'active' | 'superseded' | 'revoked';
  evidence?: 'valid' | 'none' | 'foreign' | 'revoked' | 'expired';
  extraInvalidEvidence?: boolean;
}

describe('memory relevance and evidence filtering before the result limit', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>;
  let memory: ReturnType<typeof createMemoryControl>;

  beforeAll(async () => {
    // An isolated embedded database; no environment, production connection, auth or runtime is loaded.
    store = await createDatabase({});
    await memoryMigration(store.db);
    await sql`CREATE TABLE tasks (id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL,
      status text NOT NULL, updated_at timestamptz NOT NULL)`.execute(store.db);
    memory = createMemoryControl(store.db, { now: () => clock });
  });
  afterAll(async () => { await store?.close(); });

  async function seed(ownerId: string, notes: FixtureNote[]) {
    const records = notes.map(note => {
      const id = note.id ?? randomUUID();
      return { id, root_id: id, owner_id: ownerId, version: 1, layer: note.layer ?? 'semantic',
        title: note.title ?? 'Unrelated journal', content: note.content ?? 'Ordinary daily observation',
        status: note.status ?? 'active', confidence: 0.5, confidence_kind: 'user_asserted', task_id: note.taskId ?? null,
        expires_at: note.expiresAt ?? future, created_at: past, updated_at: note.updatedAt ?? clock };
    });
    const evidence: Record<string, unknown>[] = [];
    const links: { memory_id: string; evidence_id: string; relation: string }[] = [];
    for (const [index, note] of notes.entries()) {
      if (note.evidence === 'none') continue;
      const kinds = note.extraInvalidEvidence ? [note.evidence ?? 'valid', 'revoked'] : [note.evidence ?? 'valid'];
      for (const kind of kinds) {
        const id = randomUUID();
        evidence.push({ id, owner_id: kind === 'foreign' ? `${ownerId}-other` : ownerId, source_key: id,
          kind: 'manual', description: 'Fixture provenance', task_id: note.taskId ?? null, event_id: null,
          content_hash: 'a'.repeat(64), trust: 'manual', status: kind === 'revoked' ? 'revoked' : 'active',
          observed_at: past, expires_at: kind === 'expired' ? past : null });
        links.push({ memory_id: records[index]!.id, evidence_id: id, relation: 'asserted' });
      }
    }
    await store.db.insertInto('memory_items').values(records).execute();
    if (evidence.length) await store.db.insertInto('memory_evidence').values(evidence).execute();
    if (links.length) await store.db.insertInto('memory_provenance').values(links).execute();
    return records.map(row => row.id);
  }

  it('recalls a relevant note older than more than 300 unrelated recent notes', async () => {
    const owner = 'memory-relevance-old';
    const [old] = await seed(owner, [{ title: 'Violet telescope calibration', updatedAt: past },
      ...Array.from({ length: 305 }, () => ({}))]);
    const result = await memory.search(owner, { query: 'violet', limit: 1 }, readOnly);
    expect(result.items.map(item => item.id)).toEqual([old]);
    expect(result.citations.map(citation => citation.memoryId)).toEqual([old]);
    expect(result.method).toBe('lexical-v1');
  });

  it('ranks stronger relevance before recency without discarding older matching candidates', async () => {
    const owner = 'memory-relevance-rank';
    const [old] = await seed(owner, [{ title: 'Telescope calibration', updatedAt: past },
      ...Array.from({ length: 305 }, () => ({ content: 'The telescope needs calibration.' }))]);
    expect((await memory.search(owner, { query: 'telescope calibration', limit: 1 }, readOnly)).items.map(item => item.id)).toEqual([old]);
  });

  it('excludes revoked, expired and foreign-owned memories', async () => {
    const owner = 'memory-relevance-owner';
    const [valid] = await seed(owner, [{ title: 'Cerulean ledger' },
      { title: 'Cerulean ledger', status: 'revoked' }, { title: 'Cerulean ledger', status: 'superseded' },
      { title: 'Cerulean ledger', expiresAt: past }]);
    await seed(`${owner}-other`, [{ title: 'Cerulean ledger' }]);
    const result = await memory.search(owner, { query: 'cerulean', limit: 30 }, readOnly);
    expect(result.items.map(item => item.id)).toEqual([valid]);
    expect(result.expiredExcluded).toBe(1);
  });

  it.each(['none', 'foreign', 'revoked', 'expired'] as const)('rejects %s provenance before LIMIT', async evidence => {
    const owner = `memory-relevance-evidence-${evidence}`;
    const [valid] = await seed(owner, [{ title: 'Amethyst archive', updatedAt: past },
      ...Array.from({ length: 32 }, () => ({ title: 'Amethyst archive', evidence }))]);
    const result = await memory.search(owner, { query: 'amethyst', limit: 1 }, readOnly);
    expect(result.items.map(item => item.id)).toEqual([valid]);
    expect(result.items[0]!.provenance).toHaveLength(1);
  });

  it('requires every provenance reference to remain valid', async () => {
    const owner = 'memory-relevance-all-provenance';
    const [valid] = await seed(owner, [{ title: 'Indigo catalog', updatedAt: past },
      { title: 'Indigo catalog', extraInvalidEvidence: true }]);
    expect((await memory.search(owner, { query: 'indigo', limit: 1 }, readOnly)).items.map(item => item.id)).toEqual([valid]);
  });

  it('preserves working-memory task boundaries and layer filtering', async () => {
    const owner = 'memory-relevance-task';
    for (const id of ['first', 'second']) await store.db.insertInto('tasks').values({ id: `${owner}-${id}`,
      owner_id: owner, title: 'Task fixture', status: 'running', updated_at: clock }).execute();
    await store.db.insertInto('tasks').values({ id: `${owner}-foreign`, owner_id: `${owner}-other`,
      title: 'Foreign task', status: 'running', updated_at: clock }).execute();
    const [global, first, second, semantic] = await seed(owner, [
      { title: 'Cobalt record', layer: 'working' },
      { title: 'Cobalt record', layer: 'working', taskId: `${owner}-first` },
      { title: 'Cobalt record', layer: 'working', taskId: `${owner}-second` },
      { title: 'Cobalt record', layer: 'semantic' },
    ]);
    expect((await memory.search(owner, { query: 'cobalt', layers: ['working'] }, readOnly)).items.map(item => item.id)).toEqual([global]);
    expect((await memory.search(owner, { query: 'cobalt', layers: ['working'], taskId: `${owner}-first` }, readOnly)).items.map(item => item.id)).toEqual([first]);
    expect((await memory.search(owner, { query: 'cobalt', layers: ['working'], taskId: `${owner}-second` }, readOnly)).items.map(item => item.id)).toEqual([second]);
    expect((await memory.search(owner, { query: 'cobalt', layers: ['semantic'] }, readOnly)).items.map(item => item.id)).toEqual([semantic]);
    await expect(memory.search(owner, { query: 'cobalt', taskId: `${owner}-foreign` }, readOnly)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it.each([
    ['ＣＡＬＩＢＲＡＴＩＯＮ', 'calibration'],
    ['MixedCase', 'MIXEDCASE'],
    ['مُحَاسَبَة الشَّرِكَة', 'محاسبة الشركة'],
  ])('preserves normalized matching for %s', async (title, query) => {
    const owner = `memory-relevance-normalize-${randomUUID()}`;
    const [id] = await seed(owner, [{ title }]);
    expect((await memory.search(owner, { query }, readOnly)).items.map(item => item.id)).toEqual([id]);
  });

  it.each([
    // Aljlayl and Frieder's examples, with tatweel inserted per the Unicode chart.
    // https://ir.cs.georgetown.edu/publications/downloads/CIKM02-Arabic.pdf (retrieved 2026-11-27)
    // https://www.unicode.org/charts/PDF/U0600.pdf (retrieved 2026-11-27)
    ['hamza above alef', 'أحرف', 'احرف'],
    ['hamza below alef', 'إنسان', 'انسان'],
    ['tatweel', 'أحرف', 'أح\u0640رف'],
    // The Academy of the Arabic Language's dictionary entry, with madda folded as above.
    // https://www.arabicacademy.gov.eg/ar/محرك-البحث/الآلة (retrieved 2026-11-27)
    ['alef with madda', 'آلة', 'آلة'.replace('آ', 'ا')],
    // Eskander et al.'s example of Egyptian spelling variation.
    // https://aclanthology.org/N13-1066.pdf (retrieved 2026-11-27)
    ['alef maqsura', 'مصرى', 'مصري'],
    // The owner's reported query, with the taa marbuta rule isolated.
    ['taa marbuta', 'السيارة', 'السياره'],
    ['the reported phrase', 'أوراق السيارة', 'اوراق السياره'],
  ])('finds both spellings of %s in titles and content', async (_name, canonical, variant) => {
    const owner = `memory-relevance-arabic-${randomUUID()}`;
    const [titleId, contentId] = await seed(owner, [{ title: canonical }, { content: variant }]);

    for (const query of [canonical, variant]) {
      const { items } = await memory.search(owner, { query }, readOnly);
      expect(items.map(item => item.id)).toEqual([titleId, contentId]);
      expect(items[0]?.title).toBe(canonical);
      expect(items[1]?.content).toBe(variant);
    }
  });

  it('ignores Arabic stopwords in scoring and returns no matches for a stopword-only query', async () => {
    const owner = 'memory-relevance-arabic-stopwords';
    // The reported function words, verified against the published Arabic stopword list.
    // https://github.com/apache/lucene/blob/releases/lucene/9.12.2/lucene/analysis/common/src/resources/org/apache/lucene/analysis/ar/stopwords.txt (retrieved 2026-11-27)
    const stopwords = ['ما', 'في', 'هو'].join(' ');
    const [matching] = await seed(owner, [
      { content: 'أوراق السيارة', updatedAt: past },
      { title: stopwords, content: stopwords },
    ]);

    const { items } = await memory.search(owner, { query: `${stopwords} اوراق السياره` }, readOnly);
    expect(items.map(item => item.id)).toEqual([matching]);
    expect(await memory.search(owner, { query: 'مَـا فِي هُوَ' }, readOnly)).toMatchObject({ items: [], citations: [] });
  });

  it('preserves a searchable name even when it folds like an Arabic stopword', async () => {
    const owner = 'memory-relevance-arabic-name';
    // The name/preposition spelling ambiguity described in the Arabizi orthography guidelines.
    // https://aclanthology.org/W14-3612.pdf (retrieved 2026-11-27)
    const [matching] = await seed(owner, [{ title: 'علي' }, { title: 'Unrelated journal' }]);
    expect((await memory.search(owner, { query: 'علي' }, readOnly)).items.map(item => item.id)).toEqual([matching]);
    expect((await memory.search(owner, { query: 'على' }, readOnly)).items).toEqual([]);
  });

  it('does not interpret query punctuation as SQL wildcard syntax', async () => {
    const owner = 'memory-relevance-punctuation';
    const [matching] = await seed(owner, [{ title: 'Cerulean log', content: 'Plain entry' }, { title: 'No matching term', content: 'Plain entry' }]);
    expect((await memory.search(owner, { query: 'cerulean_%', limit: 30 }, readOnly)).items.map(item => item.id)).toEqual([matching]);
    expect((await memory.search(owner, { query: "cerulean%' OR 1=1 --", limit: 30 }, readOnly)).items.map(item => item.id)).toEqual([matching]);
  });

  it('returns only the newest eligible memories for an empty query with deterministic ties', async () => {
    const owner = 'memory-relevance-empty';
    const laterId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const earlierId = '00000000-0000-4000-8000-000000000001';
    await seed(owner, [{ id: laterId }, { id: earlierId }, { updatedAt: past },
      { updatedAt: new Date(clock.getTime() + 1000), evidence: 'revoked' }]);
    const result = await memory.search(owner, { query: '', limit: 2 }, readOnly);
    expect(result.items.map(item => item.id)).toEqual([earlierId, laterId]);
    expect(result.citations).toHaveLength(2);
    await expect(memory.search(owner, { query: '', limit: 31 }, readOnly)).rejects.toBeDefined();
  });

  it('does not write task outcomes, notes, evidence or audit entries during read-only lookup', async () => {
    const owner = 'memory-relevance-readonly';
    await seed(owner, [{ title: 'Saffron notebook' }]);
    const counts = async () => {
      const result: number[] = [];
      for (const table of ['memory_items', 'memory_evidence', 'memory_provenance', 'memory_audit']) {
        const row = await store.db.selectFrom(table).select(eb => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
        result.push(Number(row.n));
      }
      return result;
    };
    const before = await counts();
    expect((await memory.search(owner, { query: 'saffron' }, readOnly)).items).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
});
