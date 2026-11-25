import { expect, it, vi } from 'vitest';
import { SafeNetwork } from './network.js';

it('preserves text-reader headers on the same origin and filters them after an origin change', async () => {
  const initial = 'https://source.example/start';
  const sameOrigin = 'https://source.example/next';
  const crossOrigin = 'https://destination.example/final';
  const network = new SafeNetwork();
  const options = {
    signal: new AbortController().signal,
    headers: { Cookie: 'fixture-cookie', 'Accept-Language': 'en' },
  };
  const request = vi.spyOn(network, 'request')
    .mockResolvedValueOnce({ url: initial, status: 302, headers: { location: sameOrigin }, body: Buffer.alloc(0) })
    .mockResolvedValueOnce({ url: sameOrigin, status: 302, headers: { location: crossOrigin }, body: Buffer.alloc(0) })
    .mockResolvedValueOnce({ url: crossOrigin, status: 200, headers: {}, body: Buffer.from('fixture') });

  expect(await network.text(initial, options)).toEqual({ url: crossOrigin, text: 'fixture', status: 200 });
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenNthCalledWith(1, initial, options);
  expect(request).toHaveBeenNthCalledWith(2, sameOrigin, options);
  expect(options.headers).toEqual({ Cookie: 'fixture-cookie', 'Accept-Language': 'en' });
  expect(request).toHaveBeenNthCalledWith(3, crossOrigin, { ...options, headers: { 'Accept-Language': 'en' } });
});
