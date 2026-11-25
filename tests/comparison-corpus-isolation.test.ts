import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { addsInputLiteral, scanCapabilityCorpus } from './helpers/comparison-corpus-isolation.js';

const development = resolve(import.meta.dirname, 'fixtures/agent-capability-bench/development.json');

it('detects a copied input even when the source escapes quotes or a newline', () => {
  const input = "Lift the workshop's gate.\nCheck the latch.";
  const existing = "'Lift the workshop\\'s gate.\\nCheck the latch.'";
  expect(addsInputLiteral(existing, '', input)).toBe(true);
  expect(addsInputLiteral(existing, existing, input)).toBe(false);
  expect(addsInputLiteral(`${existing}\n${existing}`, existing, input)).toBe(true);
});

// The development corpus is present in the benchmark scratch merge.
it.skipIf(!existsSync(development))('keeps capability development inputs out of the source tree', () => {
  expect(scanCapabilityCorpus(development).leaks).toEqual([]);
});
