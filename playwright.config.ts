import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,
  expect:{timeout:15000},
  use:{baseURL:'http://127.0.0.1:3100',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'node scripts/e2e-server.mjs',url:'http://127.0.0.1:3100/api/setup',reuseExistingServer:false,timeout:180000},
});
