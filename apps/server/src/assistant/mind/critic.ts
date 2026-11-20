import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { publicSearchText } from '@mohassan/browser';
import { composeReply, missingText, replyCopy, requiresSourceDate, researchText, showBareValue, siteQuoteText } from './compose.js';
import type { Claim, Evidence, Frame, MindDeps, MindReply, SiteObservation } from './contract.js';
import { getComparisonSelection, independentSources } from './evidence.js';
import { boundedQuote, declaredDate, evidenceKeyDomain, extractQuote, isPageInstruction } from './extract.js';
import { header, inspectSite, readableUrl, siteHost, type SiteRead } from './site-check.js';

type Page = Awaited<ReturnType<MindDeps['read']>>;
type Document = Awaited<ReturnType<NonNullable<MindDeps['knowledge']>>>[number];

export interface CriticContext {
  pages: readonly Page[];
  comparisonReads?: readonly SiteRead[];
  searches?: number;
  trustedLocal?: Pick<MindReply, 'text' | 'claims' | 'evidence' | 'status' | 'question'>;
  indexedReads?: readonly { url: string; sourceHash: string; fetchedAt: string }[];
  startedAt?: Date;
  endedAt?: Date;
  memory?: readonly string[];
  knowledge?: readonly Document[];
}

type CheckedPage = { page: Page; url: string; details: ReturnType<typeof inspectSite> };
type Metadata = Extract<SiteObservation, { kind: 'metadata' }>;

function validUrl(value: string, base?: string): string | null {
  try { return readableUrl(value, base); }
  catch { return null; }
}

const responseHasBody = (page: Page) => page.status >= 200 && page.status < 300 && page.status !== 202;
const urlPattern = /(?:https?:\/\/|www\.)[^\s<>«»"']+/giu;
const publicText = (text: string) => !isPageInstruction(text) && publicSearchText(text) === text;

function allLinksRead(text: string, readUrls: ReadonlySet<string>) {
  return [...text.matchAll(urlPattern)].every(([reference]) => {
    const candidate = /^www\./iu.test(reference) ? `https://${reference}` : reference;
    for (const address of [candidate, candidate.replace(/[.,;!?،؛؟)\]]+$/u, '')]) {
      const url = validUrl(address);
      if (url && readUrls.has(url)) return true;
    }
    return false;
  });
}

function containsValue(text: string, value: string) {
  if (!value) return false;
  const beginsWithWord = /^[\p{L}\p{M}\p{N}]/u;
  const endsWithWord = /[\p{L}\p{M}\p{N}]$/u;
  const arabicThousands = /^،\p{Nd}{3}(?!\p{Nd})/u;
  for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + value.length)) {
    const prefix = text.slice(0, i);
    const suffix = text.slice(i + value.length);
    const before = endsWithWord.test(prefix) && beginsWithWord.test(value);
    const after = beginsWithWord.test(suffix) && endsWithWord.test(value);
    const afterNumericPrefix = /(?:\p{Nd}[.,٫٬]|[−+-])$/u.test(prefix)
      || /\p{Nd}،$/u.test(prefix) && arabicThousands.test(text.slice(i - 1));
    const beforeNumericSuffix = /^[.,٫٬]\p{Nd}/u.test(suffix) || arabicThousands.test(suffix);
    if (/^\p{Nd}/u.test(value) && afterNumericPrefix) continue;
    if (/\p{Nd}$/u.test(value) && beforeNumericSuffix) continue;
    if (!before && !after) return true;
  }
  return false;
}

function readTimeIsValid(value: string | undefined, context: CriticContext) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    && (!context.startedAt || time >= context.startedAt.getTime())
    && (!context.endedAt || time <= context.endedAt.getTime());
}

function metadataValue({ page, details }: CheckedPage, field: Metadata['field']): string | undefined {
  switch (field) {
    case 'protocol': return new URL(page.url).protocol.slice(0, -1).toUpperCase();
    case 'content_type': return header(page, 'content-type');
    case 'last_modified': return header(page, 'last-modified');
    case 'title': return details.title;
    case 'language': return details.language;
    case 'identity': return details.identity;
    case 'page_date': return details.pageDate;
    case 'content_hash': return createHash('sha256').update(page.html || page.text).digest('hex');
  }
}

