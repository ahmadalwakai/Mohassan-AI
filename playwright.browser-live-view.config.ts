import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/browser-live-view.spec.ts',
  testIgnore: [],
  timeout: 120_000,
  globalSetup: './tests/e2e/browser-live-view-setup.ts',
  outputDir: './test-results/browser-live-view',
});
