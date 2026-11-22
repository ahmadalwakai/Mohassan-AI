import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { publicSearchText, safeResumeUrl, searchRetryAfter } from '@mohassan/browser';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import { missingText, replyCopy, requiresSourceDate, showBareValue, siteQuoteText } from './compose.js';
import type { Claim, Evidence, Frame, MindDeps, MindReply, SiteObservation } from './contract.js';
import { declaredDate, extractQuote, isPageInstruction, matchMention, topicScore } from './extract.js';
import { matchText, stripCourtesyTail } from './normalize.js';
import { siteName } from '../activity.js';

// مقترحات الخطة، غير مقيسة قبل اختبار المسارات الكاملة.
const READ_LIMIT_MS = 8_000;
const SITE_LIMIT_MS = 12_000;
const MAX_REDIRECTS = 5;
const MAX_INTERNAL_LINKS = 10;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE = new Set([429, 503]);

export type ReadPage = Awaited<ReturnType<MindDeps['read']>>;
type ReadDeps = Pick<MindDeps, 'read' | 'now'>;
type Link = { url: string; label: string };
export interface SiteRead {
  page?: ReadPage;
  reads: { page: ReadPage; fetchedAt: string; elapsedMs: number }[];
  redirects: { from: string; to: string; status: number; fetchedAt: string }[];
  failure?: 'unavailable' | 'redirect_limit' | 'unsafe_redirect' | 'deadline';
}
export interface SiteDetails {
  title?: string;
  language?: string;
  identity?: string;
  pageDate?: string;
  visibleText?: string;
  links: Link[];
  sitemaps: string[];
}

export function readableUrl(input: string, base?: string): string | null {
  const parsed = URL.parse(input, base);
  if (!parsed) return null;
  parsed.hash = '';
  const url = safeResumeUrl(parsed.href);
  if (!url) return null;
  const pathname = decodeURIComponent(parsed.pathname);
  if (/(?:^|\/)(?:log[-_]?in|sign[-_]?in|sign[-_]?up|logout|checkout|captcha|challenge|payment|cart|admin|__effect)(?:\/|$)/i.test(pathname)) return null;
  return url;
}

export const siteHost = (url: string) => new URL(url).hostname.replace(/^www\./i, '');
const sameSite = (a: string, b: string) => siteHost(a) === siteHost(b);
const isSuccess = (status: number) => status >= 200 && status < 300 && status !== 202;

export function header(page: ReadPage, key: string): string | undefined {
  return Object.entries(page.headers).find(([name]) => name.toLowerCase() === key)?.[1];
}

export function signalUntil(signal: AbortSignal, deadline: number): AbortSignal {
  const left = Math.ceil(deadline - performance.now());
  const timeout = left > 0 ? AbortSignal.timeout(left) : AbortSignal.abort(new DOMException('Network deadline exceeded', 'TimeoutError'));
  return AbortSignal.any([signal, timeout]);
}

export async function withDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel!);
  }
}

export async function readSite(
  input: string, deps: ReadDeps, signal: AbortSignal, deadline: number, stayOnHost = false,
): Promise<SiteRead> {
  const result: SiteRead = { reads: [], redirects: [] };
  let url = readableUrl(input);
  if (!url) return { ...result, failure: 'unavailable' };
  const first = url;
  const visited = new Set<string>();
  let retried = false;
  while (url) {
    signal.throwIfAborted();
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) return { ...result, failure: 'deadline' };
    const started = performance.now();
    const target: string = url;
    const request = AbortSignal.any([signal, AbortSignal.timeout(Math.min(READ_LIMIT_MS, left))]);
    let response: ReadPage;
    try {
      response = await withDeadline(request, () => deps.read(target, request));
    } catch {
      signal.throwIfAborted();
      return { ...result, failure: request.aborted ? 'deadline' : 'unavailable' };
    }
    const observed = readableUrl(response.url);
    if (!observed || stayOnHost && !sameSite(first, observed)) return { ...result, failure: 'unsafe_redirect' };
    const page: ReadPage = { ...response, url: observed };
    const fetchedAt = page.fetchedAt ?? deps.now().toISOString();
    result.page = page;
    result.reads.push({ page, fetchedAt, elapsedMs: performance.now() - started });
    const retry = header(page, 'retry-after');
    if (!retried && RETRYABLE.has(page.status)) {
      const wait = page.status === 503 && !retry ? 0 : searchRetryAfter(retry, deps.now().getTime());
      if (wait < deadline - performance.now()) {
        retried = true;
        if (wait) await delay(wait, undefined, { signal });
        continue;
      }
    }
    visited.add(target);
    const location = REDIRECTS.has(page.status) && header(page, 'location');
    if (!location) break;
    const next = readableUrl(location, page.url);
    if (!next || stayOnHost && !sameSite(first, next)) return { ...result, failure: 'unsafe_redirect' };
    if (result.redirects.length >= MAX_REDIRECTS || visited.has(next)) return { ...result, failure: 'redirect_limit' };
    result.redirects.push({ from: page.url, to: next, status: page.status, fetchedAt });
    url = next;
  }
  return result;
}

