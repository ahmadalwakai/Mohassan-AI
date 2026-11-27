import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { PDF_LIMITS } from '@mohassan/learning';
import { describe, expect, it, vi } from 'vitest';
import { detectMonitorNeed } from '../apps/server/src/monitors/detection.js';
import { evaluateMonitor } from '../apps/server/src/monitors/evaluation.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { pdfMonitorSpec } from '../apps/server/src/monitors/sources/pdf-intent.js';
import { readPdfMonitor } from '../apps/server/src/monitors/sources/pdf.js';
import { pdfFixture } from '../packages/learning/src/pdf-fixture.js';
import { writeMonitorPdfFixture } from './fixtures/monitors/pdf.js';

const url = 'https://publisher.example/report.pdf';
const at = new Date('2026-11-25T12:00:00Z');
const clock = () => at.getTime();
const options = { ownerId: 'fixture-owner', v2: true };
const source = { kind: 'pdf', url } as const;
const spec = (read: MonitorSpec['read'], condition: MonitorSpec['condition'] = { kind: 'change' }) =>
  ({ source, read, condition, language: 'en', title: 'Public PDF', message: 'Public PDF changed', timing: monitorTiming('pdf', 'normal', { now: at }) } as const);

function transport(body: Buffer, status = 200, headers = { 'content-type': 'application/pdf', etag: '"revision"' }) {
  const network = new SafeNetwork();
  return { validate: network.validate.bind(network), request: vi.fn<SafeNetwork['request']>(async target => ({ body, url: target, status, headers })) };
}

function observed(result: Awaited<ReturnType<typeof readPdfMonitor>>) {
  if (result.kind !== 'value') throw new Error('Expected a PDF observation, got ' + result.kind);
  return result.observation;
}

