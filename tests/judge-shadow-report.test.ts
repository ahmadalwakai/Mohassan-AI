import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJudgeLogWriter } from '../apps/server/src/assistant/judge-shadow-log.js';
import type { JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { summarizeJudgeShadow } from '../scripts/judge/shadow-summary.js';

type FixtureLine = Omit<JudgeShadowLine, 'origin'> & { origin?: string };
const defaults: Omit<FixtureLine, 'at'> = {
  conversationId: 'fixture', runId: 'fixture', question: 'What did I ask last time?', previous: null,
  reply: 'Here is the answer.', status: 'completed', decision: 'send', applied: false, withholdText: null,
  kind: 'answer', lang: 'en', intent: 'fixture', answerType: null, sourced: false, codes: [], findings: [],
  lead: null, best: null, fixedReply: null, support: null, evidence: 0, ms: 1,
};
const records: FixtureLine[] = [
  {
    ...defaults, at: '2026-11-24T23:59:59.999Z', decision: 'fix', applied: true, kind: 'quote',
    codes: ['lead_not_best'], evidence: 1, support: { supported: 1, sentences: 2 },
  },
  {
    ...defaults, at: '2026-11-25T00:00:00.000Z', origin: 'pipeline', textKept: false, question: '', reply: '',
    conversationReview: { version: 1, action: 'note', applied: false, ms: 1, findings: [
      { check: 'corrections', code: 'corrected_value_repeated' },
      { check: 'corrections', code: 'corrected_value_repeated' },
    ] },
  },
  {
    ...defaults, at: '2026-11-25T12:30:00.000Z', origin: 'chat-v5', textKept: true, decision: 'withhold',
    codes: ['evidence_unavailable', 'language_mismatch'],
    conversationReview: { version: 1, action: 'note', applied: false, ms: 1, findings: [
      { check: 'contradiction', code: 'earlier_claim_conflict' },
    ] },
  },
  {
    ...defaults, at: '2026-11-26T00:00:00.000Z', origin: 'fixture-council-member', textKept: true,
    conversationReview: { version: 1, action: 'send', applied: false, ms: 1, findings: [] },
  },
];

describe('judge shadow report', () => {
  let directory: string;
  let log: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-report-'));
    log = join(directory, 'shadow.jsonl');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const archiveNames = async () => (await readdir(directory)).filter(name => /^shadow\.jsonl\.\d{13}\.gz$/u.test(name));

  async function writeRecords(lines: FixtureLine[]) {
    const append = createJudgeLogWriter(log);
    for (const line of lines) await append(`${JSON.stringify(line)}\n`, line.at.slice(0, 10));
  }

  it('counts the active log and UTC archives, including legacy rows and review findings', async () => {
    await writeRecords(records);
    expect(await archiveNames()).toHaveLength(2);

    const { summary, recent } = await summarizeJudgeShadow(log, { last: 2 });

    expect(summary).toMatchObject({ since: null, from: records[0].at, to: records[3].at,
      support: { repliesWithEvidence: 1, supported: 1, sentences: 2 } });
    expect(summary.all).toEqual({
      total: records.length, applied: 1, decision: { send: 2, fix: 1, withhold: 1 }, kind: { answer: 3, quote: 1 },
      code: { lead_not_best: 1, evidence_unavailable: 1, language_mismatch: 1 },
      origin: { pipeline: 2, 'chat-v5': 1, 'fixture-council-member': 1 },
      conversationReview: {
        total: 3, applied: 0, action: { note: 2, send: 1 }, check: { corrections: 2, contradiction: 1 },
        code: { corrected_value_repeated: 2, earlier_claim_conflict: 1 },
      },
    });
    expect(summary.textKept).toMatchObject({
      total: 3, decision: { fix: 1, withhold: 1, send: 1 }, origin: { pipeline: 1, 'chat-v5': 1, 'fixture-council-member': 1 },
      conversationReview: { total: 2, action: { note: 1, send: 1 }, check: { contradiction: 1 } },
    });
    expect(summary.textOmitted).toMatchObject({
      total: 1, decision: { send: 1 }, origin: { pipeline: 1 },
      conversationReview: { total: 1, action: { note: 1 }, check: { corrections: 2 } },
    });
    expect(recent.map(line => line.at)).toEqual(records.slice(-2).map(line => line.at));

    const { summary: windowed } = await summarizeJudgeShadow(log, { days: 2, now: new Date('2026-11-26T18:00:00Z') });
    expect(windowed).toMatchObject({
      since: records[1].at, from: records[1].at, to: records[3].at, all: { total: 3, origin: { pipeline: 1 } },
      textKept: { total: 2 }, textOmitted: { total: 1 },
    });
    const { summary: today } = await summarizeJudgeShadow(log, { days: 1, now: new Date('2026-11-25T18:00:00Z') });
    expect(today).toMatchObject({
      since: records[1].at, until: records[3].at, from: records[1].at, to: records[2].at, all: { total: 2 },
    });

    const reportScript = fileURLToPath(new URL('../scripts/judge/shadow-report.ts', import.meta.url));
    const json = execFileSync(process.execPath, ['--import', 'tsx', reportScript, '--log', log, '--since', '2026-11-25T13:30:00+01:00', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(json)).toMatchObject({
      since: records[2].at, from: records[2].at, to: records[3].at,
      all: { total: 2, origin: { 'chat-v5': 1, 'fixture-council-member': 1 } },
      textKept: { total: 2 }, textOmitted: { total: 0 },
    });
    expect(json).not.toContain(defaults.question);
    expect(json).not.toContain(defaults.reply);
  });

  it('counts an interrupted rotation once while the plain and gzipped archive coexist', async () => {
    await writeRecords(records.slice(0, 2));
    const [archive] = await archiveNames();
    const gzip = join(directory, archive);
    await writeFile(gzip.slice(0, -3), `${JSON.stringify(records[0])}\n`);
    expect((await summarizeJudgeShadow(log)).summary.all.total).toBe(2);
    await rm(gzip);
    expect((await summarizeJudgeShadow(log)).summary.all.total).toBe(2);
  });

  it('rejects ambiguous windows and returns zero counts when no entries match', async () => {
    await expect(summarizeJudgeShadow(log, { days: 2, since: '2026-11-25' })).rejects.toThrow('Use either --days or --since.');
    await expect(summarizeJudgeShadow(log, { days: 0 })).rejects.toThrow('--days needs a positive integer.');
    await expect(summarizeJudgeShadow(log, { since: '2026-11-31' })).rejects.toThrow('--since needs a date');
    expect((await summarizeJudgeShadow(log)).summary).toMatchObject({ from: null, to: null, all: { total: 0 } });
    await writeRecords(records.slice(0, 1));
    expect((await summarizeJudgeShadow(log, { since: '2026-11-25' })).summary.all.total).toBe(0);
  });
});
