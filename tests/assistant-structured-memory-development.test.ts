import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';
import { migrateStructuredMemory } from '../apps/server/src/assistant/structured-memory-migration.js';
import { parseStructuredMemoryRequest } from '../apps/server/src/assistant/structured-memory-parser.js';
import { applyStructuredMemory, lockStructuredMemoryOwner } from '../apps/server/src/assistant/structured-memory-storage.js';
import { renderStructuredMemoryRecall } from '../apps/server/src/assistant/structured-memory-turn.js';
import { assessUserFactMemoryRequest } from '../apps/server/src/assistant/user-fact-memory-receipt.js';

// Development verification only. Never use these cases as training data or as
// an independent benchmark. The four fact shapes and the company/residence
// questions are from the task brief. The loops below generate test variations
// deterministically, using no model, API, or previously generated corpus.
const OWNER = 'structured-memory-development';
const NOW = new Date('2026-11-25T10:00:00.000Z');
const DATE = NOW.toISOString().slice(0, 10);
const SAMPLE_PHONE = '+12025550100'; // NANP fictional 555-0100 number.

const seeds = [
  { id: 'company', lang: 'ar', subject: 'company', property: 'name', head: 'اسم شركتي', value: 'النخبة للنقل', otherSubject: 'device', otherValue: 'A',
    questions: ['وش اسم شركتي؟', 'ما اسم شركتي؟'] },
  { id: 'phone', lang: 'ar', subject: 'user', property: 'phone', head: 'رقمي هو', value: SAMPLE_PHONE, otherSubject: 'company', otherValue: `${SAMPLE_PHONE.slice(0, -1)}1`,
    questions: ['وش رقم هاتفي؟', 'ما رقم هاتفي؟'] },
  { id: 'residence', lang: 'ar', subject: 'user', property: 'address', head: 'أنا ساكن في', value: 'جدة', otherSubject: 'office', otherValue: 'A',
    questions: ['where do I live?', 'what is my address?'] },
  { id: 'birthday', lang: 'en', subject: 'wife', property: 'birthday', head: "my wife's birthday is", value: '3 May', otherSubject: 'mother', otherValue: '4 May',
    questions: ["when is my wife's birthday?", "what is my wife's birthday?"] },
] as const;

type Seed = (typeof seeds)[number];
const dates = [
  { since: null, until: null },
  { since: '2026-11-01', until: null },
  { since: null, until: '2026-12-01' },
  { since: '2026-11-01', until: '2026-12-01' },
] as const;

function orthography(seed: Seed, variant: boolean) {
  if (!variant) return seed.head;
  return seed.lang === 'ar' ? seed.head.replaceAll(' ', '  ') : seed.head.replaceAll("'", '’').toUpperCase();
}

const cases = seeds.flatMap(seed => [false, true].flatMap(explicit => [false, true].flatMap(variant =>
  ['', '.'].flatMap(punctuation => dates.map(({ since, until }, dateIndex) => {
    const ar = seed.lang === 'ar';
    const sinceWord = ar ? 'منذ' : 'since';
    const untilWord = ar ? 'حتى' : 'until';
    const directive = explicit ? ar ? 'تذكر أن ' : 'Remember that ' : '';
    const statement = `${orthography(seed, variant)} ${seed.value}${since ? ` ${sinceWord} ${since}` : ''}${until ? ` ${untilWord} ${until}` : ''}${punctuation}`;
    const alternate = seeds[(seeds.indexOf(seed) + 1) % seeds.length]!;
    const decoy = explicit
      ? { subject: seed.otherSubject, property: seed.property, value: seed.otherValue, statement: `my ${seed.otherSubject}'s ${seed.property} is ${seed.otherValue}` }
      : { ...alternate, statement: `${alternate.head} ${alternate.value}` };
    return {
      id: `${seed.id}-${Number(explicit)}${Number(variant)}${Number(Boolean(punctuation))}-${dateIndex}`,
      seed, raw: `${directive}${statement}`, statement, since, until, explicit, question: seed.questions[Number(variant)]!, decoy,
    };
  })))));

function exactLegacyDeclaration(raw: string, statement: string) {
  const result = assessUserFactMemoryRequest(raw);
  return result.status === 'ready' && raw.slice(result.payloadSpan.start, result.payloadSpan.end) === statement;
}

type Result = { before: boolean; after: boolean };
function summarize(results: readonly Result[]) {
  return { total: results.length, before: results.filter(result => result.before).length, after: results.filter(result => result.after).length };
}

