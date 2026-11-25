import type { SafeNetwork } from '@mohassan/browser';
import { monitorGithubArabicStatus, type GithubMonitorSource, type MonitorSpec } from '@mohassan/contracts';
import { z } from 'zod';
import type { MonitorObservation } from '../evaluation.js';
import { cleanMonitorText } from '../page.js';
import type { MonitorReadOptions, MonitorReadResult } from '../sources.js';
import { GithubReadFailure, githubPublicIdentifier, openGithubBatch } from './github-network.js';

export type { GithubMonitorSource } from '@mohassan/contracts';
export { GITHUB_API_HOST, GITHUB_BATCH_INTERVAL_MS, GITHUB_BATCH_REQUEST_LIMIT, GITHUB_BATCH_TIMEOUT_MS, GITHUB_PRIMARY_LIMIT,
  GITHUB_WINDOW_MS, type GithubMonitorCache } from './github-network.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/iu);
const ref = z.string().min(1).max(255).refine(githubPublicIdentifier);
// Strip all unused fields at the network boundary before persisting validators.
const pull = z.object({ state: z.enum(['open', 'closed']), merged: z.boolean(), head: z.object({ sha }) });
const branch = z.object({ commit: z.object({ sha }) });
const combined = z.object({ state: z.enum(['success', 'failure', 'pending']), total_count: z.int().min(0), sha });
const check = z.object({ id: z.int().positive(), head_sha: sha,
  status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
  conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required']).nullable(),
});
const checks = z.object({ total_count: z.int().min(0), check_runs: z.array(check).max(100) });
const release = z.object({ id: z.int().positive(), tag_name: ref, draft: z.boolean(), prerelease: z.boolean(),
  published_at: z.iso.datetime({ offset: true }).nullable() });
const releases = z.array(release).max(30);
const tags = z.array(z.object({ name: ref })).max(30);
const notOk = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
type CIStatus = z.infer<typeof combined>['state'];
type Batch = Awaited<ReturnType<typeof openGithubBatch>>;

export function githubMonitorUrl({ owner, repo, watch }: GithubMonitorSource): string {
  const root = `https://github.com/${owner}/${repo}`;
  if ('number' in watch) return `${root}/pull/${watch.number}${watch.kind === 'pull-ci' ? '/checks' : ''}`;
  if ('branch' in watch) return `${root}/tree/${encodeURIComponent(watch.branch)}`;
  return `${root}/${watch.kind === 'releases' || watch.kind === 'latest-release' ? 'releases' : 'tags'}`;
}

async function readCI(batch: Batch, path: string, commit: string): Promise<CIStatus> {
  const root = `${path}/commits/${commit}`;
  const status = await batch.json(`${root}/status?per_page=100&page=1`, combined);
  if (status.sha.toLowerCase() !== commit.toLowerCase()) throw new GithubReadFailure('unreachable');
  const checkRuns = (page: number) => batch.json(`${root}/check-runs?filter=latest&per_page=100&page=${page}`, checks);
  const first = await checkRuns(1);
  const count = first.total_count;
  if (count > 300) throw new GithubReadFailure('unreachable');
  const runs = [...first.check_runs];
  for (let page = 2; page <= Math.ceil(count / 100); page++) {
    const next = await checkRuns(page);
    if (next.total_count !== count) throw new GithubReadFailure('unreachable');
    runs.push(...next.check_runs);
  }
  if (runs.length !== count || new Set(runs.map(run => run.id)).size !== count
      || runs.some(run => run.head_sha.toLowerCase() !== commit.toLowerCase())) throw new GithubReadFailure('unreachable');
  if (status.state === 'failure' || runs.some(run => run.status === 'completed' && run.conclusion && notOk.has(run.conclusion))) return 'failure';
  if (status.total_count && status.state === 'pending' || runs.some(run => run.status !== 'completed' || run.conclusion === null)) return 'pending';
  return status.total_count || count ? 'success' : 'pending';
}

