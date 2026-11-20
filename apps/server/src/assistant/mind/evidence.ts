import { publicSearchText } from '@mohassan/browser';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import type { Claim, Evidence, Frame, MindDeps, MindReply } from './contract.js';
import { missingText, requiresSourceDate, researchText, showBareValue } from './compose.js';
import { boundedQuote, declaredDate, evidenceKeyDomain, extractQuote, isPageInstruction, topicScore, typedNumbers, type ExtractedQuote } from './extract.js';
import { header, inspectSite, readableUrl, readSite, signalUntil, siteHost, withDeadline, type ReadPage, type SiteRead } from './site-check.js';

// حدود الخطة، غير مقيسة كقيم مثلى. القياس على النقل الوهمي في تقرير الدور هـ.
const MAX_QUERIES = 3;
const MAX_SOURCES = 4;
export const EVIDENCE_LIMIT_MS = 25_000;

type Hit = Awaited<ReturnType<MindDeps['search']>>[number];
export type SearchQuote = ExtractedQuote & { evidence: Evidence; host: string };
export interface EvidenceCollection {
  quotes: SearchQuote[];
  queries: string[];
  pages: SiteRead[];
  timedOut: boolean;
}

function searchQuery(frame: Frame): string {
  return frame.focus.join(' ').trim() || frame.text.replace(/https?:\/\/\S+/gu, '').trim();
}

function responseIsUsable(result: SiteRead): boolean {
  const status = result.page?.status;
  return !result.failure && status !== undefined && status >= 200 && status < 300 && status !== 202;
}

function quotePage(result: SiteRead, frame: Frame, official: boolean): SearchQuote | undefined {
  if (!responseIsUsable(result) || !result.page) return undefined;
  const page = result.page;
  const details = inspectSite(page);
  const pageDate = details.pageDate ?? declaredDate(header(page, 'last-modified')) ?? null;
  const source = official ? 'site' : 'web';
  if (requiresSourceDate(frame, source) && !pageDate) return undefined;
  const extracted = extractQuote(details.visibleText ?? page.text, frame);
  if (!extracted) return undefined;
  return {
    ...extracted,
    host: siteHost(page.url),
    evidence: {
      id: '', source, url: page.url, fetchedAt: result.reads.at(-1)?.fetchedAt,
      pageDate, quote: extracted.quote, value: extracted.value, official,
    },
  };
}

function relevantSearchUrls(hits: readonly Hit[], preferred: readonly string[]): string[] {
  const urls = [...new Set(hits.flatMap(hit => {
    const url = readableUrl(hit.url);
    return url ? [url] : [];
  }))];
  return urls.sort((a, b) => Number(preferred.includes(siteHost(b))) - Number(preferred.includes(siteHost(a))));
}

type ResearchOptions = { skipDirect?: boolean; deadline?: number };

export async function collectEvidence(
  frame: Frame, deps: MindDeps, signal: AbortSignal, options: ResearchOptions = {},
): Promise<EvidenceCollection> {
  const collection: EvidenceCollection = { quotes: [], queries: [], pages: [], timedOut: false };
  if (frame.personal) return collection;
  signal.throwIfAborted();
  const deadline = Math.min(performance.now() + EVIDENCE_LIMIT_MS, options.deadline ?? Infinity);
  const scope = signalUntil(signal, deadline);
  const expired = () => scope.aborted || performance.now() >= deadline;
  const direct = [...new Set(frame.urls.flatMap(url => readableUrl(url) ?? []))].slice(0, MAX_SOURCES);
  const preferred = direct.map(siteHost);
  const allSeen = new Set<string>();
  const finishedHosts = new Set<string>();
  const read = async (urls: string[], official: boolean) => {
    if (expired()) return;
    const selected = new Set<string>();
    const batch = urls.filter(url => {
      const host = siteHost(url);
      if (allSeen.has(url) || finishedHosts.has(host) || selected.has(host)) return false;
      selected.add(host);
      return true;
    }).slice(0, MAX_SOURCES - allSeen.size);
    batch.forEach(url => allSeen.add(url));
    const outcomes = await Promise.all(batch.map(url => readSite(url, deps, signal, deadline)));
    for (const result of outcomes) {
      collection.pages.push(result);
      const candidate = quotePage(result, frame, official);
      if (!candidate || finishedHosts.has(candidate.host)) continue;
      candidate.evidence.id = `research-${collection.quotes.length}`;
      collection.quotes.push(candidate);
      finishedHosts.add(candidate.host);
    }
  };

  if (options.skipDirect && direct[0]) allSeen.add(direct[0]);
  await read(direct, true);
  if (collection.quotes.length || expired()) {
    signal.throwIfAborted();
    collection.timedOut = expired();
    return collection;
  }
  const query = searchQuery(frame);
  if (!query) return collection;
  // Reissue an empty search once if there is no named public host to focus the next request.
  const queries = preferred.length ? [query, `${query} site:${preferred[0]}`] : [query, query];
  for (const next of queries.slice(0, MAX_QUERIES)) {
    if (expired() || allSeen.size >= MAX_SOURCES) break;
    collection.queries.push(next);
    let hits: Hit[];
    try { hits = await withDeadline(scope, () => deps.search(next, MAX_SOURCES, scope)); }
    catch {
      signal.throwIfAborted();
      continue;
    }
    const urls = relevantSearchUrls(hits, preferred);
    if (!urls.length) continue;
    await read(urls, false);
    if (collection.quotes.length) break;
  }
  signal.throwIfAborted();
  collection.timedOut = expired();
  return collection;
}

