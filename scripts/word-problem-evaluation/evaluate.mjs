/** Evaluate the fixed GSM8K train hold-out through Mohassan's offline chat harness. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedSha256 = 'ddd39b03baf3e5c6c3c4fa2c970ae8e8996b57b841426a8cd9860931fd7eb985';
const forbidden = new Set(['search', 'read', 'open', 'unexpected_fetch']);
const finalAnswer = /^Final answer = ([^\r\n]+)$/gmu;

function exactNumber(raw) {
  const trimmed = raw.trim().replaceAll('−', '-');
  if (trimmed.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(trimmed)) return null;
  const normalized = trimmed.replaceAll(',', '');
  const fraction = /^([+-]?\d+)[/⁄]([1-9]\d*)$/u.exec(normalized);
  if (fraction) return [BigInt(fraction[1]), BigInt(fraction[2])];
  const decimal = /^([+-]?\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (!decimal) return null;
  const remainder = decimal[2] ?? '';
  return [BigInt(decimal[1] + remainder), 10n ** BigInt(remainder.length)];
}

function sameNumber(actual, expected) {
  const left = exactNumber(actual);
  const right = exactNumber(expected);
  return left !== null && right !== null && left[0] * right[1] === right[0] * left[1];
}

function assess(observation, gold) {
  const [turn] = observation.turns;
  if (!turn || turn.error) return { category: 'unobserved', answered: false };
  const calls = [...turn.toolCalls, ...turn.boundaryCalls];
  const computed = turn.route === 'compute' && turn.status === 'completed'
    && calls.some(call => call.tool === 'calculate' && call.outcome === 'recorded');
  const finalLines = [...turn.answer.matchAll(finalAnswer)];
  if (!computed && finalLines.length === 0) {
    return { category: 'abstained', answered: false };
  }
  const executed = computed && turn.questionCount === 0 && !turn.modelCalls
    && !turn.unexpectedEffects && !turn.fixtureMisses
    && !calls.some(call => forbidden.has(call.tool));
  if (!executed) return { category: 'invalidExecution', answered: true };
  if (finalLines.length !== 1 || !turn.answer.trimEnd().endsWith(finalLines[0][0].trimEnd()) || !exactNumber(finalLines[0][1])) {
    return { category: 'invalidFinalAnswer', answered: true };
  }
  return { category: sameNumber(finalLines[0][1], gold) ? 'correct' : 'wrong', answered: true };
}

async function main() {
  const [repo, holdout, shardRaw = '0', countRaw = '1'] = process.argv.slice(2);
  const shard = Number(shardRaw);
  const count = Number(countRaw);
  if (!repo || !holdout || !Number.isInteger(shard) || !Number.isInteger(count) || shard < 0 || shard >= count) {
    throw new Error('Expected repository path, frozen held-out path, optional zero-based shard and shard count');
  }
  const input = await readFile(holdout);
  if (createHash('sha256').update(input).digest('hex') !== expectedSha256) {
    throw new Error('The held-out input differs from the pre-tuning split');
  }
  const rows = input.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const { withCapabilityHarness } = await import(pathToFileURL(resolve(repo, 'scripts/agent-capability-bench/observe.ts')).href);
  const totals = { total: 0, answered: 0, correct: 0, wrong: 0, abstained: 0, unobserved: 0, invalidExecution: 0, invalidFinalAnswer: 0 };
  await withCapabilityHarness(async observe => {
    for (let index = shard; index < rows.length; index += count) {
      const row = rows[index];
      const observation = await observe({ id: row.source_id, turns: [{ text: row.question }] });
      const { category, answered } = assess(observation, row.gold);
      totals.total++;
      totals[category]++;
      if (answered) totals.answered++;
    }
  });
  process.stdout.write(JSON.stringify({ shard, count, expectedSha256, ...totals }) + '\n');
}

main().catch(error => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