function matchesNetworkEvidence(item: Evidence, check: CheckedPage, frame: Frame, readUrls: ReadonlySet<string>) {
  const { page, details, url } = check;
  const observation = item.observation;
  if (observation) {
    if (item.source !== 'site' || item.quote || item.value !== undefined) return false;
    if (observation.kind === 'http_status') return page.status === observation.status;
    if (observation.kind === 'redirect') {
      const location = header(page, 'location');
      const destination = validUrl(observation.to);
      return observation.status >= 300 && observation.status < 400 && observation.status === page.status
        && !!destination && readUrls.has(destination) && !!location && validUrl(location, url) === destination;
    }
    return !!observation.value && publicText(observation.value) && metadataValue(check, observation.field) === observation.value;
  }
  if (!responseHasBody(page) || !item.quote || !publicText(item.quote) || boundedQuote(item.quote, item.value) !== item.quote) return false;
  const visible = details.visibleText ?? page.text;
  // inspectSite includes the document title ahead of its visible body. The title has a separate metadata claim.
  const body = page.html && details.title && visible.startsWith(details.title) ? visible.slice(details.title.length).trimStart() : visible;
  if (!body.includes(item.quote) || item.value !== undefined && !containsValue(item.quote, item.value)) return false;
  const actualDate = details.pageDate ?? declaredDate(header(page, 'last-modified'));
  return (!item.pageDate || item.pageDate === actualDate) && (!requiresSourceDate(frame, item.source) || !!item.pageDate);
}

function networkEvidenceIsGrounded(item: Evidence, frame: Frame, context: CriticContext, pages: readonly CheckedPage[], urls: ReadonlySet<string>) {
  if (frame.personal || !['site', 'index', 'web'].includes(item.source) || !item.url || !readTimeIsValid(item.fetchedAt, context)) return false;
  const url = validUrl(item.url);
  return url === item.url && pages.some(page => page.url === url && (page.page.fetchedAt === undefined || page.page.fetchedAt === item.fetchedAt)
    && matchesNetworkEvidence(item, page, frame, urls));
}

function sameResponse(first: Page, second: Page) {
  const address = validUrl(first.url);
  return !!address && address === validUrl(second.url) && first.status === second.status
    && first.html === second.html && first.text === second.text && isDeepStrictEqual(first.headers, second.headers);
}

function comparisonIsObserved(trace: SiteRead, pages: readonly CheckedPage[], context: CriticContext) {
  const final = trace.reads.at(-1);
  if (!final || !trace.page || !sameResponse(trace.page, final.page)) return false;
  const redirects: SiteRead['redirects'] = [];
  for (const [index, read] of trace.reads.entries()) {
    const original = read.page;
    if (!readTimeIsValid(read.fetchedAt, context) || original.fetchedAt !== undefined && original.fetchedAt !== read.fetchedAt) return false;
    if (!pages.some(item => sameResponse(item.page, original) && (item.page.fetchedAt === undefined || item.page.fetchedAt === read.fetchedAt))) return false;

    const next = trace.reads[index + 1]?.page;
    if (!next || next.url === original.url) continue;
    const location = header(original, 'location');
    if (!location || original.status < 300 || original.status >= 400 || validUrl(location, original.url) !== next.url) return false;
    redirects.push({ from: original.url, to: next.url, status: original.status, fetchedAt: read.fetchedAt });
  }
  return isDeepStrictEqual(redirects, trace.redirects);
}

function provedComparison(frame: Frame, pages: readonly CheckedPage[], context: CriticContext) {
  const traces = context.comparisonReads?.filter(trace => !trace.failure && trace.page && responseHasBody(trace.page));
  if (frame.intent !== 'compare' || !traces?.length || !traces.every(trace => comparisonIsObserved(trace, pages, context))) return undefined;
  return getComparisonSelection(frame, traces);
}

