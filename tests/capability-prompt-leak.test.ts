import { expect, test } from 'vitest';
import { capabilityLeakBaseline, findAddedCapabilityInputs, hasGitObject, readCapabilityInputs } from './helpers/capability-prompt-leak.js';

const development = 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f:tests/fixtures/agent-capability-bench/development.json';

test.skipIf(!hasGitObject(capabilityLeakBaseline))('reports added case inputs by path and ID', () => {
  const insertedText = ['The benchmark partition', 'has no chat inputs.'].join(' ');
  const results = findAddedCapabilityInputs([{ id: 'example', turns: [{ text: insertedText }] }]);
  expect(results).toEqual(['tests/helpers/capability-prompt-leak.ts (example)']);
});

// Shallow checkouts can opt in by fetching the frozen benchmark branch and product baseline.
test.skipIf(!hasGitObject(development) || !hasGitObject(capabilityLeakBaseline))('keeps frozen development prompts out of product files and tests', () => {
  expect(findAddedCapabilityInputs(readCapabilityInputs(development))).toEqual([]);
});
