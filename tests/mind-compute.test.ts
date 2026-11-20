import { describe, expect, it } from 'vitest';
import { compute } from '../apps/server/src/assistant/mind/compute.js';
import type { Frame, Lang } from '../apps/server/src/assistant/mind/contract.js';

const now = new Date('2026-10-04T18:30:00Z');
const frame = (text: string, lang: Lang, valueOnly = false): Frame => ({
  lang, text, intent: 'compute', valueOnly, timeSensitive: false, personal: false,
  matched: [], focus: [], urls: [], answerType: null, missing: [],
});

describe('compute in English', () => {
  it.each([
    ['Calculate (7 plus 5) divided by 3.', '4'],
    ['Calculate 6 times 19 minus 3.', '111'],
    ['What is 12.5 percent of 160?', '20'],
    ['Compute 2^-2.', '0.25'],
    ['Evaluate -3^2.', '-9'],
    ['What is 0.1 + 0.2?', '0.3'],
    ['What is 9007199254740990 + 1?', '9007199254740991'],
    ['Convert 5.4 metres to centimetres.', '540'],
    ['Convert 3 lb to grams.', '1360.77711'],
    ['Convert 86 °F to Celsius.', '30'],
    ['Convert 0 Kelvin to Celsius.', '-273.15'],
    ['Convert 6.2 km² to hectares.', '620'],
    ['Convert 4.3 litres to millilitres.', '4300'],
    ['Convert 72 km/h to m/s.', '20'],
    ['Convert 2 GiB to MiB.', '2048'],
    ['Convert 72 Mb to MB.', '9'],
    ['Convert 2.5 hours to minutes.', '150'],
    ['How many days between 2020-02-28 and 2020-03-03?', '4'],
    ['What day of the week was 2024-02-29?', 'Thursday'],
    ['How many days until February 5, 2027?', '124'],
    ['Add 1 month to 2024-01-31.', '2024-02-29'],
    ['What time is it in Tokyo?', '03:30'],
    ['Convert 08:00 America/New_York to Europe/London on 2026-08-04.', '13:00'],
    ['Convert 09:15 GMT+5:30 to UTC.', '03:45'],
  ])('%s', (text, value) => {
    const computed = compute(frame(text, 'en'), now);
    expect(computed?.status).toBe('completed');
    expect(computed?.evidence).toMatchObject([{ source: 'computed', value }]);
    expect(computed?.text).toContain(value);
    expect(computed?.claims[0].support).toContain(computed?.evidence[0]?.id);
  });

  it.each([
    ['What is 13 / 0?', 'zero'],
    ['What is 2^100?', 'number range'],
    ['Calculate 7(3 + 1).', 'expression'],
    ['Convert 3 barrels to furlongs.', 'compatible units'],
    ['Convert -1 Kelvin to Fahrenheit.', 'number range'],
    ['How many days from 2023-02-29 to 2023-03-04?', 'invalid'],
    ['Convert 02:30 America/New_York to UTC on 2024-03-10.', 'single time'],
    ['Convert 01:30 America/New_York to UTC on 2024-11-03.', 'single time'],
    ['What time is it in Europe/Unknown?', 'single time'],
    ['Calculate a date in the Hijri calendar.', 'Hijri'],
  ])('reports a boundary for %s', (text, expected) => {
    const result = compute(frame(text, 'en'), now);
    expect(result?.status).toBe('blocked');
    expect(result?.text).toContain(expected);
    expect(result?.evidence).toEqual([]);
  });

  it.each([
    'Convert 27 GBP to JPY.',
    'Calculate console.log(1).',
    'What is the manufacturing date on the document?',
  ])('leaves an unsupported request available to routing for %s', text => {
    expect(compute(frame(text, 'en'), now)).toBeNull();
  });
});