export type EvidenceAgreement = 'confirmed' | 'single_source' | 'conflict' | 'not_found';

type PublicationRead = SiteRead | ReadPage;
function canonicalHost(page: ReadPage): string | undefined {
  if (!page.html) return undefined;
  const nodes: Html.Node[] = [parse(page.html)];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ('tagName' in node && node.tagName === 'link' && /(?:^|\s)canonical(?:\s|$)/iu.test(node.attrs.find(attr => attr.name === 'rel')?.value ?? '')) {
      const href = node.attrs.find(attr => attr.name === 'href')?.value;
      const target = href && readableUrl(href, page.url);
      if (target) return siteHost(target);
    }
    if ('childNodes' in node) nodes.push(...node.childNodes);
  }
  return undefined;
}

function publication(item: Evidence, pages: readonly PublicationRead[]) {
  const eligible = pages.flatMap(value => 'reads' in value
    ? value.reads.map(({ page, fetchedAt }) => ({ page, fetchedAt })) : [{ page: value, fetchedAt: value.fetchedAt }]);
  const candidates = eligible.filter(({ page }) => readableUrl(page.url) === item.url && page.status >= 200 && page.status < 300 && page.status !== 202);
  const receipt = candidates.find(({ fetchedAt }) => fetchedAt && fetchedAt === item.fetchedAt)
    ?? candidates.find(({ fetchedAt }) => !fetchedAt);
  const page = receipt?.page;
  const identity = page && inspectSite(page).identity?.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ');
  const canonical = page && canonicalHost(page);
  const hosts = [siteHost(item.url!), ...(canonical ? [canonical] : [])];
  return { identity, hosts: hosts.map(host => host.replace(/\.$/u, '')) };
}

export function independentSources(first: Evidence, second: Evidence, pages: readonly PublicationRead[]): boolean {
  if (!first.url || !second.url) return false;
  const a = publication(first, pages), b = publication(second, pages);
  if (a.identity && a.identity === b.identity) return false;
  return a.hosts.every(left => b.hosts.every(right => left !== right && !left.endsWith(`.${right}`) && !right.endsWith(`.${left}`)));
}

export function classifyEvidence(quotes: readonly SearchQuote[], pages: readonly PublicationRead[] = []): EvidenceAgreement {
  if (!quotes.length) return 'not_found';
  const keyed = quotes.filter((quote): quote is SearchQuote & { key: string } => Boolean(quote.key));
  if (new Set(keyed.map(quote => evidenceKeyDomain(quote.key))).size !== 1) return 'single_source';
  const keys = new Set(keyed.map(quote => quote.key));
  const independent = keyed.some((left, index) => keyed.slice(index + 1).some(right => (keys.size === 1 || left.key !== right.key)
    && independentSources(left.evidence, right.evidence, pages)));
  return independent ? keys.size > 1 ? 'conflict' : 'confirmed' : 'single_source';
}

const comparison = /\b(lighter|heavier|longer|shorter|larger|smaller|cheaper|costlier|higher|lower)\b|(أخف|اخف|أثقل|اثقل|أطول|اطول|أقصر|اقصر|أكبر|اكبر|أصغر|اصغر|أرخص|ارخص|أغلى|اغلى|أعلى|اعلى|أقل|اقل)/iu;
const maxComparison = /^(?:heavier|longer|larger|costlier|higher|أثقل|اثقل|أطول|اطول|أكبر|اكبر|أغلى|اغلى|أعلى|اعلى)$/iu;

function literalLabel(sentence: string, name: string): string | undefined {
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${pattern}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').exec(sentence)?.[0];
}

