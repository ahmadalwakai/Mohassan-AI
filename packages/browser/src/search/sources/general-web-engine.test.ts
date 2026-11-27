import { afterEach, expect, it, vi } from 'vitest';
import { BRAVE_WEB_SEARCH_URL, SafeNetwork } from '../../network.js';
import { SearchEngine } from '../engine.js';
import type { SearchProviderContext } from '../providers.js';
import { englishQuery, englishResult } from './fixtures/general-web.js';
import { generalWebProviders } from './general-web.js';

afterEach(() => vi.unstubAllEnvs());

it('uses the server-resolved role before search and bypasses storage for Brave results', async () => {
  vi.stubEnv('SEARCH_GENERAL_WEB_PROVIDER', 'brave');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'fixture-only-role-check');
  vi.stubEnv('SEARCH_GENERAL_WEB_ROLES', 'owner');
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async url => url === BRAVE_WEB_SEARCH_URL
    ? { url, status: 200, headers: {}, body: Buffer.from(JSON.stringify({ type: 'search', web: { results: [englishResult] } })) }
    : { url, status: 403, headers: {}, body: Buffer.alloc(0) });
  const now = () => 0;
  let role: SearchProviderContext['role'] = 'member';
  const resolveAccountRole = vi.fn(async () => role);
  const store = { get: vi.fn(async () => null), put: vi.fn(), revision: vi.fn(async () => 0), clear: vi.fn() };
  const engine = new SearchEngine(network, { providers: generalWebProviders(network, now), store, resolveAccountRole, now });
  const account = { ownerId: 'authenticated-account' };

  expect((await engine.execute(englishQuery, 1, undefined, account)).hits).toEqual([]);
  expect(resolveAccountRole).toHaveBeenCalledWith(account.ownerId);
  expect(request).not.toHaveBeenCalled();
  expect(store.get).toHaveBeenCalledTimes(1);
  expect(store.put).toHaveBeenCalledTimes(1);

  role = 'owner';
  expect((await engine.execute(englishQuery, 1, undefined, account)).hits).toEqual([
    expect.objectContaining({ url: englishResult.url, providers: ['Brave Search'] }),
  ]);
  expect(request.mock.calls.filter(([url]) => url === BRAVE_WEB_SEARCH_URL)).toHaveLength(1);
  expect(store.get).toHaveBeenCalledTimes(1);
  expect(store.put).toHaveBeenCalledTimes(1);

  role = 'member';
  expect((await engine.execute(englishQuery, 1, undefined, account)).hits).toEqual([]);
  expect((await engine.execute(englishQuery, 1)).hits).toEqual([]);
  expect(request.mock.calls.filter(([url]) => url === BRAVE_WEB_SEARCH_URL)).toHaveLength(1);
});
