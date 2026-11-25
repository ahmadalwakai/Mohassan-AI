import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExchangeRateTable, parseExchangeRateTable, reasonCurrency } from '../apps/server/src/assistant/reasoning/currency.js';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';
import { currencyDevelopmentTable } from './fixtures/reasoning-currency.js';

const snapshot = { asOf: '2024-02-29', source: 'Reference snapshot', base: 'USD', rates: { EUR: '1.005', JPY: '125', KWD: '0.3055' } };

describe('offline exchange-rate tables', () => {
  it('loads a dated file and supplies the implicit base rate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mohassan-rates-'));
    try {
      const path = join(dir, 'rates.json');
      writeFileSync(path, JSON.stringify(snapshot));
      expect(loadExchangeRateTable(path)).toEqual({ ...snapshot, rates: { USD: '1', ...snapshot.rates } });
      writeFileSync(path, ' '.repeat(64 * 1024 + 1));
      expect(() => loadExchangeRateTable(path)).toThrow('64 KiB');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { asOf: '2025-02-29' }, { source: '' }, { base: 'ZZZ' }, { rates: {} },
    { rates: { EUR: '0' } }, { rates: { EUR: '-1' } }, { rates: { EUR: 'NaN' } },
    { rates: { EUR: '1', USD: '1.2' } }, { rates: { EUR: '1e-2' } },
  ])('rejects incomplete or invalid snapshots (%j)', overrides => {
    expect(() => parseExchangeRateTable({ ...snapshot, ...overrides })).toThrow(TypeError);
  });
});

describe('local currency reasoning', () => {
  const rates = parseExchangeRateTable(snapshot);

  it.each([
    ['Convert $1 to EUR', '1.01'], ['Convert -1 USD to EUR', '-1.01'],
    ['Convert 0.5 USD to JPY', '63'], ['Convert 1 USD to KWD', '0.306'],
    ['Convert 2 USD to USD', '2'], ['Convert -0.001 USD to EUR', '0'],
    ['What’s the exchange rate from USD to EUR?', '1.005'],
  ])('computes and cites %s', (request, expected) => {
    const reply = reasonCurrency(request, 'en', rates);
    expect(reply?.status).toBe('completed');
    expect(reply?.evidence.find(item => item.id === REASONING_VALUE_ID)?.value).toBe(expected);
    expect(reply?.text).toContain('Rates dated 2024-02-29 from Reference snapshot');
    expect(reply?.evidence.find(item => item.id === 'exchange-rate-snapshot')).toMatchObject({ sourceRef: 'Reference snapshot', pageDate: '2024-02-29' });
  });

  it('accepts Arabic grouping, decimal markers and courtesy', () => {
    const reply = reasonCurrency('لو سمحت حوّل ١٬٠٠٠٫٥ دولار إلى ريال سعودي', 'ar', currencyDevelopmentTable);
    expect(reply?.status).toBe('completed');
    expect(reply?.evidence.find(item => item.id === REASONING_VALUE_ID)?.value).toBe('4002');
    expect(reply?.text).toContain('أسعار 2025-02-20');
  });

  it.each(['Convert 1 USD to EUR as of today', 'What is the current exchange rate from JPY to EUR?', 'كم سعر الدولار مقابل اليورو اليوم؟'])('reports a gap for freshness requests (%s)', request => {
    expect(reasonCurrency(request, 'en', rates)?.status).toBe('blocked');
  });

  it('reports the missing currencies and leaves other computations alone', () => {
    expect(reasonCurrency('30 NOK to SAR', 'en', rates)?.text).toContain('NOK, SAR');
    expect(reasonCurrency('Convert 4 kg to g', 'en', rates)).toBeNull();
    expect(reasonCurrency('Convert 50 USD to EUR and send it to Alex', 'en', rates)).toBeNull();
  });
});
