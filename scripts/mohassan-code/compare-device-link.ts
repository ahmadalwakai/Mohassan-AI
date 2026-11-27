import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const sets = ['slice2', 'before-after', 'logic', 'show-change', 'instructions', 'rename', 'projects', 'suite'];
const replyFields = ['firstText', 'afterQuestionText', 'approvalPrompt', 'approvalDetail', 'finalText'] as const;
type Row = Record<string, unknown> & { id: string; control?: boolean; met?: boolean; ms?: number };
interface Report { set: string; realSandbox: boolean; viaDeviceLink: boolean; rows: Row[]; tasks?: string[]; totals?: unknown }

function normalizeReply(text: string) {
  return text
    .replace(/\bmohassan\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, 'mohassan/<task-id>')
    .replace(/(\bgit merge --ff-only -- )[0-9a-f]{40,64}\b/giu, '$1<checkpoint-id>')
    .replace(/(http:\/\/127\.0\.0\.1:)\d{1,5}(\/france\b)/gu, '$1<fixture-port-id>$2')
    .replace(/( · (?:read|قُرئت) )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/gu, '$1<read-time>')
    .replace(/\bmohassan-measure-coding-[a-z0-9]{6}\b/giu, 'mohassan-measure-coding-<fixture-id>');
}

function observations({ ms: _ms, ...row }: Row) {
  const replies = replyFields.map(field => typeof row[field] === 'string' ? normalizeReply(row[field]) : row[field]);
  const outcome: Record<string, unknown> = { ...row };
  for (const field of replyFields) delete outcome[field];
  return { replies, outcome };
}

function outcomeLabel(row: Row) {
  const phases = [row.first, row.afterQuestion, row.final].filter(Boolean).join(' → ');
  const result = row.codingOutcome ?? row.codingTaskStatus;
  return [phases, result, row.met === undefined ? null : row.met ? 'met' : 'miss'].filter(Boolean).join(' / ');
}

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx scripts/mohassan-code/compare-device-link.ts <report-directory>');
let matches = 0;
let total = 0;
let equivalentReports = true;
console.log('| Set | Case | Role | Local outcome | Device outcome | Replies |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const set of sets) {
  const [local, device] = await Promise.all(['local', 'device'].map(async arm =>
    JSON.parse(await readFile(join(directory, `${set}-${arm}.json`), 'utf8')) as Report));
  if (local.set !== set || device.set !== set || local.viaDeviceLink !== false || device.viaDeviceLink !== true
    || local.realSandbox !== device.realSandbox || local.rows.length !== device.rows.length
    || new Set(local.rows.map(row => row.id)).size !== local.rows.length
    || new Set(device.rows.map(row => row.id)).size !== device.rows.length) {
    throw new Error(`${set}: reports use different fixtures or have missing or duplicate cases`);
  }
  if (!isDeepStrictEqual(local.tasks, device.tasks) || !isDeepStrictEqual(local.totals, device.totals)) {
    console.error(`${set}: task inventory or totals differ`);
    equivalentReports = false;
  }
  for (const before of local.rows) {
    const after = device.rows.find(row => row.id === before.id);
    if (!after) throw new Error(`${set}/${before.id}: case missing from device report`);
    const original = observations(before), throughLink = observations(after);
    const sameOutcome = isDeepStrictEqual(original.outcome, throughLink.outcome);
    const sameReplies = isDeepStrictEqual(original.replies, throughLink.replies);
    total++;
    if (sameOutcome && sameReplies) matches++;
    else console.error(JSON.stringify({ set, case: before.id, sameOutcome, sameReplies, local: original, device: throughLink }));
    console.log(`| ${set} | ${before.id} | ${before.control ? 'Control' : 'Target'} | ${outcomeLabel(before)} | ${outcomeLabel(after)} | ${sameReplies ? 'Same' : 'Different'} |`);
  }
}
console.log(`\n${matches}/${total} cases matched.`);
if (!equivalentReports || matches !== total) process.exitCode = 1;
