import { createHash } from 'node:crypto';
import type { MonitorSpec } from '@mohassan/contracts';
import { matchMonitorText, phraseIndex } from './page.js';

export interface WatchedBlock { key: string; text: string }

export interface MonitorObservation {
  value: string | number | boolean | string[];
  excerpt: string;
  observedAt: string;
  url?: string;
  blocks?: WatchedBlock[];
  itemKeys?: string[];
  itemUrls?: (string | null)[];
}

interface BlockSample { key: string; stable: string | null; pending?: string | null; volatile?: boolean }

export interface MonitorEvaluationState {
  observation: MonitorObservation;
  blocks?: BlockSample[];
  seen?: string[];
  reference?: number;
  ready: boolean;
  firstCheck: boolean;
}

interface Evaluation {
  state: MonitorEvaluationState;
  changed: boolean;
  trigger?: MonitorObservation;
}

const MAX_SEEN_ITEMS = 2048;

function stableText(value: string | null): string | null {
  return value === null ? null : matchMonitorText(value);
}

function blockChanges(previous: BlockSample[], observation: MonitorObservation): { blocks: BlockSample[]; edited?: string; changed: boolean } {
  const current = new Map(observation.blocks?.map(item => [item.key, item.text]));
  const blocks: BlockSample[] = [];
  let edited: string | undefined;
  let changed = false;
  for (const item of previous) {
    const observed = current.get(item.key) ?? null;
    current.delete(item.key);
    const value = stableText(observed);
    if (value === item.stable) {
      if (item.stable !== null) blocks.push({ key: item.key, stable: item.stable, volatile: item.volatile || item.pending !== undefined });
    } else if (value === item.pending) {
      if (value !== null) blocks.push({ key: item.key, stable: value });
      if (!item.volatile) {
        edited ??= observed ?? observation.excerpt;
        changed = true;
      }
    } else {
      const volatile = item.volatile || item.pending !== undefined;
      blocks.push({ key: item.key, stable: item.stable, pending: value, volatile });
      changed ||= !volatile;
    }
  }
  for (const [key, text] of current) {
    blocks.push({ key, stable: null, pending: stableText(text) });
    changed = true;
  }
  return { blocks, edited, changed };
}

function itemHashes(observation: MonitorObservation): string[] {
  if (!Array.isArray(observation.value)) return [];
  return (observation.itemKeys ?? observation.value.map(matchMonitorText)).map(key => createHash('sha256').update(key).digest('hex'));
}

function canonicalValue(observation: MonitorObservation): MonitorObservation['value'] {
  if (typeof observation.value === 'string') return matchMonitorText(observation.value);
  return Array.isArray(observation.value) ? itemHashes(observation).sort() : observation.value;
}

function sameValue(left: MonitorObservation, right: MonitorObservation): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function present(value: MonitorObservation['value']): boolean {
  if (typeof value === 'number') return true;
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function textual(value: MonitorObservation['value']): string {
  return Array.isArray(value) ? value.join(' ') : String(value);
}

function compare(condition: MonitorSpec['condition'], value: MonitorObservation['value']): boolean {
  if (condition.kind !== 'equals' && condition.kind !== 'contains') return false;
  const left = matchMonitorText(textual(value)), right = matchMonitorText(condition.value);
  return condition.kind === 'equals' ? left === right : phraseIndex(left, right) >= 0;
}

function crossed(value: number, direction: 'above' | 'below', threshold: number): boolean {
  return direction === 'above' ? value > threshold : value < threshold;
}

export function evaluateMonitor(
  spec: Pick<MonitorSpec, 'condition'>,
  previous: MonitorEvaluationState | undefined,
  observation: MonitorObservation,
  _options?: { revalidated?: boolean },
): Evaluation {
  const { condition } = spec;
  const value = observation.value;
  if (!previous) {
    const state: MonitorEvaluationState = {
      observation,
      ready: condition.kind !== 'crossing' || typeof value !== 'number' || !crossed(value, condition.direction, condition.value),
      firstCheck: true,
    };
    if (observation.blocks) state.blocks = observation.blocks.map(({ key, text }) => ({ key, stable: stableText(text) }));
    if (condition.kind === 'new-item') state.seen = [...new Set(itemHashes(observation))];
    if (condition.kind === 'percent' && typeof value === 'number' && value !== 0) state.reference = value;
    return { state, changed: false };
  }

  const state: MonitorEvaluationState = { ...previous, firstCheck: false, observation };
  let changed = !sameValue(previous.observation, observation);
  let triggered = false;
  let excerpt = observation.excerpt;
  let url = observation.url;

  switch (condition.kind) {
    case 'change':
      if (previous.blocks && observation.blocks) {
        const compared = blockChanges(previous.blocks, observation);
        state.blocks = compared.blocks;
        changed = compared.changed;
        triggered = compared.edited !== undefined;
        excerpt = compared.edited ?? excerpt;
      } else {
        triggered = changed;
      }
      break;
    case 'equals':
    case 'contains':
      triggered = compare(condition, value) && (previous.firstCheck || !compare(condition, previous.observation.value));
      break;
    case 'appears':
      triggered = present(value) && !present(previous.observation.value);
      break;
    case 'disappears':
      triggered = !present(value) && present(previous.observation.value);
      break;
    case 'threshold':
    case 'crossing':
      if (typeof value !== 'number') break;
      if (previous.ready && crossed(value, condition.direction, condition.value)) {
        triggered = true;
        state.ready = false;
      } else if (!previous.ready) {
        const beyondHysteresis = condition.direction === 'above'
          ? value <= condition.value - condition.hysteresis : value >= condition.value + condition.hysteresis;
        if (beyondHysteresis) state.ready = true;
      }
      break;
    case 'percent':
      if (typeof value !== 'number') break;
      if (previous.reference === undefined) {
        if (value !== 0) state.reference = value;
        break;
      }
      {
        const percent = 100 * (value - previous.reference) / Math.abs(previous.reference);
        const comparable = condition.direction === 'above' ? percent : condition.direction === 'below' ? -percent : Math.abs(percent);
        const inside = comparable >= condition.value;
        triggered = inside && previous.ready;
        state.ready = !inside;
      }
      break;
    case 'new-item':
      if (Array.isArray(value)) {
        const seen = new Set(previous.seen);
        const hashes = itemHashes(observation);
        const fresh = value.filter((_item, index) => !seen.has(hashes[index]));
        // Bound durable history. Once full, avoid claiming an unremembered ID is new.
        if (seen.size < MAX_SEEN_ITEMS && fresh.length) {
          state.seen = [...new Set([...seen, ...hashes])].slice(0, MAX_SEEN_ITEMS);
          triggered = true;
          excerpt = fresh.join(' · ').slice(0, 320);
          const freshIndex = hashes.findIndex(hash => !seen.has(hash));
          url = observation.itemUrls?.[freshIndex] ?? url;
        }
      }
      break;
  }

  return { state, changed, ...(triggered ? { trigger: { ...observation, excerpt, ...(url && { url }) } } : {}) };
}
