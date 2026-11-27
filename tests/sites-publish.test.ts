import { afterEach, expect, it, vi } from 'vitest';
import { createVercelPublisher } from '../apps/server/src/sites-publish.js';

const input = { slug: 'test-site', files: [] };

afterEach(() => vi.useRealTimers());

it.each(['fetch', 'body'])('times out a hung deployment %s within its request budget', async hang => {
  vi.useFakeTimers();
  const timeoutMs = 100;
  const hungResponse = new Response(new ReadableStream());
  const transport = vi.fn<typeof fetch>(async () => hang === 'fetch'
    ? new Promise<Response>(() => {})
    : hungResponse);
  const publisher = createVercelPublisher({ token: 'test-token', fetch: transport, timeoutMs });

  const publishing = publisher.publish(input);
  const timedOut = expect(publishing).rejects.toMatchObject({ code: 'PUBLISH_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(timeoutMs / 2);
  await timedOut;
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it('enforces the deployment deadline during the wait before a poll', async () => {
  const timeoutMs = 25;
  const transport = vi.fn<typeof fetch>(async () => Response.json({ id: 'dpl_waiting', readyState: 'BUILDING' }));
  const publisher = createVercelPublisher({ token: 'test-token', fetch: transport, timeoutMs, pollMs: timeoutMs * 2 });

  await expect(publisher.publish(input)).rejects.toMatchObject({ code: 'PUBLISH_TIMEOUT' });
  expect(transport).toHaveBeenCalledTimes(1);
});
