import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, testMatch: '**/skills-focus-audit.ts',
  use: { ...base.use, trace: 'on' },
});
