import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['production', undefined, false],
  ['production', 'true', false],
  ['production', 'off', false],
  ['production', 'owner', true],
  ['development', undefined, true],
  ['development', 'owner', true],
  ['development', 'off', false],
] as const)('sets the coding link for %s with CODING_DEVICE_LINK=%s', async (environment, flag, enabled) => {
  vi.stubEnv('MOHASSAN_ISOLATED_TEST', 'true');
  vi.stubEnv('NODE_ENV', environment);
  vi.stubEnv('CODING_DEVICE_LINK', flag);
  const { getConfig } = await import('../apps/server/src/config.js');
  expect(getConfig().codingDeviceLink).toBe(enabled);
});
