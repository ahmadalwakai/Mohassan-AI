import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';

describe('judge shadow', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-shadow-')); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it('logs one line per reply with the verdict and never changes the reply', async () => {
    const shadow = createJudgeShadow({ logFile: join(directory, 'nested', 'shadow.jsonl'), now: () => new Date('2026-11-22T05:00:00Z') });
    const reply = ['فيما انخفضت الأقلية اليهودية المغربية ويصل عددها إلى نحو 6,000.', '', '**تفاصيل أخرى من نفس المصدر:**', '- حسب إحصاء سنة 2024، يبلغ عدد سكان المغرب 37 مليون نسمة.', '', '**المصدر:** [ويكيبيديا — المغرب](https://ar.wikipedia.org/wiki/m)'].join('\n');
    const verdict = shadow.observe({ conversationId: 'c1', runId: 'r1', question: 'كم عدد سكان المغرب؟', reply, status: 'completed' });
    expect(verdict?.decision).toBe('fix');
    const plain = shadow.observe({ conversationId: 'c1', runId: 'r2', question: 'كم يساوي 15 ضرب 23؟', reply: '15 * 23 = 345', status: 'completed' });
    expect(plain?.decision).toBe('send');
    await shadow.flush();
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ at: '2026-11-22T05:00:00.000Z', conversationId: 'c1', runId: 'r1', decision: 'fix', applied: false, kind: 'answer', sourced: true, evidence: 0, support: null });
    expect(lines[0]!.codes).toContain('lead_not_best');
    expect(lines[0]!.fixedReply?.split('\n')[0]).toMatch(/^حسب إحصاء سنة 2024/u);
    expect(lines[0]!.reply).toBe(reply);
    expect(lines[1]).toMatchObject({ runId: 'r2', decision: 'send', kind: 'computed' });
    expect(typeof lines[1]!.ms).toBe('number');
  });

  it('marks a line as applied only when the host said it would send the fix and a fix exists', async () => {
    const shadow = createJudgeShadow({ logFile: join(directory, 'applied.jsonl') });
    const reply = ['فيما انخفضت الأقلية اليهودية المغربية ويصل عددها إلى نحو 6,000.', '', '**تفاصيل أخرى من نفس المصدر:**', '- حسب إحصاء سنة 2024، يبلغ عدد سكان المغرب 37 مليون نسمة.', '', '**المصدر:** [ويكيبيديا — المغرب](https://ar.wikipedia.org/wiki/m)'].join('\n');
    shadow.observe({ conversationId: 'c4', runId: 'r1', question: 'كم عدد سكان المغرب؟', reply, applyFix: true });
    shadow.observe({ conversationId: 'c4', runId: 'r2', question: 'كم يساوي 15 ضرب 23؟', reply: '15 * 23 = 345', applyFix: true });
    await shadow.flush();
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
    expect(lines[0]).toMatchObject({ runId: 'r1', decision: 'fix', applied: true });
    expect(lines[0]!.reply).toBe(reply);
    expect(lines[1]).toMatchObject({ runId: 'r2', decision: 'send', applied: false });
  });

  it('returns null instead of throwing when the input is broken', async () => {
    const shadow = createJudgeShadow({ logFile: join(directory, 'broken.jsonl') });
    expect(shadow.observe({ conversationId: 'c2', runId: 'r1', question: undefined as unknown as string, reply: undefined as unknown as string })).not.toBeUndefined();
    await shadow.flush();
  });

  it('drains the queued log and refuses new observations from the start of close', async () => {
    const shadow = createJudgeShadow({ logFile: join(directory, 'closing', 'judge.jsonl') });
    const input = { conversationId: 'c3', question: 'What is 3 + 4?', reply: '3 + 4 = 7' };
    shadow.observe({ ...input, runId: 'queued' });
    const closed = shadow.close();
    expect(shadow.observe({ ...input, runId: 'during-close' })).toBeNull();
    await closed;
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
    expect(lines.map(line => line.runId)).toEqual(['queued']);
    expect(shadow.observe({ ...input, runId: 'after-close' })).toBeNull();
  });
});
