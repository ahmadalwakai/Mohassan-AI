import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ModelObservation, TurnDecisionLog } from './manager.js';
import { getModelEntry } from './registry.js';
import { ShadowModelCounts, type ShadowModelCall } from './shadow-model-counts.js';

const outcomes = {
  ok: true, abstained: true, 'invalid-output': true, 'unknown-model': true, absent: true, incompatible: true,
  'gpu-locked': true, busy: true, 'memory-budget': true, timeout: true, unhealthy: true, unsupported: true, 'invalid-input': true,
} satisfies Record<ModelObservation['outcome'], true>;

type SnapshotRow = Pick<TurnDecisionLog, 'event' | 'mode' | 'arbiter'> & {
  language?: unknown;
  stages: { models: ShadowModelCall[] }[];
};

function validateOutcome(outcome: unknown): void {
  if (outcome !== undefined && (typeof outcome !== 'string' || !Object.hasOwn(outcomes, outcome))) {
    throw new Error('Invalid shadow outcome.');
  }
}

interface ArbiterCounts {
  contested: number;
  disagreements: number;
  changed: number;
  reasons: Map<string, number>;
  alternatives: Map<string, number>;
  times: number[];
}

export async function summarizeShadow(path: string) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const counts = new ShadowModelCounts();
  const decisions = new Map<string, ArbiterCounts>();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row: SnapshotRow = JSON.parse(line);
      if (row.event !== 'model_relations_turn' || row.mode !== 'shadow' || !Array.isArray(row.stages)) {
        throw new Error('Invalid shadow record.');
      }
      const calls = row.stages.flatMap(stage => {
        if (!Array.isArray(stage.models)) throw new Error('Invalid shadow stage.');
        return stage.models;
      });
      for (const call of calls) {
        if (!getModelEntry(call.model)) throw new Error('Invalid shadow model ID.');
        validateOutcome(call.outcome);
      }
      const language = row.language;
      if (language !== undefined && language !== 'ar' && language !== 'en' && language !== 'mixed') {
        throw new Error('Invalid shadow language.');
      }
      for (const decision of row.arbiter ?? []) {
        validateOutcome(decision.modelOutcome);
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
      counts.recordTurn(language, calls, row.arbiter);
    }
  } catch {
    throw new Error('Cannot summarize the shadow log. Check the path and use a complete JSONL snapshot.');
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    ...counts.summary(),
    ...(decisions.size ? { arbiter: [...decisions].sort(([first], [second]) => first.localeCompare(second, 'en'))
      .map(([type, { times, reasons, alternatives, ...count }]) => ({
        type, ...count, disagreementRate: count.disagreements / count.contested,
        reasons: Object.fromEntries(reasons), disagreementsByChoice: Object.fromEntries(alternatives),
        p95Ms: times.length ? times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1] : null,
      })) } : {}),
  };
}