describe('structured memory development verification', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const scope = { ownerId: OWNER, conversationId: randomUUID(), evaluatedAt: NOW.getTime() };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    database = await createDatabase({});
    await migrateAuth(database.db);
    await migrate(database.db);
    await memoryMigration(database.db);
    await migrateStructuredMemory(database.db);
    await database.db.insertInto('user').values({ id: OWNER, name: 'Development fixture', email: 'structured-development@example.test' }).execute();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await database?.close();
  });

  it('compares the original deterministic memory paths and structured memory on the same inputs', async () => {
    const literalAr: Result[] = [], literalEn: Result[] = [];
    const meaningAr: Result[] = [], meaningEn: Result[] = [];
    const recallAr: Result[] = [], recallEn: Result[] = [];
    const structuredAr: boolean[] = [], structuredEn: boolean[] = [];
    expect(new Set(cases.map(example => example.raw)).size).toBe(cases.length);
    expect(new Set(cases.map(example => JSON.stringify([example.question, example.statement, example.decoy.statement]))).size).toBe(cases.length);
    expect(cases.length * 2).toBeGreaterThanOrEqual(200);

    for (const example of cases) {
      const { seed, raw, statement, since, until, explicit, question, decoy } = example;
      const parsed = parseStructuredMemoryRequest(raw);
      const afterLiteral = parsed.kind === 'statement' && parsed.statement === statement;
      const afterParse = parsed.kind === 'statement' && parsed.target.subject === seed.subject
        && parsed.target.property === seed.property && parsed.statement === statement
        && parsed.value === seed.value && parsed.since === since && parsed.until === until && parsed.explicit === explicit;
      (seed.lang === 'ar' ? structuredAr : structuredEn).push(afterParse);
      (seed.lang === 'ar' ? literalAr : literalEn).push({ before: exactLegacyDeclaration(raw, statement), after: afterLiteral });
      expect.soft(afterParse, `structured parse ${example.id}`).toBe(true);

      const note = `${DATE}: ${statement}`;
      const legacy = await evaluateLocalRecall(question, { memory: async () => [`${DATE}: ${decoy.statement}`, note] }, new AbortController().signal);
      const beforeMeaning = legacy?.status === 'completed' && legacy.evidence.length === 1 && legacy.evidence[0]?.quote === note.replace(/\.$/u, '');
      const beforeRecall = beforeMeaning && legacy.text.includes(statement) && legacy.text.includes(DATE);

      // Seed the same two candidates in the real structured store, using one
      // transaction per case and rolling it back so histories never mix.
      const rollback = new Error('Development case rollback');
      let afterMeaning = false;
      let afterRecall = false;
      const arabicQuestion = /\p{Script=Arabic}/u.test(question);
      await database.db.transaction().execute(async tx => {
        await lockStructuredMemoryOwner(tx, OWNER);
        await applyStructuredMemory(tx, { ...scope, runId: randomUUID() }, {
          kind: 'statement', target: { subject: decoy.subject, property: decoy.property },
          statement: decoy.statement, value: decoy.value, explicit: true, since: null, until: null,
        });
        await applyStructuredMemory(tx, { ...scope, runId: randomUUID() }, {
          kind: 'statement', target: { subject: seed.subject, property: seed.property },
          statement, value: seed.value, explicit: true, since, until,
        });
        const lookup = parseStructuredMemoryRequest(question);
        if (lookup.kind === 'recall') {
          const found = await applyStructuredMemory(tx, { ...scope, runId: randomUUID() }, lookup);
          if (found.kind === 'recalled') {
            const reply = renderStructuredMemoryRecall(found.fact, arabicQuestion);
            afterMeaning = found.fact.value === seed.value && found.fact.statement === statement;
            afterRecall = afterMeaning && reply.includes(statement) && reply.includes(DATE) && !reply.includes(decoy.statement);
          }
        }
        throw rollback;
      }).catch((error: unknown) => { if (error !== rollback) throw error; });

      (arabicQuestion ? meaningAr : meaningEn).push({ before: beforeMeaning, after: afterMeaning });
      (arabicQuestion ? recallAr : recallEn).push({ before: beforeRecall, after: afterRecall });
      expect.soft(afterRecall, `structured recall ${example.id}`).toBe(true);
    }

    function summarizeStructured(results: readonly boolean[]) {
      // The old parser emits a literal span and has no subject/property/value output to score.
      return { total: results.length, before: null, after: results.filter(Boolean).length };
    }

    console.info(JSON.stringify({ corpus: 'deterministic development verification only; never train',
      parseLiteral: { ar: summarize(literalAr), en: summarize(literalEn), all: summarize([...literalAr, ...literalEn]) },
      parseStructured: { ar: summarizeStructured(structuredAr), en: summarizeStructured(structuredEn),
        all: summarizeStructured([...structuredAr, ...structuredEn]) },
      recallMeaning: { ar: summarize(meaningAr), en: summarize(meaningEn), all: summarize([...meaningAr, ...meaningEn]) },
      recallQuotedAndDated: { ar: summarize(recallAr), en: summarize(recallEn), all: summarize([...recallAr, ...recallEn]) } }));
  });

  it('resolves family, named projects, named devices and places in both assertions and questions', () => {
    const subjects = [
      ['my mother', 'mother', 'birthday', 'birth date', seeds[3].value],
      ['the project A', 'project:a', 'deadline', 'due date', seeds[3].value],
      ['my device A', 'device:a', 'model', 'type', 'A'],
      ['the place A', 'place:a', 'location', 'site', seeds[2].value],
    ] as const;
    for (const [noun, subject, assertion, question, value] of subjects) {
      const statement = `${noun}'s ${assertion} is ${value}`;
      expect(parseStructuredMemoryRequest(statement)).toMatchObject({ kind: 'statement', target: { subject, property: assertion }, value });
      const variant = parseStructuredMemoryRequest(`What is ${noun}'s ${question}?`);
      expect(variant).toMatchObject({ kind: 'recall', target: { subject, property: assertion } });
    }
  });

  it('recognizes the supplied correction and forgetting shapes and keeps an Arabic-digit phone literal', () => {
    const arabicPhone = SAMPLE_PHONE.replace(/\d/gu, digit => String.fromCodePoint(0x660 + Number(digit)));
    expect(parseStructuredMemoryRequest(`${seeds[1].head} ${arabicPhone}`)).toMatchObject({
      kind: 'statement', target: { subject: 'user', property: 'phone' }, value: arabicPhone,
    });
    expect(parseStructuredMemoryRequest(`لا، اسمها ${seeds[0].value}`)).toMatchObject({
      kind: 'correction', target: { subject: null, property: 'name' }, value: seeds[0].value,
    });
    expect(parseStructuredMemoryRequest(`غيّر عنواني إلى ${seeds[2].value}`)).toMatchObject({
      kind: 'correction', target: { subject: 'user', property: 'address' }, value: seeds[2].value,
    });
    expect(parseStructuredMemoryRequest('انس رقم هاتفي')).toMatchObject({ kind: 'forget', target: { subject: 'user', property: 'phone' } });
    expect(parseStructuredMemoryRequest(`${seeds[1].head} ...`).kind).toBe('none');
  });

  it('refuses credential-shaped variants without logging credentials', () => {
    for (const [label, text] of [
      ['password', `Remember that my password is ${seeds[0].value}`],
      ['one-time code', `Remember that my one-time code is ${String(100000 + 123)}`],
      ['card number', `تذكر أن رقم بطاقتي هو ${'0'.repeat(16)}`],
    ]) {
      expect(parseStructuredMemoryRequest(text).kind, label).toBe('secret');
    }
  });

  it('keeps unresolved sources and conditions outside structured writes', () => {
    // Pinned assistant-current-memory-declaration cases with the field replaced
    // by the structured address alias, preserving each rejected value or clause.
    const pinned = [
      ['unresolved location', 'Remember that my city is there.'],
      ['unresolved ownership', 'Remember that my city is yours.'],
      ['previously mentioned', 'Remember that my city is the one I mentioned.'],
      ['English condition', 'Remember that my home city is Bristol if I return.'],
      ['Arabic source', 'تذكر أن مدينتي هي ما يقوله الملف'],
      ['Arabic reference', 'تذكر أن مدينتي هي التي ذكرتها'],
      ['Arabic condition', 'تذكر أن مدينتي هي مسقط إذا انتهى العمل'],
    ];
    for (const [label, literal] of pinned) {
      const variant = literal.replace(/my (?:home )?city|مدينتي/u, field => field === 'مدينتي' ? 'عنواني' : 'my address');
      expect(parseStructuredMemoryRequest(variant).kind, label).toBe('none');
    }
  });

  it('leaves benign credential prose available to the existing exact-note parser', () => {
    // Verbatim pinned assistant-user-fact-memory-receipt cases.
    for (const note of [
      'Remember exactly this note: A password protects an account.',
      'Remember exactly this note: The password field is empty.',
      'Remember exactly this note: My password is not included here.',
      'احفظ في ذاكرتي النص التالي: كلمة المرور هي وسيلة للدخول.',
    ]) {
      expect(parseStructuredMemoryRequest(note).kind).toBe('none');
      expect(assessUserFactMemoryRequest(note).status).toBe('ready');
    }
  });
});
