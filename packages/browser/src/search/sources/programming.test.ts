import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserError, SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { programmingProviders } from './programming.js';
import github from './fixtures/programming-github.json' with { type: 'json' };
import npm from './fixtures/programming-npm.json' with { type: 'json' };
import pypi from './fixtures/programming-pypi.json' with { type: 'json' };

const pypiRobotsUrl = pypi.source.robots;
const pypiRobots = readFileSync(new URL('./fixtures/programming-pypi-robots.txt', import.meta.url), 'utf8');
const pypiProjectUrl = `https://pypi.org/pypi/${pypi.project.info.name}/json`;
const npmRobotsUrl = new URL('/robots.txt', npm.search.url).href;
const clock = Date.parse(npm.checked) + 24 * 60 * 60 * 1000;
const clockDate = new Date(clock).toISOString().slice(0, 10);
const signal = () => new AbortController().signal;

function json(url: string, body: unknown, status = 200, headers: Record<string, string> = {}): SafeResponse {
  return { url, status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) };
}

function fakeNetwork(...responses: SafeResponse[]) {
  const routes = new Map(responses.map(response => [response.url, response]));
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async (url, options) => {
    options?.signal?.throwIfAborted();
    const response = routes.get(url);
    if (!response) throw new Error(`Unrecorded fixture route ${url}`);
    return response;
  });
  return { network, request, urls: () => request.mock.calls.map(([url]) => url) };
}

function robots(url: string, body = 'User-agent: *\nAllow: /\n'): SafeResponse {
  return { url, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) };
}

function fixture(...responses: SafeResponse[]) {
  const fake = fakeNetwork(...responses);
  return {
    ...fake,
    provider: (name: string, now = () => clock) => {
      const provider = programmingProviders(fake.network, now).find(item => item.name === name);
      if (!provider) throw new Error(`Missing programming provider ${name}`);
      return provider;
    },
  };
}

const githubRobots = json(github.robots.url, github.robots.body, github.robots.status);
const githubSearch = json(github.repositories.url, github.repositories.body, github.repositories.status, github.repositories.headers);

function expectFacts(snippet: string, ...facts: Array<string | number>) {
  for (const fact of facts) expect(snippet).toContain(String(fact));
}

function gitRepositoryPath(url: string) {
  const { hostname, pathname } = new URL(url);
  return `${hostname}${pathname.replace(/\.git$/, '')}`;
}

