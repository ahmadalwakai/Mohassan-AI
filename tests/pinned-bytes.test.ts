import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Keep the inventory independent of Git attributes so missing rules fail the test.
const pinnedPaths = git('ls-files', '-z', '--',
  'packages/scratch-classifiers/models',
  'apps/server/src/assistant/refusal/learned-model.json',
  'apps/server/src/assistant/arithmetic-search-model.json',
  'scripts/gates/registrations',
  'scripts/gates/monitor_trial.py',
  'scripts/response-policy/decision-cases.jsonl',
  'skills-pilot/tests/cases.json',
  'skills-pilot/tests/heldout*.json',
  'tests/fixtures/manners-development.ts',
  'tests/fixtures/slot-tagger-v1',
  'tests/fixtures/agent-capability-bench/v2/exclusion/*.json',
  'tests/fixtures/agent-capability-bench/v2/exclusion/*.jsonl',
).toString('utf8').split('\0').filter(Boolean);

it.each(pinnedPaths)('preserves %s when core.autocrlf is true', path => {
  const textAttribute = git('check-attr', '-z', 'text', '--', path).toString('utf8').split('\0')[2];
  const blob = `:${path}`;
  const tracked = git('cat-file', 'blob', blob);
  const checkout = git('-c', 'core.autocrlf=true', 'cat-file', '--filters', blob);

  expect({ textAttribute, sha256: sha256(checkout) }).toEqual({ textAttribute: 'unset', sha256: sha256(tracked) });
});
