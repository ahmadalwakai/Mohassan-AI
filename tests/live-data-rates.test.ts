import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ExchangeIntent } from '@mohassan/contracts';
import { getRates, parseEcbRates } from '../apps/server/src/live-data/rates.js';
import { createLiveRequestClient } from '../apps/server/src/live-data/request.js';

// Recorded verbatim from the ECB on 2026-11-25. Observation date: 2026-11-24.
const ECB_XML_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ecbXml = readFileSync(new URL('./fixtures/live-data/ecb-daily-2026-11-24.xml', import.meta.url), 'utf8');
const usdToGbp: ExchangeIntent = { kind: 'exchange', language: 'ar', amount: '123.45', from: 'USD', to: 'GBP' };

function recordedClient() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(ecbXml));
  return { fetch, client: createLiveRequestClient({ fetch }) };
}

describe('ECB reference exchange rates', () => {
  it('reads the observation date, EUR base and exact decimals from the recorded XML', () => {
    expect(parseEcbRates(ecbXml)).toMatchObject({
      asOf: '2026-11-24', source: ECB_XML_URL, base: 'EUR', rates: { EUR: '1', USD: '1.0963', GBP: '0.83700', JPY: '174.39' },
    });
  });

  it('crosses through EUR and shows the source, date and required daily-rate qualification', async () => {
    const { fetch, client } = recordedClient();
    const { status, text: answer } = await client.run(scope => getRates(scope, usdToGbp));
    expect(status).toBe('completed');
    // Independent decimal test oracle: 123.45 * 0.83700 / 1.0963, rounded to cents.
    expect(answer).toContain('123.45 USD ≈ 94.25 GBP');
    expect(answer).toContain('السعر التقاطعي عبر اليورو (EUR)');
    expect(answer).toContain('سعر مرجعي يومي من البنك المركزي الأوروبي بتاريخ 2026-11-24، وليس سعر السوق اللحظي');
    expect(answer).toContain(ECB_XML_URL);
    expect(String(fetch.mock.calls[0][0])).toBe(ECB_XML_URL);
  });

  it('preserves precision for a quote and uses minor currency units for a conversion', async () => {
    const { client } = recordedClient();
    const pair: ExchangeIntent = { kind: 'exchange', language: 'en', amount: '1', from: 'GBP', to: 'JPY' };
    const { text: quote } = await client.run(scope => getRates(scope, { ...pair, rateOnly: true }));
    const { text: amount } = await client.run(scope => getRates(scope, pair));
    // Independent decimal test oracle: 174.39 / 0.83700.
    expect(quote).toContain('1 GBP ≈ 208.351254480287 JPY');
    expect(amount).toContain('1 GBP ≈ 208 JPY');
    expect(quote).toContain('Daily European Central Bank reference rate dated 2026-11-24');
  });

  it('rounds signed tie values away from zero using exact decimal amounts', async () => {
    const { client } = recordedClient();
    const { text: answer } = await client.run(scope => getRates(scope, { ...usdToGbp, amount: '-999999999999999999.005', from: 'EUR', to: 'EUR' }));
    expect(answer).toContain('≈ -999999999999999999.01 EUR');
  });

  it.each([
    ['EUR', 'AED', '100', '402.62 AED', 'https://www.centralbank.ae/media/e44dkkze/cbuae-annual-report-2014-en.pdf'],
    ['QAR', 'BHD', '100', '10.33 BHD', 'https://www.cbb.gov.bh/wp-content/uploads/2019/01/Economic-Report-2007-ENG.pdf'],
    ['OMR', 'GBP', '100', '198.57 GBP', 'https://cbo.gov.om/Pages/FixedPeg.aspx'],
    ['SAR', 'QAR', '75', '72.8 QAR', 'https://www.sama.gov.sa/en-US/MediaCenter/News/Pages/news-557.aspx'],
  ])('computes %s to %s using only published pegs and shows the issuing central-bank links', async (from, to, amount, result, citation) => {
    const { client } = recordedClient();
    const { text: answer } = await client.run(scope => getRates(scope, { ...usdToGbp, from, to, amount }));
    // Decimal test oracles use the recorded ECB numbers and the official parity citations in rates.ts.
    expect(answer).toContain(`≈ ${result}`);
    expect(answer).toContain('الربط الرسمي بالدولار');
    expect(answer).toContain(citation);
    if (from === 'QAR' || to === 'QAR') expect(answer).toContain('https://www.qcb.gov.qa/en/Pages/MonetaryPolicyTools.aspx');
  });

  it.each(['EGP', 'KWD', 'ZZZ'])('explains missing %s coverage without computing a value', async to => {
    const { client } = recordedClient();
    const { status, text: answer } = await client.run(scope => getRates(scope, { ...usdToGbp, to }));
    expect(status).toBe('blocked');
    expect(answer).toContain(`لا يوجد مصدر حي موثوق لـ ${to}`);
    expect(answer).toContain('2026-11-24');
    expect(answer).not.toContain('≈');
  });

  it.each([
    // Hand-written corruptions of the recorded XML, not provider responses.
    ecbXml.replace('2026-11-24', '2026-11-31'),
    ecbXml.replace("rate='1.0963'", "rate='0.0000'"),
    ecbXml.replace("currency='GBP'", "currency='USD'"),
    ecbXml.replace('</gesmes:Envelope>', ''),
  ])('rejects malformed XML observation data (%#)', xml => {
    expect(() => parseEcbRates(xml)).toThrow(TypeError);
  });

  it('reuses a successful dated feed for 15 minutes and refreshes it on expiry', async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(ecbXml));
    const client = createLiveRequestClient({ fetch, clock: () => now });
    await client.run(scope => getRates(scope, usdToGbp));
    now += 15 * 60 * 1000 - 1;
    await client.run(scope => getRates(scope, { ...usdToGbp, to: 'JPY' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    now++;
    await client.run(scope => getRates(scope, usdToGbp));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed provider response for fallback and does not cache it', async () => {
    const { fetch, client } = recordedClient();
    // Hand-written failure response for exercising the transport path.
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.run(scope => getRates(scope, usdToGbp))).rejects.toThrow(/ECB.*503/u);
    await expect(client.run(scope => getRates(scope, usdToGbp))).resolves.toMatchObject({ text: expect.stringContaining('94.25 GBP') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
