import { isIP } from 'node:net';

export function ingressClientIp(headers: Headers, vercel: string | undefined) {
  const ip = vercel === '1' ? headers.get('x-vercel-forwarded-for') : null;
  return ip && !ip.includes('%') && isIP(ip) ? ip : null;
}

/** Stream to the API with backpressure and enforce the same byte limit on chunked uploads. */
export function boundedRelayBody(source: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal) {
  let size = 0;
  let tooLarge = false;
  const body = source?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) {
        tooLarge = true;
        controller.error(new Error('Request body exceeds the proxy limit'));
        return;
      }
      controller.enqueue(chunk);
    },
  }), { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  return { request: body ? { body, duplex: 'half' as const } : {}, tooLarge: () => tooLarge };
}

export function secureSitePreview(headers: Headers, path: string[]) {
  if (path.length < 4 || path[0] !== 'sites' || path[2] !== 'p') return;
  headers.set('Content-Security-Policy', "frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'no-referrer');
}
