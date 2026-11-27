import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/assistant-conversation-paging.e2e.ts',
  timeout: 90_000,
  globalSetup: './tests/e2e/conversation-paging-setup.ts',
  outputDir: './test-results/conversation-paging',
});