function observationTexts(item: Evidence, frame: Frame, snapshots: NonNullable<CriticContext['indexedReads']>): string[] {
  const observation = item.observation;
  if (!observation || !item.url) return [];
  const copy = replyCopy[frame.lang];
  if (observation.kind === 'http_status') {
    const basic = `HTTP ${observation.status} · ${item.url}`;
    return [basic, `${basic} · ${copy.readAt} ${item.fetchedAt}`];
  }
  if (observation.kind === 'redirect') {
    const differentHost = siteHost(item.url) !== siteHost(observation.to);
    return [`HTTP ${observation.status} · ${item.url} → ${observation.to}${differentHost ? ` · ${copy.differentHost}` : ''}`];
  }
  if (observation.field !== 'content_hash') return [`${copy[observation.field]} ${observation.value}`];
  return snapshots.filter(snapshot => snapshot.url === item.url).map(snapshot => {
    const label = snapshot.sourceHash === observation.value ? copy.sameHash : copy.differentHash;
    return `${label} (${snapshot.fetchedAt}) ${observation.value}`;
  });
}

function evidenceKey(frame: Frame, item: Evidence) {
  if (!item.value) return undefined;
  const parsed = extractQuote(item.quote, frame);
  return parsed?.quote === item.quote && parsed.value === item.value ? parsed.key : undefined;
}

function provesAgreement(status: 'confirmed' | 'conflict', frame: Frame, support: readonly Evidence[], pages: readonly Page[]) {
  const verified = support.flatMap(evidence => {
    const key = evidenceKey(frame, evidence);
    return key ? [{ evidence, key }] : [];
  });
  if (verified.length !== support.length || new Set(verified.map(item => evidenceKeyDomain(item.key))).size !== 1) return false;
  if (status === 'confirmed' && new Set(verified.map(item => item.key)).size !== 1) return false;
  return verified.some((first, index) => verified.slice(index + 1).some(second =>
    (status === 'confirmed' || first.key !== second.key) && independentSources(first.evidence, second.evidence, pages)));
}

function matchesCitation(claim: Claim, frame: Frame, support: readonly Evidence[], selection: string | undefined, context: CriticContext, partialReply: boolean) {
  if (claim.status !== 'confirmed' && claim.status !== 'single_source' && claim.status !== 'conflict') return false;
  const [first] = support;
  if (support.some(item => item.observation)) {
    return !frame.valueOnly && claim.status === 'single_source' && support.length === 1 && observationTexts(first, frame, context.indexedReads ?? []).includes(claim.text);
  }
  if ((claim.status === 'confirmed' || claim.status === 'conflict') && !provesAgreement(claim.status, frame, support, context.pages)) return false;

  const supportedSelection = selection && support.some(item => containsValue(item.quote, selection)) ? selection : undefined;
  if (claim.status === 'single_source' && support.length !== 1 && !supportedSelection) return false;
  const partialCitation = partialReply && claim.text === researchText(frame.lang, claim.status, support, true, supportedSelection);
  if (showBareValue(frame, claim.status, support)) {
    return claim.text === (supportedSelection ?? first.value) || partialCitation;
  }
  if (first.source === 'site' && support.length === 1 && claim.status === 'single_source') {
    if (claim.text === siteQuoteText(frame.lang, first, true) || !requiresSourceDate(frame, first.source) && claim.text === siteQuoteText(frame.lang, first)) return true;
  }
  return claim.text === researchText(frame.lang, claim.status, support, false, supportedSelection) || partialCitation;
}

function localEvidenceIsGrounded(item: Evidence, frame: Frame, context: CriticContext) {
  if (item.url || item.observation || !item.quote || !publicText(item.quote)) return false;
  if (frame.personal && item.source !== 'memory') return false;
  if (item.source === 'computed') return true; // Matched independently against the selected calculator's result.
  if (boundedQuote(item.quote, item.value) !== item.quote || item.value !== undefined && !containsValue(item.quote, item.value)) return false;
  if (frame.timeSensitive && !item.pageDate) return false;
  if (item.source === 'memory') return context.memory?.some(value => value.includes(item.quote) && (!item.pageDate || value.includes(item.pageDate))) ?? false;
  if (item.source === 'knowledge') return context.knowledge?.some(value => value.text.includes(item.quote) && (!item.pageDate || value.text.includes(item.pageDate))) ?? false;
  return false;
}

