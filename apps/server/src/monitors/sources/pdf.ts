import { createHash } from 'node:crypto';
import { BrowserError, safeResumeUrl, searchRetryAfter, type SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { extractPdfText, LearningContentError, PDF_LIMITS } from '@mohassan/learning';
import { isWritingPdf } from '../../assistant/writing/pdf-source.js';
import { monitorContainsCredentials, redactMonitorEvidence } from '../credential-privacy.js';
import type { MonitorObservation } from '../evaluation.js';
import { pageNumbers } from '../page-values-v2.js';
import { cleanMonitorText, display, hasPhrase, labelNeedles, matchMonitorText, phraseIndex } from '../page.js';
import type { MonitorPageAnchor, MonitorPageCandidate } from '../page-v2.js';
import type { MonitorReadOptions, MonitorReadResult, MonitorSourceCache } from '../sources.js';

type PdfSpec = MonitorSpec & { source: { kind: 'pdf'; url: string; anchor?: string } };
type Transport = Pick<SafeNetwork, 'validate' | 'request'>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
// Align evidence blocks with the existing page reader and lists with MonitorObservationSchema.
const MAX_BLOCK_CHARS = 512;
const MAX_LIST_ITEMS = 100;
const LIST_MARKER = /^(?:[•●◦▪‣–—-]|\p{Nd}+[.)])\s+(.+)$/u;
const EOF_MARKER = '%%EOF';
// Matches the lexer whitespace entries in pdfjs-dist's pdf.worker.mjs.
const PDF_WHITESPACE = Buffer.from('\0\t\n\f\r ');

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const labelText = (text: string) => matchMonitorText(text).replace(/[:：\s]+$/u, '');

function publicUrl(network: Transport, input: string): string {
  const url = network.validate(input).href;
  if (!safeResumeUrl(url)) throw new BrowserError('MONITOR_URL_DENIED', 'The PDF address contains private access material.');
  return url;
}

function cacheEtag(value: string | undefined): string | undefined {
  if (value && value.length <= 512 && /^(?:W\/)?"[^"\r\n]*"$/u.test(value) && !monitorContainsCredentials(value)) return value;
}

function cacheModified(value: string | undefined): string | undefined {
  if (value && value.length <= 64 && Number.isFinite(Date.parse(value)) && !monitorContainsCredentials(value)) return value;
}

function numericCandidates(lines: string[], spec: PdfSpec, url: string, observedAt: string): MonitorPageCandidate[] {
  if (spec.read.kind !== 'number') return [];
  const label = spec.read.label ?? spec.source.anchor;
  const needles = label ? labelNeedles(label) : [];
  const result: MonitorPageCandidate[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_BLOCK_CHARS) continue;
    const normalized = matchMonitorText(line);
    const labelAt = needles.map(needle => ({ needle, index: phraseIndex(normalized, needle) })).find(match => match.index >= 0);
    const previousLine = lines[index - 1] ?? '';
    const followsLabel = needles.includes(labelText(previousLine));
    if (label && !labelAt && !followsLabel) continue;
    if (!labelAt && followsLabel && /[:：]/u.test(line)) continue;
    // A standalone label belongs to the next line. For inline values, remove the label itself.
    const values = pageNumbers(line).filter(number => !labelAt || number.index + number.raw.length <= labelAt.index
      || number.index >= labelAt.index + labelAt.needle.length);
    if (values.length !== 1 || values[0].conflicting) continue;
    const { value, currency, unit } = values[0];
    const contextLine = followsLabel ? lines[index - 2] ?? '' : previousLine;
    const context = matchMonitorText(`${contextLine.slice(0, MAX_BLOCK_CHARS)} ${line}`)
      .replace(/[\p{N}.,٫٬]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const pattern = { kind: 'number', ...(currency && { currency }), ...(unit && { unit }) };
    const key = digest(JSON.stringify({ label, context, pattern }));
    const excerpt = display(followsLabel ? `${previousLine} ${line}` : line);
    const choice = contextLine ? `${contextLine} · ${excerpt}` : excerpt;
    result.push({ id: key.slice(0, 24), label: display(choice).slice(0, 180),
      anchor: { key, label: label ?? '', context: display(context), origin: 'visible', pattern },
      observation: { value, excerpt, observedAt, url } });
  }
  return result;
}

function readNumber(lines: string[], spec: PdfSpec, url: string, at: string, previous?: MonitorPageAnchor): MonitorReadResult {
  const candidates = numericCandidates(lines, spec, url, at);
  const exact = previous ? candidates.filter(item => item.anchor.key === previous.key) : candidates;
  if (exact.length === 1) {
    const { observation, anchor } = exact[0];
    return { kind: 'value', observation, cache: { url, anchor } };
  }
  const unique = new Set(candidates.map(item => item.id));
  if (unique.size > 1 && unique.size === candidates.length) {
    return { kind: 'clarify', candidates: candidates.slice(0, 4), confidence: 0.55, url };
  }
  return previous || candidates.length ? { kind: 'unsafe-target', confidence: 0, url } : { kind: 'missing', url };
}

