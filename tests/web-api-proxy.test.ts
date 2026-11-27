import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../apps/web/app/api/[...path]/route.js';

const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const site = 'http://web.example.test';

beforeEach(() => {
  vi.stubEnv('INTERNAL_API_SECRET', 'test-only-service-header');
  vi.stubEnv('MOHASSAN_SERVER_URL', 'http://api.example.test');
  vi.stubEnv('VERCEL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function streamRequest(path: string, body: ReadableStream<Uint8Array>) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' as const };
  return new NextRequest(`${site}${path}`, init);
}

describe('public API proxy', () => {
  it.each(['pair', 'poll'])('keeps device %s requests out of the web relay', async action => {
    const fetchUpstream = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchUpstream);
    const path = ['coding', 'device', action];
    const response = await POST(new NextRequest(`${site}/api/${path.join('/')}`, {
      method: 'POST', headers: { 'sec-fetch-mode': 'cors' },
    }), context(...path));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CODING_DEVICE_BROWSER_DENIED');
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(['coding/projects', 'coding/projects/demo'])('allows the device deadline for POST /api/%s', async path => {
    const routeTimeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ ok: true })));
    const response = await POST(new NextRequest(`${site}/api/${path}`, { method: 'POST' }), context(...path.split('/')));

    expect(response.status).toBe(200);
    expect(routeTimeout).toHaveBeenCalledWith(65_000);
  });

  it('starts the upstream request before consuming the entire body and streams bounded chunks intact', async () => {
    const order: string[] = [];
    const chunks = ['{"message":', '"hello"}'];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          order.push('end of body');
          controller.close();
        }
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    }, { highWaterMark: 0 });
    const received: string[] = [];
    const fetchUpstream = vi.fn<typeof fetch>(async (_target, init) => {
      order.push('upstream');
      received.push(await new Response(init?.body).text());
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchUpstream);

    const result = await POST(streamRequest('/api/chat/images', body), context('chat', 'images'));
    expect(result.status).toBe(200);
    expect(order).toEqual(['upstream', 'end of body']);
    expect(fetchUpstream.mock.calls[0]?.[1]?.body).toBeInstanceOf(ReadableStream);
    expect(received).toEqual(['{"message":"hello"}']);
  });

  it('stops forwarding at the byte limit for a stream with no content-length', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(16_384));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } });
    let forwarded = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_target, init) => {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          forwarded += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      return Response.json({ ok: true });
    }));

    const result = await POST(streamRequest('/api/tasks', body), context('tasks'));
    expect(result.status).toBe(413);
    expect(forwarded).toBe(16_384);
  });

  it('cancels a stalled upload at the read deadline', async () => {
    const uploadDeadline = new AbortController();
    const routeDeadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 60_000 ? uploadDeadline.signal : routeDeadline.signal);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_target, init) => {
      markStarted();
      await new Response(init?.body).arrayBuffer();
      return Response.json({ ok: true });
    }));

    const pending = POST(streamRequest('/api/desktop/files', body), context('desktop', 'files'));
    await started;
    uploadDeadline.abort();
    expect((await pending).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, '192.0.2.1', null],
    ['1', '192.0.2.1', '192.0.2.1'],
    ['1', '2001:db8::1', '2001:db8::1'],
    ['1', '192.0.2.1, 192.0.2.2', null],
  ])('forwards only one valid platform IP when Vercel is %s', async (vercel, ingressIp, expected) => {
    vi.stubEnv('VERCEL', vercel);
    const fetchUpstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchUpstream);
    const result = await GET(new NextRequest(`${site}/api/auth/get-session`, { headers: {
      'x-vercel-forwarded-for': ingressIp, 'x-forwarded-for': '192.0.2.9', 'x-real-ip': '192.0.2.10',
      'x-mohassan-internal': 'test-only-client-header', cookie: 'test=fixture',
    } }), context('auth', 'get-session'));

    expect(result.status).toBe(200);
    const outbound = new Headers(fetchUpstream.mock.calls[0]?.[1]?.headers);
    expect(outbound.get('x-mohassan-client-ip')).toBe(expected);
    expect(outbound.has('x-forwarded-for')).toBe(false);
    expect(outbound.has('x-real-ip')).toBe(false);
    expect(outbound.get('x-mohassan-internal') === 'test-only-service-header').toBe(true);
    expect(outbound.get('cookie') === 'test=fixture').toBe(true);
  });

  it('preserves sandboxing, frame restrictions and referrer protection for preview documents', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('<p>Local preview fixture</p>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));
    const path = ['sites', 'fixture-site', 'p', 'fixture-preview', 'index.html'];
    const result = await GET(new NextRequest(`${site}/api/${path.join('/')}`), context(...path));
    expect(result.status).toBe(200);
    expect(result.headers.get('content-security-policy')).toContain("frame-ancestors 'self'; sandbox");
    expect(result.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('forwards separate session cookie fields and drops unrelated upstream headers', async () => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-unrelated': 'ignored' });
    const cookies = ['test-session=fixture; Path=/; HttpOnly', 'test-other=fixture; Path=/; Secure'];
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{}', { headers })));

    const result = await GET(new NextRequest(`${site}/api/auth/get-session`), context('auth', 'get-session'));
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie()).toEqual(cookies);
    expect(result.headers.has('x-unrelated')).toBe(false);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
});
