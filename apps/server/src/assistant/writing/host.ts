import type { AgentPage, SearchProvider } from '@mohassan/browser';
import type { Kysely } from 'kysely';
import type { DocumentControl } from '../../documents.js';
import type { BrainState } from '../brain.js';
import { reviewBrowserRequestScope } from '../browser-request-scope.js';
import { buildFrame } from '../mind/frame.js';
import { extractPublicSearchQueries } from '../public-query-provenance.js';
import { assessRequestScope, parseUserRequestConstraints, requestCapabilityAllowed, reviewPublicProjection } from '../request-scope.js';
import { writingTask } from '../writer.js';
import type { WritingSource } from './evidence.js';
import { gatherExplanationSources, MAX_EXPLANATION_SOURCES, sourceBodyIdentity, sourceIdentity } from './multisource/gather.js';
import { usesAlignedEvidence } from './multisource/types.js';
import { writingPdfSource } from './pdf-source.js';
import { renderExtractiveWriting, type ExtractiveWritingReply } from './render.js';
import { extractiveWritingEnabled, writingUrl, type ExtractiveWritingTask } from './request.js';

const SOURCE_LIMIT = 6;
const SOURCE_CHARS = 256_000;
const PARALLEL_READS = 2;

export type WritingPageReader = (url: string, signal: AbortSignal, options?: { live?: boolean; includePdf?: boolean }) =>
  Promise<{ url: string; title: string; text: string; status: number; fetchedAt?: string; layout?: WritingSource['layout'] } | 'disallowed' | null>;

interface WritingPorts {
  db: Kysely<any>;
  ownerId: string;
  id: string;
  runId: string;
  request: string;
  previousText: string | null | undefined;
  state: BrainState;
  signal: AbortSignal;
  full: boolean;
  search: SearchProvider;
  config: {
    readPage?: WritingPageReader;
    documents?: { control: Pick<DocumentControl, 'content' | 'list' | 'readLocal'>; link: (id: string) => string };
  };
  active: () => Promise<unknown>;
  observe: () => Promise<AgentPage | null>;
  scrub: (text: string) => string;
  finish: (text: string, status: 'completed' | 'partial' | 'blocked') => Promise<unknown>;
}

interface Sources {
  items: WritingSource[];
  missing?: boolean;
}

function supplied(task: ExtractiveWritingTask, previous: string | null | undefined): WritingSource | undefined {
  const title = task.language === 'ar' ? 'النص المرسل' : 'Supplied text';
  if (task.source.kind === 'paste') return { title, text: task.source.text, offset: task.source.offset };
  if (task.source.kind === 'previous_text' && previous?.trim()) {
    const prior = writingTask(previous, 'extractive')?.source;
    return prior?.kind === 'paste' ? { title, text: prior.text, offset: prior.offset } : { title, text: previous };
  }
  return undefined;
}

function observeShadow(task: ExtractiveWritingTask, enabled: boolean, sources: number, reply: ExtractiveWritingReply | null, complete: boolean | null, independentSources?: number): void {
  try {
    console.info(JSON.stringify({ event: 'extractive_writing_shadow', enabled, operation: task.kind,
      sourceKind: task.source.kind, format: task.format, language: task.language, sources, spans: reply?.evidence.length ?? 0, complete,
      ...(usesAlignedEvidence(task) ? { intent: task.intent ?? task.kind, independentSources, alignment: reply?.alignment } : {}) }));
  } catch { /* Logging must not affect the request. */ }
}

function independentSourceCount(sources: readonly WritingSource[]): number {
  const bodies = new Set<string>();
  const publishers = new Set<string>();
  for (const source of sources) {
    const publisher = sourceIdentity(source);
    const body = sourceBodyIdentity(source);
    if (!publisher || bodies.has(body)) continue;
    bodies.add(body);
    publishers.add(publisher);
  }
  return publishers.size;
}

