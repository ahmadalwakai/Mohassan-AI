import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';
import { createJudgeLogWriter } from '../apps/server/src/assistant/judge-shadow-log.js';

describe('judge log rotation', () => {
  let directory: string;
  let log: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-rotation-'));
    log = join(directory, 'shadow.jsonl');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const archives = async () => (await readdir(directory)).filter(name => /^shadow\.jsonl\.\d{13}\.gz$/u.test(name)).sort();
  const unzip = async (name: string) => gunzipSync(await readFile(join(directory, name))).toString('utf8');
  const runIds = (text: string) => text.trimEnd().split('\n').map(line => JSON.parse(line).runId);

  it('keeps complete, ordered records when queued observations span midnight UTC', async () => {
    let time = new Date('2026-11-24T23:59:59Z');
    const shadow = createJudgeShadow({ logFile: log, now: () => time });
    const input = { conversationId: 'conversation', question: 'How are you?', reply: 'I am fine.' };
    shadow.observe({ ...input, runId: 'first' });
    shadow.observe({ ...input, runId: 'second' });
    time = new Date('2026-11-25T00:00:00Z');
    shadow.observe({ ...input, runId: 'third' });
    await shadow.flush();

    const names = await archives();
    expect(names).toHaveLength(1);
    expect(runIds(await unzip(names[0]!))).toEqual(['first', 'second']);
    expect(runIds(await readFile(log, 'utf8'))).toEqual(['third']);
  });

  it('uses UTF-8 bytes for the cap and keeps only the newest 14 archives', async () => {
    const records = Array.from({ length: 17 }, (_, id) => `${JSON.stringify({ id: String(id).padStart(2, '0'), text: 'ن' })}\n`);
    const limit = Buffer.byteLength(records[0]!) * 2 - 1;
    const append = createJudgeLogWriter(log, limit);
    await writeFile(`${log}.notes`, 'unrelated');
    for (const record of records) await append(record, '2026-11-25');

    const names = await archives();
    expect(names).toHaveLength(14);
    expect(await Promise.all(names.map(unzip))).toEqual(records.slice(-15, -1));
    expect(await readFile(log, 'utf8')).toBe(records.at(-1));
    expect(await readFile(`${log}.notes`, 'utf8')).toBe('unrelated');
    expect(await readdir(directory)).toHaveLength(names.length + 2);
  });

  it('recovers an interrupted gzip and rotates a previous UTC day after a restart', async () => {
    const pending = `${log}.${new Date('2026-11-23T00:00:00Z').getTime()}`;
    await writeFile(pending, '{"runId":"before restart"}\n');
    await writeFile(`${pending}.tmp`, 'incomplete gzip');
    await writeFile(log, '{"runId":"yesterday"}\n');
    const yesterday = new Date('2026-11-24T23:55:00Z');
    await utimes(log, yesterday, yesterday);

    await createJudgeLogWriter(log)('{"runId":"today"}\n', '2026-11-25');

    const names = await archives();
    expect(names).toHaveLength(2);
    expect(runIds((await Promise.all(names.map(unzip))).join(''))).toEqual(['before restart', 'yesterday']);
    expect(runIds(await readFile(log, 'utf8'))).toEqual(['today']);
    await expect(readFile(pending)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${pending}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
