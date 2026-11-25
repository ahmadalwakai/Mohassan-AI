import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

describe('model commands', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mohassan-model-cli-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MOHASSAN_MODEL_WORKER_CONFIG: join(scratch, 'missing-worker.json'), MOHASSAN_OCR_MODEL_DIR: scratch },
      timeout: 15_000,
    });
  }

  it('lists a checked-in classifier and reports a missing worker configuration as absent', () => {
    const list = run('list');
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'refusal', state: expect.stringMatching(/^(experimental|shadow|active)$/u) }),
      expect.objectContaining({ id: 'google-ads-pointer', state: 'absent' }),
    ]));

    const health = run('health', 'google-ads-pointer');
    expect(health.status).toBe(1);
    expect(JSON.parse(health.stdout)).toMatchObject({ ok: false, reason: 'absent' });
  });

  it('lists the observed digest of an installed artifact without a declared pin', async () => {
    const weights = Buffer.from('local OCR artifact');
    await writeFile(join(scratch, 'manifest.json'), '{}');
    await writeFile(join(scratch, 'weights.bin'), weights);

    const list = run('list');
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout).find((entry: { id: string }) => entry.id === 'ocr')).toMatchObject({
      artifacts: expect.arrayContaining([expect.objectContaining({
        role: 'weights', present: true, expectedSha256: null, sha256: createHash('sha256').update(weights).digest('hex'),
      })]),
    });
  });

  it('checks, runs and measures a checked-in model from a BOM-prefixed JSON input', async () => {
    const input = join(scratch, 'input.json');
    await writeFile(input, '\uFEFF{"text":"What is the time?"}', 'utf8');

    const health = run('health', 'refusal');
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({ ok: true });

    const prediction = run('run', 'refusal', input);
    expect(prediction.status, prediction.stdout || prediction.stderr).toBe(0);
    expect(JSON.parse(prediction.stdout)).toMatchObject({ ok: true, output: expect.any(Object) });

    const latency = run('latency', 'refusal', input, '3');
    expect(latency.status, latency.stdout || latency.stderr).toBe(0);
    const result = JSON.parse(latency.stdout);
    expect(result).toMatchObject({ modelId: 'refusal', iterations: 3, coldMs: expect.any(Number), medianMs: expect.any(Number), p95Ms: expect.any(Number) });
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.medianMs);
  });

  it('rejects malformed inputs without echoing their content', async () => {
    const input = join(scratch, 'input.json');
    await writeFile(input, 'local text', 'utf8');

    const result = run('run', 'refusal', input);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Input file contains invalid JSON.\n');
    expect(result.stdout).toBe('');
  });

  it('summarizes only comparable shadow calls in the disagreement denominator', async () => {
    const log = join(scratch, 'shadow.jsonl');
    const rows = [
      [{ model: 'refusal', attempted: true, disagreed: true }],
      [{ model: 'refusal', attempted: true, disagreed: false }],
      [{ model: 'refusal', attempted: false, fallback: 'existing-rules' }],
    ].map(models => JSON.stringify({ event: 'model_relations_turn', mode: 'shadow', stages: [{ models }] }));
    await writeFile(log, rows.join('\r\n') + '\r\n');

    const result = run('shadow-summary', log);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      turns: 3,
      models: [{ model: 'refusal', considered: 3, attempted: 2, compared: 2, disagreements: 1,
        fallbacks: 1, disagreementRate: 0.5 }],
    });
  });
});
