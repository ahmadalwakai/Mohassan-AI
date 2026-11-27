import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivationConsoleSnapshot } from '@mohassan/contracts';
import { ActivationConsole } from '../apps/web/app/activation-console/activation-console';
import { activationPath, requestActivationConsole, type ActivationState } from '../apps/web/app/activation-console/activation-data';
import ActivationConsolePage from '../apps/web/app/activation-console/page';
import Forbidden from '../apps/web/app/activation-console/forbidden';
import Unauthorized from '../apps/web/app/activation-console/unauthorized';
import { GET as relay } from '../apps/web/app/api/[...path]/route';

const incoming = vi.hoisted(() => new Headers());
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('next/navigation', () => ({
  forbidden: () => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;403'); },
  unauthorized: () => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;401'); },
}));

// The reader and trial values come from the production baseline, retrieved on 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/config.ts#L19
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/V5-OWNER-CHAT-2026-11-26.md
const switchFixture = {
  name: 'MOHASSAN_V5_CHAT', kind: 'feature', sensitive: false,
  currentValue: 'off', configuredValue: null, ownerTrial: 'owner', dependencies: ['MOHASSAN_MODEL_WORKER'],
  readers: [{ module: 'apps/server/src/config.ts', defaultValue: 'off', parsing: 'raw === owner', needsRestart: true }],
  preflight: { path: 'scripts/cloud-linux/preflight-wave-6.mjs', args: ['--owner-v5'] },
  evidence: { path: 'docs/V5-OWNER-CHAT-2026-11-26.md', summary: 'قياسات تجربة المالك' },
  risk: 'تغيير مسار الرد التجريبي.', sources: [], observation: null,
} satisfies ActivationConsoleSnapshot['switches'][number];
const snapshot: ActivationConsoleSnapshot = { switches: [switchFixture], observationWindowDays: 7 };

afterEach(() => {
  incoming.delete('cookie');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function render(initialState: ActivationState) {
  return renderToStaticMarkup(createElement(ActivationConsole, { initialState }));
}

function stubServer(response: Response) {
  vi.stubEnv('INTERNAL_API_SECRET', 'activation-test-only');
  vi.stubEnv('MOHASSAN_SERVER_URL', 'http://127.0.0.1:4000');
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Arabic activation console', () => {
  it('renders a loading state, a retryable error, and an empty registry', () => {
    expect(render({ kind: 'loading' })).toContain('role="status">جارٍ تحميل مفاتيح الإنتاج');
    expect(render({ kind: 'error' })).toContain('role="alert">تعذّر تحميل مفاتيح الإنتاج');
    expect(render({ kind: 'error' })).toContain('إعادة المحاولة');
    expect(render({ kind: 'ready', snapshot: { ...snapshot, switches: [] } })).toContain('لا توجد مفاتيح إنتاج في السجل');
  });

  it('shows live, default, trial, dependencies, source evidence, and risk as read-only details', () => {
    const observedAt = new Date(0).toISOString();
    const page = render({ kind: 'ready', snapshot: { ...snapshot, switches: [{
      ...switchFixture, configuredValue: 'owner',
      observation: { eventCount: 1, comparedCount: 1, disagreements: 1, errors: 0, lastObservedAt: observedAt },
    }] } });
    expect(page).toContain('dir="rtl" lang="ar"');
    expect(page).toContain('MOHASSAN_V5_CHAT');
    expect(page).toContain('القيمة الحالية</small><code dir="ltr">off');
    expect(page).toContain('الافتراضي</small><code dir="ltr">off');
    expect(page).toContain('تجربة المالك</small><code dir="ltr">owner');
    expect(page).toContain('القيمة المضبوطة في العملية <code dir="ltr">owner');
    expect(page).toContain(switchFixture.dependencies[0]);
    expect(page).toContain(`/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/${switchFixture.evidence.path}`);
    expect(page).toContain(switchFixture.preflight.path);
    expect(page).toContain(switchFixture.preflight.args[0]);
    expect(page).toContain(switchFixture.risk);
    expect(page).toContain(`dateTime="${observedAt}"`);
    expect(page).toContain('يتطلّب إعادة التشغيل');
    expect(page).not.toContain('<form');
  });

  it('keeps backend failure, invalid data, and access failures distinct', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ switches: [] }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    for (const kind of ['signin', 'forbidden', 'error', 'error', 'error']) {
      await expect(requestActivationConsole(activationPath)).resolves.toEqual({ kind });
    }
    expect(fetch).toHaveBeenCalledWith(activationPath, { cache: 'no-store', redirect: 'error' });
  });
});

describe('activation console document and web API access', () => {
  it('renders the loading page only after the access API accepts the owner session', async () => {
    incoming.set('cookie', 'session=owner');
    const fetch = stubServer(Response.json({ role: 'owner' }));
    const page = renderToStaticMarkup(await ActivationConsolePage());
    expect(page).toContain('جارٍ تحميل مفاتيح الإنتاج');
    expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:4000/api/access'), expect.objectContaining({
      cache: 'no-store', redirect: 'error',
      headers: { cookie: 'session=owner', 'x-mohassan-internal': 'activation-test-only' },
    }));
    expect(page).not.toContain('activation-test-only');
  });

  it('renders the Arabic 403 and 401 documents without switch data', async () => {
    const fetch = stubServer(Response.json({ role: 'member' }));
    incoming.set('cookie', 'session=member');
    await expect(ActivationConsolePage()).rejects.toThrow(';403');
    expect(renderToStaticMarkup(createElement(Forbidden))).toContain('هذه الصفحة متاحة لحساب المالك فقط');

    fetch.mockResolvedValue(new Response(null, { status: 401 }));
    incoming.set('cookie', 'session=expired');
    await expect(ActivationConsolePage()).rejects.toThrow(';401');
    incoming.delete('cookie');
    await expect(ActivationConsolePage()).rejects.toThrow(';401');
    expect(renderToStaticMarkup(createElement(Unauthorized))).toContain('سجّل الدخول بحساب المالك');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([200, 403, 401])('preserves Fastify status %s via the no-store same-origin relay', async status => {
    const fetch = stubServer(Response.json(status === 200 ? snapshot : { error: { code: 'AUTH' } }, { status }));
    const response = await relay(new NextRequest(`http://localhost${activationPath}`, {
      headers: { cookie: 'session=test' },
    }), { params: Promise.resolve({ path: ['activation-console'] }) });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetch.mock.calls[0]?.[1].headers.get('cookie')).toBe('session=test');
  });
});