function comparableQuotes(frame: Frame, pages: readonly SiteRead[]): { quotes: SearchQuote[]; selected: string } | undefined {
  if (frame.intent !== 'compare') return undefined;
  const match = comparison.exec(frame.text);
  if (!match) return undefined;
  const tail = frame.text.slice(match.index + match[0].length).replace(/^[\s،,:;]+/u, '').replace(/[؟?!]+$/u, '');
  const candidates = tail.split(/\s+(?:or|versus|vs\.?|أم|ام|أو|او)\s+/iu).map(name => name.replace(/^(?:the\s+|من\s+|بين\s+)/iu, '').trim());
  if (candidates.length !== 2 || candidates.some(name => !name)) return undefined;
  const found = pages.flatMap(result => {
    if (!result.page || !responseIsUsable(result)) return [];
    const page = result.page, details = inspectSite(page);
    const pageDate = details.pageDate ?? declaredDate(header(page, 'last-modified')) ?? null;
    const first = result.reads[0]?.page.url;
    const named = frame.urls.some(url => readableUrl(url) === first);
    const source = named ? 'site' : 'web';
    if (requiresSourceDate(frame, source) && !pageDate) return [];
    return [...new Intl.Segmenter(frame.lang, { granularity: 'sentence' }).segment(details.visibleText ?? page.text)].flatMap(({ segment }) => {
      if (isPageInstruction(segment) || /https?:\/\//iu.test(segment) || publicSearchText(segment) !== segment) return [];
      const values = typedNumbers(segment).filter(value => value.unit !== 'number');
      return candidates.flatMap((name, index) => {
        // A literal full label or a unique proper-name component identifies the quantity's entity.
        const unique = name.split(/\s+/u).filter(word => !literalLabel(candidates[1 - index], word));
        const label = literalLabel(segment, name) ?? unique.map(word => literalLabel(segment, word)).find(word => word && /^\p{Lu}/u.test(word));
        if (!label || values.length !== 1) return [];
        const value = values[0];
        const quote = boundedQuote(segment, value.value);
        if (!quote.includes(label)) return [];
        const evidence: Evidence = {
          id: `comparison-${index}`, source, url: page.url, fetchedAt: result.reads.at(-1)?.fetchedAt,
          quote, value: value.value, pageDate, official: named,
        };
        return [{ index, label, number: value.number, unit: value.unit, quote: {
          quote, value: value.value, key: value.key, score: topicScore(segment, frame.focus), host: siteHost(page.url), evidence,
        } }];
      });
    });
  });
  const a = found.find(item => item.index === 0), b = found.find(item => item.index === 1);
  if (!a || !b || a.unit !== b.unit || a.number === b.number || found.some(item => item.unit !== a.unit || item.number !== (item.index === 0 ? a.number : b.number))) return undefined;
  const selected = (maxComparison.test(match[0]) === (a.number > b.number) ? a : b).label;
  return { quotes: [a.quote, b.quote], selected };
}

export function getComparisonSelection(frame: Frame, pages: readonly SiteRead[]): string | undefined {
  return comparableQuotes(frame, pages)?.selected;
}

type ResearchAnswer = Pick<MindReply, 'status' | 'text' | 'claims' | 'evidence'> & { comparisonReads: SiteRead[] };
export async function answerResearch(
  frame: Frame, deps: MindDeps, signal: AbortSignal, options: ResearchOptions = {},
): Promise<ResearchAnswer> {
  const collection = await collectEvidence(frame, deps, signal, options);
  const compared = comparableQuotes(frame, collection.pages);
  const agreement = compared ? 'single_source' : classifyEvidence(collection.quotes, collection.pages);
  const keyed = collection.quotes.filter(quote => quote.key);
  const selected = compared?.quotes ?? (agreement === 'single_source' ? (keyed.length ? keyed : collection.quotes).slice(0, 1) : keyed);
  const evidence = selected.map(quote => quote.evidence);
  const bare = showBareValue(frame, agreement, evidence, collection.timedOut);
  const value = compared?.selected ?? selected[0]?.value;
  const comparisonReads = collection.pages;
  if (agreement === 'not_found' || bare && !value) {
    const text = missingText(frame.lang, collection.pages.filter(responseIsUsable).length, collection.queries.length);
    return { text, claims: [{ text, status: 'not_found', support: [] }], status: 'blocked', evidence: [], comparisonReads };
  }
  const text = bare ? value! : researchText(frame.lang, agreement, evidence, collection.timedOut, compared?.selected);
  const claim: Claim = { text, status: agreement, support: evidence.map(item => item.id) };
  return { status: agreement === 'confirmed' && !collection.timedOut ? 'completed' : 'partial', text, claims: [claim], evidence, comparisonReads };
}
