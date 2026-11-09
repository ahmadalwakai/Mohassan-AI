import { parentPort, workerData } from 'node:worker_threads';

// Data-only extraction. No viewer, annotation actions, XFA, JavaScript sandbox,
// network fetch, external font fallback, rendering, or user-controlled asset URLs.
globalThis.fetch = async () => { throw new Error('PDF_NETWORK_DISABLED'); };
globalThis.eval = () => { throw new Error('PDF_EVAL_DISABLED'); };
globalThis.Function = new Proxy(globalThis.Function, {
  apply() { throw new Error('PDF_EVAL_DISABLED'); },
  construct() { throw new Error('PDF_EVAL_DISABLED'); },
});

let loading;
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  loading = getDocument({
    data: workerData.bytes, verbosity: 0, stopAtErrors: true,
    isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false,
    useWorkerFetch: false, useWasm: false, disableRange: true, disableStream: true,
    disableAutoFetch: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: 0,
  });
  const document = await loading.promise;
  const metadata = await document.getMetadata();
  if (metadata.info.EncryptFilterName || await document.getPermissions() !== null) throw { code: 'KNOWLEDGE_PDF_ENCRYPTED' };
  if (document.numPages > workerData.limits.pages) throw { code: 'KNOWLEDGE_PDF_PAGE_LIMIT' };
  const parts = [];
  let byteCount = 0;
  const append = text => {
    byteCount += Buffer.byteLength(text, 'utf8');
    if (byteCount > workerData.limits.textBytes) throw { code: 'KNOWLEDGE_PDF_TEXT_LIMIT' };
    parts.push(text);
  };
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value.items) {
          if (typeof item.str !== 'string') continue;
          append(item.str); append(item.hasEOL ? '\n' : ' ');
        }
      }
    } finally { await reader.cancel(new Error('PDF_TEXT_READING_FINISHED')).catch(() => {}); page.cleanup(); }
    append('\n\n');
  }
  const text = parts.join('').replace(/[ \t]+/g, ' ').trim();
  if (!text) throw { code: 'KNOWLEDGE_PDF_NO_TEXT' };
  if (text.includes('\0')) throw { code: 'KNOWLEDGE_PDF_INVALID' };
  parentPort.postMessage({ text });
} catch (error) {
  parentPort.postMessage({ error: error?.name === 'PasswordException' ? 'KNOWLEDGE_PDF_ENCRYPTED' : error?.code ?? 'KNOWLEDGE_PDF_INVALID' });
} finally {
  await loading?.destroy().catch(() => {});
}
