import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { TurnDecisionLog } from './manager.js';
import { getModelEntry, modelRegistry, modelRoots, resolveModelInRoots } from './registry.js';
import { createModelRuntime } from './runtime.js';

const maxInputBytes = 1024 * 1024;
const defaultIterations = 20;
const maxIterations = 1_000;
const usage = [
  'npm run models:list',
  'npm run models:health -- [model-id]',
  'npm run models:run -- <model-id> <input.json>',
  'npm run models:latency -- <model-id> <input.json> [iterations]',
  'npm run models:shadow-summary -- [log.jsonl]',
].join('\n');

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function readInput(path: string): Promise<unknown> {
  const inputError = () => new Error('Input must be a readable JSON file up to 1 MiB.');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw inputError(); });
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxInputBytes) throw inputError();
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw inputError();
    bytes = buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch {
    throw new Error('Input file contains invalid JSON.');
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

async function summarizeShadow(path: string): Promise<void> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const counts = new Map<string, { considered: number; attempted: number; compared: number; disagreements: number; fallbacks: number }>();
  const decisions = new Map<string, { contested: number; disagreements: number; changed: number;
    reasons: Map<string, number>; alternatives: Map<string, number>; times: number[] }>();
  let turns = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row: TurnDecisionLog = JSON.parse(line);
      if (row.event !== 'model_relations_turn' || row.mode !== 'shadow' || !Array.isArray(row.stages)) {
        throw new Error('Invalid shadow record.');
      }
      for (const stage of row.stages) {
        for (const call of stage.models) {
          if (!getModelEntry(call.model)) throw new Error('Invalid shadow model ID.');
          const count = counts.get(call.model) ?? { considered: 0, attempted: 0, compared: 0, disagreements: 0, fallbacks: 0 };
          count.considered++;
          if (call.attempted === true) count.attempted++;
          if (typeof call.disagreed === 'boolean') count.compared++;
          if (call.disagreed === true) count.disagreements++;
          if (call.fallback === 'existing-rules') count.fallbacks++;
          counts.set(call.model, count);
        }
      }
      for (const decision of row.arbiter ?? []) {
        const { type, precedence, proposed, selected, reason, elapsedMs } = decision;
        const count = decisions.get(type) ?? { contested: 0, disagreements: 0, changed: 0,
          reasons: new Map<string, number>(), alternatives: new Map<string, number>(), times: [] };
        count.contested++;
        count.reasons.set(reason, (count.reasons.get(reason) ?? 0) + 1);
        if (proposed !== precedence) {
          count.disagreements++;
          const path = `${precedence} → ${proposed}`;
          count.alternatives.set(path, (count.alternatives.get(path) ?? 0) + 1);
        }
        if (selected !== precedence) count.changed++;
        if (Number.isFinite(elapsedMs) && elapsedMs >= 0) count.times.push(elapsedMs);
        decisions.set(type, count);
      }
      turns++;
    }
  } catch {
    throw new Error('Cannot summarize the shadow log. Check the path and use a complete JSONL snapshot.');
  } finally {
    lines.close();
    input.destroy();
  }
  print({
    turns,
    models: [...counts].sort(([first], [second]) => first.localeCompare(second, 'en')).map(([model, count]) => ({
      model, ...count, disagreementRate: count.compared ? count.disagreements / count.compared : null,
    })),
    ...(decisions.size ? { arbiter: [...decisions].sort(([first], [second]) => first.localeCompare(second, 'en'))
      .map(([type, { times, reasons, alternatives, ...count }]) => ({
        type, ...count, disagreementRate: count.disagreements / count.contested,
        reasons: Object.fromEntries(reasons), disagreementsByChoice: Object.fromEntries(alternatives),
        p95Ms: times.length ? percentile(times.sort((a, b) => a - b), 0.95) : null,
      })) } : {}),
  });
}

async function main([command, modelId, inputPath, iterationsArg, ...extra]: readonly string[]): Promise<number> {
  if (command === '--help' || modelId === '--help') {
    process.stdout.write(usage + '\n');
    return 0;
  }
  if (command === 'list' && modelId === undefined) {
    const inventory = [];
    for (const entry of modelRegistry) {
      const { state, artifacts } = await resolveModelInRoots(entry, modelRoots(process.cwd()));
      inventory.push({ ...entry, state, artifacts });
    }
    print(inventory);
    return 0;
  }
  if (command === 'shadow-summary' && inputPath === undefined) {
    await summarizeShadow(modelId ?? '.data/model-relations-shadow.jsonl');
    return 0;
  }
  if (extra.length || (command === 'health' && inputPath !== undefined) ||
    ((command === 'run' || command === 'latency') && (!modelId || !inputPath)) ||
    (command === 'run' && iterationsArg !== undefined) ||
    (command !== 'health' && command !== 'run' && command !== 'latency')) {
    throw new Error(usage);
  }
  if (modelId && !getModelEntry(modelId)) throw new Error('Unknown model ID. Use npm run models:list.');
  const iterations = iterationsArg === undefined ? defaultIterations : Number(iterationsArg);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > maxIterations) {
    throw new Error('Iterations must be an integer from 1 to 1000.');
  }

  const runtime = createModelRuntime({ root: process.cwd(), artifactRoots: modelRoots(process.cwd()) });
  try {
    if (command === 'health') {
      const ids = modelId ? [modelId] : modelRegistry.map(entry => entry.id);
      let exitCode = 0;
      const results = [];
      for (const id of ids) {
        const result = await runtime.health(id);
        results.push({ modelId: id, ...result });
        if (!result.ok && (modelId || result.reason !== 'absent')) exitCode = 1;
      }
      print(modelId ? results[0] : results);
      return exitCode;
    }
    if (modelId === undefined || inputPath === undefined) throw new Error(usage);
    const input = await readInput(inputPath);
    const coldStart = performance.now();
    const result = await runtime.run(modelId, input);
    const coldMs = performance.now() - coldStart;
    if (command === 'run' || !result.ok) {
      print(result);
      return result.ok ? 0 : 1;
    }

    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const start = performance.now();
      const sample = await runtime.run(modelId, input);
      if (!sample.ok) {
        print(sample);
        return 1;
      }
      samples.push(performance.now() - start);
    }
    samples.sort((first, second) => first - second);
    const middle = Math.floor(samples.length / 2);
    const medianMs = samples.length % 2 === 0 ? (samples[middle - 1] + samples[middle]) / 2 : samples[middle];
    print({ modelId, iterations, coldMs, medianMs, p95Ms: percentile(samples, 0.95) });
    return 0;
  } finally {
    await runtime.close();
  }
}

main(process.argv.slice(2)).then(exitCode => {
  process.exitCode = exitCode;
}).catch(error => {
  process.stderr.write((error instanceof Error ? error.message : 'Model command failed.') + '\n');
  process.exitCode = 1;
});
