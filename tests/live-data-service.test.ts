import type { HijriIntent, LiveDataIntent, WeatherIntent } from '@mohassan/contracts';
import { describe, expect, it, vi } from 'vitest';
import { HIJRI_SOURCES, UMM_AL_QURA_ARCHIVE_DATE } from '../apps/server/src/live-data/hijri.js';
import { createLiveRequestClient } from '../apps/server/src/live-data/request.js';
import { answerLiveData } from '../apps/server/src/live-data/service.js';
import forecast from './fixtures/live-data/open-meteo-forecast.json';
import geocoding from './fixtures/live-data/open-meteo-geocoding.json';

const weather: WeatherIntent = { kind: 'weather', language: 'en', period: 'current', place: 'London' };
const forecastTime = new Date('2026-11-25T03:44:25Z');
const hijriToday: HijriIntent = { kind: 'hijri', language: 'ar', direction: 'today' };

function offlineClient() {
  const fetch = vi.fn(async () => { throw new Error('An offline answer called a data source'); });
  return { fetch, client: createLiveRequestClient({ fetch }) };
}

describe('live data request and fallback', () => {
  it('shares a three-second deadline between geocoding and fetching the forecast', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((input: URL | string, _init?: RequestInit): Promise<Response> => {
        if (new URL(input).hostname === 'geocoding-api.open-meteo.com') {
          return new Promise(resolve => setTimeout(() => resolve(Response.json(geocoding)), 2_000));
        }
        return new Promise(() => { /* Simulate a forecast source that ignores cancellation. */ });
      });
      const client = createLiveRequestClient({ fetch });
      const complete = vi.fn();
      const pending = answerLiveData(weather, { client, now: forecastTime }).then(outcome => {
        complete();
        return outcome;
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(complete).not.toHaveBeenCalled();
      const geocodingSignal = fetch.mock.calls[0][1]?.signal;
      const forecastSignal = fetch.mock.calls[1][1]?.signal;
      expect(geocodingSignal).toBe(forecastSignal);
      expect(forecastSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        kind: 'fallback', notice: 'Open-Meteo timed out after 3 seconds. I’ll continue with the usual lookup.',
      });
      expect(forecastSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports which source failed, then retries the failed fetch without losing cached geocoding', async () => {
    // Hand-written HTTP failure. Successful requests replay the recorded fixtures.
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(geocoding))
      .mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json(forecast));
    const client = createLiveRequestClient({ fetch });
    const read = () => answerLiveData(weather, { client, now: forecastTime });
    await expect(read()).resolves.toEqual({
      kind: 'fallback', notice: 'Could not retrieve usable data from Open-Meteo. I’ll continue with the usual lookup.',
    });
    await expect(read()).resolves.toMatchObject({
      kind: 'answer', reply: { status: 'completed', text: expect.stringContaining('4.4 °C') },
    });
    expect(fetch.mock.calls.map(([input]) => new URL(input).hostname)).toEqual([
      'geocoding-api.open-meteo.com', 'api.open-meteo.com', 'api.open-meteo.com',
    ]);
  });

  it('distinguishes geocoding and exchange feed failures in fallback notices', async () => {
    // Hand-written transport failure exercised with both public providers.
    const fetch = vi.fn(async () => { throw new Error('Connection refused'); });
    const client = createLiveRequestClient({ fetch });
    await expect(answerLiveData(weather, { client })).resolves.toMatchObject({
      kind: 'fallback', notice: expect.stringContaining('Open-Meteo geocoding'),
    });
    await expect(answerLiveData({ kind: 'exchange', language: 'ar', amount: '1', from: 'EUR', to: 'USD' }, { client }))
      .resolves.toMatchObject({ kind: 'fallback', notice: expect.stringContaining('تعذّر الحصول على بيانات صالحة من البنك المركزي الأوروبي') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates chat cancellation and discards results arriving after cancellation', async () => {
    let completeFirstFetch!: (response: Response) => void;
    const firstResponse = new Promise<Response>(resolve => { completeFirstFetch = resolve; });
    const fetch = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(firstResponse).mockResolvedValueOnce(Response.json(geocoding)).mockResolvedValueOnce(Response.json(forecast));
    const client = createLiveRequestClient({ fetch });
    const parent = new AbortController();
    const cancelled = new Error('Chat cancelled');
    const pending = answerLiveData(weather, { client, now: forecastTime, signal: parent.signal });
    const rejection = expect(pending).rejects.toBe(cancelled);
    parent.abort(cancelled);
    await rejection;
    expect(fetch.mock.calls[0][1]?.signal).toMatchObject({ aborted: true, reason: cancelled });

    // The late response still has a body. It must not seed the place cache or start a forecast fetch.
    completeFirstFetch(Response.json(geocoding));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(answerLiveData(weather, { client, now: forecastTime })).resolves.toMatchObject({ kind: 'answer' });
    expect(fetch.mock.calls.map(([input]) => new URL(input).hostname)).toEqual([
      'geocoding-api.open-meteo.com', 'geocoding-api.open-meteo.com', 'api.open-meteo.com',
    ]);
  });

  it('does not contact data services when source access is disabled or a market is unsupported', async () => {
    const { fetch, client } = offlineClient();
    await expect(answerLiveData(weather, { client, allowSource: false })).resolves.toMatchObject({
      kind: 'answer', reply: { status: 'blocked', text: expect.stringContaining('external data source') },
    });
    const gold: LiveDataIntent = { kind: 'unsupported-market', language: 'ar', asset: 'gold' };
    await expect(answerLiveData(gold, { client })).resolves.toMatchObject({
      kind: 'answer', reply: { status: 'blocked', text: expect.stringContaining('لا يوجد مصدر حي موثوق') },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('live calendar answer', () => {
  it('uses the IANA time zone through midnight, otherwise reports UTC', async () => {
    // Saudi Royal Court decision 192/H gives both dates in Umm al-Qura (retrieved 2026-11-25).
    // https://www.spa.gov.sa/w2272518
    const now = new Date('2025-03-01T00:30:00Z');
    const { fetch, client } = offlineClient();
    await expect(answerLiveData(hijriToday, { now, client, timeZone: 'America/Los_Angeles' })).resolves.toMatchObject({
      kind: 'answer', reply: { status: 'completed', text: expect.stringMatching(/2025-02-28 ↔ 29 شعبان 1446 هـ[\s\S]*America\/Los_Angeles/u) },
    });
    for (const timeZone of [undefined, 'Invalid/Zone', '+03:00']) {
      await expect(answerLiveData(hijriToday, { now, client, timeZone })).resolves.toMatchObject({
        kind: 'answer', reply: { status: 'completed', text: expect.stringMatching(/2025-03-01 ↔ 1 رمضان 1446 هـ[\s\S]*UTC/u) },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the official table, data time, and method for a known conversion', async () => {
    // Saudi Royal Court decision 192/H (retrieved 2026-11-25): https://www.spa.gov.sa/w2272518
    const input: HijriIntent = { kind: 'hijri', language: 'en', direction: 'to-gregorian', date: { year: 1446, month: 9, day: 1 } };
    const { fetch, client } = offlineClient();
    const result = await answerLiveData(input, { client, allowSource: false });
    expect(result).toMatchObject({ kind: 'answer', reply: { status: 'completed' } });
    if (result.kind !== 'answer') throw new Error('Expected an offline calendar answer');
    const { text } = result.reply;
    expect(text).toContain('1 Ramadan 1446 AH ↔ 2025-03-01');
    expect(text).toContain('Gregorian conversion date 2025-03-01');
    expect(text).toContain(UMM_AL_QURA_ARCHIVE_DATE);
    expect(text).toContain('Umm al-Qura month-length table from KACST');
    expect(text).toContain(HIJRI_SOURCES['umm-al-qura']);
    expect(text).not.toContain('حساب تقريبي');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['ar', 'en'] as const)('identifies approximate %s answers explicitly after the official table ends', async language => {
    // First day past the KACST coverage, derived from the archived table in umm-al-qura-data.ts.
    const date = { year: 2077, month: 11, day: 17 };
    const { fetch, client } = offlineClient();
    const result = await answerLiveData({ kind: 'hijri', direction: 'to-hijri', language, date }, { client });
    expect(result).toMatchObject({ kind: 'answer', reply: { status: 'completed' } });
    if (result.kind !== 'answer') throw new Error('Expected an offline calendar answer');
    const { text } = result.reply;
    expect(text).toContain('2077-11-17');
    expect(text).toContain('حساب تقريبي، قد يختلف يومًا عن تقويم أم القرى أو رؤية الهلال');
    expect(text).toContain(language === 'ar' ? 'التقويم الهجري الحسابي الجدولي' : 'Tabular Islamic civil calendar');
    expect(text).toContain(HIJRI_SOURCES.tabular);
    expect(fetch).not.toHaveBeenCalled();
  });
});
