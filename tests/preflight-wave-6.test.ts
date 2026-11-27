import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const preflight = fileURLToPath(new URL('../scripts/cloud-linux/preflight-wave-6.mjs', import.meta.url));
const example = new URL('../scripts/cloud-linux/model-worker.v5.example.json', import.meta.url);

function runPreflight({ changePendingLimit = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wave-6-preflight-'));
  try {
    const workerConfig = join(directory, 'model-worker.json');
    const envFile = join(directory, 'server.env');
    const config = JSON.parse(readFileSync(example, 'utf8'));
    config.model.checkpoint.path = join(directory, 'unavailable-checkpoint');
    config.model.tokenizer.path = join(directory, 'unavailable-tokenizer');
    if (changePendingLimit) config.limits.maxPending += 1;
    writeFileSync(workerConfig, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(envFile, [
      'MOHASSAN_MODEL_WORKER=1', 'MOHASSAN_V5_CHAT=owner',
      `MOHASSAN_MODEL_WORKER_CONFIG=${workerConfig}`,
      `EXECUTOR_PYTHON=${join(directory, 'unavailable-executor')}`,
    ].join('\n'), { mode: 0o600 });
    const result = spawnSync(process.execPath, [preflight, '--owner-v5', '--env-file', envFile,
      '--service-user', userInfo().username], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('owner v5 preflight', () => {
  it('reports when the configured resident worker interpreter is unavailable', () => {
    expect(runPreflight()).toContain('FAIL trusted Python 3.12 for the v5 model worker');
  });

  it('rejects changes to the reviewed queue and resource limits', () => {
    expect(runPreflight()).toMatch(/^OK v5 worker config exists with the expected identity/m);
    expect(runPreflight({ changePendingLimit: true })).toMatch(/^FAIL v5 worker config exists with the expected identity/m);
  });
});
