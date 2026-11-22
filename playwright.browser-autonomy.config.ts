import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/assistant-browser-cursor.spec.ts',
  globalSetup: './tests/e2e/browser-autonomy-setup.ts',
  outputDir: './test-results/browser-autonomy',
});
