import { SafeNetwork, type SafeResponse } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { describe, expect, it, vi } from 'vitest';
import { detectGithubAnswerOffer, detectGithubMonitorNeed, githubMonitorSpec } from '../apps/server/src/monitors/sources/github-intent.js';
import {
  GITHUB_API_HOST, GITHUB_BATCH_INTERVAL_MS, GITHUB_BATCH_REQUEST_LIMIT, readGithubMonitor, type GithubMonitorSource,
} from '../apps/server/src/monitors/sources/github.js';
import type { MonitorReadOptions } from '../apps/server/src/monitors/sources.js';
import { githubFixture as fixture } from './fixtures/monitors/github-rest.js';

const at = new Date('2026-11-25T20:00:00.000Z');
const prPath = '/repos/owner/repo/pulls/42';
const PR = 'https://github.com/owner/repo/pull/42';
const success = `Has CI passed for PR 42? ${PR}`;
const prMerge = `When will PR 42 merge? ${PR}`;
const statusPath = (sha: string) => `/repos/owner/repo/commits/${sha}/status?per_page=100&page=1`;
const checksPath = (sha: string) => `/repos/owner/repo/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`;
const clock = () => at.getTime();

function spec(text: string, prior?: string) {
  const need = detectGithubMonitorNeed(text, prior ? [{ role: 'user', text: prior }] : undefined);
  const result = need && githubMonitorSpec(need, at);
  if (!result || result.source.kind !== 'github') throw new Error(`Expected a GitHub monitor for: ${text}`);
  return { ...result, source: result.source } satisfies MonitorSpec & { source: GithubMonitorSource };
}

type RequestOptions = NonNullable<Parameters<SafeNetwork['request']>[1]>;
type Result = { status?: number; body?: unknown; headers?: Record<string, string> };
class FixtureNetwork extends SafeNetwork {
  calls: { path: string; options: RequestOptions }[] = [];
  constructor(private response: (path: string) => Result) { super(); }
  override async request(address: string, options: RequestOptions = {}): Promise<SafeResponse> {
    const url = this.validate(address, options.allowedOrigins);
    const path = `${url.pathname}${url.search}`;
    this.calls.push({ path, options });
    const { status = 200, body, headers = {} } = this.response(path);
    return { status, body: Buffer.from(body === undefined ? '' : JSON.stringify(body)), headers, url: url.href };
  }
}

function options(overrides: Partial<MonitorReadOptions> = {}) {
  return { ownerId: 'owner', reserveHost: vi.fn(async () => null), extendHost: vi.fn(async () => {}), ...overrides };
}

