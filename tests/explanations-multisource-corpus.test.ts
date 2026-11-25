import type { SearchProvider } from '@mohassan/browser';
import { expect, it } from 'vitest';
import type { EvidenceSpan, WritingSource } from '../apps/server/src/assistant/writing/evidence.js';
import { alignClaims } from '../apps/server/src/assistant/writing/multisource/alignment.js';
import { extractClaims } from '../apps/server/src/assistant/writing/multisource/claims.js';
import { gatherExplanationSources, sourceIdentity } from '../apps/server/src/assistant/writing/multisource/gather.js';
import { renderExtractiveWriting } from '../apps/server/src/assistant/writing/render.js';
import { parseExtractiveWriting } from '../apps/server/src/assistant/writing/request.js';
import caseData from './fixtures/explanations-multisource/cases.json';
import pageData from './fixtures/explanations-multisource/pages.json';

interface Quote { url: string; quote: string }
interface DevelopmentCase {
  id: string;
  language: 'en' | 'ar';
  kind: 'why' | 'how' | 'comparison';
  question: string;
  sourceUrls: string[];
  keyClaims: (Quote & { alternatives?: Quote[] })[];
  conflicts?: { left: Quote; right: Quote }[];
}

const cases: DevelopmentCase[] = caseData as DevelopmentCase[];
const urlKey = (url: string) => {
  const address = new URL(url);
  address.hash = '';
  return address.href;
};
const pages = new Map<string, WritingSource>(pageData.map(page => [urlKey(page.url), { ...page, url: new URL(page.url).href }]));
const matches = (span: EvidenceSpan, mark: Quote) => Boolean(span.source.url
  && urlKey(span.source.url) === urlKey(mark.url) && span.text.includes(mark.quote));

function verifyCitations(text: string, evidence: EvidenceSpan[], read: ReadonlyMap<string, WritingSource>): number {
  const displayed = [...text.matchAll(/«([\s\S]*?)» \[(?:\\.|[^\]\\])*\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/gu)];
  expect(displayed).toHaveLength(evidence.length);
  const unmatched = [...evidence];
  for (const [, quote, href] of displayed) {
    const displayedQuote = quote.replace(/\\([\\\x60*_[\]<>|#~!])/gu, '$1');
    const url = urlKey(href);
    const index = unmatched.findIndex(span => span.source.url && urlKey(span.source.url) === url
      && span.text.replace(/\r?\n/gu, ' ') === displayedQuote);
    expect(index, `Cited quote at ${url}`).toBeGreaterThanOrEqual(0);
    const [span] = unmatched.splice(index, 1);
    const page = read.get(url);
    expect(page, `Read receipt for ${url}`).toBeDefined();
    expect(page?.text.slice(span.start, span.end)).toBe(span.text);
  }
  return displayed.length;
}

it('replays the bilingual development sources and verifies every rendered citation', async () => {
  expect(cases.length).toBeGreaterThanOrEqual(60);
  expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
  expect(new Set(cases.map(item => item.question)).size).toBe(cases.length);
  const metrics = new Map<string, { questions: number; marked: number; covered: number; cited: number; seeds: number; detected: number; unexpected: number }>();
  for (const fixture of cases) {
    const task = parseExtractiveWriting(fixture.question);
    expect(task, fixture.id).toMatchObject({ language: fixture.language, source: { kind: 'search' },
      ...(fixture.kind === 'comparison' ? { kind: 'comparison' } : { kind: 'explanation', intent: fixture.kind }) });
    if (!task || task.source.kind !== 'search') throw new Error(`Invalid development fixture ${fixture.id}`);
    const { query } = task.source;
    const sourceUrls = fixture.sourceUrls.map(url => pages.get(urlKey(url))!.url!);
    const provider: SearchProvider = { name: 'explanation-fixtures', search: async (_query, limit) => sourceUrls.slice(0, limit)
      .map(url => ({ url, title: pages.get(urlKey(url))!.title, snippet: 'Search result snippets are not evidence.' })) };
    const signal = new AbortController().signal;
    const read = new Map<string, WritingSource>();
    const sources = await gatherExplanationSources({ query, ownerId: 'development-fixtures', provider, signal,
      search: async limit => (await provider.search(query, limit, signal)).map(hit => hit.url), read: async url => {
        const page = pages.get(urlKey(url));
        if (page) read.set(urlKey(url), page);
        return page ?? null;
      } });
    expect(new Set(sources.map(sourceIdentity)).size, fixture.id).toBeGreaterThanOrEqual(3);
    const reply = renderExtractiveWriting(task, sources);
    const cited = verifyCitations(reply.text, reply.evidence, read);
    expect(reply.text).not.toContain('Search result snippets');
    expect(fixture.keyClaims.length, fixture.id).toBeGreaterThan(0);
    const allMarks = [...fixture.keyClaims.flatMap(mark => [mark, ...(mark.alternatives ?? [])]),
      ...(fixture.conflicts ?? []).flatMap(pair => [pair.left, pair.right])];
    for (const mark of allMarks) {
      const page = read.get(urlKey(mark.url));
      expect(page, `${fixture.id} expected read of ${mark.url}`).toBeDefined();
      expect(page?.text, fixture.id).toContain(mark.quote);
    }
    const covered = fixture.keyClaims.filter(mark => [mark, ...(mark.alternatives ?? [])]
      .some(candidate => reply.evidence.some(span => matches(span, candidate)))).length;
    const { conflicts } = alignClaims(sources.flatMap(extractClaims));
    const matchesConflict = (pair: NonNullable<DevelopmentCase['conflicts']>[number], conflict: typeof conflicts[number]) =>
      matches(conflict.left.span, pair.left) && matches(conflict.right.span, pair.right)
      || matches(conflict.right.span, pair.left) && matches(conflict.left.span, pair.right);
    const key = `${fixture.language}/${fixture.kind}`;
    const stats = metrics.get(key) ?? { questions: 0, marked: 0, covered: 0, cited: 0, seeds: 0, detected: 0, unexpected: 0 };
    stats.questions++;
    stats.marked += fixture.keyClaims.length;
    stats.covered += covered;
    stats.cited += cited;
    stats.seeds += fixture.conflicts?.length ?? 0;
    stats.detected += (fixture.conflicts ?? []).filter(pair => conflicts.some(conflict => matchesConflict(pair, conflict))).length;
    stats.unexpected += conflicts.filter(conflict => !(fixture.conflicts ?? []).some(pair => matchesConflict(pair, conflict))).length;
    metrics.set(key, stats);
  }
  expect(metrics.size).toBe(6);
  for (const stats of metrics.values()) {
    expect(stats.questions).toBeGreaterThanOrEqual(10);
    expect(stats.cited).toBeGreaterThan(0);
  }
  expect([...metrics.values()].some(stats => stats.seeds > 0)).toBe(true);
  console.info(JSON.stringify({ event: 'multisource_explanations_development', citationValidity: 'all rendered citations verified',
    metrics: Object.fromEntries([...metrics].sort()) }));
});