async function attempt<T>(ports: WritingPorts, read: () => Promise<T>): Promise<T | null> {
  await ports.active();
  let value: T;
  try { value = await read(); } catch (error) {
    if (ports.signal.aborted) throw error;
    await ports.active();
    return null;
  }
  await ports.active();
  return value;
}

function allowedUrl(value: string): string | null {
  const url = writingUrl(value);
  // Reading known search-engine query endpoints is outside the page reader.
  return url && !extractPublicSearchQueries(url).length ? url : null;
}

async function readUrl(ports: WritingPorts, value: string): Promise<WritingSource | null> {
  // The production port enforces SafeNetwork, robots, access limits and redirects.
  const readPage = ports.config.readPage;
  const url = allowedUrl(value);
  if (!url || !readPage || ports.scrub(url) !== url) return null;
  const page = await attempt(ports, () => readPage(url, ports.signal, { includePdf: true }));
  return page && page !== 'disallowed' && page.status >= 200 && page.status < 300 && page.text.trim() && allowedUrl(page.url)
    ? { title: page.title, text: page.text, url: page.url, layout: page.layout } : null;
}

async function readUrls(ports: WritingPorts, urls: readonly string[]): Promise<Sources> {
  const unique = [...new Set(urls)];
  const selected = unique.slice(0, SOURCE_LIMIT);
  const items: WritingSource[] = [];
  // The shared PDF reader admits two workers. A list of PDF URLs uses it in batches.
  for (let index = 0; index < selected.length; index += PARALLEL_READS) {
    const batch = await Promise.all(selected.slice(index, index + PARALLEL_READS).map(url => readUrl(ports, url)));
    items.push(...batch.filter(page => page !== null));
  }
  return { items: [...new Map(items.map(source => [source.url, source])).values()], missing: items.length < unique.length };
}

async function recentReadUrls(ports: WritingPorts, limit: number): Promise<string[]> {
  const rows = await ports.db.selectFrom('chat_runs').select('state')
    .where('conversation_id', '=', ports.id).where('owner_id', '=', ports.ownerId).where('id', '!=', ports.runId)
    .where('status', 'in', ['completed', 'partial']).orderBy('created_at', 'desc').limit(12).execute();
  const urls = new Set<string>();
  for (const row of rows) {
    const state = row.state as BrainState | null;
    const urlsRead = Array.isArray(state?.writingReadUrls) ? state.writingReadUrls : [];
    const publicHandsUrl = state?.requestResolution?.scope === 'public' ? state.handsFound?.url : undefined;
    for (const url of [...urlsRead, publicHandsUrl]) {
      if (typeof url === 'string' && allowedUrl(url)) urls.add(url);
      if (urls.size >= limit) return [...urls];
    }
  }
  return [...urls];
}

function documentId(url: string, link: (id: string) => string): string | null {
  const match = /\/api\/documents\/([a-f0-9-]{36})\/content$/iu.exec(new URL(url).pathname);
  return match && writingUrl(link(match[1])) === url ? match[1] : null;
}

async function readDocument(ports: WritingPorts, id: string): Promise<WritingSource | null> {
  const documents = ports.config.documents;
  if (!documents) return null;
  return attempt(ports, async () => writingPdfSource(await documents.control.content(ports.ownerId, id), ports.signal, documents.link(id)));
}

