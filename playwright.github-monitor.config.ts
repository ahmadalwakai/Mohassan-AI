import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/smart-monitors-github.spec.ts',
  timeout: 120_000,
  use: { ...base.use, serviceWorkers: 'block' },
  globalSetup: './tests/e2e/github-monitor-setup.ts',
  outputDir: './test-results/github-monitor',
});
