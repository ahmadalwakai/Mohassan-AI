import { extractPdfText } from '@mohassan/learning';
import type { WritingSource } from './evidence.js';

interface PdfResponse {
  url: string;
  status: number;
  body: Uint8Array;
  headers: Record<string, string | undefined>;
}

export async function writingPdfSource(input: { name: string; bytes: Uint8Array }, signal: AbortSignal, url?: string): Promise<WritingSource> {
  const text = await extractPdfText(input.bytes, { signal });
  return { title: input.name, text, layout: 'pdf', ...(url ? { url } : {}) };
}

export function isWritingPdf(response: PdfResponse): boolean {
  const type = response.headers['content-type'] ?? '';
  return /^application\/pdf(?:[;\s]|$)/iu.test(type) || (!type || /^application\/octet-stream(?:[;\s]|$)/iu.test(type))
    && Buffer.from(response.body.subarray(0, 5)).toString('ascii') === '%PDF-';
}

export async function readWritingPdf(response: PdfResponse, signal: AbortSignal) {
  if (response.status < 200 || response.status >= 300 || !isWritingPdf(response)) return null;
  const url = new URL(response.url);
  const name = url.pathname.split('/').at(-1) || 'PDF';
  let title: string;
  try { title = decodeURIComponent(name); } catch { title = name; }
  try {
    const source = await writingPdfSource({ name: title, bytes: response.body }, signal, response.url);
    return { ...source, url: response.url, status: response.status };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
