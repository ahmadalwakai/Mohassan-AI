import {randomInt} from 'node:crypto';
import {appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {addLatency, createHistogram, histogramBytes, latencyBoundsMs, latencyBucketIndex, summarizeHistogram} from '../apps/server/src/ops/metrics/histogram';
import {MetricsSnapshots, snapshotRetentionMs} from '../apps/server/src/ops/metrics/snapshots';
import {hourMs, MetricsStore, minuteMs} from '../apps/server/src/ops/metrics/store';

const route = 'GET /api/widgets/:id';
const base = 1000 * hourMs;

function histogramFor(values: number[]) {
  const histogram = createHistogram();
  for (const ms of values) addLatency(histogram, latencyBucketIndex(ms), ms);
  return histogram;
}

describe('fixed metrics histograms', () => {
  it('uses inclusive upper bounds and returns no percentiles for empty buckets', () => {
    const bounds = latencyBoundsMs;
    for (const [index, bound] of bounds.entries()) {
      expect(latencyBucketIndex(bound)).toBe(index);
      expect(latencyBucketIndex(bound * 1.0001)).toBe(index + 1);
    }
    expect(latencyBucketIndex(0)).toBe(0);
    expect(summarizeHistogram(createHistogram())).toEqual({samples: 0, p50: null, p90: null, p99: null});
  });

  it('matches the bucket containing each brute-force nearest rank on random samples', () => {
    for (let trial = 0; trial < 12; trial++) {
      const values = Array.from({length: randomInt(1, 1500)}, () => 2 ** (randomInt(-60, 580) / 20));
      const sorted = [...values].sort((left, right) => left - right);
      const actual = summarizeHistogram(histogramFor(values));
      expect(actual.samples).toBe(values.length);
      for (const percentile of [50, 90, 99] as const) {
        const exact = sorted[Math.ceil(percentile * sorted.length / 100) - 1];
        const upperBound = latencyBoundsMs.find(bound => bound >= exact) ?? sorted[sorted.length - 1];
        expect(actual[`p${percentile}`]).toBe(upperBound);
      }
    }
    const over = latencyBoundsMs[latencyBoundsMs.length - 1] * 2;
    expect(summarizeHistogram(histogramFor([over]))).toEqual({samples: 1, p50: over, p90: over, p99: over});
  });
});

describe('rolling metrics store', () => {
  it('rolls minute and hour windows forward and retains separate traffic classes', () => {
    let now = base;
    const store = new MetricsStore({now: () => now});
    store.recordRequest('owner', route, 201, 9);
    store.recordRequest('member', route, 503, 20);
    now += 59 * minuteMs;
    store.recordRequest('owner', route, 404, 30);
    let view = store.view();
    expect(view.windows.hour.startMs).toBe(base);
    expect(view.windows.hour.roles.owner.routes[0]).toMatchObject({count: 2, statusClasses: {'2xx': 1, '4xx': 1}});
    expect(view.windows.hour.roles.member.routes[0]).toMatchObject({count: 1, statusClasses: {'5xx': 1}});
    expect(view.hourlyRoutes).toHaveLength(24);
    expect(view.hourlyRoutes.at(-1)?.roles.owner[0].count).toBe(2);

    now += minuteMs;
    view = store.view();
    expect(view.windows.hour.startMs).toBe(base + minuteMs);
    expect(view.windows.hour.roles.owner.routes[0].count).toBe(1);
    expect(view.windows.hour.roles.member.routes).toEqual([]);
    expect(view.windows.day.roles.owner.routes[0].count).toBe(2);
    expect(view.hourlyRoutes.at(-2)).toMatchObject({startMs: base, endMs: base + hourMs});

    now = base + 24 * hourMs;
    view = store.view();
    expect(view.windows.day.roles.owner.routes).toEqual([]);
    expect(view.windows.week.roles.member.routes[0].count).toBe(1);
    now = base + 7 * 24 * hourMs;
    expect(store.view().windows.week.roles.member.routes).toEqual([]);
  });

  it('reduces collection to counts when the histogram cap would be exceeded and recovers on rollover', () => {
    let now = base;
    const store = new MetricsStore({now: () => now, memoryCapBytes: 2 * histogramBytes});
    store.recordRequest('owner', route, 200, 18);
    now += minuteMs;
    store.recordRequest('owner', route, 500, 22);
    store.recordChat('owner', {started: true, finalAnswerMs: 120, phases: {answering: 20}, paths: ['web', 'web']});
    store.recordResources({rssBytes: 8120});
    const view = store.view();
    expect(view.countingOnly).toBe(true);
    expect(view.windows.day.roles.owner.routes[0]).toMatchObject({
      count: 2, statusClasses: {'2xx': 1, '5xx': 1}, latency: {samples: 1},
    });
    expect(view.windows.day.roles.owner.chat).toMatchObject({
      runs: 1, finalAnswer: {samples: 0, p99: null}, phases: {}, paths: {web: 1},
    });
    expect(view.windows.day.resources.rssBytes).toEqual({samples: 0, average: null, max: null});

    now += 7 * 24 * hourMs;
    store.recordRequest('owner', route, 200, 36);
    expect(store.view().countingOnly).toBe(false);
    expect(store.view().windows.hour.roles.owner.routes[0].latency.samples).toBe(1);
  });
});

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'production-metrics-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('hourly metrics snapshots', () => {
  it('appends deltas for closed and graceful partial hours and reloads each measure once', async () => {
    const directory = await tempDirectory();
    let now = base + 58 * minuteMs;
    const store = new MetricsStore({now: () => now});
    const snapshots = new MetricsSnapshots(store, directory);
    await snapshots.load();
    expect(snapshots.healthy).toBe(true);
    store.recordRequest('owner', route, 200, 70);
    store.recordRequest('member', route, 409, 18);
    store.recordChat('owner', {started: true, firstProgressMs: 11});
    store.recordChat('owner', {finalAnswerMs: 90, phases: {executing: 31}, paths: ['web', 'browser']});
    store.recordResources({rssBytes: 8210, openHandles: 4});
    await snapshots.flush();
    expect(await readdir(directory)).toEqual([]);

    now = base + hourMs + minuteMs;
    await Promise.all([snapshots.flush(), snapshots.flush()]);
    expect(await readdir(directory)).toEqual([`metrics-${base}.jsonl`]);
    store.recordRequest('member', route, 202, 12);
    await snapshots.flush({includeCurrentHour: true});
    store.recordRequest('member', route, 503, 45);
    await snapshots.flush({includeCurrentHour: true});

    const expected = store.view();
    const restored = new MetricsStore({now: () => now});
    const reopened = new MetricsSnapshots(restored, directory);
    await Promise.all([reopened.load(), reopened.load()]);
    expect(reopened.healthy).toBe(true);
    expect(restored.view()).toEqual(expected);
    const member = restored.view().windows.hour.roles.member.routes[0];
    expect(member.count).toBe(3);
    expect(member.latency.samples).toBe(3);
    expect(restored.view().windows.hour.resources.rssBytes).toEqual({samples: 1, average: 8210, max: 8210});
    for (const suffix of ['', '-1']) {
      const segment = await readFile(join(directory, `metrics-${base + hourMs}${suffix}.jsonl`), 'utf8');
      expect(segment.trimEnd().split('\n').map(line => JSON.parse(line))).toHaveLength(1);
    }
  });

  it('ignores a torn line and resumes appending after it on restart', async () => {
    const directory = await tempDirectory();
    const first = new MetricsStore({now: () => base});
    const snapshots = new MetricsSnapshots(first, directory);
    first.recordRequest('owner', route, 201, 60);
    await snapshots.flush({includeCurrentHour: true});
    await appendFile(join(directory, `metrics-${base}.jsonl`), '{"version":1');

    const second = new MetricsStore({now: () => base});
    const reopened = new MetricsSnapshots(second, directory);
    await reopened.load();
    second.recordRequest('owner', route, 503, 70);
    await reopened.flush({includeCurrentHour: true});

    const restored = new MetricsStore({now: () => base});
    await new MetricsSnapshots(restored, directory).load();
    expect(restored.view().windows.hour.roles.owner.routes[0]).toMatchObject({count: 2, latency: {samples: 2}});
  });

  it('removes the oldest files to enforce the size cap and removes expired hours without touching unrelated files', async () => {
    const directory = await tempDirectory();
    let now = base;
    const first = new MetricsStore({now: () => now});
    const firstWriter = new MetricsSnapshots(first, directory);
    first.recordRequest('owner', route, 200, 16);
    await firstWriter.flush({includeCurrentHour: true});
    const firstFilename = `metrics-${base}.jsonl`;
    const {size} = await stat(join(directory, firstFilename));
    await writeFile(join(directory, 'keep.jsonl'), 'unrelated file');

    const second = new MetricsStore({now: () => now});
    const limited = new MetricsSnapshots(second, directory, {maxBytes: size});
    now += hourMs;
    second.recordRequest('owner', route, 200, 16);
    await limited.flush({includeCurrentHour: true});
    const secondFilename = `metrics-${now}.jsonl`;
    expect(limited.healthy).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(['keep.jsonl', secondFilename].sort());
    expect((await stat(join(directory, secondFilename))).size).toBeLessThanOrEqual(size);

    now += snapshotRetentionMs;
    await limited.flush();
    expect(await readdir(directory)).toEqual(['keep.jsonl']);
  });

  it('drops an oversized segment without blocking smaller snapshots or deleting existing history', async () => {
    const directory = await tempDirectory();
    let now = base;
    const original = new MetricsStore({now: () => now});
    const firstWriter = new MetricsSnapshots(original, directory);
    original.recordRequest('owner', route, 200, 16);
    await firstWriter.flush({includeCurrentHour: true});
    const firstFilename = `metrics-${base}.jsonl`;
    const {size} = await stat(join(directory, firstFilename));

    const store = new MetricsStore({now: () => now});
    const limited = new MetricsSnapshots(store, directory, {maxBytes: size});
    store.recordRequest('owner', route, 200, 16);
    store.recordRequest('owner', 'GET /api/other', 200, 16);
    await limited.flush({includeCurrentHour: true});
    expect(limited.healthy).toBe(false);
    expect(await readdir(directory)).toEqual([firstFilename]);

    store.recordRequest('owner', route, 500, 16);
    await limited.flush({includeCurrentHour: true});
    expect(limited.healthy).toBe(true);
    expect(await readdir(directory)).toEqual([`metrics-${base}-1.jsonl`]);

    const restored = new MetricsStore({now: () => now});
    await new MetricsSnapshots(restored, directory).load();
    expect(restored.view().windows.hour.roles.owner.routes[0]).toMatchObject({count: 1, statusClasses: {'5xx': 1}});
  });

  it('keeps collecting and retries a failed write without duplicating the snapshot', async () => {
    const temporary = await tempDirectory();
    const directory = join(temporary, 'snapshots');
    await writeFile(directory, '');
    const store = new MetricsStore({now: () => base});
    const snapshots = new MetricsSnapshots(store, directory);
    await snapshots.load();
    store.recordRequest('owner', route, 200, 12);
    await snapshots.flush({includeCurrentHour: true});
    expect(snapshots.healthy).toBe(false);
    expect(store.view().windows.hour.roles.owner.routes[0].count).toBe(1);

    await rm(directory);
    await snapshots.flush({includeCurrentHour: true});
    expect(snapshots.healthy).toBe(true);
    const restored = new MetricsStore({now: () => base});
    await new MetricsSnapshots(restored, directory).load();
    expect(restored.view().windows.hour.roles.owner.routes[0].count).toBe(1);
  });
});
