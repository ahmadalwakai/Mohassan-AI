import { describe, expect, it } from 'vitest';
import {
  extractStructuredEvidence, type EvidenceDate, type StructuredEvidencePage, type StructuredEvidenceTarget,
} from '../apps/server/src/assistant/structured-evidence.js';

const year = (value: number): EvidenceDate => ({ calendar: 'gregorian', year: value });
const day = (y: number, month: number, date: number): EvidenceDate => ({ ...year(y), month, day: date });
const population: StructuredEvidenceTarget = { entity: 'Australia', attribute: 'population', unit: 'people', kind: 'population' };
const price: StructuredEvidenceTarget = { entity: 'Ticket', attribute: 'price', unit: 'USD', kind: 'price' };
const height: StructuredEvidenceTarget = { entity: 'Test Peak', attribute: 'height', unit: 'm', kind: 'height' };
const now = '2026-11-25T12:00:00Z';
const observed = (value: number, period: number) => `Australia’s population was ${value} million people in ${period}.`;
const page = (text: string, properties: Partial<StructuredEvidencePage> = {}): StructuredEvidencePage => ({
  url: 'https://statistics.example/population',
  title: 'Statistics',
  fetchedAt: now,
  text,
  ...properties,
});
const otherPage = (text: string) => page(text, { url: 'https://registry.example/population' });

