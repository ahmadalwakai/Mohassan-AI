/** Optional service vocabulary grounded in local text. It supplies slots, never request labels. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CorpusServices = Record<'ar' | 'en', readonly string[]>;

export function loadCorpusServices(filename: string): { services: CorpusServices; path: string; sha256: string } {
  const path = resolve(filename), bytes = readFileSync(path);
  const data = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: number; languages?: Record<string, unknown> };
  if (data.schemaVersion !== 1 || !data.languages) throw new Error('Unsupported local service vocabulary');
  const services: Record<'ar' | 'en', string[]> = { ar: [], en: [] };
  for (const language of ['ar', 'en'] as const) {
    const entries = data.languages[language];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`No local service phrases for ${language}`);
    const seen = new Set<string>();
    for (const entry of entries) {
      const text = entry && typeof entry === 'object' ? (entry as { text?: unknown }).text : undefined;
      if (typeof text !== 'string' || text !== text.trim() || text.length > 100 || text.split(/\s+/).length > 6
          || !/^[\p{L}\p{M}]+(?:[- '][\p{L}\p{M}]+)*$/u.test(text)) {
        throw new Error(`Invalid local service phrase for ${language}`);
      }
      const key = text.toLowerCase();
      if (!seen.has(key)) { services[language].push(text); seen.add(key); }
    }
  }
  return { services, path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
