import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openKnowledgeBase } from '../packages/knowledge-base/src/query.ts';
import {
  createOfflineKnowledgeShadow, parseOfflineKnowledgeQuestion, type OfflineKnowledgeShadowReport,
} from '../packages/knowledge-base/src/shadow.ts';
import { openBuild } from '../packages/knowledge-base/src/store.ts';
import type { StoredClaim } from '../packages/knowledge-base/src/types.ts';

const snapshot = {
  dataset: 'wikidata', source: 'https://example.test/hand-built-fixture.json', license: 'CC0-1.0',
  dumpDate: '2026-11-25', fingerprint: 'sha256:fixture',
} as const;
const yearSnak = {
  snaktype: 'value', property: 'P585', datatype: 'time', datavalue: {
    type: 'time', value: { time: '+2021-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  },
} as const;

function quantity(property: string, amount: string, unit: string): StoredClaim {
  return {
    property, id: null, rank: 'normal', qualifiers: {}, references: [],
    snak: { snaktype: 'value', property, datatype: 'quantity', datavalue: { type: 'quantity', value: { amount, unit } } },
  };
}

let directory: string;
let knowledge: ReturnType<typeof openKnowledgeBase>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mohassan-knowledge-shadow-'));
  const path = join(directory, 'shadow.sqlite');
  const build = openBuild(path, { ...snapshot, categories: ['countries'] });
  try {
    build.commit({ phase: 'entities', offset: 0 }, () => {});
    build.writeEntities([
      {
        id: 'Q1', revision: 101, labels: { en: 'Coastland', ar: 'آراد' }, descriptions: {}, aliases: { en: ['Common name'] },
        categories: ['countries'], claims: [
          { ...quantity('P1082', '+1200', '1'), qualifiers: { P585: [yearSnak] } },
          quantity('P2046', '+150', 'http://www.wikidata.org/entity/Q712226'),
          quantity('P2049', '+3', 'http://www.wikidata.org/entity/Q11573'),
          quantity('P2049', '+4', 'http://www.wikidata.org/entity/Q11573'),
          { property: 'P36', id: null, rank: 'normal', qualifiers: {}, references: [], snak: { property: 'P36', snaktype: 'somevalue' } },
        ],
      },
      {
        id: 'Q2', revision: 102, labels: { en: 'Hillcountry' }, descriptions: {}, aliases: { en: ['Common name'] },
        categories: ['countries'], claims: [quantity('P2046', '+100', 'http://www.wikidata.org/entity/Q712226')],
      },
    ], { phase: 'entities', offset: 2 });
    build.finish();
  } finally {
    build.close();
  }
  knowledge = openKnowledgeBase(path);
});
afterAll(async () => {
  knowledge?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('offline knowledge shadow', () => {
  it('parses bounded English and Arabic fact forms and keeps ambiguous grammar out', () => {
    expect(parseOfflineKnowledgeQuestion('What’s the population of Coastland as of 2021?')).toMatchObject({
      kind: 'fact', entity: 'coastland', property: 'P1082', year: 2021,
    });
    expect(parseOfflineKnowledgeQuestion('مَا عاصِمَة آراد؟')).toMatchObject({ kind: 'fact', entity: 'اراد', property: 'P36' });
    expect(parseOfflineKnowledgeQuestion('ما أصغر دولة من حيث المساحة؟')).toMatchObject({ kind: 'superlative', direction: 'min' });
    expect(parseOfflineKnowledgeQuestion('قارن بين آراد مقابل البلد من حيث المساحة')).toMatchObject({ kind: 'compare', entities: ['اراد', 'البلد'] });
    expect(parseOfflineKnowledgeQuestion('What is the largest by area?')).toBeUndefined();
    expect(parseOfflineKnowledgeQuestion('What was the population of Coastland?')).toBeUndefined();
    expect(parseOfflineKnowledgeQuestion('What is the area of Coastland? What is its capital?')).toBeUndefined();
  });

  it('queues a dated, sourced Arabic fact beside the baseline answer', async () => {
    const log = vi.fn<(report: OfflineKnowledgeShadowReport) => void>();
    let now = new Date('2026-11-25T02:00:00Z');
    const shadow = createOfflineKnowledgeShadow({ knowledge, log, now: () => now });
    expect(shadow.observe({ question: 'كم عدد سكان آراد في عام ٢٠٢١؟', answer: '1,250', runId: 'fixture-run' })).toBeUndefined();
    now = new Date('2026-11-26T02:00:00Z');
    expect(log).not.toHaveBeenCalled();
    await shadow.flush();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      at: '2026-11-25T02:00:00.000Z', answer: '1,250', runId: 'fixture-run', snapshot,
      result: expect.objectContaining({
        kind: 'fact', status: 'found', facts: [expect.objectContaining({
          entityId: 'Q1', property: 'P1082', source: expect.objectContaining({ dumpDate: snapshot.dumpDate, revision: 101 }),
          statement: expect.objectContaining({ snak: expect.objectContaining({ datavalue: { type: 'quantity', value: { amount: '+1200', unit: '1' } } }) }),
        })],
      }),
    }));
  });

  it('logs ambiguity, missing facts, non-value statements and unsupported forms', async () => {
    const log = vi.fn<(report: OfflineKnowledgeShadowReport) => void>();
    const shadow = createOfflineKnowledgeShadow({ knowledge, log });
    shadow.observe({ question: 'What is the area of Common name?', answer: '' });
    shadow.observe({ question: 'What is the population of Coastland in 2022?', answer: '' });
    shadow.observe({ question: 'What is the capital of Coastland?', answer: '' });
    shadow.observe({ question: { kind: 'fact', entity: 'Coastland', property: 'P2049' }, answer: '' });
    shadow.observe({ question: 'What is the area of Unknown?', answer: '' });
    shadow.observe({ question: 'Who founded Coastland?', answer: '' });
    await shadow.flush();
    expect(log.mock.calls.map(([report]) => report.result.status)).toEqual([
      'ambiguous', 'unavailable', 'non-value', 'multiple-statements', 'unavailable', 'unsupported',
    ]);
    expect(log.mock.calls[0]?.[0].result).toMatchObject({ candidates: [{ entityId: 'Q1' }, { entityId: 'Q2' }] });
    expect(log.mock.calls[4]?.[0].result).toEqual({ status: 'unavailable', reason: 'entity-not-found' });
    expect(log.mock.calls[5]?.[0]).toMatchObject({ snapshot, result: { status: 'unsupported' } });
    expect(JSON.stringify(log.mock.calls[5])).not.toContain('Who founded Coastland?');
  });

  it('evaluates a country-area superlative and typed comparison through the query API', async () => {
    const log = vi.fn<(report: OfflineKnowledgeShadowReport) => void>();
    const shadow = createOfflineKnowledgeShadow({ knowledge, log });
    shadow.observe({ question: 'Which country is the largest by area?', answer: 'Hillcountry' });
    shadow.observe({
      question: { kind: 'compare', entities: ['Q2', 'Q1'], property: 'P2046', unit: 'Q712226' }, answer: 'Hillcountry is larger',
    });
    shadow.observe({ question: 'Compare the area of Coastland and Q1', answer: '' });
    await shadow.flush();
    expect(log.mock.calls[0]?.[0].result).toMatchObject({ kind: 'superlative', status: 'ranked', ranking: { facts: [{ entityId: 'Q1' }] } });
    expect(log.mock.calls[1]?.[0].result).toMatchObject({
      kind: 'compare', status: 'ordered', comparison: { rows: [{ entityId: 'Q1', amount: '150' }, { entityId: 'Q2', amount: '100' }] },
    });
    expect(log.mock.calls[2]?.[0].result).toEqual({ status: 'unavailable', reason: 'same-entity' });
  });

  it('continues after query and sink failures without logging exception text', async () => {
    const lookupFacts = vi.fn(knowledge.lookupFacts).mockImplementationOnce(() => { throw new Error('fixture failure'); });
    const log = vi.fn<(report: OfflineKnowledgeShadowReport) => void | Promise<void>>()
      .mockRejectedValueOnce(new Error('sink failure'));
    const shadow = createOfflineKnowledgeShadow({ knowledge: { ...knowledge, lookupFacts }, log });
    shadow.observe({ question: 'What is the area of Coastland?', answer: 'First' });
    shadow.observe({ question: 'What is the area of Coastland?', answer: 'Second' });
    await expect(shadow.flush()).resolves.toBeUndefined();
    expect(log.mock.calls.map(([report]) => [report.answer, report.result.status])).toEqual([['First', 'error'], ['Second', 'found']]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture failure');
  });
});
