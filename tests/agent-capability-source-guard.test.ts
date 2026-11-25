import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { capabilityDevelopmentFixture, findCapabilityInputLeaks, findCapabilityPartitionLeaks } from './helpers/agent-capability-source-guard.js';

const root = fileURLToPath(new URL('../', import.meta.url));

it('rejects benchmark inputs and field answers copied into source and tests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-leak-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const write = (path: string, text: string) => {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    const text = 'Can the amber directory\nbe sorted?';
    const field = "An arranger's cabinet";
    write(capabilityDevelopmentFixture, text);
    write('scripts/agent-capability-bench/sample.ts', text);
    write('apps/server/source.ts', `const sample = ${JSON.stringify(text)};`);
    write('tests/copied.test.ts', "const field = 'An arranger\\'s cabinet';");

    expect(findCapabilityInputLeaks(directory, [{
      id: 'boundary-sentinel',
      turns: [{ text }, { text: '', fields: { subject: field } }],
    }])).toEqual([
      'apps/server/source.ts:1 (boundary-sentinel, turn 1)',
      'tests/copied.test.ts:1 (boundary-sentinel, turn 2)',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The frozen fixture lives on the benchmark branch and is available in a scratch merge.
it.skipIf(!existsSync(join(root, capabilityDevelopmentFixture)))('keeps frozen development inputs inside the benchmark', () => {
  expect(findCapabilityPartitionLeaks(root, 'development')).toEqual([]);
});
