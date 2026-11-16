/**
 * Builds the large word list that goal v3 draws training service names from.
 *   npx tsx scripts/ads-training/service-vocab.ts
 * Reads the local Simple English Wikipedia text (shard-000, already downloaded). Keeps lowercase
 * words that often follow "the" or "a" (mostly nouns), then removes stop words, every word the
 * goal templates use, and every held-out service, place and city word, so test stays unseen.
 * Writes artifacts/ads-training/service-vocab.json (git-ignored). Downloads nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { reservedGoalWords } from './goal.js';

const SHARD = 'artifacts/corpora/simplewiki-20261101/text/shard-000.txt', OUT = 'artifacts/ads-training/service-vocab.json', SIZE = 4000;
const STOP = new Set(('about above after again against also among another around because been before being below between both but could does doing down during each '
  + 'even every first from further have having here into itself just last least less made make many more most much must next none only other over own same '
  + 'several should since some such than that their them then there these they this those through under until upon very were what when where which while '
  + 'whole will with within without would year years time times part parts number name names people world state states city town country area way end use '
  + 'same other one two three four five six seven eight nine ten').split(' '));

const reserved = reservedGoalWords(), counts = new Map<string, number>();
for (const match of readFileSync(SHARD, 'utf8').matchAll(/\b(?:the|a) ([a-z]{4,12})\b/g)) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
const words = [...counts].filter(([word, count]) => count >= 20 && !STOP.has(word) && !reserved.has(word))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, SIZE).map(([word]) => word);
writeFileSync(OUT, JSON.stringify({ source: SHARD, rule: 'follows "the"/"a", 4-12 letters, count >= 20, minus stop/template/held-out words', words }, null, 1) + '\n');
console.log(JSON.stringify({ words: words.length, sample: words.filter((_, index) => index % 400 === 0) }));
