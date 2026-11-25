import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH } from '../apps/web/app/api/[...path]/route';
import { reminderLocalInput, reminderRecurrenceLabel } from '../apps/web/components/reminders-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('reminder settings date controls', () => {
  // Offsets calculated from the EU and US rules and Riyadh zone in the IANA
  // sources https://data.iana.org/time-zones/tzdb/europe,
  // https://data.iana.org/time-zones/tzdb/northamerica, and
  // https://data.iana.org/time-zones/tzdb/asia (retrieved 2026-11-25).
  it.each([
    ['Europe/London', '2027-10-31T00:30:00.000Z', '2027-10-31T01:30'],
    ['Europe/London', '2027-10-31T01:30:00.000Z', '2027-10-31T01:30'],
    ['America/New_York', '2027-03-14T07:00:00.000Z', '2027-03-14T03:00'],
    ['Asia/Riyadh', '2027-01-31T21:00:00.000Z', '2027-02-01T00:00'],
  ])('formats the wall-clock value in %s at %s', (timeZone, dueAt, expected) => {
    expect(reminderLocalInput({ timeZone, dueAt })).toBe(expected);
  });

  // Arabic wide weekday names (retrieved 2026-11-25).
  // https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-dates-full/main/ar/ca-gregorian.json
  it('shows the named weekdays of a recurring reminder', () => {
    const label = reminderRecurrenceLabel({ kind: 'weekly', weekdays: [1, 7], hour: 9, minute: 0 });
    expect(label).toContain('الاثنين');
    expect(label).toContain('الأحد');
  });
});

describe('web reminder proxy', () => {
  it('forwards the edit method and payload only for a reminder', async () => {
    vi.stubEnv('INTERNAL_API_SECRET', 'reminder-web-fixture');
    vi.stubEnv('MOHASSAN_SERVER_URL', 'http://127.0.0.1:4200');
    const outbound = vi.fn(async (_url: URL, _options: RequestInit) => Response.json({ reminder: {} }));
    vi.stubGlobal('fetch', outbound);
    const id = crypto.randomUUID();
    const path = ['reminders', id];
    const body = JSON.stringify({ localDueAt: '2027-10-31T01:30', timeZone: 'Europe/London', overlap: 'later' });
    const request = new NextRequest(`https://example.test/api/reminders/${id}`, {
      method: 'PATCH', body, headers: { 'Content-Type': 'application/json' },
    });

    const edited = await PATCH(request, { params: Promise.resolve({ path }) });
    expect(edited.ok).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [target, forwarded] = outbound.mock.calls[0]!;
    expect(target.pathname).toBe(`/api/reminders/${id}`);
    expect(forwarded.method).toBe('PATCH');
    expect(new TextDecoder().decode(forwarded.body as Uint8Array)).toBe(body);

    const denied = await PATCH(request, { params: Promise.resolve({ path: ['chat', id] }) });
    expect(denied.status).toBe(405);
    expect(outbound).toHaveBeenCalledTimes(1);
  });
});
