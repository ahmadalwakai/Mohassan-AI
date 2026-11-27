import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BrowserError, SafeNetwork, SearchEngine, compileQuery, excludesWikipedia, isPublicAddress, matchesSearchPhrases, publicSearchScan,
  publicSearchText, safeResumeUrl, webFreshnessText, type AgentPage, type SearchHit, type SearchProvider,
} from '@mohassan/browser';
import type { CommandChatConfig } from '../../command-chat.js';
import { reviewBrowserRequestScope } from '../browser-request-scope.js';
import { reviewExplicitPublicBrowserQuery } from '../browser-public-query.js';
import {
  excerpt, isLiveWebQuestion, pageAnswer, parseHands, plainTitle, PROVIDER_SPACING_MS, readableOverHttp, topicCoverage, topicWords,
} from '../hands.js';
import { extractPublicSearchQueries, mergePublicQueryTerms, reviewGeneratedPublicQuery } from '../public-query-provenance.js';
import type { ReplyConstraints } from '../reply-directive.js';
import { parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText, reviewPublicProjection } from '../request-scope.js';
import type { PlanAttempt, PlanToolResult } from './executor.js';
import type { PlanStep, PlanValue, ResolvedStepInputs } from './types.js';
import { webFigure, webMeasureKind } from './web-figures.js';
import { planReadMeasure, planReadTarget } from './web-target.js';

export interface PlanWebToolContext {
  ownerId: string;
  request: string;
  replyConstraints?: ReplyConstraints;
  search?: SearchProvider;
  readPage?: CommandChatConfig['readPage'];
  openPage?: (url: string, signal: AbortSignal) => Promise<AgentPage>;
  onWebAction?(tool: 'open' | 'read' | 'search', outcome: 'completed' | 'failed'): void;
  networkPolicy?: CommandChatConfig['networkPolicy'];
  active(): Promise<void>;
  signal: AbortSignal;
  scrub(text: string): string;
}

const ENTITY_OPERAND = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .’'&-]{0,119}$/u;
const OFFICIAL = /\bofficial\b|(?:رسمي|الرسمي)/iu;
const LIVE_EXPLICIT = /\b(?:today|current|now|latest)\b|(?:اليوم|الآن|حاليًا|حاليا|أحدث)/iu;
const MAX_SEARCH_RESULTS = 6;
const LOCAL_HOST = /(?:^|\.)(?:localhost|local|internal|home|onion)$/iu;
const ENTITY_NAME = String.raw`([\p{L}\p{M}][\p{L}\p{M}'’\-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’\-]*){0,4}?)`;
const ENTITY_END = String.raw`(?=\s*(?:[.,;،؛،!؟\n]|$)|\s+(?:and|which|located|since|from|وهي|وهو|وتقع|التي|الذي)\b)`;
const ENTITY_RELATIONS: ReadonlyArray<readonly [RegExp, readonly RegExp[]]> = [
  [/\bcapital\b|عاصم[ةه]/iu, [
    new RegExp(String.raw`\bcapital(?:\s+city)?(?:\s+of\s+[^.,;]{1,100}?)?\s+is\s+${ENTITY_NAME}${ENTITY_END}`, 'iu'),
    new RegExp(String.raw`(?:^|[.!?]\s+)${ENTITY_NAME}\s+is\s+(?:the\s+)?capital\b`, 'iu'),
    new RegExp(String.raw`عاصم[ةه](?:ها)?\s+(?:\p{L}+\s+){0,2}?(?:(?:هي|هو)\s+)${ENTITY_NAME}${ENTITY_END}`, 'iu'),
    new RegExp(String.raw`(?:^|[.!؟]\s+)${ENTITY_NAME}\s+(?:(?:هي|هو)\s+)?عاصم[ةه](?!\p{L})`, 'iu'),
  ]],
  [/\b(?:founder|inventor|writer|author|wrote|winner|won)\b|(?:مؤسس|مخترع|مؤلف|كاتب|فائز|فاز)/iu, [
    new RegExp(String.raw`\b(?:founded|invented|written|won)\s+by\s+${ENTITY_NAME}${ENTITY_END}`, 'iu'),
    new RegExp(String.raw`\b(?:founder|inventor|author|writer|winner)(?:\s+of\s+[^.,;]{1,100}?)?\s+is\s+${ENTITY_NAME}${ENTITY_END}`, 'iu'),
    new RegExp(String.raw`(?:المؤسس|المؤلف|الفائز)\s+(?:(?:هو|هي)\s+)${ENTITY_NAME}${ENTITY_END}`, 'iu'),
  ]],
];

