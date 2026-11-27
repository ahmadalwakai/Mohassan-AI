import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerOfflineQuestion, createKnowledgeQa, createKnowledgeQaShadow, openKnowledgeBase } from '../packages/knowledge-base/src/index.ts';
import type { KnowledgeQaShadowReport, StoredClaim, StoredEntity, WikidataSnak } from '../packages/knowledge-base/src/index.ts';
import { openBuild } from '../packages/knowledge-base/src/store.ts';

const dumpDate = '2026-11-16';
const calendar = 'http://www.wikidata.org/entity/Q1985727';
function time(property: string, date: string, precision: number): WikidataSnak {
  return { property, snaktype: 'value', datavalue: { type: 'time', value: { time: `+${date}T00:00:00Z`, precision, calendarmodel: calendar } } };
}

function claim(property: string, type: string, value: unknown, fields: Partial<StoredClaim> = {}): StoredClaim {
  return { id: null, property, rank: 'normal', qualifiers: {}, references: [],
    snak: { property, snaktype: 'value', datavalue: { type, value } }, ...fields };
}

function item(property: string, id: string, fields?: Partial<StoredClaim>) {
  return claim(property, 'wikibase-entityid', { id }, fields);
}

function quantity(property: string, amount: string, unit: string, fields?: Partial<StoredClaim>) {
  return claim(property, 'quantity', { amount, unit }, fields);
}

const entities: StoredEntity[] = [
  { id: 'Q76', revision: 100, labels: { en: 'Barack Obama', ar: 'باراك أوباما' }, categories: ['people'],
    aliases: {}, descriptions: {}, claims: [
      item('P19', 'Q18094'), item('P40', 'Q9126'), item('P40', 'Q9126', { rank: 'preferred' }), item('P40', 'Q15070006'),
      claim('P569', 'time', { time: '+1961-08-04T00:00:00Z', precision: 11, calendarmodel: calendar }),
    ] },
  { id: 'Q13133', revision: 150, labels: { en: 'Michelle Obama', ar: 'ميشيل أوباما' }, categories: ['people'],
    aliases: {}, descriptions: {}, claims: [
      claim('P569', 'time', { time: '+1964-01-17T00:00:00Z', precision: 11, calendarmodel: calendar }),
    ] },
  { id: 'Q18094', revision: 200, labels: { en: 'Honolulu', ar: 'هونولولو' }, categories: ['cities'],
    aliases: {}, descriptions: {}, claims: [item('P17', 'Q30')] },
  { id: 'Q30', revision: 300, labels: { en: 'United States of America', ar: 'الولايات المتحدة' }, categories: ['countries'],
    aliases: { en: ['United States'] }, descriptions: {}, claims: [
      item('P36', 'Q61', { id: 'Q30$fixture', rank: 'preferred', qualifiers: { P580: [time('P580', '1800-00-00', 9)] } }),
      item('P36', 'Q1345', { qualifiers: { P580: [time('P580', '1790-00-00', 9)], P582: [time('P582', '1800-00-00', 9)] } }),
      quantity('P2046', '+9833520', 'http://www.wikidata.org/entity/Q712226'),
    ] },
  { id: 'Q61', revision: 400, labels: { en: 'Washington, D.C.', ar: 'واشنطن العاصمة' }, categories: ['cities'],
    aliases: { en: ['Washington'] }, descriptions: { en: 'capital of the United States' }, claims: [item('P17', 'Q30')] },
  { id: 'Q1223', revision: 500, labels: { en: 'Washington', ar: 'واشنطن' }, categories: ['places'],
    aliases: {}, descriptions: { en: 'U.S. state' }, claims: [item('P17', 'Q30')] },
  { id: 'Q31', revision: 600, labels: { en: 'Belgium', ar: 'بلجيكا' }, categories: ['countries'],
    aliases: {}, descriptions: {}, claims: [
      quantity('P2046', '+30689', 'http://www.wikidata.org/entity/Q712226'),
      quantity('P1082', '+11492641', '1', { id: 'Q31$fixture', qualifiers: { P585: [time('P585', '2020-00-00', 9)] },
        references: [{ snaks: { P813: [time('P813', '2021-02-01', 11)] } }] }),
      quantity('P1082', '+11825551', '1', { qualifiers: { P585: [time('P585', '2025-00-00', 9)] } }),
    ] },
];

