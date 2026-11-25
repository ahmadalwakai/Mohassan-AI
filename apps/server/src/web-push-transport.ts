import { SafeNetwork } from '@mohassan/browser';

const network = new SafeNetwork();

export async function deliverWebPushRequest(endpoint: string, request: { headers: object; body: Buffer | null }) {
  // Forward the generated Web Push headers, including VAPID authorization. The
  // network guard pins the connection and returns redirects without following them.
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));
  const response = await network.request(endpoint, {
    method: 'POST', headers, body: request.body ?? undefined, browser: true,
    signal: AbortSignal.timeout(5_000), maxBytes: 8_192,
  });
  if (response.status === 404 || response.status === 410) return 'expired';
  return response.status >= 200 && response.status < 300 ? 'delivered' : 'failed';
}