describe('programming providers', () => {
  it('reads npm discovery facts, including download counts, from the registry search response', async () => {
    const { provider, urls } = fixture(robots(npmRobotsUrl), json(npm.search.url, npm.search.body));
    const query = compileQuery('best npm library for terminal colors');
    const hits = await provider('npm').search(query, 2, signal());

    expect(urls()).toEqual([npmRobotsUrl, npm.search.url]);
    expect(hits.map(({ title, url }) => ({ title, url }))).toEqual(npm.search.body.objects.map(({ package: row }) => ({
      title: row.name, url: row.links.npm,
    })));
    for (const [index, { package: row, downloads }] of npm.search.body.objects.entries()) {
      expectFacts(hits[index].snippet, row.version, row.description, row.license, row.date.slice(0, 10), gitRepositoryPath(row.links.repository),
        downloads.weekly, downloads.monthly, `Read on: ${clockDate}`);
    }
  });

  it.each(['latest version of is-number', 'كيف أثبّت حزمة is-number؟'])('uses npm metadata for the exact name in %s', async question => {
    const { provider, urls } = fixture(robots(npmRobotsUrl), json(npm.metadata.url, npm.metadata.body));
    const query = compileQuery(question);
    const adapter = provider('npm');
    const { name, time, 'dist-tags': tags, versions } = npm.metadata.body;
    const version = tags.latest as keyof typeof versions;
    const manifest = versions[version];

    expect(adapter.supports(query)).toBe(true);
    const [hit] = await adapter.search(query, 2, signal());
    expect(urls()).toEqual([npmRobotsUrl, npm.metadata.url]);
    expect(hit).toMatchObject({ title: name, url: `https://www.npmjs.com/package/${name}` });
    expectFacts(hit.snippet, version, manifest.description, manifest.license, time[version].slice(0, 10), gitRepositoryPath(manifest.repository.url), clockDate);
    expect(hit.snippet).not.toContain(time.modified.slice(0, 10));
  });

  it.each([true, false])('recovers from an oversized npm packument with matching index version %s', async matching => {
    const { package: row, downloads } = npm.search.body.objects[0];
    const metadataUrl = new URL('/' + row.name, npm.metadata.url).href;
    const tagUrl = metadataUrl + '/latest';
    const search = new URL(npm.search.url);
    search.search = new URLSearchParams({ text: row.name, size: '20' }).toString();
    // Replay the recorded search fields with a latest-tag manifest for the same release.
    const manifest = { name: row.name, version: row.version, description: row.description, license: row.license,
      repository: { url: row.links.repository } };
    const indexed = { ...row, version: matching ? row.version : npm.metadata.body['dist-tags'].latest };
    const { provider, request, urls } = fixture(robots(npmRobotsUrl), json(tagUrl, manifest),
      json(search.href, { objects: [{ package: indexed, downloads }] }));
    request.mockImplementationOnce(async () => robots(npmRobotsUrl))
      .mockRejectedValueOnce(new BrowserError('BROWSER_RESPONSE_TOO_LARGE', 'Fixture packument exceeds its transport limit.'));

    const [hit] = await provider('npm').search(compileQuery(`latest version of ${row.name}`), 2, signal());

    expect(urls()).toEqual([npmRobotsUrl, metadataUrl, tagUrl, search.href]);
    expect(hit).toMatchObject({ title: row.name, url: row.links.npm });
    expectFacts(hit.snippet, `Latest version: ${row.version}`, row.license, gitRepositoryPath(row.links.repository), clockDate);
    const publication = `Published: ${row.date.slice(0, 10)}`;
    if (matching) expect(hit.snippet).toContain(publication);
    else expect(hit.snippet).not.toContain(publication);
  });

  it.each([
    'pip install sampleproject',
    'ما أحدث إصدار من حزمة sampleproject في Python؟',
    'كيف أثبّت `sampleproject`؟',
  ])('looks up one exact PyPI name for %s if robots allow it', async question => {
    const { provider, urls } = fixture(robots(pypiRobotsUrl), json(pypiProjectUrl, pypi.project));
    const query = compileQuery(question);
    const adapter = provider('PyPI');
    const { info, urls: releaseFiles } = pypi.project;

    expect(adapter.supports(query)).toBe(true);
    const [hit] = await adapter.search(query, 4, signal());
    expect(urls()).toEqual([pypiRobotsUrl, pypiProjectUrl]);
    expect(hit).toMatchObject({ title: info.name, url: info.project_url });
    expectFacts(hit.snippet, info.version, info.summary, info.project_urls.Source.replace(/\/$/, ''),
      releaseFiles[0].upload_time_iso_8601.slice(0, 10), clockDate);
  });

  it('normalizes an exact PyPI name and treats its documented 404 as an empty result', async () => {
    const missingUrl = 'https://pypi.org/pypi/unrecorded-pypi-example-2026/json';
    const { provider, urls } = fixture(robots(pypiRobotsUrl), {
      url: missingUrl, status: pypi.missing.status, headers: {}, body: Buffer.from(pypi.missing.body),
    });
    const query = compileQuery('pip install Unrecorded_PyPI_Example-2026');

    await expect(provider('PyPI').search(query, 4, signal())).resolves.toEqual([]);
    expect(urls()).toEqual([pypiRobotsUrl, missingUrl]);
  });

  it('leaves PyPI JSON untouched when the recorded robots policy disallows it', async () => {
    const { provider, urls } = fixture(robots(pypiRobotsUrl, pypiRobots), json(pypiProjectUrl, pypi.project));
    const query = compileQuery('pip install sampleproject');

    await expect(provider('PyPI').search(query, 4, signal())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(urls()).toEqual([pypiRobotsUrl]);
  });

  it('uses the GitHub repository search API anonymously and cites the repository metadata', async () => {
    const { provider, request, urls } = fixture(githubRobots, githubSearch);
    const query = compileQuery('repository for pallets/flask');
    const [row] = github.repositories.body.items;
    const [hit] = await provider('GitHub').search(query, 1, signal());

    expect(urls()).toEqual([github.robots.url, github.repositories.url]);
    const headers = request.mock.calls[1]?.[1]?.headers;
    expect(headers?.accept).toBe('application/vnd.github+json');
    expect(Object.keys(headers ?? {}).map(header => header.toLowerCase())).not.toContain('authorization');
    expect(hit).toMatchObject({ title: row.full_name, url: row.html_url });
    expectFacts(hit.snippet, row.description, row.language, row.stargazers_count, row.license.spdx_id, clockDate);
  });

  it.each([github.rateLimit.status, 429])('enforces GitHub HTTP %i reset and makes no automatic retry', async status => {
    let current = Date.parse(github.rateLimit.headers.date);
    const reset = Number(github.rateLimit.headers['x-ratelimit-reset']) * 1000;
    const limited = json(github.repositories.url, {}, status, github.rateLimit.headers);
    const { provider, request, urls } = fixture(githubRobots, limited);
    const adapter = provider('GitHub', () => current);
    const query = compileQuery('repository for pallets/flask');

    await expect(adapter.search(query, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: reset - current });
    expect(urls()).toEqual([github.robots.url, github.repositories.url]);

    current = reset - 1;
    await expect(adapter.search(query, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1 });
    expect(urls()).toEqual([github.robots.url, github.repositories.url]);

    current = reset;
    request.mockResolvedValueOnce(githubSearch);
    await expect(adapter.search(query, 1, signal())).resolves.toHaveLength(1);
    expect(urls()).toEqual([github.robots.url, github.repositories.url, github.repositories.url]);
  });

  it('honors the later GitHub Retry-After when the API also supplies a reset', async () => {
    const receipt = Date.parse(github.rateLimit.headers.date);
    const reset = Number(github.rateLimit.headers['x-ratelimit-reset']) * 1000;
    const retrySeconds = (reset - receipt) / 1000 + 15;
    const limited = json(github.repositories.url, {}, 429, { ...github.rateLimit.headers, 'retry-after': String(retrySeconds) });
    const { provider, urls } = fixture(githubRobots, limited);
    const adapter = provider('GitHub', () => receipt);

    await expect(adapter.search(compileQuery('repository for pallets/flask'), 1, signal()))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: retrySeconds * 1000 });
    expect(urls()).toEqual([github.robots.url, github.repositories.url]);
  });

  it('paces anonymous GitHub searches across provider instances', async () => {
    let current = clock;
    const now = () => current;
    const { provider, urls } = fixture(githubRobots, githubSearch);
    const first = provider('GitHub', now);
    const second = provider('GitHub', now);
    const query = compileQuery('repository for pallets/flask');
    // Ten unauthenticated searches per minute, checked 2026-11-27.
    // https://docs.github.com/en/rest/search/search#rate-limit
    const spacingMs = 60_000 / 10;

    await expect(first.search(query, 1, signal())).resolves.toHaveLength(1);
    await expect(second.search(query, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: spacingMs });
    expect(urls().filter(url => url === github.repositories.url)).toHaveLength(1);

    current += spacingMs;
    await expect(second.search(query, 1, signal())).resolves.toHaveLength(1);
    expect(urls().filter(url => url === github.repositories.url)).toHaveLength(2);
  });

  it('honors npm Retry-After before dispatching another request', async () => {
    const { provider, urls } = fixture(robots(npmRobotsUrl), json(npm.search.url, {}, 429, { 'retry-after': '75' }));
    const query = compileQuery('best npm library for terminal colors');
    const adapter = provider('npm');

    await expect(adapter.search(query, 2, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 75_000 });
    await expect(adapter.search(query, 2, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 75_000 });
    expect(urls()).toEqual([npmRobotsUrl, npm.search.url]);
  });

  it('keeps npm metadata when supplementary download counts are rate limited', async () => {
    const { name } = npm.metadata.body;
    const searchUrl = new URL('/-/v1/search', npm.metadata.url);
    searchUrl.search = new URLSearchParams({ text: name, size: '20' }).toString();
    const { provider, urls } = fixture(robots(npmRobotsUrl), json(npm.metadata.url, npm.metadata.body),
      json(searchUrl.href, {}, 429, { 'retry-after': '75' }));
    const adapter = provider('npm');
    const query = compileQuery('downloads of ' + name);

    const [hit] = await adapter.search(query, 2, signal());
    expectFacts(hit.snippet, npm.metadata.body['dist-tags'].latest, clockDate);
    expect(hit.snippet).not.toContain('Downloads (weekly)');
    await expect(adapter.search(query, 2, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 75_000 });
    expect(urls()).toEqual([npmRobotsUrl, npm.metadata.url, searchUrl.href]);
  });

  it('rejects encoded credentials and honors cancellation before contacting any source', async () => {
    const { provider, request } = fixture();
    const controller = new AbortController();
    controller.abort();
    const query = compileQuery('best npm library for terminal colors');
    const sensitive = compileQuery('best npm library for terminal colors password%3Dfixture-value');

    await expect(provider('npm').search(query, 2, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider('npm').search(sensitive, 2, signal())).rejects.toMatchObject({ code: 'RESEARCH_QUERY_SECRET' });
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies relevant unplanned queries without treating every technical question as a PyPI name', () => {
    const { provider, request } = fixture();
    const bestLibrary = compileQuery('What is the best JavaScript library for terminal colors?');
    const pythonPackage = compileQuery('How do I install the Python package sampleproject?');
    const repository = compileQuery('Where is the repository for the Python Flask project?');
    const debugging = compileQuery('Why does this Python code raise an error?');
    const weather = compileQuery('weather forecast for London');

    expect(bestLibrary.intent).toBe('technical');
    expect(repository.intent).toBe('technical');
    expect(provider('npm').supports(bestLibrary)).toBe(true);
    expect(provider('npm').supports(compileQuery('latest version of python-shell'))).toBe(true);
    expect(provider('PyPI').supports(pythonPackage)).toBe(true);
    expect(provider('PyPI').supports(debugging)).toBe(false);
    expect(provider('GitHub').supports(repository)).toBe(true);
    for (const name of ['npm', 'PyPI', 'GitHub']) {
      const adapter = provider(name);
      expect(adapter.supports(weather)).toBe(false);
      expect(adapter.planned.domains).toEqual(['programming']);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