export async function readGithubMonitor(network: SafeNetwork, spec: MonitorSpec & { source: GithubMonitorSource },
  options: MonitorReadOptions, clock = Date.now): Promise<MonitorReadResult> {
  const { owner, repo, watch } = spec.source;
  const url = githubMonitorUrl(spec.source);
  const name = `${owner}/${repo}`;
  if (!githubPublicIdentifier(name) || 'branch' in watch && !githubPublicIdentifier(watch.branch)) return { kind: 'unreachable' };
  const ar = spec.language === 'ar';
  try {
    const batch = await openGithubBatch(network, options, clock);
    const path = `/repos/${owner}/${repo}`;
    const repositoryUrl = `https://github.com/${name}`;
    let evidenceUrl = url;
    let publicationTimes: string[] | undefined;
    let reading: Pick<MonitorObservation, 'value' | 'excerpt' | 'itemKeys' | 'itemUrls'>;
    const single = (value: string, excerpt: string) => ({ value, excerpt });
    const state = (value: CIStatus | 'open' | 'merged' | 'closed', label: string) =>
      single(value, `${label} · ${ar ? monitorGithubArabicStatus[value] : value}`);
    const empty = ar ? 'لا توجد إصدارات أو وسوم منشورة' : 'No published releases or tags';
    if ('number' in watch) {
      const detail = await batch.json(`${path}/pulls/${watch.number}`, pull);
      const subject = `${name} #${watch.number}`;
      if (watch.kind === 'pull-head' || watch.kind === 'pull-ci') evidenceUrl = `${repositoryUrl}/commit/${detail.head.sha}`;
      if (watch.kind === 'pull-head') reading = single(detail.head.sha, `${subject} · ${detail.head.sha.slice(0, 12)}`);
      else if (watch.kind === 'pull-ci') reading = state(await readCI(batch, path, detail.head.sha), `${subject} · ${detail.head.sha.slice(0, 12)}`);
      else reading = state(detail.merged ? 'merged' : detail.state, subject);
    } else if ('branch' in watch) {
      const detail = await batch.json(`${path}/branches/${encodeURIComponent(watch.branch)}`, branch);
      const subject = `${name} · ${watch.branch}`;
      evidenceUrl = `${repositoryUrl}/commit/${detail.commit.sha}`;
      reading = watch.kind === 'branch-ci' ? state(await readCI(batch, path, detail.commit.sha), `${subject} · ${detail.commit.sha.slice(0, 12)}`)
        : single(detail.commit.sha, `${subject} · ${detail.commit.sha.slice(0, 12)}`);
    } else if (watch.kind === 'latest-release') {
      try {
        const latest = await batch.json(`${path}/releases/latest`, release);
        if (latest.draft || latest.prerelease || !latest.published_at) throw new GithubReadFailure('unreachable');
        publicationTimes = [latest.published_at];
        evidenceUrl = `${url}/tag/${encodeURIComponent(latest.tag_name)}`;
        reading = single(latest.tag_name, `${name} · ${latest.tag_name}`);
      } catch (error) {
        if (!(error instanceof GithubReadFailure) || error.outcome !== 'missing') throw error;
        // A public repository with no stable releases still makes a valid baseline.
        const listed = await batch.json(`${path}/releases?per_page=30`, releases);
        if (listed.some(item => !item.draft && !item.prerelease && item.published_at)) throw new GithubReadFailure('unreachable');
        reading = single('', `${name} · ${empty}`);
      }
    } else if (watch.kind === 'releases') {
      const listed = (await batch.json(`${path}/releases?per_page=30`, releases)).filter(item => !item.draft && item.published_at !== null);
      const versions = listed.map(item => item.tag_name);
      reading = { value: versions, excerpt: `${name} · ${versions.join(' · ') || empty}`,
        itemKeys: listed.map(item => `release:${item.id}`), itemUrls: versions.map(version => `${url}/tag/${encodeURIComponent(version)}`) };
      publicationTimes = listed.map(item => item.published_at!);
    } else {
      const listed = await batch.json(`${path}/tags?per_page=30`, tags);
      const versions = listed.map(item => item.name);
      if (watch.kind === 'latest-tag') reading = single(versions[0] ?? '', `${name} · ${versions[0] ?? empty}`);
      else reading = { value: versions, excerpt: `${name} · ${versions.join(' · ') || empty}`,
        itemKeys: versions.map(version => `tag:${version}`), itemUrls: versions.map(version => `${repositoryUrl}/tree/${encodeURIComponent(version)}`) };
    }
    const cache = { url, github: { responses: batch.responses } };
    if (batch.unchanged && !options.preview) return { kind: 'unchanged', cache, publicationTimes };
    return { kind: 'value', observation: { ...reading, excerpt: cleanMonitorText(reading.excerpt).slice(0, 320),
      url: evidenceUrl, observedAt: new Date(clock()).toISOString() }, cache, publicationTimes };
  } catch (error) {
    options.signal?.throwIfAborted();
    const outcome = error instanceof GithubReadFailure ? error.outcome : 'unreachable';
    return typeof outcome === 'number' ? { kind: 'deferred', at: outcome } : { kind: outcome, url };
  }
}
