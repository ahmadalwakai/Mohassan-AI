import { vi } from 'vitest';

// Deterministic test-only labels in place of the generated local vocabulary artifact.
export const hostnameWords = Array.from({ length: 8 }, (_, index) => `grammarfixture${index}`);

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: vi.fn(fs.readFileSync).mockImplementation((file, options) => {
      if (file === 'artifacts/ads-training/service-vocab.json') {
        return JSON.stringify({ words: hostnameWords });
      }
      return fs.readFileSync(file, options);
    }),
  };
});
