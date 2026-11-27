import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareProbe } from './budget-inputs.js';
import { hashBudgetBytes } from './budget-receipt.js';
import { getModelEntry } from './registry.js';

it('creates fixed bilingual OCR inputs from the committed screenshot', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'mohassan-budget-inputs-'));
  const model = { entry: getModelEntry('ocr')!, state: 'active' as const, artifacts: [] };
  try {
    const arabic = await prepareProbe(root, scratch, model, 'ar');
    const english = await prepareProbe(root, scratch, model, 'en');
    const screenshot = await readFile(join(root, 'apps/android/docs/screenshots/image-done.jpg'));
    expect(arabic.sourceSha256).toBe(hashBudgetBytes(screenshot));
    expect(english.sourceSha256).toBe(arabic.sourceSha256);
    expect(arabic.inputSha256).toBe(hashBudgetBytes(await readFile(join(scratch, 'ar.png'))));
    expect(english.inputSha256).toBe(hashBudgetBytes(await readFile(join(scratch, 'en.png'))));
    expect(arabic.inputSha256).not.toBe(english.inputSha256);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});