describe('structured evidence', () => {
  it('quotes the exact original sentence, literal and period using UTF-16 offsets', () => {
    const quote = 'بلغ عدد سكان أستراليا نحو ۲۷٫۲ مليون نسمة عام ٢٠٢٤.';
    const first = page(`📄 تقرير سابق\n  ${quote}  \nملاحظة.`, { publishedAt: '2025-03-09' });
    const result = extractStructuredEvidence({
      ...population, entity: 'أستراليا', attribute: 'عدد السكان', time: year(2024),
    }, [first], { now });
    expect(result.status).toBe('value');
    expect(result.top).toMatchObject({
      value: { kind: 'number', value: 27_200_000, unit: 'count' },
      approximate: true, scaled: true, referenceTime: year(2024), possiblyStale: false,
      evidence: { quote, url: first.url, publishedAt: '2025-03-09', fetchedAt: now },
      timeEvidence: { quote: '٢٠٢٤' },
    });
    const { evidence, timeEvidence } = result.top!;
    expect(first.text.slice(evidence.start, evidence.end)).toBe(quote);
    expect(first.text.slice(evidence.valueStart, evidence.valueEnd)).toBe(evidence.literal);
    expect(evidence.literal).toBe('نحو ۲۷٫۲ مليون نسمة');
    expect(first.text.slice(timeEvidence!.start, timeEvidence!.end)).toBe('٢٠٢٤');
  });

  it('selects the requested period from a yearly series and avoids mixing years', () => {
    const series = page('Australia’s population was 26 million in 2022 and 27 million in 2024.');
    const recent = otherPage('In 2025, Australia had a population of 28 million people.');
    const specific = extractStructuredEvidence({ ...population, time: year(2022) }, [series, recent], { now });
    expect(specific.top?.value).toMatchObject({ value: 26_000_000 });
    expect(specific.top?.possiblyStale).toBe(true);
    expect(specific.conflicts).toEqual([]);
    const latest = extractStructuredEvidence(population, [series, recent], { now });
    expect(latest.top?.value).toMatchObject({ value: 28_000_000 });
    expect(latest.candidates).toHaveLength(3);
    expect(latest.conflicts).toEqual([]);
  });

  it('recognizes an estimated population and a distance defined by its endpoints', () => {
    const estimate = page('Australia’s estimated population was about 26.5 million in 2023.');
    const distance = page('The distance from Old Town to New Town is 18 kilometres.');
    expect(extractStructuredEvidence(population, [estimate], { now }).top).toMatchObject({
      value: { value: 26_500_000 }, approximate: true, referenceTime: year(2023),
    });
    expect(extractStructuredEvidence({ entity: 'Old Town to New Town', attribute: 'distance', unit: 'km' }, [distance]).top)
      .toMatchObject({ value: { value: 18, unit: 'km' } });
  });

  it('declares a gap when only other years or unknown periods are evidenced', () => {
    const dated = page(observed(27, 2024), { publishedAt: '2025-01-09' });
    const undated = otherPage('Australia has a population of 28 million people.');
    const result = extractStructuredEvidence({ ...population, time: year(2025) }, [dated, undated], { now });
    expect(result).toMatchObject({
      status: 'gap', top: null, gaps: [{ reason: 'requested-time-not-found', message: 'لم أجد قيمة موثقة' }],
      read: [{ url: dated.url, publishedAt: '2025-01-09' }, { url: undated.url }],
    });
    expect(result.candidates).toHaveLength(2);
  });

  it('does not treat growth, forecasts, or a different country on the subject page as the total', () => {
    const source = page([
      'The population of Canada was 40 million people in 2024.',
      'The population of Australia’s largest city was 5.4 million people in 2024.',
      'Australia’s population was lower than Canada’s 40 million people in 2024.',
      'Australia’s population growth was 2 million people in 2024.',
      'Australia’s population includes 12 million people in coastal areas.',
      'Australia’s population increased 300,000 people in 2024.',
      'Australia’s population grew by 300,000 people in 2024.',
      'Australia’s population is projected to reach 32 million people in 2032.',
    ].join('\n'), { title: 'Australia' });
    expect(extractStructuredEvidence(population, [source], { now })).toMatchObject({
      status: 'gap', top: null, candidates: [], gaps: [{ reason: 'no-verified-value', message: 'لم أجد قيمة موثقة' }],
    });
  });

  it('does not substitute a subregion, per-capita figure, or different peak', () => {
    const region = page('', { title: 'Australia population', tables: [{
      headers: ['State', 'Population', 'Year'], rows: [['Queensland', '5.6 million', '2024']],
    }] });
    const gdp = page('Australia’s GDP per capita was 64,000 USD in 2024.');
    const peaks = page('Unlike Test Peak, Another Peak has an elevation of 8,611 metres.');
    expect(extractStructuredEvidence(population, [region]).top).toBeNull();
    expect(extractStructuredEvidence({ entity: 'Australia', attribute: 'GDP', unit: 'USD' }, [gdp]).top).toBeNull();
    expect(extractStructuredEvidence(height, [peaks]).top).toBeNull();
  });

  it('keeps named-source scope exact and lists all reads even when some are ineligible', () => {
    const first = page(observed(27, 2024), { url: 'https://statistics.example/allowed#facts' });
    const second = otherPage(observed(30, 2024));
    const result = extractStructuredEvidence({
      ...population, allowedSourceUrls: ['https://statistics.example/allowed'],
    }, [first, second], { now });
    expect(result.status).toBe('value');
    expect(result.candidates).toHaveLength(1);
    expect(result.top?.evidence.url).toBe(first.url);
    expect(result.read.map(read => read.url)).toEqual([first.url, second.url]);
    expect(extractStructuredEvidence({ ...population, allowedSourceUrls: [] }, [first]).top).toBeNull();
  });

  it('declares conflicts with both sources and an explicit tolerance for the same period', () => {
    const first = page(observed(27, 2024));
    const second = otherPage(observed(28, 2024));
    const result = extractStructuredEvidence({ ...population, time: year(2024) }, [first, second], { now });
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toMatchObject([{
      first: { evidence: { url: first.url }, referenceTime: year(2024) },
      second: { evidence: { url: second.url }, referenceTime: year(2024) },
      tolerance: { relative: 0.01, absolute: 0 },
    }]);
    expect(extractStructuredEvidence(population, [first, second], { now, absoluteTolerance: 1_000_000 }).conflicts).toEqual([]);
    expect(extractStructuredEvidence(population, [first, second], { now, relativeTolerance: 0.04 }).conflicts).toEqual([]);
  });

  it('does not call copies or different dates a cross-source conflict', () => {
    const first = page(observed(27, 2024), { sourceId: 'same-publisher' });
    const copy = page(observed(29, 2024), { url: 'https://archive.example/report', sourceId: 'same-publisher' });
    const next = otherPage(observed(30, 2025));
    const fragment = page(observed(31, 2024), { url: `${first.url}#other`, sourceId: 'same-publisher' });
    expect(extractStructuredEvidence(population, [first, copy, next, fragment], { now }).conflicts).toEqual([]);
    const precise = otherPage('Australia’s population was 28 million people at 30 June 2024.');
    expect(extractStructuredEvidence(population, [first, precise], { now }).conflicts).toEqual([]);
    expect(extractStructuredEvidence({ ...population, time: day(2024, 6, 30) }, [first, precise]).top?.evidence.url).toBe(precise.url);
  });

  it('never uses the page publication or fetch timestamp as a measurement date', () => {
    const source = page('The Ticket price is USD 81.', { publishedAt: '2026-11-25' });
    const result = extractStructuredEvidence(price, [source], { now });
    expect(result.top).toMatchObject({ referenceTime: null, possiblyStale: false, freshness: 'unknown' });
    expect(result.gaps).toMatchObject([{ reason: 'freshness-unknown' }]);
    expect(extractStructuredEvidence({ ...price, time: day(2026, 11, 25) }, [source], { now }).top).toBeNull();
  });

  it('does not bind a date that describes the report rather than the quantity', () => {
    const report = page('In a 2025 report, Australia’s population was stated as 26.8 million.');
    const result = extractStructuredEvidence(population, [report], { now });
    expect(result.top).toMatchObject({ referenceTime: null, freshness: 'unknown' });
    expect(extractStructuredEvidence({ ...population, time: year(2025) }, [report], { now }).top).toBeNull();
  });

  it('does not treat distinct quarters as the same annual observation', () => {
    const first = page('Australia’s population was 27 million people in Q1 2024.');
    const second = otherPage('Australia’s population was 28 million people in Q2 2024.');
    const untimed = extractStructuredEvidence(population, [first, second], { now });
    expect(untimed.candidates.map(candidate => candidate.referenceTime)).toEqual([null, null]);
    expect(untimed.conflicts).toEqual([]);
    expect(extractStructuredEvidence({ ...population, time: year(2024) }, [first, second], { now }).top).toBeNull();
  });

  it('applies freshness thresholds per kind from the measured time', () => {
    const source = page('The Ticket price on 2026-11-23 was USD 81.', { publishedAt: '2026-11-25' });
    const stale = extractStructuredEvidence(price, [source], { now });
    expect(stale.top).toMatchObject({ referenceTime: day(2026, 11, 23), freshness: 'possibly-stale', possiblyStale: true });
    const fresh = extractStructuredEvidence(price, [source], { now, staleAfterDays: { price: 3, population: 1 } });
    expect(fresh.top?.freshness).toBe('fresh');
  });

  it('uses the exact table value, reference header and dedicated unit cell', () => {
    const source = page('', {
      title: 'Test Peak', tables: [{ headers: ['Measure', 'Unit', '2022', '2024'], rows: [['Height', 'km', '4.1', '4.2']] }],
    });
    const result = extractStructuredEvidence({ ...height, time: year(2022) }, [source], { now });
    expect(result.top).toMatchObject({
      value: { kind: 'number', value: 4100, unit: 'm' }, stated: { kind: 'number', value: 4.1, unit: 'km' },
      conversion: { from: 'km', to: 'm', factor: 1000 }, referenceTime: year(2022),
      evidence: { kind: 'table', tableIndex: 0, rowIndex: 0, columnIndex: 2, start: 0, end: 3,
        quote: '4.1', valueStart: 0, valueEnd: 3, literal: '4.1', header: '2022', unitCell: { columnIndex: 1, quote: 'km' } },
      timeEvidence: { kind: 'table-header', columnIndex: 2, quote: '2022' },
    });
  });

  it('binds table values and scales to the entity row and reference date column', () => {
    const source = page('', { tables: [{
      caption: 'GDP (USD millions)',
      headers: ['Country', 'Year', 'Value'],
      rows: [['Canada', '2024', '3,010'], ['Australia', '2024', '1,750']],
    }] });
    const result = extractStructuredEvidence({
      entity: 'Australia', attribute: 'GDP', unit: 'USD', kind: 'gdp', time: year(2024),
    }, [source], { now });
    expect(result.top).toMatchObject({
      value: { kind: 'number', value: 1_750_000_000, unit: 'USD' }, scaled: true,
      evidence: { kind: 'table', rowIndex: 1, columnIndex: 2, literal: '1,750', rowLabel: 'Australia' },
      timeEvidence: { kind: 'table-cell', rowIndex: 1, columnIndex: 1, quote: '2024' },
    });
    expect(result.candidates).toHaveLength(1);
  });

  it('does not apply an implicit header scale to a self-contained literal', () => {
    const source = page('', { title: 'Australia', tables: [{
      headers: ['Year', 'Population (millions of people)'], rows: [['2024', '1,250 people']],
    }] });
    const result = extractStructuredEvidence(population, [source], { now });
    expect(result.top).toMatchObject({ value: { value: 1250, unit: 'count' }, scaled: false });
  });

  it('declares overlapping ranges compatible and preserves the literal endpoints', () => {
    const first = page('The Ticket price on 2026-11-25 was between USD 80 and 100.');
    const second = otherPage('The Ticket price on 2026-11-25 was around USD 95.');
    const result = extractStructuredEvidence(price, [first, second], { now, relativeTolerance: 0 });
    expect(result.top).toMatchObject({ value: { kind: 'range', min: 80, max: 100, unit: 'USD' },
      evidence: { literal: 'between USD 80 and 100' } });
    expect(result.candidates[1]).toMatchObject({ approximate: true });
    expect(result.conflicts).toEqual([]);
  });

  it('keeps a dated value in its original calendar without converting it', () => {
    const source = page('', { title: 'غزوة بدر', tables: [{
      headers: ['', ''], rows: [['التاريخ', '17 رمضان 2هـ / 13 مارس 624م']],
    }] });
    const result = extractStructuredEvidence({
      entity: 'غزوة بدر', attribute: 'التاريخ', unit: 'date', time: { calendar: 'hijri', year: 2 },
    }, [source], { now });
    expect(result.top).toMatchObject({
      value: { kind: 'date', date: { calendar: 'hijri', year: 2, month: 9, day: 17 } },
      referenceTime: null, evidence: { literal: '17 رمضان 2هـ' },
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.top?.conversion).toBeUndefined();
  });

  it('declares incompatible event dates from different sources in the same calendar', () => {
    const first = page('The launch of Test Probe was on 2 July 2024.');
    const second = otherPage('Test Probe launch: July 3, 2024.');
    const result = extractStructuredEvidence({ entity: 'Test Probe', attribute: 'launch', unit: 'date' }, [first, second], { now });
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toHaveLength(1);
  });

  it('does not use a commemoration date as the date of the event it marks', () => {
    const retrospective = page('On 20 July 2019, the parade marked 50 years since Apollo 11 landed.');
    const result = extractStructuredEvidence({ entity: 'Apollo 11', attribute: 'landed', unit: 'date' }, [retrospective]);
    expect(result).toMatchObject({ status: 'gap', top: null });
  });

  it('does not swap currencies or give a value from an invalid source URL', () => {
    const usd = page('The Ticket price on 2026-11-25 was USD 81.', { url: 'file:///tmp/unrelated' });
    const aud = otherPage('The Ticket price on 2026-11-25 was AUD 81.');
    const ambiguous = page('The Ticket price on 2026-11-25 was $81.');
    expect(extractStructuredEvidence(price, [usd, aud, ambiguous], { now }).top).toBeNull();
  });
});
