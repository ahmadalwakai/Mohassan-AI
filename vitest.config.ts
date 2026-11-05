import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000, maxWorkers: 1, fileParallelism: false } });
