import { browserLiveBudget } from '@mohassan/contracts';

export async function boundedBrowserLiveFrame(response: Response, headers: Headers): Promise<Response> {
  const max = browserLiveBudget.maxFrameBytes;
  const tooLarge = () => Response.json(
    { error: { code: 'BROWSER_LIVE_FRAME_TOO_LARGE', message: 'تجاوزت الصورة الحد المسموح.' } },
    { status: 413, headers: { 'Cache-Control': 'no-store' } },
  );
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    return tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Response(null, { status: response.status, headers });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const frame = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    frame.set(chunk, offset);
    offset += chunk.byteLength;
  }
  headers.set('Content-Length', String(bytes));
  return new Response(frame, { status: response.status, headers });
}
