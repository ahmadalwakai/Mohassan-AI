import { describe, expect, it } from 'vitest';
import {
  conflictingQuantity, equivalentQuantity, extractQuantities, labelledConversion, supportsQuantity,
} from '../apps/server/src/assistant/truth-agreement-quantities.js';

// Agent-written development cases. This suite is for verification only.
const figure = (text: string) => extractQuantities(text)[0]!;
const values = (text: string) => extractQuantities(text).map(({ kind, value, unit }) => ({ kind, value, unit }));

describe('pre-send truth quantities', () => {
  it('reads a bilingual date as a single value and retains offsets', () => {
    const input = 'افتتح المتحف في ١٤ تِشرين الثاني ۲۰۲۲، ثم زاره ۲٬۳۰۰ شخص.';
    const quantities = extractQuantities(input);
    expect(quantities.map(({ kind, value, unit }) => [kind, value, unit]))
      .toEqual([['date', '2022-11-14', null], ['number', '2300', 'people']]);
    expect(input.slice(quantities[0].start, quantities[0].end)).toBe('١٤ تِشرين الثاني ۲۰۲۲');
    expect(input.slice(quantities[1].start, quantities[1].end)).toBe('۲٬۳۰۰ شخص');
    expect(equivalentQuantity(quantities[0], figure('November 14th, 2022'))).toBe(true);
  });

  it('distinguishes an elapsed count from a contextual year', () => {
    expect(values('The works took 2023 days and ended in 2024.')).toEqual([
      { kind: 'number', value: '2023', unit: 'days' },
      { kind: 'date', value: '2024', unit: null },
    ]);
    expect(figure('2024').kind).toBe('date');
    expect(figure('Capacity is 2024.').kind).toBe('number');
    expect(figure('افتتح المعرض عام ١٩٨٩م').kind).toBe('date');
    expect(figure('ارتفاع المعرض ١٩٨٩م').unit).toBe('m');
    expect(figure('The stadium opened in the 1980s.').kind).toBe('number');
  });

  it('rejects an invalid calendar day and distinguishes date precision', () => {
    expect(values('Opened on 2023-02-29.').some(value => value.kind === 'date')).toBe(false);
    expect(values('Opened on 30 February 2024.').some(value => value.kind === 'date')).toBe(false);
    const year = figure('in 2024');
    const leapDay = figure('29 February 2024');
    expect(supportsQuantity(year, leapDay)).toBe(true);
    expect(supportsQuantity(leapDay, year)).toBe(false);
    expect(conflictingQuantity(leapDay, year)).toBe(false);
    expect(conflictingQuantity(leapDay, figure('in 2023'))).toBe(true);
    expect(supportsQuantity(figure('February 2024'), figure('2024/02/29'))).toBe(true);
  });

  it('keeps amount, sign, scale, percent, and count unit exact', () => {
    expect(values('بلغ الحضور ١٫٢ مليون شخص وبلغ النمو ٣٫٥٪.')).toEqual([
      { kind: 'number', value: '1200000', unit: 'people' },
      { kind: 'number', value: '3.5', unit: '%' },
    ]);
    expect(equivalentQuantity(figure('1.2 million people'), figure('1,200,000 persons'))).toBe(true);
    expect(equivalentQuantity(figure('1,200,000 citizens'), figure('1,200,000 residents'))).toBe(false);
    expect(figure('2M').unit).toBeNull();
    expect(equivalentQuantity(figure('−12 degrees Celsius'), figure('12°C'))).toBe(false);
    expect(equivalentQuantity(figure('25 percent'), figure('25 percentage points'))).toBe(false);
    expect(equivalentQuantity(figure('9007199254740992 seats'), figure('9007199254740993 seats'))).toBe(false);
  });

  it('recognizes common units and keeps price and density distinct from counts', () => {
    expect(values('USD 21.30, 4 مترًا, 8 books, 10 employees, 2 people per km².')).toEqual([
      { kind: 'number', value: '21.3', unit: 'USD' },
      { kind: 'number', value: '4', unit: 'm' },
      { kind: 'number', value: '8', unit: 'books' },
      { kind: 'number', value: '10', unit: 'employees' },
      { kind: 'number', value: '2', unit: 'people/km2' },
    ]);
    expect(equivalentQuantity(figure('5 USD'), figure('5 EUR'))).toBe(false);
    expect(equivalentQuantity(figure('5 people per km²'), figure('5 people'))).toBe(false);
    expect(figure('a total of 50, as announced').unit).toBeNull();
    expect(figure('The bag weighs 24 pounds.').unit).toBe('lb');
    expect(figure('The ticket costs 24 pounds.').unit).toBe('pounds');
  });

  it('accepts explicit, exact conversions with compatible units', () => {
    const distance = 'The bridge is 2.5 km (converted from meters).';
    expect(labelledConversion(distance, figure(distance), figure('2,500 m'))).toBe(true);
    const arabic = 'المسافة ٢٥٠٠ متر، أي ما يعادل ٢٫٥ كيلومتر.';
    expect(labelledConversion(arabic, extractQuantities(arabic)[1], figure('2,500 m'))).toBe(true);
    const temperature = 'Converted: 32 °F.';
    expect(labelledConversion(temperature, figure(temperature), figure('0 °C'))).toBe(true);
  });

  it('rejects unlabelled, unrelated, wrong, and currency conversions', () => {
    const unlabelled = 'The trail is 2.5 km.';
    const unrelated = 'The bridge is 2.5 km, and the detour is 3 km (converted from m).';
    const incorrect = 'The bridge is 2.5 km (converted from m).';
    const costs = 'Equivalent to 2 GBP.';
    expect(labelledConversion(unlabelled, figure(unlabelled), figure('2,500 m'))).toBe(false);
    expect(labelledConversion(unrelated, figure(unrelated), figure('2,500 m'))).toBe(false);
    expect(labelledConversion(incorrect, figure(incorrect), figure('25,000 m'))).toBe(false);
    expect(labelledConversion(incorrect, figure(incorrect), figure('2,500 kg'))).toBe(false);
    expect(labelledConversion(costs, figure(costs), figure('2 EUR'))).toBe(false);
  });
});
