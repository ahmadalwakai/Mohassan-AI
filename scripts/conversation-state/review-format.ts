/**
 * The owner's review of conversation state v2 against v1 (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, E1.1): one Arabic sheet,
 * one verdict per real message where the two readings differ. The verdicts are the owner's, on the owner's own messages, so
 * this is the independent measure the agent-written development set cannot be.
 *
 * A verdict is written after «الحكم:» in the sheet, or sent in chat as "1 v2، 2 كلاهما، 3 v1". Accepted words:
 * v1 · v2 · كلاهما (both) · لا أحد (neither). Anything else, or nothing, is left unanswered.
 */
export type Verdict = 'v1' | 'v2' | 'both' | 'neither';

export interface ReviewReading { label: string; query: string | null; note: string | null }
export interface ReviewItem {
  number: number;
  source: 'live' | 'frozen';
  /** Where it came from: a live conversation and turn, or a frozen real-set id. */
  ref: string;
  /** The owner's earlier messages in the same conversation, oldest first (at most two). */
  earlier: string[];
  text: string;
  v1: ReviewReading;
  v2: ReviewReading;
}

const fold = (text: string) => text.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي')
  .replace(/ة/gu, 'ه').toLowerCase().replace(/[\s.،,:;؛!؟?«»"'()[\]]+/gu, ' ').trim();

const WORDS: Array<[string, Verdict]> = [
  ['v1', 'v1'], ['v2', 'v2'], ['الاول', 'v1'], ['الحالي', 'v1'], ['الثاني', 'v2'], ['الجديد', 'v2'],
  ['كلاهما', 'both'], ['الاثنان', 'both'], ['الاثنين', 'both'], ['both', 'both'],
  ['لا احد', 'neither'], ['ولا واحد', 'neither'], ['لا هذا ولا ذاك', 'neither'], ['none', 'neither'], ['neither', 'neither'],
];

/** One verdict from the owner's words, or null when it is empty or unclear. */
export function parseVerdict(raw: string): Verdict | null {
  const key = fold(raw);
  if (!key) return null;
  const found = WORDS.filter(([word]) => key === word);
  return found.length === 1 ? found[0]![1] : null;
}

/** Verdicts written in the sheet: the line «الحكم: …» under each «### N». A sheet the owner did not touch gives none. */
export function parseSheet(markdown: string): Map<number, Verdict> {
  const verdicts = new Map<number, Verdict>();
  let current: number | null = null;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^###\s+(\d{1,4})\s*$/u.exec(line.trim());
    if (heading) { current = Number(heading[1]); continue; }
    const answer = /^\s*الحكم\s*[:：]\s*\[?([^\]]*)\]?\s*$/u.exec(line);
    if (answer && current !== null) {
      const verdict = parseVerdict(answer[1] ?? '');
      if (verdict) verdicts.set(current, verdict);
      current = null;
    }
  }
  return verdicts;
}

/** Verdicts sent in chat: "1 v2، 2 كلاهما، 3: v1" (comma, Arabic comma, semicolon or new line between them). */
export function parseAnswers(text: string): Map<number, Verdict> {
  const verdicts = new Map<number, Verdict>();
  for (const part of text.normalize('NFKC').replace(/[٠-٩]/gu, digit => String.fromCharCode(48 + digit.charCodeAt(0) - 0x0660)).split(/[،,;؛\n]+/u)) {
    const found = /^\s*#?(\d{1,4})\s*[:：.\-)]?\s*(.+?)\s*$/u.exec(part);
    if (!found) continue;
    const verdict = parseVerdict(found[2] ?? '');
    if (verdict) verdicts.set(Number(found[1]), verdict);
  }
  return verdicts;
}

export interface ReviewScore {
  items: number;
  answered: number;
  counts: Record<Verdict, number>;
  /** Right means the owner chose that reading or both. */
  v1Right: number;
  v2Right: number;
  /** Discordant pairs: v2 right and v1 wrong (verdict v2), v1 right and v2 wrong (verdict v1). */
  mcnemar: { b: number; c: number; p: number };
}

export function scoreReview(items: number, verdicts: ReadonlyMap<number, Verdict>): ReviewScore {
  const counts: Record<Verdict, number> = { v1: 0, v2: 0, both: 0, neither: 0 };
  for (const verdict of verdicts.values()) counts[verdict]++;
  const b = counts.v2, c = counts.v1;
  return { items, answered: verdicts.size, counts, v1Right: counts.v1 + counts.both, v2Right: counts.v2 + counts.both, mcnemar: { b, c, p: mcnemarExact(b, c) } };
}

/** Exact two-sided McNemar p-value from the discordant counts. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) tail += binomial(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}
function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
  return result;
}

/** Wilson 95% interval for k of n. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, centre = p + z * z / (2 * n), half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(centre - half) / d, (centre + half) / d];
}

export const sameQuery = (a: string | null, b: string | null) => (a === null) === (b === null) && (a === null || fold(a) === fold(b!));
