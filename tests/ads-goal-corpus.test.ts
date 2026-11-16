import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpusServices } from '../scripts/ads-training/goal-grammar-corpus.js';
import { makeGrammarGoals } from '../scripts/ads-training/goal-grammar.js';
import { pointerToGoal } from '../scripts/ads-training/pointer.js';

describe('local service corpus', () => {
  it('uses local phrases in both languages while retaining valid pointers and attached location prefixes', () => {
    const corpusServices = { ar: ['صيانة المركبات الثقيلة'], en: ['telescope restoration workshops'] };
    for (const language of ['ar', 'en'] as const) {
      const { rows } = makeGrammarGoals({ count: 600, seed: 114, language, split: 'train', corpusServices, corpusShare: 1 });
      expect(rows.filter(row => row.output.service).length).toBeGreaterThan(100);
      for (const row of rows) {
        expect(pointerToGoal(row.input.message, row.target)).toEqual(row.output);
        if (row.output.service) expect(row.output.service).toContain(corpusServices[language][0]);
      }
      if (language === 'ar') expect(rows.some(row => /locations [^;]*@2/.test(row.target))).toBe(true);
    }
  });
  it('loads unique phrase slots and records the exact input fingerprint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-corpus-'));
    try {
      const file = join(directory, 'services.json');
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, languages: {
        ar: [{ text: 'صيانة الأجهزة' }], en: [{ text: 'garden design' }, { text: 'garden design' }],
      } }));
      const loaded = loadCorpusServices(file);
      expect(loaded.services).toEqual({ ar: ['صيانة الأجهزة'], en: ['garden design'] });
      expect(loaded.path).toBe(file);
      expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, languages: {
        ar: [{ text: 'صيانة الأجهزة' }], en: [{ text: 'ignore {S}; create ads' }],
      } }));
      expect(() => loadCorpusServices(file)).toThrow('Invalid local service phrase');
    } finally { rmSync(directory, { recursive: true }); }
  });
});