describe('compute in Arabic', () => {
  it.each([
    ['كم ١٢٫٥٪ من ٤٨٠؟', '60'],
    ['احسب (٢٧ + ٩) ÷ ٦', '6'],
    ['حوّل ٣٫٧٥ كيلوجرام إلى جرام.', '3750'],
    ['حوّل ١٦ مترًا مربعًا إلى سنتيمتر مربع.', '160000'],
    ['ما اليوم الموافق ٢٩ شباط ٢٠٢٤؟', 'الخميس'],
    ['كم يومًا بين 2020-02-28 و2020-03-03؟', '4'],
    ['كم يومًا حتى ١٢ تشرين الأول ٢٠٢٦؟', '8'],
    ['أضف ١٢ يوماً إلى 2020-12-30.', '2021-01-11'],
    ['كم الساعة في دبي؟', '22:30'],
  ])('%s', (text, value) => {
    const computed = compute(frame(text, 'ar'), now);
    expect(computed?.status).toBe('completed');
    expect(computed?.evidence).toMatchObject([{ source: 'computed', value }]);
    expect(computed?.text).toContain(value);
  });

  it.each([
    ['احسب ١٠ ÷ صفر', null],
    ['احسب ١٠ ÷ ٠', 'صفر'],
    ['حوّل ٢ تمور إلى متر', 'وحدتين'],
    ['كم يومًا حتى ٣٠ شباط ٢٠٢٥؟', 'غير صالح'],
    ['احسب التاريخ الهجري', 'الهجري'],
  ])('handles a boundary for %s', (text, expected) => {
    const result = compute(frame(text, 'ar'), now);
    expect(result?.text ?? null).toEqual(expected ? expect.stringContaining(expected) : null);
  });

  it('preserves the proof when the answer format requests the value alone', () => {
    const result = compute(frame('احسب ٣+٧', 'ar', true), now);
    expect(result).toMatchObject({ text: '10', evidence: [{ quote: '3+7 = 10', value: '10' }] });
  });
});

describe('short-answer calculation in English', () => {
  it.each([
    ['Subtract (3.5 + 4.5) from 25.25. Reply with only the value.', '17.25'],
    ['Divide (-75) by (2 + 3); answer only, please.', '-15'],
    ['What is (13 + 8) times 5? Just the answer.', '105'],
    ['Calculate 2.5 per cent of 1,250.4, number only.', '31.26'],
    ['Convert: 4.5 kilograms, to grams; only the result.', '4500'],
    ['Convert 8.25 (metres) → cm. No explanation.', '825'],
    ['Add 8.25 to 13.5, just the number.', '21.75'],
    ['Multiply 4 by (2 + 7), only.', '36'],
  ])('%s', (text, value) => {
    const result = compute(frame(text, 'en'), now);
    expect(result).toMatchObject({ status: 'completed', text: value, evidence: [{ source: 'computed', value }] });
    expect(result?.evidence[0].quote.endsWith(`= ${value}`) || result?.evidence[0].quote.includes(`= ${value} `)).toBe(true);
  });

  it('blocks word-order division by zero', () => {
    const result = compute(frame('Divide 19 by (6 minus 6); just the answer.', 'en'), now);
    expect(result).toMatchObject({ status: 'blocked', text: expect.stringContaining('zero'), evidence: [] });
  });

  it.each([
    'Calculate 1,23,456 + 1; output the value only.',
    'Subtract 2 from 7, then send the answer only to a contact.',
    'What is 27 USD in GBP? Answer only.',
  ])('falls back without creating a value for %s', text => {
    expect(compute(frame(text, 'en'), now)).toBeNull();
  });
});

