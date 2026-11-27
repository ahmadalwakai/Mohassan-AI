import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      timeout: args[0] === 'budgets' ? 60_000 : 15_000,
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

  it.skipIf(process.platform !== 'linux')('writes a bilingual budget receipt for the checked-in CPU models', async () => {
    const path = join(scratch, 'budgets.json');
    const result = run('budgets', path, '1');
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    expect(JSON.parse(result.stdout)).toEqual(receipt);
    expect(receipt).toMatchObject({
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      machine: { arch: process.arch, platform: process.platform },
      samplesPerLanguage: 1,
    });
    const checkedIn = ['arithmetic', 'refusal', 'scratch-follow-up', 'scratch-refusal', 'scratch-route', 'scratch-speech-act'];
    const stats = { p50: expect.any(Number), p95: expect.any(Number) };
    const sha256 = expect.stringMatching(/^[0-9a-f]{64}$/u);
    const language = { inputSha256: sha256, sourceSha256: sha256, coldStartMs: stats,
      warmCallMs: stats, peakRssKiB: expect.any(Number) };
    for (const modelId of checkedIn) {
      const row = receipt.models.find((model: { modelId: string }) => model.modelId === modelId);
      expect(row).toMatchObject({ status: 'measured', languages: { ar: language, en: language } });
      expect(row.languages.ar.inputSha256).not.toBe(row.languages.en.inputSha256);
      expect(row.languages.ar.peakRssKiB).toBeGreaterThan(0);
      expect(row.languages.en.peakRssKiB).toBeGreaterThan(0);
    }
    expect(receipt.models.find((model: { modelId: string }) => model.modelId === 'google-ads-pointer'))
      .toMatchObject({ status: 'absent' });
  }, 65_000);

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
    expect(JSON.parse(result.stdout)).toMatchObject({
      turns: 3,
      turnsByLanguage: { ar: 0, en: 0, mixed: 0, unknown: 3 },
      models: [{ model: 'refusal', considered: 3, attempted: 2, compared: 2, disagreements: 1,
        fallbacks: 1, disagreementRate: 0.5,
        byLanguage: { unknown: { compared: 2, disagreements: 1, outcomes: { unknown: { numerator: 3, denominator: 3 } } } } }],
    });
  });

  it('reports each shadow failure over the considered calls in its language', async () => {
    const log = join(scratch, 'shadow.jsonl');
    const observations = [
      { language: 'ar', outcome: 'ok', disagreed: true },
      { language: 'ar', outcome: 'busy' },
      { language: 'en', outcome: 'ok', disagreed: false },
      { language: 'en', outcome: 'timeout', attempted: false },
      { language: 'mixed', outcome: 'absent' },
      { language: 'mixed', outcome: 'unhealthy' },
    ];
    const rows = observations.map(({ language, outcome, attempted = true, disagreed }) => JSON.stringify({
      event: 'model_relations_turn', mode: 'shadow', language,
      stages: [{ models: [{ model: 'refusal', outcome, attempted, disagreed,
        ...(outcome === 'ok' ? {} : { fallback: 'existing-rules' }) }] }],
    }));
    await writeFile(log, rows.join('\n') + '\n');

    const result = run('shadow-summary', log);
    expect(result.status, result.stderr).toBe(0);
    const share = (numerator: number, denominator: number) => ({ numerator, denominator });
    expect(JSON.parse(result.stdout)).toMatchObject({
      turnsByLanguage: { ar: 2, en: 2, mixed: 2, unknown: 0 },
      models: [{ model: 'refusal', considered: 6, attempted: 5, compared: 2, disagreements: 1, fallbacks: 4,
        outcomes: { ok: share(2, 6), busy: share(1, 6), timeout: share(1, 6), absent: share(1, 6), unhealthy: share(1, 6) },
        byLanguage: {
          ar: { compared: 1, disagreements: 1, outcomes: { ok: share(1, 2), busy: share(1, 2) } },
          en: { compared: 1, disagreements: 0, outcomes: { ok: share(1, 2), timeout: share(1, 2) } },
          mixed: { compared: 0, disagreements: 0, outcomes: { absent: share(1, 2), unhealthy: share(1, 2) } },
        } }],
    });
  });

  it('reports arbiter disagreements separately from actual changes', async () => {
    const log = join(scratch, 'shadow.jsonl');
    const rows = [
      { precedence: 'writer', proposed: 'planner', selected: 'writer', reason: 'shadow', elapsedMs: 0.4 },
      { precedence: 'writer', proposed: 'planner', selected: 'planner', reason: 'higher-pass-likelihood', elapsedMs: 0.2 },
      { precedence: 'writer', proposed: 'writer', selected: 'writer', reason: 'killed', elapsedMs: 0.1 },
    ].map(decision => JSON.stringify({
      event: 'model_relations_turn', mode: 'shadow', stages: [], arbiter: [{ type: 'compound-plan', ...decision }],
    }));
    await writeFile(log, rows.join('\n') + '\n');

    const result = run('shadow-summary', log);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).arbiter).toEqual([{
      type: 'compound-plan', contested: 3, disagreements: 2, changed: 1, disagreementRate: 2 / 3,
      reasons: { shadow: 1, 'higher-pass-likelihood': 1, killed: 1 },
      disagreementsByChoice: { 'writer → planner': 2 }, p95Ms: 0.4,
    }]);
  });
});