const attribute = (node: Html.Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const children = (node: Html.Node) => 'childNodes' in node ? node.childNodes : [];
function textOf(node: Html.Node): string {
  const stack: Html.Node[] = [node];
  const values: string[] = [];
  while (stack.length) {
    const next = stack.pop()!;
    if ('value' in next) values.push(next.value);
    const nested = children(next);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  return values.join(' ').replace(/\s+/gu, ' ').trim();
}

const PUBLIC_ORG_TYPES = /^(?:Organization|Corporation|GovernmentOrganization|NGO|LocalBusiness|Store|Restaurant|Hospital|Museum|Library|School|CollegeOrUniversity|EducationalOrganization|MedicalOrganization)$/i;
function structuredInformation(raw: string): { identity?: string; dateModified?: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  const pending: unknown[] = [parsed];
  const info: { identity?: string; dateModified?: string } = {};
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    if (!item || typeof item !== 'object') continue;
    const node = item as Record<string, unknown>;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (!info.identity && types.some(type => typeof type === 'string' && PUBLIC_ORG_TYPES.test(type.replace(/^https?:\/\/schema\.org\//i, ''))) && typeof node.name === 'string') info.identity = node.name;
    if (!info.dateModified && typeof node.dateModified === 'string') info.dateModified = node.dateModified;
    if (node['@graph']) pending.push(node['@graph']);
  }
  return info;
}

export function inspectSite(page: ReadPage): SiteDetails {
  const result: SiteDetails = { links: [], sitemaps: [] };
  const stack: Html.Node[] = page.html ? [parse(page.html)] : [];
  const visited = new Set<string>();
  let dateTime: string | undefined;
  const body: string[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if ('value' in node) body.push(node.value);
    if ('tagName' in node) {
      if (attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden') === 'true' || /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/iu.test(attribute(node, 'style') ?? '') || ['form', 'template', 'noscript', 'style', 'svg'].includes(node.tagName)) continue;
      if (node.tagName === 'title' && !result.title) result.title = textOf(node);
      if (node.tagName === 'html') result.language = attribute(node, 'lang');
      if (node.tagName === 'time') dateTime ??= attribute(node, 'datetime');
      if (node.tagName === 'script') {
        if (attribute(node, 'type') === 'application/ld+json') {
          const info = structuredInformation(node.childNodes.map(child => 'value' in child ? child.value : '').join(''));
          result.identity ??= info.identity;
          result.pageDate ??= info.dateModified;
        }
        continue;
      }
      const href = ['a', 'link'].includes(node.tagName) && attribute(node, 'href');
      if (href) {
        const url = readableUrl(href, page.url);
        const label = node.tagName === 'a' ? textOf(node) : '';
        if (url && sameSite(url, page.url) && !isPageInstruction(label)) {
          if (/\bsitemap\b/i.test(attribute(node, 'rel') ?? '') || /(?:sitemap|خريطة الموقع)/iu.test(label)) result.sitemaps.push(url);
          if (node.tagName === 'a' && url !== page.url && !visited.has(url)) {
            result.links.push({ url, label });
            visited.add(url);
          }
        }
      }
    }
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  if (page.html) result.visibleText = body.join(' ').replace(/\s+/gu, ' ').trim();
  result.language ||= header(page, 'content-language');
  const visibleModified = /(?:last (?:updated|modified)|آخر\s+تحديث)\s*[:：]?\s*([^\r\n.!؟]+)(?=[\r\n.!؟]|$)/iu.exec(result.visibleText ?? page.text)?.[1];
  result.pageDate = declaredDate(result.pageDate) ?? declaredDate(visibleModified) ?? declaredDate(dateTime);
  return result;
}

function knownLocation(page: ReadPage, details: SiteDetails, focus: readonly string[]): string | undefined {
  return details.links
    .map(link => ({ ...link, score: topicScore(`${link.label} ${new URL(link.url).pathname}`, focus) }))
    .filter(link => link.score > 0 && link.url !== page.url)
    .sort((a, b) => b.score - a.score)[0]?.url;
}

function sitemapLocations(text: string, map: string): string[] {
  // A sitemap supplies paths to read, never evidence of an answer on its own.
  return [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/giu)].flatMap(match => {
    const target = readableUrl(match[1].trim().replaceAll('&amp;', '&'), map);
    return target && sameSite(target, map) ? [target] : [];
  });
}

export async function recoverMovedPage(
  original: ReadPage, frame: Frame, deps: ReadDeps, signal: AbortSignal, deadline: number,
): Promise<SiteRead | undefined> {
  const details = inspectSite(original);
  let sitemap = details.sitemaps[0];
  if (!sitemap) {
    // RFC 9309 policy URL, not a guessed content path.
    const rules = await readSite(new URL('/robots.txt', original.url).href, deps, signal, deadline, true);
    const known = rules.page && /^\s*Sitemap\s*:\s*(\S+)\s*$/imu.exec(rules.page.text)?.[1];
    if (known && readableUrl(known, original.url) && sameSite(new URL(known, original.url).href, original.url)) sitemap = new URL(known, original.url).href;
  }
  if (sitemap) {
    const map = await readSite(sitemap, deps, signal, deadline, true);
    if (map.page && isSuccess(map.page.status)) {
      const candidate = sitemapLocations(map.page.html || map.page.text, sitemap)
        .map(url => ({ url, score: topicScore(new URL(url).pathname, frame.focus) }))
        .filter(item => item.score > 0 && item.url !== original.url)
        .sort((a, b) => b.score - a.score)[0];
      if (candidate) {
        const moved = await readSite(candidate.url, deps, signal, deadline, true);
        if (moved.page && isSuccess(moved.page.status)) return moved;
      }
    }
  }
  const linked = knownLocation(original, details, frame.focus);
  if (linked) return readSite(linked, deps, signal, deadline, true);
  const home = details.links.find(link => new URL(link.url).pathname === '/' && !new URL(link.url).search);
  if (!home) return undefined;
  const landing = await readSite(home.url, deps, signal, deadline, true);
  if (!landing.page || !isSuccess(landing.page.status)) return undefined;
  const related = knownLocation(landing.page, inspectSite(landing.page), frame.focus);
  return related ? readSite(related, deps, signal, deadline, true) : undefined;
}

export interface SiteCheck {
  address?: string;
  result?: SiteRead;
  details?: SiteDetails;
  links: SiteRead[];
  prior?: { sourceHash: string; fetchedAt: string };
  contentHash?: string;
}

const explicitSample = /\b(?:(?:internal|broken|dead)\s+(?:links|hyperlinks)|(?:check|test|audit|inspect|sample|verify|list|show)\s+(?:(?:the|all|its|some|any|a sample of)\s+)?(?:links|hyperlinks))\b|(?:روابط(?:ها)?\s+(?:ال)?(?:داخليه|معطله|مكسوره)|(?:افحص|اختبر|تحقق من|اعرض)\s+(?:عينه من\s+)?(?:ال)?روابط)(?!\p{L})/iu;
const broadAudit = /\b(?:(?:general|overall|full|complete|comprehensive)\s+(?:(?:site|website|page)\s+)?(?:audit|inspection|check|review|report)|(?:audit|inspection|check|review)\s+(?:the\s+)?(?:entire|whole)\s+(?:site|website|page))\b|(?:فحص|تدقيق|مراجعه|تقرير)\s+(?:عام|شامل|كامل)(?!\p{L})/iu;
const generalInspection = /^(?:(?:(?:please|kindly)\s+)?(?:audit|inspect|check|test|assess|scan|review|analyze|analyse)(?:\s+(?:(?:the|this|that)\s+)?(?:site|website|page))?(?:\s+(?:at|on|for))?|(?:(?:من فضلك|لو سمحت)\s+)?(?:افحص|اختبر|دقق|راجع|حلل|فحص|تدقيق|مراجعه)(?:\s+(?:(?:هذا|هذه|ذلك|تلك)\s+)?(?:ال)?(?:موقع|صفحه))?)[\s.?!؟،,:]*$/iu;

function wantsLinkSample(frame: Frame): boolean {
  const request = matchText(stripCourtesyTail(frame.text.replace(/(?:https?:\/\/|www\.)[^\s<>«»"']+/giu, ' '))).trim();
  return explicitSample.test(request) || broadAudit.test(request) || generalInspection.test(request);
}

export async function checkSite(frame: Frame, deps: MindDeps, signal: AbortSignal, options: { deadline?: number } = {}): Promise<SiteCheck> {
  const address = frame.urls[0];
  if (!address || frame.personal) return { links: [] };
  const deadline = Math.min(performance.now() + SITE_LIMIT_MS, options.deadline ?? Infinity);
  await deps.step(`قراءة ${siteName(address)}`);
  let result = await readSite(address, deps, signal, deadline);
  if (frame.intent === 'site_question' && result.page?.status === 404) {
    const recovered = await recoverMovedPage(result.page, frame, deps, signal, deadline);
    if (recovered?.page && isSuccess(recovered.page.status)) {
      result = { ...recovered, reads: [...result.reads, ...recovered.reads], redirects: [...result.redirects, ...recovered.redirects] };
    }
  }
  const page = result.page;
  if (!page) return { address, result, links: [] };
  const details = inspectSite(page);
  const eligible = frame.intent === 'site_check' && isSuccess(page.status) && !result.failure;
  const sample = eligible && wantsLinkSample(frame) ? details.links.slice(0, MAX_INTERNAL_LINKS) : [];
  if (sample.length) await deps.step(`قراءة ${sample.length} من صفحات ${siteName(address)}`);
  const links = await Promise.all(sample.map(link => readSite(link.url, deps, signal, deadline, true)));
  const contentHash = page.html || page.text ? createHash('sha256').update(page.html || page.text).digest('hex') : undefined;
  let prior: SiteCheck['prior'];
  if (eligible && contentHash && deps.siteSnapshot && performance.now() < deadline) {
    const scoped = signalUntil(signal, deadline);
    try { prior = await withDeadline(scoped, () => deps.siteSnapshot!(page.url)) ?? undefined; }
    catch (error) { if (!scoped.aborted || signal.aborted) throw error; }
  }
  return { address, result, details, links, prior, contentHash };
}

type SiteAnswer = Pick<MindReply, 'status' | 'text' | 'claims' | 'evidence'>;
export async function answerSite(frame: Frame, deps: MindDeps, signal: AbortSignal, options: { deadline?: number } = {}): Promise<SiteAnswer> {
  const diagnostic = await checkSite(frame, deps, signal, options);
  const { result, details } = diagnostic;
  const page = result?.page;
  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const ar = frame.lang === 'ar';
  const add = (text: string, observedUrl: string, fetchedAt: string, quote: string, observation?: SiteObservation, value?: string, pageDate?: string) => {
    const id = `site-${evidence.length}`;
    evidence.push({ id, source: 'site', url: observedUrl, fetchedAt, quote, observation, value, pageDate, official: true });
    claims.push({ text, support: [id], status: 'single_source' });
  };
  const missing = (text: string) => claims.push({ text, support: [], status: 'not_found' });
  const finish = (status: SiteAnswer['status']): SiteAnswer => ({ status, claims, evidence, text: claims.map(claim => claim.text).join('\n') });
  if (!page || !details || !result) {
    missing(replyCopy[frame.lang].cannotRead);
    return finish('blocked');
  }
  const observed = result.reads.at(-1)!;
  const accessed = ar ? `وقت القراءة ${observed.fetchedAt}` : `Read at ${observed.fetchedAt}`;
  const contentAvailable = isSuccess(page.status) && !result.failure;
  const asksMention = /\b(?:mention|mentions|say anything about|refer to)\b|هل\s+(?:يذكر|تذكر)|(?:يذكر|تذكر)\s+.*[؟?]/iu.test(frame.text);
  const needsContent = frame.intent === 'site_question' || asksMention;
  const sourceText = details.visibleText ?? page.text;
  const pageDate = details.pageDate ?? declaredDate(header(page, 'last-modified'));
  const extraction = contentAvailable && needsContent && (!requiresSourceDate(frame, 'site') || pageDate)
    ? (asksMention ? matchMention(sourceText, frame) : extractQuote(sourceText, frame)) : undefined;
  const item: Evidence | undefined = extraction ? {
    id: `site-${evidence.length}`, source: 'site', url: page.url, fetchedAt: observed.fetchedAt, quote: extraction.quote,
    value: extraction.value, pageDate, official: true,
  } : undefined;
  const valueOnly = item && showBareValue(frame, 'single_source', [item]);
  const matched = item && (!valueOnly || item.value) ? item : undefined;
  if (needsContent && matched) {
    evidence.push(matched);
    claims.push({ text: valueOnly ? matched.value! : siteQuoteText(frame.lang, matched, true), support: [matched.id], status: 'single_source' });
    if (frame.intent === 'site_question' || frame.valueOnly) return finish('completed');
  } else if (needsContent) {
    const checked = new Set(result.reads.filter(read => isSuccess(read.page.status)).map(read => read.page.url)).size;
    missing(missingText(frame.lang, checked));
    if (frame.intent === 'site_question' || frame.valueOnly) return finish('partial');
  }

  add(`HTTP ${page.status} · ${page.url} · ${accessed}`, page.url, observed.fetchedAt, '', { kind: 'http_status', status: page.status });
  const protocol = new URL(page.url).protocol.replace(':', '').toUpperCase();
  const metadata = (field: Extract<SiteObservation, { kind: 'metadata' }>['field'], label: string, value?: string) => {
    if (value && !isPageInstruction(value) && !/https?:\/\//iu.test(value) && publicSearchText(value) === value) add(`${label} ${value}`, page.url, observed.fetchedAt, '', { kind: 'metadata', field, value });
  };
  metadata('protocol', ar ? 'البروتوكول' : 'Protocol', protocol);
  metadata('content_type', ar ? 'نوع المحتوى' : 'Content type', header(page, 'content-type'));
  metadata('last_modified', ar ? 'آخر تعديل وفق الترويسة' : 'Last modified per response header', header(page, 'last-modified'));
  if (contentAvailable) {
    metadata('title', ar ? 'العنوان' : 'Title', details.title);
    metadata('language', ar ? 'اللغة المعلنة' : 'Declared page language', details.language);
    metadata('identity', ar ? 'اسم الجهة المعلن' : 'Declared organisation name', details.identity);
    metadata('page_date', ar ? 'التاريخ الذي تعرضه الصفحة' : 'Date reported by the page', details.pageDate);
  }
  for (const hop of result.redirects) {
    if (!result.reads.some(read => read.page.url === hop.to)) continue;
    const changed = !sameSite(hop.from, hop.to);
    const note = changed ? ar ? ' · تغيّر النطاق' : ' · different host' : '';
    add(`HTTP ${hop.status} · ${hop.from} → ${hop.to}${note}`, hop.from, hop.fetchedAt, '', { kind: 'redirect', status: hop.status, to: hop.to });
  }
  for (const linked of diagnostic.links) {
    const observation = linked.reads.at(-1);
    if (observation) add(`HTTP ${observation.page.status} · ${observation.page.url}`, observation.page.url, observation.fetchedAt, '', { kind: 'http_status', status: observation.page.status });
  }
  if (diagnostic.prior && diagnostic.contentHash) {
    const same = diagnostic.prior.sourceHash === diagnostic.contentHash;
    const label = same ? ar ? 'تطابق بصمة القراءة المفهرسة' : 'Matches the indexed read' : ar ? 'تختلف بصمة القراءة المفهرسة' : 'Differs from the indexed read';
    metadata('content_hash', `${label} (${diagnostic.prior.fetchedAt})`, diagnostic.contentHash);
  }
  return finish(result.failure || needsContent && !matched ? 'partial' : 'completed');
}
