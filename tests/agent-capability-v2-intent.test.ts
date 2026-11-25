import { describe, expect, it } from 'vitest';
import { capabilityCaseSchema } from '../scripts/agent-capability-bench/corpus.js';
import { importClinc, importMassive } from '../scripts/agent-capability-bench/v2/intent.js';

// Parser/mapper test inputs only. These are never included in the sealed corpus or sent to chat.
describe('CLINC150 mapping', () => {
  it('assigns expectations for the evaluated test intents and counts ambiguous rows', () => {
    const result = importClinc(JSON.stringify({
      train: [['Thank you for the work on the fixture.', 'thank_you']],
      test: [
        ['What is your preferred name for this demo?', 'what_is_your_name'],
        ['What is 31 times 7?', 'calculator'],
        ['What is 7 divided by 3?', 'calculator'],
        ['Could you repeat that last bit?', 'repeat'],
        ['Display my account balance.', 'balance'],
        ['Can you look up available flights?', 'book_flight'],
        ['Please book a flight to Testville.', 'book_flight'],
      ],
      oos_test: [['Where can I buy tickets near Testville?', 'oos'], ['Please order a blue notebook.', 'oos']],
    }));
    expect(result.seen).toBe(9);
    expect(result.dropped).toEqual({ 'no-faithful-mapping': 3, 'oos-scope-unconfirmed': 1 });
    expect(result.candidates.map(({ key, family, item }) => [key, family, item.area])).toEqual([
      ['test:0', 'test:0', 'small-talk'], ['test:1', 'test:1', 'calculation'], ['test:3', 'test:3', 'clarification'],
      ['test:6', 'test:6', 'refusal'], ['oos_test:1', 'oos_test:1', 'refusal'],
    ]);
    expect(result.candidates[1]?.item.turns[0]?.expect).toMatchObject({
      requiredTools: ['calculate'], requiredContent: [{ match: 'number', anyOf: ['217'] }],
    });
    expect(result.candidates[2]?.item.turns[0]?.expect).toMatchObject({ route: ['clarify'], status: ['waiting_user'], questionCount: 1 });
    expect(result.candidates[4]?.item.turns[0]?.expect).toMatchObject({ route: ['unsupported'], status: ['blocked', 'partial'], questionCount: 0 });
    for (const [index, { item }] of result.candidates.entries()) {
      expect(capabilityCaseSchema.safeParse({ ...item, id: `structural-${index}`, provenance: { author: 'human', source: 'test' } }).success).toBe(true);
    }
  });

  it('rejects invalid source shape without including utterances in errors', () => {
    expect(() => importClinc(JSON.stringify({ test: [], oos_test: [['SOURCE_TEXT', 'wrong']] })))
      .toThrow(/^Invalid CLINC150 source JSON\.$/u);
  });
});

const en = (id: string, intent: string, utt: string, partition = 'test') => JSON.stringify({ id, intent, utt, partition, locale: 'en-US' });
const ar = (id: string, intent: string, utt: string, scores = [1, 1, 1]) => JSON.stringify({
  id, intent, utt, partition: 'test', locale: 'ar-SA', judgments: scores.map(intent_score => ({ intent_score })),
});

describe('MASSIVE mapping', () => {
  it('uses human-judged Arabic intents and assigns parallel localizations to the same source family', () => {
    const result = importMassive([
      en('1', 'play_music', 'Please play my classical recording.'),
      en('2', 'play_podcasts', 'Find interesting podcasts about birds.'),
      en('3', 'email_sendemail', 'Compose a new email for Testville.'),
      en('4', 'play_music', 'Stream this recording.'),
      en('5', 'play_music', 'Stream the archival recording.', 'train'),
      en('6', 'datetime_convert', 'Calculate the time difference between here and Testville.'),
      en('7', 'iot_hue_lightoff', 'Switch off all the kitchen lamps.'),
      en('8', 'play_music', 'Turn on the music app.'),
    ].join('\n'), [
      ar('1', 'play_music', 'من فضلك شغل تسجيل الموسيقى الكلاسيكية.'),
      ar('2', 'play_podcasts', 'ابحث عن بودكاست عن الطيور.'),
      ar('3', 'email_sendemail', 'اكتب بريدا إلكترونيا جديدا لأهل القرية.'),
      ar('4', 'play_music', 'شغل تسجيلي.', [1, 2, 0]),
      ar('6', 'datetime_convert', 'احسب فرق التوقيت بين هنا وهذه القرية.'),
      ar('7', 'iot_hue_lightoff', 'اطفئ جميع لمبات المطبخ.'),
      ar('8', 'play_music', 'Open the music app.'),
    ].join('\n'));

    expect(result.seen).toBe(14);
    expect(result.dropped).toEqual({ 'no-faithful-mapping': 5, 'arabic-intent-unconfirmed': 2 });
    expect(result.candidates.map(({ key, family, item }) => [key, family, item.language, item.area])).toEqual([
      ['en-US:1', '1', 'en', 'refusal'], ['en-US:4', '4', 'en', 'refusal'], ['en-US:6', '6', 'en', 'clarification'],
      ['en-US:7', '7', 'en', 'refusal'], ['ar-SA:1', '1', 'ar', 'refusal'], ['ar-SA:6', '6', 'ar', 'clarification'],
      ['ar-SA:7', '7', 'ar', 'refusal'],
    ]);
    const arabic = result.candidates.find(({ key }) => key === 'ar-SA:1')?.item;
    expect(arabic?.variety).toBe('unspecified');
    expect(arabic?.turns[0]).toMatchObject({ text: 'من فضلك شغل تسجيل الموسيقى الكلاسيكية.', expect: { route: ['unsupported', 'media'] } });
  });

  it('rejects invalid locales and duplicate source IDs with a fixed diagnostic', () => {
    const english = en('1', 'general_quirky', 'SOURCE_TEXT');
    const arabic = ar('1', 'general_quirky', 'SOURCE_TEXT');
    expect(() => importMassive(english, `${arabic}\n${arabic}`)).toThrow(/^Invalid MASSIVE ar-SA source row 2\.$/u);
    expect(() => importMassive(english, english)).toThrow(/^Invalid MASSIVE ar-SA source row 1\.$/u);
  });
});