describe('public PDF monitor', () => {
  it('extracts bilingual text and confirms a revision beyond the displayed excerpt', async () => {
    const pages = Array.from({ length: 21 }, (_, index) => `English section ${index + 1} with the original procedural text.`);
    const original = await writeMonitorPdfFixture([...pages, 'مورد الورق المعتمد هو الأرز']);
    const revision = await writeMonitorPdfFixture([...pages, 'مورد الورق المعتمد هو الصنوبر']);
    const main = spec({ kind: 'main' });
    const before = observed(await readPdfMonitor(main, options, transport(original), clock));
    const after = observed(await readPdfMonitor(main, options, transport(revision), clock));
    expect(after.excerpt).toBe(before.excerpt);
    expect(before.blocks?.map(block => block.text).join(' ')).toContain('مورد الورق المعتمد هو الأرز');
    const baseline = evaluateMonitor(main, undefined, before);
    const provisional = evaluateMonitor(main, baseline.state, after);
    expect(provisional.trigger).toBeUndefined();
    expect(evaluateMonitor(main, provisional.state, after).trigger?.excerpt).toContain('الصنوبر');
  });

  it('redacts known credential fields from stored PDF change evidence', async () => {
    const bytes = await writeMonitorPdfFixture(['Current public schedule\nAuthorization: example-field\nOpen on Monday']);
    const result = observed(await readPdfMonitor(spec({ kind: 'main' }), options, transport(bytes), clock));
    const retained = result.blocks?.map(block => block.text).join(' ');
    expect(retained).toContain('Open on Monday');
    expect(retained?.includes('example-field')).toBe(false);
  });

  it('reads wrapped phrases and tracks additions independently of list numbering', async () => {
    const original = await writeMonitorPdfFixture(['Shift list\n1. Morning shift\n2. Evening shift', 'تقرير العمل']);
    const revision = await writeMonitorPdfFixture(['Shift list\n1. Evening shift\n2. Morning shift\n3. Night shift', 'تقرير\nالعمل متاح']);
    const phrase = spec({ kind: 'phrase', phrase: 'العمل متاح' }, { kind: 'appears' });
    expect(observed(await readPdfMonitor(phrase, options, transport(original), clock)).value).toBe(false);
    expect(observed(await readPdfMonitor(phrase, options, transport(revision), clock)).value).toBe(true);
    const list = { ...spec({ kind: 'items' }, { kind: 'new-item' }), source: { ...source, anchor: 'Shift list' } };
    const before = observed(await readPdfMonitor(list, options, transport(original), clock));
    const after = observed(await readPdfMonitor(list, options, transport(revision), clock));
    expect(before.value).toEqual(['Morning shift', 'Evening shift']);
    expect(after.value).toEqual(['Evening shift', 'Morning shift', 'Night shift']);
    const baseline = evaluateMonitor(list, undefined, before);
    expect(evaluateMonitor(list, baseline.state, after).trigger?.excerpt).toBe('Night shift');
  });

  it('reads Arabic digits and asks which repeated numeric label to watch', async () => {
    const arabic = spec({ kind: 'number', label: 'السعة' });
    const report = await writeMonitorPdfFixture(['تقرير السعة\nالسعة : ٤٢']);
    expect(observed(await readPdfMonitor(arabic, options, transport(report), clock)).value).toBe(42);
    const capacity = spec({ kind: 'number', label: 'Capacity' });
    const original = await writeMonitorPdfFixture(['West hall\nCapacity: 20\nEast hall\nCapacity: 33']);
    const choice = await readPdfMonitor(capacity, options, transport(original), clock);
    expect(choice).toMatchObject({ kind: 'clarify', candidates: [{ observation: { value: 20 } }, { observation: { value: 33 } }] });
    if (choice.kind !== 'clarify') throw new Error('No PDF choices');
    const cache = { url, anchor: choice.candidates[1].anchor };
    const reordered = await writeMonitorPdfFixture(['East hall\nCapacity: 36\nWest hall\nCapacity: 21']);
    expect(observed(await readPdfMonitor(capacity, { ...options, cache }, transport(reordered), clock)).value).toBe(36);
    const missing = await writeMonitorPdfFixture(['West hall\nCapacity: 21']);
    expect(await readPdfMonitor(capacity, { ...options, cache }, transport(missing), clock)).toMatchObject({ kind: 'unsafe-target' });
  });

  it('validates every redirect, carries validators only to their document and never forwards credentials', async () => {
    const bytes = await writeMonitorPdfFixture(['Release notes']);
    const destination = 'https://files.example/rev.pdf';
    const network = transport(bytes);
    network.request.mockResolvedValueOnce({ url, body: Buffer.alloc(0), status: 302, headers: { location: destination } });
    const main = spec({ kind: 'main' });
    const first = await readPdfMonitor(main, options, network, clock);
    expect(first).toMatchObject({ kind: 'value', cache: { url: destination, etag: '"revision"' } });
    if (first.kind !== 'value') throw new Error('No PDF baseline');
    network.request.mockResolvedValueOnce({ url, body: Buffer.alloc(0), status: 302, headers: { location: destination } });
    network.request.mockResolvedValueOnce({ url: destination, body: Buffer.alloc(0), status: 304, headers: {} });
    expect(await readPdfMonitor(main, { ...options, cache: first.cache }, network, clock)).toMatchObject({ kind: 'unchanged' });
    expect(network.request.mock.calls[2][1]?.headers).toEqual({ accept: 'application/pdf, application/octet-stream;q=0.9' });
    expect(network.request.mock.calls[3][1]?.headers).toEqual({ accept: 'application/pdf, application/octet-stream;q=0.9', 'if-none-match': '"revision"' });
    network.request.mockResolvedValueOnce({ url, body: Buffer.alloc(0), status: 302, headers: { location: 'https://files.example/rev.pdf?token=fixture' } });
    await expect(readPdfMonitor(main, options, network, clock)).rejects.toMatchObject({ code: 'MONITOR_URL_DENIED' });
    expect(network.request).toHaveBeenCalledTimes(5);
  });

  it('excludes privacy-filtered validators from PDF revalidation and storage', async () => {
    const bytes = await writeMonitorPdfFixture(['Current public schedule']);
    const etag = '"Authorization: example-field"';
    const main = spec({ kind: 'main' });
    const network = transport(bytes, 200, { 'content-type': 'application/pdf', etag });
    const result = await readPdfMonitor(main, { ...options, cache: { url, etag } }, network, clock);
    expect(result.kind).toBe('value');
    expect('cache' in result && result.cache?.etag !== undefined).toBe(false);
    expect(Object.hasOwn(network.request.mock.calls[0][1]?.headers ?? {}, 'if-none-match')).toBe(false);
  });

  it('refuses encrypted, truncated, malformed, and many-page PDFs without a value or cache', async () => {
    const good = await writeMonitorPdfFixture(['This document is complete']);
    const tooManyPages = await writeMonitorPdfFixture(Array.from({ length: PDF_LIMITS.pages + 1 }, () => 'Page text'));
    for (const body of [pdfFixture(['Encrypted'], { encrypted: true }), good.subarray(0, good.lastIndexOf('startxref')),
      Buffer.from('%PDF-1.7\nMalformed content\n%%EOF\n'), tooManyPages]) {
      expect(await readPdfMonitor(spec({ kind: 'main' }), options, transport(body), clock)).toEqual({ kind: 'unreachable', url });
    }
    expect(observed(await readPdfMonitor(spec({ kind: 'main' }), options, transport(good), clock)).value).toBe('This document is complete');
  });

  it('enforces the byte cap during SafeNetwork transfer and applies the whole-file deadline', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment' });
      response.end(Buffer.alloc(PDF_LIMITS.bytes + 1));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const localUrl = `${origin}/oversized.pdf`;
      const local = { ...spec({ kind: 'main' }), source: { ...source, url: localUrl } };
      const network = new SafeNetwork({ testOrigins: [origin] });
      expect(await readPdfMonitor(local, options, network, clock)).toEqual({ kind: 'unreachable', url: localUrl });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const network = transport(Buffer.alloc(0));
    network.request.mockImplementationOnce(async target => {
      deadline.abort();
      return { url: target, body: Buffer.alloc(0), headers: {}, status: 200 };
    });
    try {
      expect(await readPdfMonitor(spec({ kind: 'main' }), options, network, clock)).toEqual({ kind: 'unreachable', url });
      expect(timeout).toHaveBeenCalledWith(PDF_LIMITS.timeoutMs);
    } finally { timeout.mockRestore(); }
  });

  it('reuses Arabic and English monitor intents, with the PDF polling interval', () => {
    const parse = (text: string) => {
      const need = detectMonitorNeed({ text });
      return need && pdfMonitorSpec(need, at);
    };
    expect(parse(`Tell me when the PDF changes at ${url}`)).toMatchObject({ source, read: { kind: 'main' }, timing: monitorTiming('pdf', 'normal', { now: at }) });
    expect(parse(`راقب الرقم بجوار «السعة» في ${url}`)).toMatchObject({ source, read: { kind: 'number', label: 'السعة' } });
    expect(parse(`Notify me when “open for orders” appears in ${url}`)).toMatchObject({ read: { kind: 'phrase', phrase: 'open for orders' } });
    expect(parse(`Watch for new list items at ${url}`)).toMatchObject({ read: { kind: 'items' }, condition: { kind: 'new-item' } });
    expect(parse('Watch the PDF at https://publisher.example/download')).toMatchObject({ source: { kind: 'pdf', url: 'https://publisher.example/download' } });
    expect(parse('Watch the page at https://publisher.example/download')).toBeNull();
    expect(parse('Tell me when “PDF” appears on https://publisher.example/download')).toBeNull();
  });
});
