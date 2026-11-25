import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [version, selectionPath, output] = process.argv.slice(2);
assert.ok(version === 'v1' || version === 'v2');
const selected = JSON.parse(await readFile(selectionPath, 'utf8'))[version];
assert.ok(Array.isArray(selected) && selected.every(id => typeof id === 'string' && id));
assert.equal(new Set(selected).size, selected.length);

const context = new AsyncLocalStorage();
const originalUUID = crypto.randomUUID;
const digest = text => createHash('sha256').update(text).digest('hex');

// Vary only the UUIDs generated inside each development fixture's execution context.
crypto.randomUUID = (...args) => {
  const scope = context.getStore();
  if (!scope) return originalUUID(...args);
  const bytes = createHash('sha256').update(JSON.stringify([version, scope.id, scope.ordinal++])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};
syncBuiltinESMExports();

const root = process.cwd();
const bench = 'scripts/agent-capability-bench';
const fixtures = join(root, 'tests/fixtures/agent-capability-bench');
const load = file => import(pathToFileURL(join(root, bench, file)).href);

try {
  const { withCapabilityHarness } = await load('observe.ts');
  const { scoreCapabilityCase } = await load('score.ts');
  let cases;
  if (version === 'v1') {
    const { loadCapabilityCorpus } = await load('corpus.ts');
    const corpus = await loadCapabilityCorpus({
      manifest: join(fixtures, 'manifest.json'), development: join(fixtures, 'development.json'),
    });
    assert.equal(corpus.sealed, undefined);
    cases = corpus.development;
  } else {
    const { loadDevelopmentCapabilityCorpus } = await load('v2/dev.ts');
    const corpus = await loadDevelopmentCapabilityCorpus(join(fixtures, 'v2', 'dev'));
    cases = corpus.cases;
  }
  const requested = new Set(selected);
  const filtered = cases.filter(({ id }) => requested.has(id));
  assert.equal(filtered.length, selected.length, 'The selection needs published development case IDs');
  const evidence = await withCapabilityHarness(async observe => {
    const results = [];
    for (const item of filtered) {
      const scope = { id: item.id, ordinal: 0 };
      const observation = await context.run(scope, () => observe(item));
      assert.ok(scope.ordinal > 0, 'The fixture did not use the controlled UUID source');
      assert.ok(observation.turns.every(turn => turn.modelCalls === 0
        && !turn.boundaryCalls.some(call => call.tool === 'unexpected_fetch')));
      const score = scoreCapabilityCase(item, observation);
      const replies = observation.turns.map(turn => turn.answer);
      results.push({
        id: item.id,
        passed: score.passed,
        failures: score.failures,
        uuidCalls: scope.ordinal,
        replySha256: replies.map(digest),
        repliesSha256: digest(JSON.stringify(replies)),
      });
    }
    return results;
  });
  await writeFile(output, JSON.stringify({ version, selection: selected, evidence }, null, 2) + '\n', {
    mode: 0o600, flag: 'wx',
  });
} finally {
  crypto.randomUUID = originalUUID;
  syncBuiltinESMExports();
}