function missingClaims(frame: Frame, context: CriticContext, pages: readonly CheckedPage[]) {
  const count = new Set(pages.filter(({ page }) => responseHasBody(page)).map(({ url }) => url)).size;
  const searches = context.searches;
  const site = frame.urls.length > 0 && !searches;
  return { count, site, searches };
}

// Drops claims and unused evidence. Fixed fallback wording never repeats rejected text.
export function critiqueReply(reply: MindReply, context: CriticContext): MindReply {
  const { frame } = reply;
  const pages = context.pages.flatMap(page => {
    const url = validUrl(page.url);
    return url ? [{ page, url, details: inspectSite(page) }] : [];
  });
  const readUrls = new Set(pages.map(({ url }) => url));
  const selection = provedComparison(frame, pages, context);
  const { count, site, searches } = missingClaims(frame, context, pages);
  const fallbackText = site && !count ? replyCopy[frame.lang].cannotRead : missingText(frame.lang, count, site ? undefined : searches ?? 0);
  const baseline = context.trustedLocal && composeReply({ ...reply, ...context.trustedLocal });
  const trustedEvidence = new Map(baseline?.evidence.map(item => [item.id, item]));
  const invalidIds = new Set<string>();
  const available = new Map<string, Evidence>();
  for (const item of reply.evidence) {
    if (!item.id || available.has(item.id)) invalidIds.add(item.id);
    available.set(item.id, item);
  }
  const claims = reply.claims.filter(claim => {
    if (!claim.text || !publicText(claim.text) || !allLinksRead(claim.text, readUrls)) return false;
    const support = claim.support.flatMap(id => {
      const item = available.get(id);
      return item && !invalidIds.has(id) ? [item] : [];
    });
    if (support.length !== claim.support.length || new Set(claim.support).size !== claim.support.length) return false;
    if (baseline?.claims.some(item => isDeepStrictEqual(item, claim))) {
      if (frame.valueOnly && claim.status !== 'conflict' && support.length && !support.some(item => item.value === claim.text || containsValue(item.quote, claim.text))) return false;
      if (frame.timeSensitive && support.some(item => item.source !== 'computed' && (!item.pageDate || !claim.text.includes(item.pageDate)))) return false;
      return support.every(item => isDeepStrictEqual(item, trustedEvidence.get(item.id)) && localEvidenceIsGrounded(item, frame, context));
    }
    if (claim.status === 'not_found') {
      return !support.length && (claim.text === fallbackText || claim.text === missingText(frame.lang, count));
    }
    return support.length > 0 && support.every(item => networkEvidenceIsGrounded(item, frame, context, pages, readUrls))
      && matchesCitation(claim, frame, support, selection, context, reply.status === 'partial');
  });
  if (!claims.length) {
    return { ...reply, status: 'blocked', question: undefined, text: fallbackText, claims: [{ text: fallbackText, status: 'not_found', support: [] }], evidence: [] };
  }

  const validatedQuestion = reply.status === 'waiting_user' && baseline?.status === 'waiting_user'
    && isDeepStrictEqual(reply.question, baseline.question) && baseline.question?.prompt === claims[0].text;
  const text = claims.map(claim => claim.text).join('\n');
  const rejected = claims.length !== reply.claims.length || text !== reply.text;
  const status = reply.status === 'waiting_user' && !validatedQuestion ? 'blocked'
    : rejected && reply.status === 'completed' ? 'partial' : reply.status;
  const used = new Set(claims.flatMap(claim => claim.support));
  return { ...reply, status, text, claims, evidence: reply.evidence.filter(item => used.has(item.id)), question: validatedQuestion ? baseline.question : undefined };
}
