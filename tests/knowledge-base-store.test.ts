import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBuild, openKnowledgeStore } from '../packages/knowledge-base/src/store.ts';
import type { BuildInput, StoredEntity } from '../packages/knowledge-base/src/types.ts';

const input: BuildInput = {
  source: 'https://example.test/fixture.json', dumpDate: '2026-11-01',
  fingerprint: 'fixture-fingerprint', categories: ['cities', 'countries'],
};

const entity: StoredEntity = {
  id: 'Q1', revision: 123,
  labels: { ar: 'مَدِينَةٌ ۱۲', en: 'Example' },
  aliases: { ar: ['أُورْ', 'أُورْ'] }, descriptions: {},
  categories: ['cities'], claims: [],
};

describe('offline Wikidata store', () => {
  let temporary: string;
  let path: string;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'mohassan-kb-store-'));
    path = join(temporary, 'data.sqlite');
  });

  afterEach(() => rmSync(temporary, { recursive: true, force: true }));

  it('commits the batch and checkpoint together and serves completed builds only', () => {
    const build = openBuild(path, input);
    try {
      expect(() => openKnowledgeStore(path)).toThrow('incomplete');
      build.commit({ phase: 'entities', offset: 0 }, () => {});
      expect(() => build.writeEntities([entity, entity], { phase: 'entities', offset: 2 })).toThrow(/UNIQUE/);
      expect(build.checkpoint).toEqual({ phase: 'entities', offset: 0 });
      expect(build.db.prepare('SELECT * FROM entities').all()).toEqual([]);
      build.writeEntities([entity], { phase: 'entities', offset: 1 });
      expect(build.finish()).toMatchObject({
        license: 'CC0-1.0', scannedEntities: 1, entityCount: 1, claimCount: 0,
      });
    } finally {
      build.close();
    }
    const reader = openKnowledgeStore(path);
    try {
      expect(reader.card).toMatchObject({ source: input.source, dumpDate: input.dumpDate, fingerprint: input.fingerprint });
      expect(reader.db.prepare('SELECT key, kind FROM names ORDER BY key').all()).toEqual([
        { key: 'example', kind: 'label' }, { key: 'اور', kind: 'alias' }, { key: 'مدينه 12', kind: 'label' },
      ]);
      expect(() => reader.db.prepare('DELETE FROM entities').run()).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
  });

  it('rejects resuming a different source and stale concurrent writers', () => {
    const first = openBuild(path, input);
    const second = openBuild(path, { ...input, categories: ['countries', 'cities'] });
    try {
      first.commit({ phase: 'classes', offset: 0 }, db => db.exec('CREATE TABLE scratch (id INTEGER)'));
      expect(() => second.commit({ phase: 'classes', offset: 0 }, () => {})).toThrow('another process');
      expect(() => openBuild(path, { ...input, fingerprint: 'other-file' })).toThrow('different build input');
    } finally {
      second.close();
      first.close();
    }
  });
});