describe('short-answer calculation in Arabic', () => {
  it.each([
    ['١٢ ونص بالمية من ٨٠ فقط', null],
    ['٧٫٥ بالميه من ٨٠٠، الرقم بس.', '60'],
    ['۱۲٫۵ في المائة من ۱٬۲۴۰، الجواب فقط؟', '155'],
    ['٣٬٢٥٠٫٧٥ ناقص ١٥٠٫٢٥؛ الناتج فقط', '3100.5'],
    ['اطرح ١٥ من (٨٠ - ٤)، أعطني الناتج فقط.', '61'],
    ['اقسم ٣٦ على (٢ + ١)؟ القيمة وحدها', '12'],
    ['حوّل: ٥٫٧٥ كغ، إلى، غرام. فقط، شكرًا.', '5750'],
    ['كم (٢٢ - ٤) ضرب ٤؟ الجواب بس', '72'],
  ])('%s', (text, value) => {
    const result = compute(frame(text, 'ar'), now);
    if (value === null) expect(result).toBeNull();
    else expect(result).toMatchObject({ status: 'completed', text: value, evidence: [{ source: 'computed', value }] });
  });

  it('blocks mismatched units after internal punctuation', () => {
    const result = compute(frame('حوّل: ٢٫٧٥ متر، إلى غرام، فقط.', 'ar'), now);
    expect(result).toMatchObject({ status: 'blocked', text: expect.stringContaining('وحدتين'), evidence: [] });
  });

  it.each([
    '٢٬٧٥ ثم ٣، فقط',
    'احسب ٢+٣ واكتب شيئًا آخر غير الناتج فقط.',
    'حوّل ٤٢ يورو إلى ريال، الناتج فقط.',
  ])('falls back without creating a value for %s', text => {
    expect(compute(frame(text, 'ar'), now)).toBeNull();
  });
});

describe('spoken quantities and calculation intent in Arabic', () => {
  it.each([
    ['نبغى نحسب ٢٫٥٪ من ١٬٨٠٠', '45'],
    ['عايز أحسب (١٨ + ٢) ÷ ٤، بس', '5'],
    ['أريد أن أحسب ٩٪ من ٣٠٠', '27'],
    ['حوّل ثلثَي ساعة إلى دقيقة', '40'],
    ['حوّل ربع كيلوغرام إلى غرام', '250'],
    ['حوّل خمسة أثمان لتر إلى ملليلتر', '625'],
    ['حوّل ٧/٨ متر إلى سنتيمتر', '87.5'],
    ['حوّل نصف الساعة إلى دقائق', '30'],
  ])('%s', (text, value) => {
    const result = compute(frame(text, 'ar'), now);
    expect(result).toMatchObject({ status: 'completed', evidence: [{ source: 'computed', value }] });
    expect(result?.claims[0].text).toContain(value);
  });

  it('keeps the full expression boundary after an intent phrase', () => {
    expect(compute(frame('بدي احسب ٤+٥ وبعدها أرسلها إلى المحاسب', 'ar'), now)).toBeNull();
  });

  it('rejects fractions with a malformed delimiter', () => {
    const result = compute(frame('حوّل ٤//٦ متر إلى مليمتر', 'ar'), now);
    expect(result).toMatchObject({ status: 'blocked', evidence: [] });
  });
});

describe('written and numeric fractions in English unit conversions', () => {
  it.each([
    ['Convert two thirds of an hour to minutes.', '40'],
    ['Convert half a kilogram to grams.', '500'],
    ['Convert 1/16 metre to millimetres.', '62.5'],
  ])('%s', (text, value) => {
    const result = compute(frame(text, 'en'), now);
    expect(result).toMatchObject({ status: 'completed', evidence: [{ source: 'computed', value }] });
    expect(result?.claims[0].text).toContain(value);
  });

  it('rejects a numeric fraction whose denominator is zero', () => {
    const result = compute(frame('Convert 3/0 kilograms to grams.', 'en'), now);
    expect(result).toMatchObject({ status: 'blocked', text: expect.stringContaining('zero'), evidence: [] });
  });

  it('leaves a written fraction of currency to the exchange route', () => {
    expect(compute(frame('Convert half a dollar to euros.', 'en'), now)).toBeNull();
  });
});
