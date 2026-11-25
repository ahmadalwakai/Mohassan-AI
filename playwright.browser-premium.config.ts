import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['**/browser-premium-matrix.ts', '**/browser-premium-frame.ts'],
  globalSetup: './tests/e2e/browser-premium-setup.ts',
  outputDir: './test-results/browser-premium',
  snapshotPathTemplate: './docs/browser-premium-ux/{arg}{ext}',
  timeout: 120_000,
  use: {
    ...base.use,
    deviceScaleFactor: 1,
    launchOptions: { args: ['--force-device-scale-factor=1'] },
  },
});
