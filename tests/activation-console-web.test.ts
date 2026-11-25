import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { ActivationStateInputSchema, ACTIVATION_GATE_MAX_BYTES } from '@mohassan/contracts';
import ActivationConsolePage from '../apps/web/app/activation-console/page';
import { ActivationConsole } from '../apps/web/app/activation-console/activation-console';
import { POST as forward } from '../apps/web/app/api/[...path]/route';

const mocks = vi.hoisted(() => ({ headers: vi.fn(), notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }) }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('../apps/web/app/activation-console/activation-console', () => ({ ActivationConsole: () => null }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function useSession(response: Response) {
  vi.stubEnv('INTERNAL_API_SECRET', 'test-only');
  vi.stubEnv('MOHASSAN_SERVER_URL', 'http://127.0.0.1:4000');
  mocks.headers.mockResolvedValue(new Headers({ cookie: 'session=test' }));
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('activation console owner page', () => {
  it('checks the current owner session on the server before rendering', async () => {
    const fetch = useSession(Response.json({ role: 'owner' }));
    expect((await ActivationConsolePage()).type).toBe(ActivationConsole);
    expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:4000/api/access'), expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
      headers: { cookie: 'session=test', 'x-mohassan-internal': 'test-only' },
    }));
  });

  it('withholds the page from a signed-in member', async () => {
    useSession(Response.json({ role: 'member' }));
    await expect(ActivationConsolePage()).rejects.toThrow('NOT_FOUND');
  });

  it('withholds the page for an expired or absent session', async () => {
    const fetch = useSession(new Response(null, { status: 401 }));
    await expect(ActivationConsolePage()).rejects.toThrow('NOT_FOUND');
    mocks.headers.mockResolvedValue(new Headers());
    await expect(ActivationConsolePage()).rejects.toThrow('NOT_FOUND');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('activation console gate upload', () => {
  it('preserves the record and bounds its UTF-8 bytes', () => {
    const record = '{"decision":"pass"}\n';
    const input = { capabilityId: 'example', enabled: true, reason: 'Verified', gate: { record, sha256: 'A'.repeat(64) } };
    expect(ActivationStateInputSchema.parse(input).gate).toEqual({ record, sha256: 'a'.repeat(64) });
    expect(ActivationStateInputSchema.safeParse({ ...input, gate: { ...input.gate, record: 'أ'.repeat(ACTIVATION_GATE_MAX_BYTES) } }).success).toBe(false);
  });

  it('raises the web proxy limit for state mutations only', async () => {
    const fetch = useSession(Response.json({ ok: true }));
    const body = JSON.stringify({ gate: { record: ' '.repeat(ACTIVATION_GATE_MAX_BYTES) } });
    function post(path: string[], payload: string) {
      const url = new URL(`http://localhost/api/${path.join('/')}`);
      const request = Object.assign(new Request(url, { method: 'POST', body: payload }), { nextUrl: url }) as NextRequest;
      return forward(request, { params: Promise.resolve({ path }) });
    }

    const accepted = await post(['activation-console', 'state'], body);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect((await post(['activation-console', 'reviews'], body)).status).toBe(413);
    expect((await post(['activation-console', 'state'], ' '.repeat(133 * 1024))).status).toBe(413);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