function entityRelation(question: string): readonly RegExp[] | undefined {
  return ENTITY_RELATIONS.find(([pattern]) => pattern.test(question))?.[1];
}

function entityRead(question: string, lines: readonly string[]): string | undefined {
  return lines.flatMap(line => (entityRelation(question) ?? []).map(pattern => pattern.exec(line)?.[1]?.trim()))
    .find(name => name && ENTITY_OPERAND.test(name));
}

function relatedQuotes(page: AgentPage, question: string): string[] {
  const terms = topicWords(question);
  if (!terms.length) return [];
  return page.text.split(/(?<=[.!?؟])\s+|\n/u).map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 400 && topicCoverage(line, terms) > 0
      && topicCoverage(`${page.title} ${line}`, terms) >= Math.min(terms.length, 2)).slice(0, 20);
}

function measuredQuote(page: AgentPage, question: string, quotes: readonly string[]) {
  const measure = webMeasureKind(question);
  const terms = topicWords(question);
  const candidates = new Set([...quotes, ...relatedQuotes(page, question)]);
  if (measure) for (const line of page.text.split(/(?<=[.!?؟])\s+|\n/u)) {
    const quote = line.trim();
    if (quote.length <= 400 && webMeasureKind(quote) === measure) candidates.add(quote);
  }
  const figures = [...candidates].flatMap(quote => {
    const figure = webFigure(question, quote);
    if (!figure) return [];
    const coverage = topicCoverage(quote, terms);
    const sameMeasure = measure !== null && webMeasureKind(quote) === measure;
    return coverage || sameMeasure ? [{ figure, quote, score: coverage * 2 + Number(sameMeasure) }] : [];
  }).sort((left, right) => right.score - left.score);
  const best = figures[0];
  if (!best || figures.some(other => other.score === best.score
    && (other.figure.value !== best.figure.value || other.figure.unit !== best.figure.unit))) return null;
  return best;
}

function citation(title: string, url: string): string {
  const label = title.replace(/[\[\]<>\\]/gu, '').trim().slice(0, 160) || new URL(url).hostname;
  return `[${label}](${url})`;
}

function observedPage(source: Exclude<Awaited<ReturnType<NonNullable<PlanWebToolContext['readPage']>>>, 'disallowed' | null>): AgentPage {
  return {
    id: source.url, url: source.url, title: source.title, text: source.text, elements: [],
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 },
    hash: createHash('sha256').update(source.text).digest('hex'), observedAt: source.fetchedAt ?? new Date().toISOString(), documentStatus: source.status,
  };
}

function parsedSearch(request: string): Extract<NonNullable<ReturnType<typeof parseHands>>[number], { kind: 'search' }> | undefined {
  const steps = parseHands(request);
  return steps?.length === 1 && steps[0]?.kind === 'search' ? steps[0] : undefined;
}

const lookupText = (request: string) => request.replace(/^(?:(?:please|kindly|من فضلك|لو سمحت)[،,\s]+)?(?:find\s+(?:out\s+)?(?:for\s+me\s+)?|(?:دور|فتش|إبحث|أبحث|ابحث)\s+(?:لي\s+)?(?:(?:عن|على|علي)\s+)?)/iu, '').trim();

