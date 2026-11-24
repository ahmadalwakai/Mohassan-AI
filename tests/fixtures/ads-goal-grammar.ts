import { vi } from 'vitest';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      if (file === 'artifacts/ads-training/service-vocab.json') {
        return JSON.stringify({ words: ['testalder', 'testbirch', 'testcedar', 'testelm', 'testmaple', 'testpine', 'testrowan', 'testwillow'] });
      }
      return fs.readFileSync(file, options);
    }),
  };
});
