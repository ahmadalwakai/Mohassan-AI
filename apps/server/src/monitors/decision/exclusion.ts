import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { matchText } from '../../assistant/mind/normalize.js';

// Same registry pin as packages/scratch-classifiers/data_guard.py.
export const MONITOR_EXCLUSION_SHA256 = 'de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054';
const registry = new URL('../../../../../tests/fixtures/agent-capability-bench/v2/exclusion/', import.meta.url);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha256 = /^[a-f0-9]{64}$/u;
let hashes: ReadonlySet<string> | null | undefined;

function readHashes(): ReadonlySet<string> | null {
  try {
    const bytes = readFileSync(new URL('manifest.json', registry));
    if (digest(bytes) !== MONITOR_EXCLUSION_SHA256) return null;
    const { partitions } = JSON.parse(bytes.toString('utf8'));
    const result = new Set<string>();
    for (const name of ['dev', 'sealed'] as const) {
      const entries = readFileSync(new URL(`${name}.jsonl`, registry));
      if (digest(entries) !== partitions[name].entries_sha256) return null;
      const rows = entries.toString('utf8').trimEnd().split('\n');
      if (rows.length !== partitions[name].case_count) return null;
      for (const row of rows) {
        const { text_sha256 } = JSON.parse(row);
        if (!Array.isArray(text_sha256) || !text_sha256.every(value => typeof value === 'string' && sha256.test(value))) return null;
        for (const hash of text_sha256) result.add(hash);
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** Mirrors scripts/agent-capability-bench/v2/exclusion.py for Arabic and English text. */
export function normalizeMonitorExclusionText(text: string) {
  const folded = Array.from(matchText(text), character => {
    // NFKC casefold keeps dotless I and folds Cherokee to uppercase. The per-character
    // uppercase/lowercase pass handles full folds such as sharp S in Latin text.
    if (character === 'ı') return character;
    const upper = character.toUpperCase();
    return /\p{Script=Cherokee}/u.test(character) ? upper : upper.toLowerCase();
  }).join('');
  return folded.replace(/[\p{White_Space}\u001c-\u001f]+/gu, ' ').replace(/^ | $/gu, '');
}

/** Checks the published fingerprints without loading the benchmark texts. */
export function monitorTrainingTextsAllowed(texts: readonly string[]) {
  if (hashes === undefined) hashes = readHashes();
  const excluded = hashes;
  return excluded !== null && !texts.some(text => excluded.has(digest(normalizeMonitorExclusionText(text))));
}
