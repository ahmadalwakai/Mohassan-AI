import { once } from 'node:events';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { SafeNetwork } from '../../network.js';

it('allows an explicit gzip request while preserving the reader default', async () => {
  const body = 'fixture';
  const encodings: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    const encoding = request.headers['accept-encoding'];
    encodings.push(encoding);
    if (encoding === 'gzip') {
      response.setHeader('content-encoding', encoding);
      response.end(gzipSync(body));
    } else {
      response.end(body);
    }
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const url = `http://127.0.0.1:${address.port}`;
    const network = new SafeNetwork({ testOrigins: [url] });
    const compressed = await network.request(url, { headers: { 'Accept-Encoding': 'gzip' } });
    const ordinary = await network.request(url);
    expect(encodings).toEqual(['gzip', 'identity']);
    expect(compressed.body.toString()).toBe(body);
    expect(ordinary.body.toString()).toBe(body);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