async function readDocuments(ports: WritingPorts, selection: Extract<ExtractiveWritingTask['source'], { kind: 'pdf' }>, limit: number): Promise<Sources> {
  const documents = ports.config.documents;
  if (!documents) return { items: [], missing: true };
  const found: (WritingSource | null)[] = [];
  if (selection.paths.length) {
    const names = selection.paths.filter(path => !/[/\\]/u.test(path));
    const stored = names.length ? await documents.control.list(ports.ownerId, undefined, 50) : [];
    for (const path of selection.paths.slice(0, limit)) {
      const matches = stored.filter(doc => doc.name.toLowerCase() === path.toLowerCase());
      const here = matches.find(doc => doc.conversationId === ports.id);
      if (here || matches.length === 1) found.push(await readDocument(ports, (here ?? matches[0]).id));
      else if (ports.full && /[/\\]/u.test(path)) {
        found.push(await attempt(ports, async () => writingPdfSource(await documents.control.readLocal(ports.ownerId, path), ports.signal)));
      } else found.push(null);
    }
    return { items: found.filter(item => item !== null), missing: selection.paths.length > limit || found.includes(null) };
  }
  const documentsHere = await documents.control.list(ports.ownerId, ports.id, selection.all ? limit + 1 : 1);
  for (const doc of documentsHere.slice(0, limit)) found.push(await readDocument(ports, doc.id));
  return { items: found.filter(item => item !== null), missing: documentsHere.length > limit || found.includes(null) };
}

function publicTopic(task: ExtractiveWritingTask, query: string, state: BrainState): boolean {
  if (query.length > 500 || !/\p{L}/u.test(query)) return false;
  const context = { contextKind: state.requestResolution?.kind, previous: state.previousSource ?? undefined };
  const current = assessRequestScope(task.instruction, context);
  if (current.scope === 'private' || current.reasons.includes('unresolved_reference')) return false;
  if (usesAlignedEvidence(task) && buildFrame(task.instruction).personal
    && !current.reasons.some(reason => reason === 'explicit_public_lookup' || reason === 'public_document_reference')) return false;
  const projected = assessRequestScope(query);
  if (projected.scope === 'private' || projected.reasons.includes('unresolved_reference')) return false;
  const projection = reviewPublicProjection(task.instruction, query, context);
  if (projection.eligible) return true;
  if (projection.reason !== 'source_not_public' || context.contextKind === 'follow_up' || context.contextKind === 'ambiguous') return false;
  // The parser identifies an explicit explanation/comparison topic. The legacy
  // public classifier recognizes questions, including one-word named subjects.
  return reviewPublicProjection(task.language === 'ar' ? `ما هو ${query}؟` : `What is ${query}?`, query).eligible;
}

async function collect(ports: WritingPorts, task: ExtractiveWritingTask, input?: WritingSource): Promise<Sources> {
  if (input) return { items: [input] };
  const source = task.source;
  const limit = usesAlignedEvidence(task) ? MAX_EXPLANATION_SOURCES : SOURCE_LIMIT;
  const constraints = parseUserRequestConstraints(ports.request);
  if (source.kind === 'pdf') return readDocuments(ports, source, limit);
  const navigation = requestCapabilityAllowed(constraints, 'browser_navigation');
  if (source.kind === 'page' && navigation) {
    const urls = source.recent || source.all ? await recentReadUrls(ports, source.all ? limit : 1) : [];
    if (urls.length) return readUrls(ports, urls);
    const page = await attempt(ports, ports.observe);
    if (page?.text?.trim() && page.documentStatus !== 404 && !Object.values(page.signals).some(Boolean)) {
      const url = writingUrl(page.url);
      if (url) return { items: [{ title: page.title, text: page.text, url }] };
    }
  }
  if (source.kind === 'urls') {
    const documents = ports.config.documents;
    const owned: string[] = [], publicUrls: string[] = [];
    for (const url of source.urls.slice(0, limit)) {
      const id = documents && documentId(url, documents.link);
      if (id) owned.push(id);
      else publicUrls.push(url);
    }
    const local: WritingSource[] = [];
    for (const id of owned) {
      const item = await readDocument(ports, id);
      if (item) local.push(item);
    }
    const publicSources = navigation && reviewBrowserRequestScope(task.instruction, 'browser_navigation', ports.state.requestResolution).allowed
      ? await readUrls(ports, publicUrls) : { items: [], missing: Boolean(publicUrls.length) };
    return { items: [...local, ...publicSources.items], missing: publicSources.missing || local.length !== owned.length || source.urls.length > limit };
  }
  if (source.kind === 'search' && navigation && requestCapabilityAllowed(constraints, 'public_search')
    && publicTopic(task, source.query, ports.state) && ports.scrub(source.query) === source.query && ports.config.readPage) {
    // Search hits are addresses only. No snippets are admitted as read evidence.
    const search = async (count: number) => {
      const hits = await attempt(ports, () => ports.search.search(source.query, count, ports.signal, { ownerId: ports.ownerId }));
      return hits?.map(hit => hit.url) ?? null;
    };
    if (usesAlignedEvidence(task)) {
      const items = await gatherExplanationSources({ query: source.query, ownerId: ports.ownerId, provider: ports.search,
        signal: ports.signal, search, read: url => readUrl(ports, url) });
      return { items };
    }
    const reads = await readUrls(ports, await search(SOURCE_LIMIT) ?? []);
    return { items: reads.items };
  }
  return { items: [] };
}

