import { defineConfig, devices } from '@playwright/test';
// The isolated fixture listens on 3100 unless MOHASSAN_E2E_WEB_PORT names another port (tests/e2e/isolation.ts validates it).
const webPort = process.env.MOHASSAN_E2E_WEB_PORT || '3100';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,
  testIgnore:'**/smart-monitors-github.spec.ts',
  expect:{timeout:15000},
  use:{baseURL:`http://127.0.0.1:${webPort}`,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  globalSetup:'./tests/e2e/global-setup.ts',
});
