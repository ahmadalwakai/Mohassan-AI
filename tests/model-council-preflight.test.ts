import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memberCouncilModelStorePresent, memberCouncilPreflightConfig } from '../scripts/cloud-linux/model-council-preflight.js';

describe('member council deploy preflight', () => {
  it.each([undefined, 'owner', 'off', 'ALL'])('only requires member council checks with all (got %s)', mode => {
    expect(memberCouncilPreflightConfig({ MOHASSAN_MODEL_COUNCIL: mode })).toBeUndefined();
  });

  it('checks the shared rollout limits and requires a configured store', () => {
    const config = memberCouncilPreflightConfig({ MOHASSAN_MODEL_COUNCIL: 'all' });
    expect(config?.hasLimits).toBe(true);
    expect(memberCouncilModelStorePresent(config?.modelStore ?? '')).toBe(false);
  });

  it('requires the configured store to be an accessible absolute directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'member-council-preflight-'));
    try {
      const file = join(directory, 'file');
      writeFileSync(file, '');
      const config = memberCouncilPreflightConfig({ MOHASSAN_MODEL_COUNCIL: 'all', MOHASSAN_MODELS_ROOT: ` ${directory} ` });
      expect(config?.modelStore).toBe(directory);
      expect(memberCouncilModelStorePresent(directory)).toBe(true);
      expect(memberCouncilModelStorePresent(file)).toBe(false);
      expect(memberCouncilModelStorePresent(join(directory, 'missing'))).toBe(false);
      expect(memberCouncilModelStorePresent('.')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux' || !process.versions.node.startsWith('24.') || !process.getuid?.())(
    'runs the council checks through the deploy preflight as an unprivileged account', () => {
      const directory = mkdtempSync(join(tmpdir(), 'member-council-deploy-'));
      try {
        const envFile = join(directory, 'server.env');
        writeFileSync(envFile, `MOHASSAN_MODEL_COUNCIL=all\nMOHASSAN_MODELS_ROOT=${directory}\n`, { mode: 0o600 });
        const preflight = fileURLToPath(new URL('../scripts/cloud-linux/preflight-wave-6.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [preflight, '--env-file', envFile, '--service-user', userInfo().username],
          { encoding: 'utf8', timeout: 15_000 });
        expect(result.error).toBeUndefined();
        expect(result.stdout).toContain('OK member council concurrency and queue limits are set');
        expect(result.stdout).toContain('OK member council model store is accessible to the service account');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
});
