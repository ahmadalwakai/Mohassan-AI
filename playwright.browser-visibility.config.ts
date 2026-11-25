import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** The browser levels stories run against the model-free brain (local brain fixture), like the cursor story. */
export default defineConfig({
  ...base,
  testMatch: ['**/assistant-browser-visibility.spec.ts', '**/browser-live-view.spec.ts'],
  timeout: 120_000,
  globalSetup: './tests/e2e/browser-autonomy-setup.ts',
  outputDir: './test-results/browser-visibility',
});
