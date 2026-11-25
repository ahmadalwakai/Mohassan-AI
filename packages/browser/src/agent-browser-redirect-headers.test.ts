import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowser } from './agent-browser.js';
import { SafeNetwork } from './network.js';

const source = 'https://source.example/resource';
const headers = { authorization: 'fixture-auth', cookie: 'fixture-cookie', 'x-api-key': 'fixture-key', accept: 'text/plain' };

async function redirectedHeaders(destination: string) {
  const request = vi.spyOn(SafeNetwork.prototype, 'request')
    .mockResolvedValueOnce({ url: source, status: 302, headers: { location: destination }, body: Buffer.alloc(0) })
    .mockResolvedValueOnce({ url: destination, status: 200, headers: {}, body: Buffer.alloc(0) });
  const route = { request: () => ({ isNavigationRequest: () => false, postDataBuffer: () => null, allHeaders: async () => headers }), fulfill: vi.fn() };
  const browser = new AgentBrowser({ profileDir: '/unused-fixture', idlePageMs: null }) as unknown as {
    forward(entry: object, route: object, url: string, method: string, credentials: string, operation: undefined, consumed: boolean): Promise<void>;
  };
  await browser.forward({}, route, source, 'GET', 'keep', undefined, false);
  expect(route.fulfill).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1]?.headers).toEqual(headers);
  return request.mock.calls[1][1]?.headers;
}

describe('agent browser redirect credentials', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retains same-origin headers and forwards only passive headers on a changed origin', async () => {
    expect(await redirectedHeaders('https://source.example/redirected')).toEqual(headers);
    vi.restoreAllMocks();
    expect(await redirectedHeaders('https://destination.example/resource')).toEqual({ accept: 'text/plain' });
  });
});
