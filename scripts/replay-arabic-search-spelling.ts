import { execFileSync } from 'node:child_process';
import type { SearchHit } from '../packages/browser/src/research.js';
import { compileQuery, rankResults } from '../packages/browser/src/search/ranking.js';

// Run from a checkout with the V2 development object fetched:
// git fetch origin 12cedfe592aab40cdd47ee00d05ea86a6d2bae89
// npx tsx scripts/replay-arabic-search-spelling.ts
// Pinned payload (retrieved 2026-11-27):
// https://github.com/ahmadalwakai/Mohassan-AI/blob/12cedfe592aab40cdd47ee00d05ea86a6d2bae89/tests/fixtures/agent-capability-bench/v2/dev/payload.json
const developmentPayload = '12cedfe592aab40cdd47ee00d05ea86a6d2bae89:tests/fixtures/agent-capability-bench/v2/dev/payload.json';
type RecordedSearch = { query: string; results: SearchHit[] };
type DevelopmentPayload = {
  cases: { language: string; area: string; fixture?: { searches?: RecordedSearch[] } }[];
};
const payload = JSON.parse(execFileSync('git', ['show', developmentPayload], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
})) as DevelopmentPayload;

type Counts = { kept: number; rejected: number };
function replay(question: string, results: SearchHit[], counts: Counts) {
  let query: ReturnType<typeof compileQuery>;
  try {
    query = compileQuery(question);
  } catch (error) {
    if (!(error instanceof Error) || !/^SEARCH_(?:PHRASE_(?:UNCLOSED|INVALID)|QUERY_EMPTY|SITE_INVALID)$/u.test(error.message)) {
      throw error;
    }
    // Queries that fail production validation still count toward the cohort.
    counts.rejected++;
    return;
  }
  const hits = rankResults(query, [{ provider: 'capability-bench-recorded-search', hits: results }], 1);
  if (hits.length) counts.kept++;
}

const summary = {
  cases: 0,
  asWritten: { kept: 0, rejected: 0 },
  informal: { kept: 0, rejected: 0 },
};
for (const item of payload.cases) {
  if (item.language !== 'ar' || (item.area !== 'factual' && item.area !== 'comparison')) continue;
  // Use the first recorded query and its hits once per case. Leave the recorded hits intact.
  const search = item.fixture?.searches?.[0];
  if (!search) continue;
  const informal = search.query.replace(/[ةى](?![\p{M}\p{Cf}]*\p{L})/gu, letter => letter === 'ة' ? 'ه' : 'ي');
  if (informal === search.query) continue;

  summary.cases++;
  replay(search.query, search.results, summary.asWritten);
  replay(informal, search.results, summary.informal);
}
console.log(JSON.stringify(summary, null, 2));