describe('GitHub monitor intent and grounded offers', () => {
  it('recognizes explicit Arabic and English state, head, CI, release and tag targets', () => {
    expect(spec('نبّهني لما يُدمج الطلب 42 في owner/repo')).toMatchObject({ language: 'ar', source: {
      owner: 'owner', repo: 'repo', watch: { kind: 'pull-request', number: 42 },
    }, condition: { kind: 'equals', value: 'merged' } });
    expect(spec('tell me when PR 42 in owner/repo is merged')).toMatchObject({ language: 'en', condition: { kind: 'equals', value: 'merged' } });
    expect(spec('أخبرني إذا نجحت فحوص هذا الطلب', `ما حالة الطلب؟ ${PR}`)).toMatchObject({ language: 'ar',
      source: { watch: { kind: 'pull-ci', number: 42 } }, condition: { kind: 'equals', value: 'success' } });
    expect(spec('watch the CI on branch main', 'This is the GitHub repo https://github.com/owner/repo')).toMatchObject({
      source: { watch: { kind: 'branch-ci', branch: 'main' } }, condition: { kind: 'change' } });
    expect(spec('watch commits on branch Team/Release in owner/repo')).toMatchObject({ source: { watch: { kind: 'branch-head', branch: 'Team/Release' } } });
    expect(spec('watch new commits on PR 42 in owner/repo')).toMatchObject({ source: { watch: { kind: 'pull-head', number: 42 } } });
    expect(spec('راقب إصدارات owner/repo')).toMatchObject({ source: { watch: { kind: 'releases' } }, read: { kind: 'items' } });
    expect(spec('watch the latest release of owner/repo')).toMatchObject({ source: { watch: { kind: 'latest-release' } } });
    expect(spec('watch the latest version of owner/repo')).toMatchObject({ source: { watch: { kind: 'latest-release' } } });
    expect(spec('track tags for owner/repo')).toMatchObject({ source: { watch: { kind: 'tags' } } });
    expect(spec('تابع أحدث وسم في owner/repo')).toMatchObject({ source: { watch: { kind: 'latest-tag' } } });
  });

  it('requests the missing repository and accepts a corresponding public repository reply', () => {
    const request = 'watch the CI on branch main';
    const need = detectGithubMonitorNeed(request);
    expect(need && githubMonitorSpec(need, at)).toBeNull();
    const clarification = detectGithubMonitorNeed('owner/repo', [{ role: 'user', text: request },
      { role: 'assistant', text: 'Send the public GitHub repository.' }]);
    expect(clarification && githubMonitorSpec(clarification, at)).toMatchObject({ source: { owner: 'owner', repo: 'repo',
      watch: { kind: 'branch-ci', branch: 'main' } } });
    expect(detectGithubMonitorNeed('merge PR 42 in owner/repo')).toBeNull();
    expect(detectGithubMonitorNeed('do not notify me if PR 42 in owner/repo is merged')).toBeNull();
    expect(detectGithubMonitorNeed('watch the CI on branch main, quick question only')).toBeNull();
    expect(detectGithubMonitorNeed('أخبرني إذا نجحت فحوص هذا الطلب', [{ role: 'assistant', text: PR }])?.sourceText).toBeUndefined();
    expect(detectGithubMonitorNeed('watch PR 42 https://user:pass@github.com/owner/repo/pull/42')).toBeNull();
  });

  it('requires evidence on the same target and a factual non-clarifying answer', () => {
    const page = { url: PR, text: 'Open', observedAt: at.toISOString(), documentStatus: 200 };
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is still open.', [page])).toMatchObject({
      before: 'open', condition: { kind: 'equals', value: 'merged' },
      source: { watch: { kind: 'pull-request', number: 42 } }, topic: 'github.com/owner/repo/pull/42',
    });
    const checks = { ...page, url: `${PR}/checks`, text: 'Checks are still pending' };
    expect(detectGithubAnswerOffer(success, 'CI is still pending.', [checks])).toMatchObject({
      before: 'pending', condition: { kind: 'equals', value: 'success' }, source: { watch: { kind: 'pull-ci', number: 42 } },
    });
    expect(detectGithubAnswerOffer(`I'm waiting for CI on PR 42 ${PR}`, 'CI is still pending.', [checks])?.condition).toEqual({ kind: 'change' });
    expect(detectGithubAnswerOffer(`Has CI failed for PR 42? ${PR}`, 'CI is still pending.', [checks])?.condition).toEqual({ kind: 'equals', value: 'failure' });
    expect(detectGithubAnswerOffer('When will the next release of owner/repo appear?', 'The latest release is v1.2.3.', [
      { url: 'https://github.com/owner/repo/releases', text: 'Latest release is v1.2.3' },
    ])).toMatchObject({ before: 'v1.2.3', source: { watch: { kind: 'latest-release' } } });
    expect(detectGithubAnswerOffer('هل يُدمج طلب السحب 42 في owner/repo؟', 'الطلب 42 مفتوح.', [page])?.language).toBe('ar');
    expect(detectGithubAnswerOffer(prMerge, 'PR 99 is still open.', [page])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is still open.', [{ ...page, url: PR.replace('42', '99') }])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is still open.', [{ ...page, url: 'https://example.org/owner/repo/pull/42' }])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is still open.', [{ ...page, documentStatus: 404 }])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is still open.', [{ ...page, text: 'It might be open' }])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'I could not verify it. PR 42 is open.', [page])).toBeNull();
    expect(detectGithubAnswerOffer(prMerge, 'PR 42 is open. Can you specify the repository?', [page])).toBeNull();
    expect(detectGithubAnswerOffer('Hello, how are you?', 'PR 42 is open.', [page])).toBeNull();
  });
});

