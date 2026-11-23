import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The agent execution story (docs/architecture/agent-execution.md) through the real server and web app on the isolated
 * fixture, with the local deterministic controller (no scripted model replies), as production runs today.
 */
export default defineConfig({
  ...base,
  testMatch: '**/agent-execution.spec.ts',
  globalSetup: './tests/e2e/browser-autonomy-setup.ts',
  outputDir: './test-results/agent-execution',
});