function allowedOperand(value: PlanValue): string | null {
  if (value.type === 'number' && Number.isFinite(value.value)) return String(value.value);
  if (value.type === 'entity' && ENTITY_OPERAND.test(value.value)) return value.value;
  return null;
}

export function createPlanWebTools(context: PlanWebToolContext) {
  const network = context.networkPolicy || context.search instanceof SearchEngine ? new SafeNetwork(context.networkPolicy) : null;
  const constraints = parseUserRequestConstraints(context.request);
  const searchSources = new Map<string, { hits: SearchHit[]; used: Set<string> }>();
  const readSources = new Map<string, string[]>();
  let searchQueue = Promise.resolve();
  let nextSearchAt = 0;

  const signalOf = (attempt: PlanAttempt) => attempt.signal ?? context.signal;
  const canRead = (request: string) => requestCapabilityAllowed(constraints, 'browser_navigation')
    && requestCapabilityAllowed(constraints, 'browser_action') && reviewBrowserRequestScope(request, 'browser_navigation').allowed;
  const safeUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      const decoded = publicSearchScan(raw);
      if (!safeResumeUrl(raw) || context.scrub(raw) !== raw || publicSearchText(decoded) !== decoded) return null;
      if (extractPublicSearchQueries(url.href).length) return null;
      if (network) return network.validate(url.href).href;
      // Injected transports own their network policy. Retain the request-level
      // vetoes here before giving a declared public destination to a transport.
      const host = url.hostname.replace(/^\[|\]$|\.$/gu, '');
      if (url.protocol !== 'https:' || url.port || (isIP(host) ? !isPublicAddress(host) : !host.includes('.') || LOCAL_HOST.test(host))) return null;
      return url.href;
    } catch { return null; }
  };

  async function readPage(url: string, signal: AbortSignal, live = false): Promise<AgentPage | null | 'disallowed'> {
    await context.active();
    signal.throwIfAborted();
    if (!context.readPage) return null;
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      const page = await context.readPage(url, signal, { live });
      await context.active();
      signal.throwIfAborted();
      if (page === 'disallowed') return 'disallowed';
      if (!page || safeUrl(page.url) !== url || page.status < 200 || page.status >= 300 || page.status === 202
        || !readableOverHttp(page.text)) return null;
      outcome = 'completed';
      return observedPage({ ...page, title: context.scrub(page.title), text: context.scrub(page.text).slice(0, 40_000) });
    } finally {
      context.onWebAction?.('read', outcome);
    }
  }

  async function openPage(url: string, signal: AbortSignal): Promise<boolean> {
    await context.active();
    signal.throwIfAborted();
    if (!context.openPage) return false;
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      const page = await context.openPage(url, signal);
      await context.active();
      signal.throwIfAborted();
      const status = page.documentStatus;
      if (safeUrl(page.url) !== url || status === undefined || status < 200 || status >= 300 || status === 202
        || Object.values(page.signals).some(Boolean)) return false;
      outcome = 'completed';
      return true;
    } finally {
      context.onWebAction?.('open', outcome);
    }
  }

  async function searchProvider(query: string, signal: AbortSignal): Promise<SearchHit[]> {
    const port = context.search!;
    const search = async () => {
      await context.active();
      signal.throwIfAborted();
      let outcome: 'completed' | 'failed' = 'failed';
      try {
        const hits = await port.search(query, MAX_SEARCH_RESULTS, signal, { ownerId: context.ownerId });
        await context.active();
        signal.throwIfAborted();
        outcome = 'completed';
        return hits;
      } finally {
        context.onWebAction?.('search', outcome);
      }
    };
    if (!(port instanceof SearchEngine)) return search();
    // The shared provider rejects overlapping admissions and holds a one-second cooldown.
    const task = searchQueue.then(async () => {
      const wait = nextSearchAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      try { return await search(); }
      finally { nextSearchAt = Date.now() + PROVIDER_SPACING_MS; }
    });
    searchQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  function queryFor(step: PlanStep, inputs: ResolvedStepInputs): { raw: string; request: string; allowed: string[] } | null {
    const clause = requestScopeActionText(step.text);
    const originalOperand = parsedSearch(clause);
    if (originalOperand?.here) return null;
    const operands: string[] = [];
    let request = clause;
    if (inputs.references.length) {
      request = step.inputs.text;
      for (const { reference, value } of inputs.references.toReversed()) {
        const operand = allowedOperand(value);
        const { start, end } = reference;
        if (operand === null || start === undefined || end === undefined) return null;
        operands.push(operand);
        const phrase = step.inputs.text.slice(start, end);
        const prefix = /^(عن|من)(?:ها|ه|هما)$/u.exec(phrase)?.[1];
        request = request.slice(0, start) + (prefix ? `${prefix} ${operand}` : operand) + request.slice(end);
      }
    }
    const parsed = parsedSearch(request);
    const lookup = lookupText(request);
    const measuredLookup = step.output === 'number' && webMeasureKind(lookup) && !originalOperand?.site;
    const raw = measuredLookup
      ? (parsed?.query ?? (lookup !== request ? lookup : lookupText(step.publicQuery ?? request))).replace(/^(?:the|a|an)\s+/iu, '').replace(/[.!?؟]+$/u, '')
      : parsed?.query ?? (inputs.references.length ? lookup : lookupText(step.publicQuery ?? request));
    const host = originalOperand?.site ? URL.parse(originalOperand.site.url)?.hostname : null;
    // Scope comes only from the user's clause, never from a referenced entity or page.
    const scoped = host ? `${raw} site:${host}` : raw;
    const allowed = mergePublicQueryTerms([], [...operands, host ?? null].filter((item): item is string => item !== null));
    return { raw: scoped.trim(), request, allowed };
  }

  function allowedQuery(step: PlanStep, renderedRequest: string, query: string, allowed: string[]): boolean {
    const request = requestScopeActionText(step.text);
    if (!query || query.length > 500 || context.scrub(query) !== query) return false;
    // Resolve only the declared slots. Review the clause as written first, then the clause with its public operands.
    const source = reviewPublicProjection(request.replace(/\.$/u, ''), query);
    const rendered = request !== renderedRequest && source.source.scope === 'unknown'
      && reviewPublicProjection(renderedRequest.replace(/\.$/u, ''), query).eligible;
    return (source.eligible || rendered || reviewExplicitPublicBrowserQuery(request, query).eligible)
      && reviewGeneratedPublicQuery(request, query, allowed).eligible;
  }

  function validHits(raw: SearchHit[], query: ReturnType<typeof compileQuery>, live: boolean): SearchHit[] {
    const seen = new Set<string>();
    return raw.slice(0, MAX_SEARCH_RESULTS).flatMap(hit => {
      const url = safeUrl(hit.url);
      if (!url || seen.has(url)) return [];
      const hostname = new URL(url).hostname.replace(/\.$/u, '');
      const wiki = hostname === 'wikipedia.org' || hostname.endsWith('.wikipedia.org');
      if ((live || excludesWikipedia(query)) && wiki || query.sites.length && !query.sites.some(site => hostname === site || hostname.endsWith(`.${site}`))) return [];
      const title = plainTitle(context.scrub(hit.title)).trim().slice(0, 200) || hostname;
      const snippet = context.scrub(hit.snippet).slice(0, 2_000);
      if (!matchesSearchPhrases(query, title, snippet)) return [];
      seen.add(url);
      return [{ title, url, snippet }];
    });
  }

  function resultFromPage(step: PlanStep, page: AgentPage, question: string): PlanToolResult {
    const lang = context.replyConstraints?.lang ?? (/\p{Script=Arabic}/u.test(step.text) ? 'ar' : 'en');
    const answer = pageAnswer(page, question, lang);
    if (answer.missing.length) return { ok: false, reason: 'no_result' };
    const quotes = answer.parts.flatMap(part => part.quotes);
    if (step.output === 'number') {
      const measured = measuredQuote(page, question, quotes);
      if (!measured) return { ok: false, reason: 'no_result' };
      return { ok: true, value: { type: 'number', ...measured.figure, label: page.title },
        text: `${measured.quote}\n${citation(page.title, page.url)}`,
        evidence: { kind: 'source', label: page.title, reference: page.url, independent: true } };
    }
    if (step.output === 'entity') {
      const typedQuotes = [...new Set([...quotes, ...relatedQuotes(page, question)])];
      const name = entityRead(question, typedQuotes);
      if (!name) return { ok: false, reason: 'no_result' };
      return { ok: true, value: { type: 'entity', value: name, label: name }, text: `${name}\n${citation(page.title, page.url)}`,
        evidence: { kind: 'source', label: page.title, reference: page.url, independent: true } };
    }
    if (step.output !== 'text') return { ok: false, reason: 'invalid_result' };
    if (!quotes.length) return { ok: false, reason: 'no_result' };
    const text = quotes.join('\n');
    const displayed = context.replyConstraints?.brief ? quotes[0] : text;
    return { ok: true, value: { type: 'text', value: text }, text: `${displayed}\n${citation(page.title, page.url)}`,
      evidence: { kind: 'source', label: page.title, reference: page.url, independent: true } };
  }

  async function search(step: PlanStep, inputs: ResolvedStepInputs, attempt: PlanAttempt): Promise<PlanToolResult> {
    if (!context.search) return { ok: false, reason: 'unavailable' };
    if (!step.publicInput || !requestCapabilityAllowed(constraints, 'public_search')) return { ok: false, reason: 'restricted' };
    const proposed = queryFor(step, inputs);
    if (!proposed || !allowedQuery(step, proposed.request, proposed.raw, proposed.allowed)) return { ok: false, reason: 'restricted' };
    const signal = signalOf(attempt);
    const state = searchSources.get(step.id) ?? { hits: [], used: new Set<string>() };
    searchSources.set(step.id, state);
    const qualifier = compileQuery(proposed.raw);
    const live = isLiveWebQuestion(proposed.raw) || qualifier.timeSensitive;
    const compact = lookupText(proposed.raw).replace(/^(?:(?:what|which|how much|who)\s+(?:is|are|was|were)\s+)?(?:the|a|an)\s+|^(?:ما هو|ما هي|ما|كم)\s+/iu, '')
      .replace(/^(?:what|which|how much|who)\s+(?:is|are|was|were)\s+/iu, '');
    // Narrow only the question scaffolding. Keep currencies, time qualifiers, domains and literal phrases intact.
    if (attempt.strategy === 'narrower_query' && compact === proposed.raw) return { ok: false, reason: 'no_result' };
    const query = attempt.strategy === 'narrower_query' ? compact : proposed.raw;
    if (!allowedQuery(step, proposed.request, query, proposed.allowed)) return { ok: false, reason: 'restricted' };
    if (attempt.strategy !== 'another_source' || !state.hits.some(hit => !state.used.has(hit.url))) {
      try {
        const candidates = await searchProvider(query, signal);
        const next = validHits(candidates, qualifier, live);
        state.hits = [...state.hits, ...next.filter(hit => !state.hits.some(prior => prior.url === hit.url))];
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof BrowserError && error.code === 'RESEARCH_SEARCH_UNAVAILABLE') return { ok: false, reason: 'no_result' };
        throw error;
      }
    }

    if (!state.hits.length) return { ok: false, reason: 'no_result' };
    const topical = topicWords(qualifier.question);
    const hits = state.hits.filter(hit => !topical.length || topicCoverage(`${hit.title} ${hit.snippet}`, topical) > 0);
    if (!hits.length) return { ok: false, reason: 'no_result' };
    if (step.output === 'list') {
      return { ok: true, value: { type: 'list', value: hits.map(hit => hit.title) }, text: hits.map(hit => `- ${citation(hit.title, hit.url)}`).join('\n'),
        evidence: { kind: 'source', label: 'Search results', independent: false } };
    }
    if (step.output === 'entity' && !entityRelation(proposed.raw)) {
      // Only suggest an official source when the available location identifies itself that way.
      const hit = hits.find(item => !OFFICIAL.test(proposed.raw) || OFFICIAL.test(item.title));
      if (!hit) return { ok: false, reason: 'no_result' };
      return { ok: true, value: { type: 'entity', value: hit.title, label: hit.title, url: hit.url }, text: citation(hit.title, hit.url),
        evidence: { kind: 'source', label: hit.title, reference: hit.url, independent: false } };
    }

    if (!context.readPage) return { ok: false, reason: 'unavailable' };
    if (!canRead(step.text)) return { ok: false, reason: 'restricted' };
    const hit = hits.find(item => !state.used.has(item.url));
    if (!hit) return { ok: false, reason: 'no_result' };
    state.used.add(hit.url);
    const page = await readPage(hit.url, signal, live);
    if (!page || page === 'disallowed') return { ok: false, reason: 'no_result' };
    return resultFromPage(step, page, qualifier.question);
  }

  async function read(step: PlanStep, inputs: ResolvedStepInputs, attempt: PlanAttempt): Promise<PlanToolResult> {
    const measurement = !inputs.references.length ? planReadMeasure(step.text) : null;
    const navigate = measurement?.navigate && step.output === 'number';
    if (!context.readPage || navigate && !context.openPage) return { ok: false, reason: 'unavailable' };
    if (!step.publicInput || !canRead(step.text)) return { ok: false, reason: 'restricted' };
    const literal = inputs.references.length ? null : planReadTarget(step.text);
    const admitted = inputs.references.flatMap(({ reference, value }) => {
      const candidates = searchSources.get(reference.stepId)?.hits ?? [];
      const preferred = value.type === 'entity' ? value.url : undefined;
      const urls = preferred ? [preferred, ...candidates.map(hit => hit.url)] : candidates.map(hit => hit.url);
      return urls.filter(url => candidates.some(hit => hit.url === url));
    });
    const urls = literal ? [literal] : [...new Set(admitted)];
    const previouslyRead = readSources.get(step.id) ?? [];
    readSources.set(step.id, previouslyRead);
    const raw = urls.find(url => !previouslyRead.includes(url));
    if (!raw) return { ok: false, reason: 'missing_input' };
    previouslyRead.push(raw);
    const url = safeUrl(raw);
    if (!url) return { ok: false, reason: 'restricted' };
    const signal = signalOf(attempt);
    const page = await readPage(url, signal, LIVE_EXPLICIT.test(webFreshnessText(step.text)));
    if (page === 'disallowed') return { ok: false, reason: literal ? 'restricted' : 'no_result' };
    // Use the unauthenticated reader for the value and the browser observation
    // for the explicit navigation. A signed-in page is not a public operand.
    if (navigate && !await openPage(url, signal)) return { ok: false, reason: 'no_result' };
    if (!page) return { ok: false, reason: 'no_result' };
    if (step.output === 'number' && measurement) return resultFromPage(step, page, measurement.question);
    const lang = /\p{Script=Arabic}/u.test(step.text) ? 'ar' : 'en';
    const requested = pageAnswer(page, step.text, lang);
    if (requested.missing.length) return { ok: false, reason: 'no_result' };
    const quotes = requested.parts.some(part => part.label)
      ? requested.parts.flatMap(part => part.quotes) : excerpt(page, 0, 3500).lines;
    const value = quotes.join('\n').trim();
    if (!value) return { ok: false, reason: 'no_result' };
    return { ok: true, value: { type: 'text', value }, text: `${value}\n\n${citation(page.title, page.url)}`,
      evidence: { kind: 'observation', label: page.title || 'Read public page', reference: page.url, independent: true } };
  }

  return { search, read };
}
