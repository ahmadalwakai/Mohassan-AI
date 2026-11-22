/**
 * Synthetic catalogue entries for capacity benchmarks ONLY. They are generated in memory, carry the
 * `fixture-synthetic-` slug prefix, and are never written to `skills/`, a package, or a database
 * outside a throwaway test store. They do not count as skills anywhere.
 *
 * To compete with real skills the way a large library would, each entry is made of words taken from
 * the real skill descriptions (so common words stay common and rare words stay rare), plus a unique tag.
 */
import { createHash } from 'node:crypto';

export interface SyntheticEntry { id: string; slug: string; name: string; description: string; category: string; version: string; contentHash: string }
export const SYNTHETIC_PREFIX = 'fixture-synthetic-';
const CATEGORIES = ['reasoning', 'coding', 'design', 'creativity', 'documents', 'languages', 'business', 'marketing', 'research', 'security', 'analytics', 'media'];

/** Deterministic 32-bit generator, so every run builds the same catalogue. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuidOf = (value: string) => { const hex = createHash('sha256').update(value).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };

/** `count` entries whose words follow the word frequencies of `vocabularySource` (real descriptions). */
export function syntheticCatalogue(count: number, vocabularySource: readonly string[], seed = 20261122): SyntheticEntry[] {
  const random = mulberry32(seed);
  const words = vocabularySource.flatMap(text => text.split(/[\s،,.:;()«»"'!?؟]+/u)).filter(word => word.length > 2);
  if (!words.length) throw new Error('vocabulary is empty');
  const pick = () => words[Math.floor(random() * words.length)];
  const out: SyntheticEntry[] = [];
  for (let n = 0; n < count; n++) {
    const tag = `وسم${n.toString(36)}`;
    const nameWords = Array.from({ length: 3 }, pick);
    const descriptionWords = Array.from({ length: 14 + Math.floor(random() * 10) }, pick);
    const slug = `${SYNTHETIC_PREFIX}${String(n).padStart(5, '0')}`;
    out.push({ id: uuidOf(slug), slug, name: `${nameWords.join(' ')} ${tag}`, description: `${descriptionWords.join(' ')} ${tag}.`, category: CATEGORIES[n % CATEGORIES.length], version: '1.0.0',
      contentHash: createHash('sha256').update(slug).digest('hex') });
  }
  return out;
}
