import type { CapabilityCase } from '../corpus.js';

export const mappingVersion = 1;

export type Dataset = 'clinc150' | 'massive' | 'mintaka' | 'tydiqa' | 'tydiqa-wana' | 'canard' | 'gsm8k' | 'mbpp';

export interface Candidate {
  dataset: Dataset;
  key: string;
  family: string;
  item: Omit<CapabilityCase, 'id' | 'provenance'>;
}

export interface ImportResult {
  dataset: Dataset;
  candidates: Candidate[];
  dropped: Record<string, number>;
  seen: number;
}

export class Mapping {
  private readonly candidates: Candidate[] = [];
  private readonly dropped = new Map<string, number>();
  private readonly keys = new Set<string>();

  constructor(private readonly dataset: Dataset) {}

  accept(key: string, family: string, item: Candidate['item']): void {
    if (!key || !family || this.keys.has(key)) throw new Error(`Invalid or duplicate row key in ${this.dataset}.`);
    this.keys.add(key);
    this.candidates.push({ dataset: this.dataset, key, family, item });
  }

  drop(reason: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
  }

  result(): ImportResult {
    return {
      dataset: this.dataset, candidates: this.candidates,
      dropped: Object.fromEntries(this.dropped),
      seen: this.candidates.length + [...this.dropped.values()].reduce((sum, count) => sum + count, 0),
    };
  }
}