function observe(text: string, spec: PdfSpec, url: string, at: string, previous?: MonitorPageAnchor): MonitorReadResult {
  const lines = text.split('\n').map(line => redactMonitorEvidence(cleanMonitorText(line)));
  const { read, source } = spec;
  let watched = lines;
  if (source.anchor && (read.kind !== 'number' || read.label && labelText(source.anchor) !== labelText(read.label))) {
    const label = labelText(source.anchor);
    const indexes = lines.flatMap((line, index) => labelText(line) === label ? [index] : []);
    if (indexes.length > 1) return { kind: 'unsafe-target', confidence: 0, url };
    if (indexes.length !== 1) return { kind: 'missing', url };
    // Blank lines delimit the selected section in the extracted document.
    const after = lines.slice(indexes[0] + 1);
    const end = after.findIndex(line => !line);
    watched = after.slice(0, end < 0 ? after.length : end);
    if (read.kind === 'number') watched = [lines[indexes[0]], ...watched];
  }
  if (read.kind === 'number') return readNumber(watched, spec, url, at, previous);

  const joined = cleanMonitorText(watched.join(' '));
  const sample = (value: MonitorObservation['value'], excerpt = joined, extra: Partial<MonitorObservation> = {}): MonitorReadResult =>
    ({ kind: 'value', observation: { value, excerpt: display(excerpt), url, observedAt: at, ...extra } });
  if (read.kind === 'items') {
    const items = new Map<string, string>();
    for (const line of watched) {
      const item = LIST_MARKER.exec(line)?.[1];
      if (!item) continue;
      const key = digest(matchMonitorText(item));
      items.set(key, display(item));
      if (items.size > MAX_LIST_ITEMS) return { kind: 'unsafe-target', confidence: 0, url };
    }
    const values = [...items.values()];
    const empty = spec.language === 'ar' ? 'لم تظهر عناصر في القائمة.' : 'There are no list items in the PDF.';
    return sample(values, values.join(' · ') || empty, { itemKeys: [...items.keys()] });
  }
  if (!joined) return { kind: 'missing', url };
  if (read.kind === 'phrase') {
    const needle = matchMonitorText(read.phrase);
    const normalized = matchMonitorText(joined);
    const present = hasPhrase(normalized, needle);
    const matchingLine = present ? watched.find(line => hasPhrase(matchMonitorText(line), needle)) : undefined;
    return sample(present, matchingLine ?? joined);
  }
  if (read.kind !== 'main') return { kind: 'missing', url };
  // Keep comparison blocks for the entire bounded document so edits beyond the excerpt can trigger.
  const blocks = joined.match(/.{1,512}(?=\s|$)|\S{1,512}/gu)
    ?.map((part, index) => ({ key: String(index), text: part.trim() })) ?? [];
  return sample(display(joined), joined, { blocks });
}

export async function readPdfMonitor(spec: PdfSpec, options: MonitorReadOptions, network: Transport,
  clock: () => number = Date.now): Promise<MonitorReadResult> {
  const deadline = AbortSignal.timeout(PDF_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let target = publicUrl(network, spec.source.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const previous = options.cache?.url === target ? options.cache : undefined;
    const etag = cacheEtag(previous?.etag);
    const lastModified = cacheModified(previous?.lastModified);
    const headers = { accept: 'application/pdf, application/octet-stream;q=0.9',
      ...(etag && { 'if-none-match': etag }),
      ...(lastModified && { 'if-modified-since': lastModified }) };
    let response;
    try {
      response = await network.request(target, { method: 'GET', signal, headers, maxBytes: PDF_LIMITS.bytes, allowAttachment: true });
      signal.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (deadline.aborted || error instanceof BrowserError && error.code === 'BROWSER_RESPONSE_TOO_LARGE') {
        return { kind: 'unreachable', url: target };
      }
      throw error;
    }
    if (REDIRECTS.has(response.status) && response.headers.location) {
      target = publicUrl(network, new URL(response.headers.location, target).href);
      continue;
    }
    if ((response.status === 429 || response.status === 503) && response.headers['retry-after']) {
      await options.extendHost?.(new URL(target).hostname, searchRetryAfter(response.headers['retry-after'], clock()));
    }
    if (response.status === 304 && previous && (etag || lastModified)) {
      return { kind: 'unchanged', cache: { ...previous, etag, lastModified } };
    }
    if (response.status !== 200 || response.body.byteLength > PDF_LIMITS.bytes || !isWritingPdf(response)) {
      return { kind: 'unreachable', url: target };
    }
    // A truncated revision must not become a new baseline even if the parser can repair it.
    const eof = response.body.lastIndexOf(EOF_MARKER);
    if (eof < 0 || response.body.subarray(eof + EOF_MARKER.length).some(byte => !PDF_WHITESPACE.includes(byte))) {
      return { kind: 'unreachable', url: target };
    }
    let text: string;
    try {
      text = await extractPdfText(response.body, { signal, monitorLayout: true });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof LearningContentError) return { kind: 'unreachable', url: target };
      throw error;
    }
    if (deadline.aborted) return { kind: 'unreachable', url: target };
    const result = observe(text, spec, target, new Date(clock()).toISOString(), options.cache?.anchor);
    if (result.kind !== 'value' && result.kind !== 'clarify') return result;
    const cache: MonitorSourceCache = { url: target, ...result.cache };
    // A choice still needs a full read until the approved candidate has become the baseline.
    if (result.kind === 'value') {
      const nextEtag = cacheEtag(response.headers.etag);
      const nextModified = cacheModified(response.headers['last-modified']);
      if (nextEtag) cache.etag = nextEtag;
      if (nextModified) cache.lastModified = nextModified;
    }
    return { ...result, cache };
  }
  return { kind: 'unreachable', url: target };
}
