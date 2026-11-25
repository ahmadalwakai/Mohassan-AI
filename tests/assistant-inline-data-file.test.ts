import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand } from '@mohassan/desktop';
import { evaluateInlineDataFile } from '../apps/server/src/assistant/inline-data-file.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('inline data file serialization', () => {
  it('preserves supplied fields and parses only explicit scalar values', () => {
    const output = evaluateInlineDataFile('Format the measurements as JSON: "sensor id" = "0042", reading = -2.5, ready = true, note = "pipe, valve and filter".');
    expect(JSON.parse(output!)).toEqual({ 'sensor id': '0042', reading: -2.5, ready: true, note: 'pipe, valve and filter' });
    expect(evaluateInlineDataFile('Make JSON with code null and count 9007199254740993. Return only JSON.')).toBe(
      '{\n  "code": null,\n  "count": "9007199254740993"\n}',
    );
    expect(evaluateInlineDataFile('Write JSON: {"large":9007199254740993}')).toBe('{"large":9007199254740993}');
    expect(JSON.parse(evaluateInlineDataFile('Make JSON with color "deep red" and enabled true.')!)).toEqual({ color: 'deep red', enabled: true });
  });

  it('uses explicit CSV headers and escapes quoted cells without losing Unicode', () => {
    expect(evaluateInlineDataFile('Return the readings in CSV with columns location and temperature: "room, west" -2.5, Cañón 4.')).toBe(
      'location,temperature\n"room, west",-2.5\nCañón,4',
    );
    expect(evaluateInlineDataFile(String.raw`Make CSV: [["a\"b",5],["c\nd",null]]`)).toBe('"a""b",5\n"c\nd",');
    expect(evaluateInlineDataFile('Make CSV: [[9007199254740993],[1e400]]')).toBe('9007199254740993\n1e400');
    expect(evaluateInlineDataFile('Return readings as CSV with columns "probe name" and "field, unit": A1 10, B2 14.')).toBe('probe name,"field, unit"\nA1,10\nB2,14');
    expect(evaluateInlineDataFile('أنشئ جدول CSV من القراءات: المستودع ٧، الساحة ٨. أعطني نص الملف هنا.')).toBe('المستودع,٧\nالساحة,٨');
  });

  it.each([
    'What is JSON? Include an example: width 10.',
    'Convert the attached record into JSON: width 10.',
    'Convert report.xlsx to JSON: total as shown.',
    'Convert the PDF into JSON: width 10.',
    'Make JSON: height 8, height 12.',
    'Return CSV with columns city, country and count: Peru 7.',
    'Make a JSON file named settings.json: start true.',
    'Create JSON with ready true and send it to the coordinator.',
    'Create JSON with value 10. Save it to draft.json.',
    'Create JSON with value 10. CSV only.',
  ])('leaves requests outside this serializer untouched (%s)', request => {
    expect(evaluateInlineDataFile(request)).toBeNull();
  });
});

describe('inline data files in command chat', () => {
  const owner = 'inline-data-owner';
  const lookup = vi.fn(async () => { throw new Error('Inline data must stay in the current request.'); });
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase({});
    await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
      models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'inline-data-test', search: lookup }, knowledgeSearch: lookup,
      documents: { link: () => 'unused', control: { create: lookup, edit: lookup, list: lookup, content: lookup, readLocal: lookup, info: lookup } },
      desktop: { parse: parseDesktopCommand, describe: describeDesktopCommand, execute: lookup },
    });
  });

  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  it.each([
    ['حوّل القياسات هذه إلى JSON: الموقع سَدير والارتفاع ٣٤.', '{\n  "الموقع": "سَدير",\n  "الارتفاع": 34\n}'],
    ['Give me CSV with columns sensor and status: [["south","ready"],["west","offline"]]', 'sensor,status\nsouth,ready\nwest,offline'],
    ['Create a file JSON: format PDF.', '{\n  "format": "PDF"\n}'],
  ])('returns complete inline data without a lookup or a question', async (goal, expected) => {
    expect(decideRequestRoute({ text: goal })).toMatchObject({ route: 'writing', availability: 'ready', publicQuery: null,
      sourceAssessment: { source: 'supplied_content', operation: 'transform' } });
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail).toMatchObject({ status: 'idle', error: null, question: null });
    expect(detail.messages.at(-1)?.text).toBe(expected);
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(lookup).not.toHaveBeenCalled();
  });
});
