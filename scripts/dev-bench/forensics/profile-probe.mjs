import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [prepared, version, selection, output, learned] = process.argv.slice(2);
assert.ok(version === 'v1' || version === 'v2');
assert.ok(learned === 'loaded' || learned === 'disabled');

if (learned === 'disabled') {
  registerHooks({ resolve(specifier, context, nextResolve) {
    const resolution = nextResolve(specifier, context);
    assert.ok(!/\/assistant\/refusal\/learned-model\.json$/u.test(resolution.url));
    if (!/\/assistant\/refusal\/learned-classifier\.[jt]s$/u.test(resolution.url)) return resolution;
    return { url: 'data:text/javascript,export const classifyLearnedRefusal = () => null;', shortCircuit: true };
  } });
}

const harnessRoot = join(prepared, version, 'scripts', 'agent-capability-bench');
const fixtures = join(prepared, version, 'tests', 'fixtures', 'agent-capability-bench');
const load = path => import(pathToFileURL(join(harnessRoot, path)).href);
const { withCapabilityHarness } = await load('observe.ts');
const { scoreCapabilityCase } = await load('score.ts');
let cases;
if (version === 'v1') {
  const { loadCapabilityCorpus } = await load('corpus.ts');
  const { development } = await loadCapabilityCorpus({
    manifest: join(fixtures, 'manifest.json'),
    development: join(fixtures, 'development.json'),
  });
  cases = development;
} else {
  const { loadDevelopmentCapabilityCorpus } = await load('v2/dev.ts');
  ({ cases } = await loadDevelopmentCapabilityCorpus(join(fixtures, 'v2/dev')));
}

const ids = selection === 'document-file' ? null : new Set(JSON.parse(await readFile(selection, 'utf8')));
const selected = cases.filter(item => ids ? ids.has(item.id) : item.area === 'document-file');
assert.equal(selected.length, ids ? ids.size : 18);

const rows = await withCapabilityHarness(async observe => {
  const result = [];
  for (const item of selected) {
    const observation = await observe(item);
    assert.ok(observation.turns.every(turn => !turn.modelCalls
      && !turn.boundaryCalls.some(call => call.tool === 'unexpected_fetch')));
    result.push(scoreCapabilityCase(item, observation));
  }
  return result;
});
await writeFile(output, JSON.stringify({ version, learned, rows }, null, 2), { mode: 0o600, flag: 'wx' });
