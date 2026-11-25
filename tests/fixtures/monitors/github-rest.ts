import pull from './github-pull.json';
import rest from './github-rest.json';

// Based on the official OpenAPI operation examples. The state and head variants
// are deterministic edits to those examples and are validated by github-openapi.ts.
const run = rest.checks.check_runs[0];
const ciPending = { ...rest.status, state: 'pending', total_count: 0, statuses: [] };
const secondSha = rest.branch.commit.sha;

export const githubFixture = {
  pull,
  merged: { ...pull, state: 'closed', merged: true, merged_at: pull.updated_at, closed_at: pull.updated_at },
  closed: { ...pull, state: 'closed', closed_at: pull.updated_at },
  pullMoved: { ...pull, head: { ...pull.head, sha: secondSha } },
  ...rest,
  branchMoved: { ...rest.branch, commit: { ...rest.branch.commit, sha: pull.head.sha } },
  ciPending,
  ciFailed: { ...rest.checks, check_runs: [{ ...run, conclusion: 'failure' }] },
  ciQueued: { ...rest.checks, check_runs: [{ ...run, status: 'queued', conclusion: null, completed_at: null }] },
  ciChecksOnPull: { ...rest.checks, check_runs: [{ ...run, head_sha: pull.head.sha }] },
  ciStatusOnPull: { ...rest.status, sha: pull.head.sha },
  noReleases: [],
};