describe('public GitHub monitor reads', () => {
  it('uses a credential-free GET and conditional validators for public pull requests', async () => {
    const watch = spec('tell me when PR 42 in owner/repo is merged');
    const responses: Result[] = [
      { body: fixture.pull, headers: { etag: 'W/"first"' } }, { status: 304 },
      { body: fixture.merged, headers: { etag: '"second"' } }, { body: fixture.closed },
    ];
    const network = new FixtureNetwork(path => {
      expect(path).toBe(prPath);
      return responses.shift()!;
    });
    const budget = options();
    const first = await readGithubMonitor(network, watch, budget, clock);
    expect(first).toMatchObject({ kind: 'value', observation: { value: 'open', url: PR, observedAt: at.toISOString() } });
    if (first.kind !== 'value') throw new Error('Missing fixture preview');
    expect(JSON.stringify(first.cache)).not.toContain('octocat');
    expect(await readGithubMonitor(network, watch, { ...budget, cache: first.cache }, clock)).toMatchObject({ kind: 'unchanged' });
    expect(await readGithubMonitor(network, watch, { ...budget, cache: first.cache }, clock)).toMatchObject({ kind: 'value', observation: { value: 'merged' } });
    expect(await readGithubMonitor(network, watch, budget, clock)).toMatchObject({ kind: 'value', observation: { value: 'closed' } });
    expect(budget.reserveHost).toHaveBeenCalledWith(GITHUB_API_HOST, GITHUB_BATCH_INTERVAL_MS);
    expect(network.calls.map(call => call.options.headers?.['if-none-match'])).toEqual([undefined, 'W/"first"', 'W/"first"', undefined]);
    for (const { options: request } of network.calls) {
      expect(request.method).toBe('GET');
      expect(request.allowedOrigins).toEqual(['https://api.github.com']);
      expect(request.headers).not.toHaveProperty('authorization');
      expect(request.headers).not.toHaveProperty('cookie');
      expect(request.headers?.['x-github-api-version']).toBe('2022-11-28');
    }
  });

  it('observes a change of PR or branch head, citing the immutable commit', async () => {
    const pr = spec('watch new commits on PR 42 in owner/repo');
    const branch = spec('watch commits on branch main in owner/repo');
    const pulls = [fixture.pull, fixture.pullMoved];
    const branches = [fixture.branch, fixture.branchMoved];
    const network = new FixtureNetwork(path => path === prPath ? { body: pulls.shift() } : { body: branches.shift() });
    for (const [watch, first, second] of [[pr, fixture.pull.head.sha, fixture.pullMoved.head.sha],
      [branch, fixture.branch.commit.sha, fixture.branchMoved.commit.sha]] as const) {
      for (const sha of [first, second]) {
        expect(await readGithubMonitor(network, watch, options(), clock)).toMatchObject({ kind: 'value', observation: {
          value: sha, url: `https://github.com/owner/repo/commit/${sha}`,
        } });
      }
    }
  });

  it('combines commit status and the latest check runs for the exact head', async () => {
    const watch = spec('watch CI on branch main in owner/repo');
    const branchSha = fixture.branch.commit.sha;
    let statuses = fixture.status;
    let checks: { total_count: number; check_runs: unknown[] } = fixture.checks;
    const network = new FixtureNetwork(path => {
      if (path === '/repos/owner/repo/branches/main') return { body: fixture.branch };
      if (path === statusPath(branchSha)) return { body: statuses };
      if (path === checksPath(branchSha)) return { body: checks };
      throw new Error(`Unexpected fixture path ${path}`);
    });
    const budget = options();
    for (const [runs, value] of [[fixture.ciQueued, 'pending'], [fixture.ciFailed, 'failure'], [fixture.checks, 'success']] as const) {
      checks = runs;
      expect(await readGithubMonitor(network, watch, budget, clock)).toMatchObject({ kind: 'value', observation: {
        value, excerpt: expect.stringContaining(branchSha.slice(0, 12)), url: `https://github.com/owner/repo/commit/${branchSha}`,
      } });
    }
    statuses = fixture.ciPending;
    expect(await readGithubMonitor(network, watch, budget, clock)).toMatchObject({ kind: 'value', observation: { value: 'success' } });
    checks = { ...fixture.checks, total_count: 2 };
    expect(await readGithubMonitor(network, watch, budget, clock)).toMatchObject({ kind: 'unreachable' });
    checks = fixture.ciChecksOnPull;
    expect(await readGithubMonitor(network, watch, budget, clock)).toMatchObject({ kind: 'unreachable' });

    const pullSha = fixture.pull.head.sha;
    const pull = new FixtureNetwork(path => {
      if (path === prPath) return { body: fixture.pull };
      if (path === statusPath(pullSha)) return { body: fixture.ciStatusOnPull };
      if (path === checksPath(pullSha)) return { body: fixture.ciChecksOnPull };
      throw new Error(`Unexpected fixture path ${path}`);
    });
    expect(await readGithubMonitor(pull, spec('watch CI on PR 42 in owner/repo'), options(), clock))
      .toMatchObject({ kind: 'value', observation: { value: 'success' } });
  });

  it('sees releases, latest stable versions and tags and can baseline an empty public repository', async () => {
    const latest = spec('watch the latest release of owner/repo');
    const network = new FixtureNetwork(path => {
      if (path === '/repos/owner/repo/releases/latest') return { body: fixture.release };
      if (path === '/repos/owner/repo/releases?per_page=30') return { body: fixture.releases };
      if (path === '/repos/owner/repo/tags?per_page=30') return { body: fixture.tags };
      throw new Error(`Unexpected fixture path ${path}`);
    });
    expect(await readGithubMonitor(network, latest, options(), clock)).toMatchObject({ kind: 'value',
      observation: { value: fixture.release.tag_name }, publicationTimes: [fixture.release.published_at] });
    expect(await readGithubMonitor(network, spec('watch releases of owner/repo'), options(), clock)).toMatchObject({ kind: 'value',
      observation: { value: fixture.releases.map(item => item.tag_name), itemKeys: fixture.releases.map(item => `release:${item.id}`) } });
    expect(await readGithubMonitor(network, spec('watch tags of owner/repo'), options(), clock)).toMatchObject({ kind: 'value',
      observation: { value: fixture.tags.map(item => item.name) } });
    expect(await readGithubMonitor(network, spec('watch the latest tag of owner/repo'), options(), clock)).toMatchObject({ kind: 'value',
      observation: { value: fixture.tags[0].name } });
    const empty = new FixtureNetwork(path => path.endsWith('/latest') ? { status: 404 } : { body: fixture.noReleases });
    expect(await readGithubMonitor(empty, latest, options(), clock)).toMatchObject({ kind: 'value', observation: { value: '' } });
    const privateOrAbsent = new FixtureNetwork(() => ({ status: 404 }));
    expect(await readGithubMonitor(privateOrAbsent, latest, options(), clock)).toMatchObject({ kind: 'missing' });
  });

  it('admits and bounds redirect hops, rejecting cross-origin and credential-bearing locations', async () => {
    const watch = spec('watch PR 42 in owner/repo');
    const rename = new FixtureNetwork(path => path === prPath
      ? { status: 301, headers: { location: '/repositories/123/pulls/42' } } : { body: fixture.pull });
    expect(await readGithubMonitor(rename, watch, options(), clock)).toMatchObject({ kind: 'value' });
    expect(rename.calls.map(call => call.path)).toEqual([prPath, '/repositories/123/pulls/42']);
    for (const location of ['https://example.org/repos/owner/repo/pulls/42', 'https://a:b@api.github.com/repos/owner/repo/pulls/42',
      '/repos/owner/repo/pulls/42?session=fixture', '/repos/owner/repo/pulls/99']) {
      const unsafe = new FixtureNetwork(() => ({ status: 301, headers: { location } }));
      expect(await readGithubMonitor(unsafe, watch, options(), clock)).toMatchObject({ kind: 'unreachable' });
      expect(unsafe.calls).toHaveLength(1);
    }
    const loop = new FixtureNetwork(() => ({ status: 302, headers: { location: prPath } }));
    expect(await readGithubMonitor(loop, watch, options(), clock)).toMatchObject({ kind: 'unreachable' });
    expect(loop.calls).toHaveLength(GITHUB_BATCH_REQUEST_LIMIT);
  });

  it('defers on shared admission and extends the shared gate using GitHub backoff headers', async () => {
    const watch = spec('watch PR 42 in owner/repo');
    for (const status of [403, 429]) {
      const budget = options();
      const limited = new FixtureNetwork(() => ({ status, headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at.getTime() / 1000 + 900), 'retry-after': '700',
      } }));
      expect(await readGithubMonitor(limited, watch, budget, clock)).toEqual({ kind: 'deferred', at: at.getTime() + 900_000 });
      expect(budget.extendHost).toHaveBeenCalledWith(GITHUB_API_HOST, 900_000);
      expect(limited.calls).toHaveLength(1);
    }
    const network = new FixtureNetwork(() => ({ body: fixture.pull }));
    expect(await readGithubMonitor(network, watch, options({ reserveHost: async () => at.getTime() + 900_000 }), clock))
      .toEqual({ kind: 'deferred', at: at.getTime() + 900_000 });
    expect(await readGithubMonitor(network, watch, { ownerId: 'owner' }, clock)).toMatchObject({ kind: 'unreachable' });
    expect(network.calls).toHaveLength(0);

    const exhausted = new FixtureNetwork(() => ({ body: fixture.pull, headers: { 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(at.getTime() / 1000 + 1200) } }));
    expect(await readGithubMonitor(exhausted, spec('watch CI on PR 42 in owner/repo'), options(), clock))
      .toEqual({ kind: 'deferred', at: at.getTime() + 1_200_000 });
    expect(exhausted.calls).toHaveLength(1);
  });
});
