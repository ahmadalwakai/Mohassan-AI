import { githubFixture } from '../../tests/fixtures/monitors/github-rest.js';
import { iso, week } from './fixtures.js';

export const githubHost = 'api.github.com';
export const githubFixtureOwner = 'fixture';
export const githubFixtureRepo = 'public-project';
export const githubPullNumber = 42;
const repo = `${githubFixtureOwner}/${githubFixtureRepo}`;
const epoch = Date.UTC(2026, 10, 9);
const head = githubFixture.pull.head.sha;
type PullState = 'open' | 'closed' | 'merged';
type CheckState = 'pending' | 'failure' | 'success';
const pullResponse = { open: githubFixture.pull, closed: githubFixture.closed, merged: githubFixture.merged };
const checkStates = ['pending', 'failure', 'success'] as const;
const json = (value: unknown) => ({ body: Buffer.from(JSON.stringify(value)), type: 'application/json' });

function combinedResponse(state: CheckState) {
  return { ...githubFixture.status, sha: head, state, statuses: githubFixture.status.statuses.map(status => ({ ...status, state })) };
}

function checksResponse(state: CheckState, page: number, pages: number, perPage: number) {
  const template = githubFixture.checks.check_runs[0];
  return { ...githubFixture.checks, total_count: pages * perPage, check_runs: Array.from({ length: perPage }, (_, index) => {
    const id = (page - 1) * perPage + index + 1;
    return { ...template, id, head_sha: head, node_id: Buffer.from(`fixture-check-${id}`).toString('base64'),
      url: `https://${githubHost}/repos/${repo}/check-runs/${id}`,
      status: state === 'pending' ? 'queued' : 'completed', conclusion: state === 'pending' ? null : state,
      completed_at: state === 'pending' ? null : template.completed_at };
  }) };
}

function releaseResponse(at: number, releaseAt: number) {
  const publication = githubFixture.release;
  const prior = { ...publication, created_at: iso(epoch - week), published_at: iso(epoch - week), draft: false, prerelease: false };
  if (at < releaseAt) return [prior];
  return [{ ...prior, id: prior.id + 1, name: 'v2.0.0', tag_name: 'v2.0.0', created_at: iso(releaseAt), published_at: iso(releaseAt) }, prior];
}

// Exercise the same response constructors that back the virtual clock in the offline OpenAPI checker.
export const simulationGithubFixtures: Record<string, readonly unknown[]> = {
  '/pulls/{pull_number}': Object.values(pullResponse),
  '/commits/{ref}/status': checkStates.map(combinedResponse),
  '/commits/{ref}/check-runs': [...checkStates.map(state => checksResponse(state, 1, 1, 100)),
    ...[1, 2, 3].map(page => checksResponse('success', page, 3, 100))],
  '/releases': [releaseResponse(epoch, epoch + week), releaseResponse(epoch + week, epoch + week)],
};

const pullBodies = { open: json(pullResponse.open), closed: json(pullResponse.closed), merged: json(pullResponse.merged) };
const statusBodies = { pending: json(combinedResponse('pending')), failure: json(combinedResponse('failure')), success: json(combinedResponse('success')) };
const checkBodies = new Map<string, ReturnType<typeof json>>();

export function githubFixtureResponse(url: URL, at: number, releaseAt = Infinity,
  pullStatus: PullState = 'open', ci: CheckState = 'pending', checkPages = 1) {
  if (url.hostname !== githubHost) return;
  const prefix = `/repos/${repo}/`;
  if (!url.pathname.startsWith(prefix)) return;
  switch (url.pathname.slice(prefix.length)) {
    case `pulls/${githubPullNumber}`:
      return pullBodies[pullStatus];
    case `commits/${head}/status`:
      return statusBodies[ci];
    case `commits/${head}/check-runs`: {
      const page = Number(url.searchParams.get('page') ?? 1);
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const key = `${ci}/${checkPages}/${page}/${perPage}`;
      let response = checkBodies.get(key);
      if (!response) {
        response = json(checksResponse(ci, page, checkPages, perPage));
        checkBodies.set(key, response);
      }
      return response;
    }
    case 'releases':
      return json(releaseResponse(at, releaseAt));
    default:
      return;
  }
}

export const githubBudgetSource = { kind: 'github', owner: githubFixtureOwner, repo: githubFixtureRepo,
  watch: { kind: 'pull-ci', number: githubPullNumber } } as const;
