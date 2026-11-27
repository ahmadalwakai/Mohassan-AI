import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
    env: {
      MOHASSAN_ISOLATED_TEST: 'true',
      MOHASSAN_MODEL_COUNCIL: 'off',
      MOHASSAN_MODEL_RELATIONS: 'off',
    },
  },
});