let directory: string;
let knowledge: ReturnType<typeof openKnowledgeBase>;
let qa: ReturnType<typeof createKnowledgeQa>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mohassan-knowledge-qa-'));
  const database = join(directory, 'qa.sqlite');
  const build = openBuild(database, { source: 'fixture:knowledge-qa', dumpDate, fingerprint: 'sha256:fixture',
    categories: ['countries', 'people', 'cities', 'places'] });
  try {
    build.commit({ phase: 'entities', offset: 0 }, () => {});
    build.writeEntities(entities, { phase: 'entities', offset: entities.length });
    build.finish();
  } finally {
    build.close();
  }
  knowledge = openKnowledgeBase(database);
  qa = createKnowledgeQa(knowledge);
});
afterAll(async () => {
  knowledge?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('offline factual answers', () => {
  it('keeps a dated population statement and its original references in Arabic', () => {
    const answer = qa.answer('كم عدد سكان بلجيكا في عام ٢٠٢٠؟');
    expect(answer).toMatchObject({
      status: 'answered', language: 'ar', values: [{ kind: 'quantity', amount: '11492641', unit: '1' }],
      facts: [{
        statement: { id: 'Q31$fixture' }, source: { revision: 600, dumpDate },
        references: [{ snaks: { P813: [expect.objectContaining({ property: 'P813' })] } }],
        dates: { snapshot: dumpDate, qualifiers: [expect.objectContaining({ property: 'P585' })],
          references: [expect.objectContaining({ property: 'P813' })] },
      }],
    });
    expect(answer.text).toContain('https://www.wikidata.org/wiki/Special:PermanentLink/600');
    expect(answer.text).toContain('P585 2020');
    expect(answer.text).toContain(dumpDate);
    expect(qa.answer('What is the latest population of Belgium?')).toMatchObject({
      status: 'answered', values: [{ amount: '11825551' }],
    });
    expect(qa.answer('When was Barack Obama born?')).toMatchObject({
      status: 'answered', values: [{ kind: 'date', year: 1961, month: 8, day: 4 }],
    });
  });

  it('uses every evidenced edge in the birth-country-capital question', () => {
    for (const question of [
      'What is the capital of the country where Barack Obama was born?',
      'ما عاصمة الدولة التي ولد فيها باراك أوباما؟',
    ]) {
      expect(qa.answer(question)).toMatchObject({
        status: 'answered', values: [{ kind: 'entity', id: 'Q61' }], facts: [
          { entityId: 'Q76', property: 'P19', dates: { snapshot: dumpDate } },
          { entityId: 'Q18094', property: 'P17', dates: { snapshot: dumpDate } },
          { entityId: 'Q30', property: 'P36', dates: { snapshot: dumpDate } },
        ],
      });
    }
  });

  it('abstains when two terms overlap the requested year even if one fact has preferred rank', () => {
    expect(qa.answer('What was the capital of the United States in 1800?')).toMatchObject({
      status: 'abstained', reason: 'conflicting-facts',
    });
    expect(qa.answer('What was the capital of the United States in 1799?')).toMatchObject({
      status: 'answered', values: [{ id: 'Q1345' }],
    });
  });

  it('requires dated offices, present capitals and populations of the whole entity', () => {
    // These deliberately fictional people and places exercise statement qualification.
    const database = join(directory, 'term-scenarios.sqlite');
    const person = (id: string, en: string): StoredEntity => ({
      id, revision: null, labels: { en }, categories: ['people'], aliases: {}, descriptions: {}, claims: [],
    });
    const state = (id: string, en: string, claims: StoredClaim[]): StoredEntity => ({
      id, revision: null, labels: { en }, categories: ['countries'], aliases: {}, descriptions: {}, claims,
    });
    const first = person('Q900000001', 'First Fixture Holder');
    const second = person('Q900000002', 'Second Fixture Holder');
    const presentCapital: StoredEntity = { ...person('Q900000003', 'Present Fixture Capital'), categories: ['cities'] };
    const plannedCapital: StoredEntity = { ...person('Q900000004', 'Planned Fixture Capital'), categories: ['cities'] };
    const past = time('P585', '2020-01-01', 11);
    const recent = time('P585', '2025-01-01', 11);
    const started = time('P580', '2024-01-01', 11);
    const ended = time('P582', '2021-01-01', 11);
    const future = time('P580', '2027-01-01', 11);
    const records = [first, second, presentCapital, plannedCapital,
      state('Q900000010', 'First Fixture State', [
        item('P35', first.id, { qualifiers: { P585: [past], P582: [ended] } }),
      ]),
      state('Q900000011', 'Second Fixture State', [
        item('P35', first.id, { rank: 'preferred', qualifiers: { P585: [past] } }),
        item('P35', second.id, { qualifiers: { P585: [recent] } }),
        item('P35', first.id, { qualifiers: { P580: [future] } }),
      ]),
      state('Q900000012', 'Third Fixture State', [
        item('P6', first.id, { qualifiers: { P585: [recent] } }),
        item('P6', second.id, { rank: 'preferred', qualifiers: { P580: [started] } }),
      ]),
      state('Q900000013', 'Fourth Fixture State', [
        item('P36', presentCapital.id),
        item('P36', plannedCapital.id, { rank: 'preferred', qualifiers: { P580: [future] } }),
      ]),
      state('Q900000014', 'Fifth Fixture State', [
        item('P36', presentCapital.id, { qualifiers: { P580: [started] } }),
      ]),
      state('Q900000015', 'Sixth Fixture State', [
        quantity('P1082', '+100', '1', { qualifiers: { P585: [past] } }),
        quantity('P1082', '+30', '1', { qualifiers: {
          P585: [recent], P518: [item('P518', presentCapital.id).snak],
        } }),
      ]),
    ];
    const build = openBuild(database, { source: 'fixture:term-scenarios', dumpDate, fingerprint: 'sha256:fixture',
      categories: ['countries', 'people', 'cities'] });
    try {
      build.commit({ phase: 'entities', offset: 0 }, () => {});
      build.writeEntities(records, { phase: 'entities', offset: records.length });
      build.finish();
    } finally {
      build.close();
    }
    expect(answerOfflineQuestion(database, 'Who is the head of state of First Fixture State?')).toBeUndefined();
    expect(answerOfflineQuestion(database, 'Who was the head of state of First Fixture State in 2020?'))
      .toContain('First Fixture Holder (as of 2020-01-01)');
    expect(answerOfflineQuestion(database, 'Who is the head of state of Second Fixture State?'))
      .toContain('Second Fixture Holder (as of 2025-01-01)');
    expect(answerOfflineQuestion(database, 'Who is the head of government of Third Fixture State?')).toBeUndefined();
    expect(answerOfflineQuestion(database, 'What is the capital of Fourth Fixture State?')).toBeUndefined();
    expect(answerOfflineQuestion(database, 'What is the capital of Fifth Fixture State?'))
      .toContain('Present Fixture Capital');
    expect(answerOfflineQuestion(database, 'What is the population of Sixth Fixture State?')).toBeUndefined();
  });

  it('compares comparable values and marks the index scope of a category superlative', () => {
    const compared = qa.answer('Compare the area of Belgium and the United States.');
    expect(compared).toMatchObject({ status: 'answered', values: [{ amount: '9833520' }, { amount: '30689' }],
      facts: [{ entityId: 'Q30' }, { entityId: 'Q31' }] });
    expect(qa.answer('Which country is the largest by area?')).toMatchObject({
      status: 'answered', values: [{ id: 'Q30' }], scope: { kind: 'indexed-category', entities: 2, comparable: 2 },
    });
    expect(qa.answer('Which country is the largest by population?')).toMatchObject({
      status: 'abstained', reason: 'incomplete-comparison',
    });
  });

  it('compares the dated statements of both entities', () => {
    expect(qa.answer('Who was born earlier, Michelle Obama or Barack Obama?')).toMatchObject({
      status: 'answered', values: [{ id: 'Q76' }],
      facts: [{ entityId: 'Q13133', property: 'P569' }, { entityId: 'Q76', property: 'P569' }],
    });
  });

  it('counts distinct recorded statements, preserving source evidence and the scope', () => {
    const result = qa.execute({
      kind: 'count', language: 'en', entity: { text: 'Barack Obama' }, expected: 'quantity',
      property: { id: 'P40', label: { en: 'children', ar: 'أبناء' }, answerType: 'entity' },
    });
    expect(result).toMatchObject({ status: 'answered', scope: { kind: 'recorded-values' },
      values: [{ kind: 'quantity', amount: '2', unit: '1' }] });
    expect(result.text).toContain('Recorded values');
    if (result.status === 'answered') expect(result.facts).toHaveLength(3);
  });

  it('returns a choice for ambiguity and explains the exact failed search in Arabic', () => {
    const ambiguous = qa.answer('What is the country of Washington?');
    expect(ambiguous).toMatchObject({ status: 'choice', mention: 'washington' });
    if (ambiguous.status === 'choice') expect(ambiguous.candidates.map(candidate => candidate.entityId).sort()).toEqual(['Q1223', 'Q61']);
    const missing = qa.answer('ما عدد سكان بلجيكا في عام ٢٠١٩؟');
    expect(missing).toMatchObject({ status: 'abstained', reason: 'fact-not-found' });
    expect(missing.text).toContain('لم أجد في قاعدة المعرفة');
    expect(missing.text).toContain('P1082');
    expect(missing.text).toContain('2019');
    expect(qa.answer('ما عاصمة بلد غير موجود؟')).toMatchObject({ status: 'abstained', reason: 'entity-not-found' });
    expect(qa.answer('Explain knowledge representation')).toMatchObject({ status: 'abstained', reason: 'unsupported' });
  });

  it('logs the baseline beside the result only when explicitly observed and recovers after a sink error', async () => {
    const log = vi.fn<(report: KnowledgeQaShadowReport) => void | Promise<void>>().mockRejectedValueOnce(new Error('sink'));
    const shadow = createKnowledgeQaShadow({ knowledge, log, now: () => new Date('2026-11-25T02:00:00Z') });
    shadow.observe({ question: 'What is the capital of the United States?', answer: 'Baseline', runId: 'first' });
    shadow.observe({ question: 'What is the capital of Belgium?', answer: 'Second baseline', runId: 'second' });
    expect(log).not.toHaveBeenCalled();
    await shadow.flush();
    expect(log.mock.calls.map(([report]) => report.result.status)).toEqual(['answered', 'abstained']);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ at: '2026-11-25T02:00:00.000Z', answer: 'Baseline', runId: 'first',
      snapshot: { dumpDate, license: 'CC0-1.0' }, result: { values: [{ id: 'Q61' }] } });
  });
});
