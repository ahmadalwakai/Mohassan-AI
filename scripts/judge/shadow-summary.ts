import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { JudgeShadowLine } from '../../apps/server/src/assistant/judge-shadow.js';

// The original log format had no origin and recorded only pipeline verdicts.
type RetainedLine = Omit<JudgeShadowLine, 'origin'> & { origin?: string };
type RecentLine = Pick<RetainedLine, 'at' | 'decision' | 'kind' | 'codes' | 'question'> & { origin: string };
type Counts = Record<string, number>;

function emptyCounts(): Counts {
  return Object.create(null);
}

function emptyGroup() {
  return {
    total: 0, applied: 0, decision: emptyCounts(), kind: emptyCounts(), code: emptyCounts(), origin: emptyCounts(),
    conversationReview: { total: 0, applied: 0, action: emptyCounts(), check: emptyCounts(), code: emptyCounts() },
  };
}

function increment(counts: Counts, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function tally(group: ReturnType<typeof emptyGroup>, line: RetainedLine, origin: string) {
  group.total++;
  if (line.applied) group.applied++;
  increment(group.decision, line.decision);
  increment(group.kind, line.kind);
  increment(group.origin, origin);
  for (const code of line.codes) increment(group.code, code);

  if (!line.conversationReview) return;
  const review = group.conversationReview;
  review.total++;
  if (line.conversationReview.applied) review.applied++;
  increment(review.action, line.conversationReview.action);
  for (const { check, code } of line.conversationReview.findings) {
    increment(review.check, check);
    increment(review.code, code);
  }
}

interface SummaryOptions {
  days?: number;
  since?: string;
  now?: Date;
  last?: number;
}

interface TimeWindow {
  since?: number;
  until?: number;
}

function timeWindow({ days, since, now = new Date() }: SummaryOptions): TimeWindow {
  if (days !== undefined && since !== undefined) throw new Error('Use either --days or --since.');
  if (days !== undefined) {
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('--days needs a positive integer.');
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    const until = midnight.setUTCDate(midnight.getUTCDate() + 1);
    const start = midnight.setUTCDate(midnight.getUTCDate() - days);
    if (!Number.isFinite(start) || !Number.isFinite(until)) throw new Error('--days is outside the supported date range.');
    return { since: start, until };
  }
  if (since === undefined) return {};
  const start = Date.parse(since);
  const day = since.slice(0, 10);
  const midnight = new Date(day);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/iu.test(since)
    || !Number.isFinite(start) || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) {
    throw new Error('--since needs a date (YYYY-MM-DD) or an ISO timestamp with a time zone.');
  }
  return { since: start };
}

function ignoreMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error;
}

async function retainedArchives(logFile: string) {
  const prefix = `${basename(logFile)}.`;
  const files = await readdir(dirname(logFile), { withFileTypes: true }).catch(ignoreMissing) ?? [];
  const archives = new Map<string, string>();
  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith(prefix)) continue;
    const match = /^(\d{13})(\.gz)?$/u.exec(file.name.slice(prefix.length));
    if (!match) continue;
    const [, id, compressed] = match;
    // During rotation both files can exist briefly. A plain archive keeps the records if gzip was interrupted.
    if (compressed || !archives.has(id)) archives.set(id, `${logFile}.${id}${compressed ?? ''}`);
  }
  return [...archives.keys()].sort().map(id => archives.get(id)!);
}

const unzip = promisify(gunzip);

async function* readLines(file: string, active: boolean): AsyncGenerator<RetainedLine> {
  const data = await readFile(file).catch(ignoreMissing);
  if (!data) return;
  const text = (file.endsWith('.gz') && !active ? await unzip(data) : data).toString('utf8');
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record: RetainedLine;
    try {
      record = JSON.parse(line) as RetainedLine;
    } catch {
      // The live writer may still be appending the final line.
      if (active && index === lines.length - 1) break;
      throw new Error(`Invalid judge log JSON in ${file}, line ${index + 1}.`);
    }
    yield record;
  }
}

async function summarizeFiles(logFile: string, archives: string[], { since, until }: TimeWindow, last: number) {
  const all = emptyGroup();
  const textKept = emptyGroup();
  const textOmitted = emptyGroup();
  const ms: number[] = [];
  const support = { repliesWithEvidence: 0, supported: 0, sentences: 0 };
  const recent: RecentLine[] = [];
  let first = Infinity;
  let latest = -Infinity;

  for (const file of [...archives, logFile]) {
    for await (const line of readLines(file, file === logFile)) {
      const at = Date.parse(line.at);
      if (!Number.isFinite(at)) throw new Error(`Invalid judge log timestamp in ${file}.`);
      if ((since !== undefined && at < since) || (until !== undefined && at >= until)) continue;
      const kept = line.textKept !== false;
      const origin = line.origin ?? 'pipeline';
      tally(all, line, origin);
      tally(kept ? textKept : textOmitted, line, origin);
      first = Math.min(first, at);
      latest = Math.max(latest, at);
      ms.push(line.ms);
      if (line.evidence > 0) {
        support.repliesWithEvidence++;
        support.supported += line.support?.supported ?? 0;
        support.sentences += line.support?.sentences ?? 0;
      }
      if (last > 0) {
        if (recent.length === last) recent.shift();
        const { decision, kind, codes, question } = line;
        recent.push({ at: line.at, decision, kind, codes, origin, question: kept ? question : '' });
      }
    }
  }

  ms.sort((a, b) => a - b);
  const percentile = (p: number) => ms[Math.ceil(p * ms.length) - 1] ?? null;
  const summary = {
    since: since === undefined ? null : new Date(since).toISOString(),
    until: until === undefined ? null : new Date(until).toISOString(),
    from: all.total ? new Date(first).toISOString() : null,
    to: all.total ? new Date(latest).toISOString() : null,
    all, textKept, textOmitted,
    latency: { p50: percentile(0.5), p95: percentile(0.95), max: ms.at(-1) ?? null },
    support,
  };
  return { summary, recent };
}

export async function summarizeJudgeShadow(logFile: string, options: SummaryOptions = {}) {
  const window = timeWindow(options);
  const last = options.last ?? 0;
  if (!Number.isSafeInteger(last) || last < 0) throw new Error('--last needs a non-negative integer.');

  for (let attempt = 0; attempt < 3; attempt++) {
    const archives = await retainedArchives(logFile);
    const report = await summarizeFiles(logFile, archives, window, last);
    const current = await retainedArchives(logFile);
    // Retry if the active file rotated or an archive was replaced while reading.
    if (archives.length === current.length && archives.every((file, index) => file === current[index])) return report;
  }
  throw new Error('Judge logs kept rotating while the report was reading them. Retry the report.');
}