export async function runExtractiveWriting(ports: WritingPorts): Promise<boolean> {
  const { state } = ports;
  if (state.steps || state.hands || state.writer || state.planner || state.document || state.site || state.questionAnswer
    || state.pendingAction || state.pendingHeld || state.pendingTask || state.pendingComputer || state.pendingDesktop || state.dropHeld) return false;
  const task = writingTask(ports.request, 'extractive');
  if (!task) return false;
  const enabled = extractiveWritingEnabled();
  const input = supplied(task, ports.previousText);
  if (!enabled) {
    try {
      const reply = input ? renderExtractiveWriting(task, [input]) : null;
      observeShadow(task, false, input ? 1 : 0, reply, reply?.complete ?? null);
    } catch { /* A shadow candidate cannot change the current route. */ }
    return false;
  }
  if (usesAlignedEvidence(task) && task.source.kind === 'search' && !ports.config.readPage) {
    observeShadow(task, true, 0, null, null, 0);
    return false;
  }
  const { items, missing: unavailableSource } = await collect(ports, task, input);
  await ports.active();
  const sources = items.flatMap(source => {
    const text = source.text.slice(0, SOURCE_CHARS);
    // Redaction changes literal offsets. Exclude that source rather than citing a changed quote.
    if (ports.scrub(text) !== text) return [];
    return [{ ...source, title: ports.scrub(source.title),
      url: source.url && ports.scrub(source.url) === source.url ? source.url : undefined, text }];
  });
  const missing = unavailableSource || sources.length !== items.length;
  const reply = renderExtractiveWriting(task, sources);
  const complete = reply.complete && !missing;
  const independentSources = usesAlignedEvidence(task) ? independentSourceCount(sources) : undefined;
  observeShadow(task, true, sources.length, reply, complete, independentSources);
  // Only public HTTP reads should become candidates for a later HTTP fetch.
  const documents = ports.config.documents;
  if (task.source.kind === 'urls' || task.source.kind === 'search') {
    state.writingReadUrls = sources.flatMap(source => source.url && !(documents && documentId(source.url, documents.link)) ? [source.url] : []);
  }
  const noInput = sources.length === 0 && (task.kind === 'summary' || task.kind === 'restructure');
  const unavailable = task.language === 'ar' ? 'لم أجد نصًا مقروءًا. ألصق النص أو حدّد صفحة أو ملف PDF.' : 'No readable text found. Paste the text or specify a page or PDF.';
  const someUnavailable = task.language === 'ar' ? 'مصادر غير متاحة' : 'Unavailable sources';
  const text = noInput ? unavailable : reply.text + (missing ? `${task.format === 'line' ? ' · ' : '\n\n'}${someUnavailable}` : '');
  await ports.finish(ports.scrub(text), complete ? 'completed' : sources.length ? 'partial' : 'blocked');
  return true;
}
