import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadScratchClassifiers, SCRATCH_HEADS, type ScratchClassifiers, type ScratchHead, type ScratchPrediction } from './index.ts';

interface GoldenCase {
  head: ScratchHead;
  text: string;
  previousText?: string;
  k?: number;
  abstained: boolean;
  topK: ScratchPrediction['topK'];
}

const MODELS = new URL('../models/', import.meta.url);

function withTemporaryModels(test: (directory: URL) => void): void {
  const temporary = mkdtempSync(join(tmpdir(), 'mohassan-scratch-models-'));
  try {
    test(pathToFileURL(`${temporary}${sep}`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe('scratch classifiers', () => {
  let classifiers: ScratchClassifiers;
  beforeAll(() => { classifiers = loadScratchClassifiers(); });

  it('matches the Python export for each head, including scores and abstention', () => {
    const golden: { version: number; cases: GoldenCase[] } = JSON.parse(readFileSync(new URL('golden.json', MODELS), 'utf8'));
    expect(golden.version).toBe(1);
    expect(new Set(golden.cases.map(entry => entry.head))).toEqual(new Set(SCRATCH_HEADS));
    expect(golden.cases.some(entry => entry.head === 'followUp' && entry.previousText)).toBe(true);
    for (const entry of golden.cases) {
      const options = { previousText: entry.previousText, topK: entry.k };
      const actual = classifiers.predict(entry.head, entry.text, options);
      expect(classifiers.predictAll(entry.text, options)[entry.head]).toEqual(actual);
      expect(actual.abstained, entry.head).toBe(entry.abstained);
      expect(actual.label, entry.head).toBe(entry.abstained ? undefined : entry.topK[0].label);
      expect(actual.topK.map(item => item.label), entry.head).toEqual(entry.topK.map(item => item.label));
      for (const [index, item] of actual.topK.entries()) {
        expect(item.score, entry.head).toBeCloseTo(entry.topK[index].score, 10);
      }
    }
  });

  it('abstains for blank input even when there is previous text', () => {
    const actual = classifiers.predictAll('  \t\n ', { previousText: 'Please check the latest forecast.' });
    for (const head of SCRATCH_HEADS) {
      expect(actual[head]).toEqual({ label: undefined, abstained: true, topK: [] });
    }
  });

  it('returns sorted probabilities and preserves the decision when limiting top-k', () => {
    const text = 'كيف سيكون الطقس اليوم؟';
    const full = classifiers.predict('route', text, { topK: 100 });
    const limited = classifiers.predict('route', text, { topK: 1 });
    expect(limited).toEqual({ ...full, topK: full.topK.slice(0, 1) });
    expect(full.topK.every((item, index, ranked) => index === 0 || ranked[index - 1].score >= item.score)).toBe(true);
    expect(full.topK.reduce((total, item) => total + item.score, 0)).toBeCloseTo(1, 10);
  });

  it('uses the previous turn only for the follow-up head', () => {
    const text = 'وماذا عن ذلك؟';
    const standalone = classifiers.predictAll(text);
    const contextual = classifiers.predictAll(text, { previousText: 'ابحث عن الفنادق في مدينة العقبة' });
    for (const head of ['refusal', 'speechAct', 'route'] as const) {
      expect(contextual[head]).toEqual(standalone[head]);
    }
  });

  it('rejects a model whose bytes differ from its pinned SHA-256', () => {
    withTemporaryModels(directory => {
      const manifest = readFileSync(new URL('manifest.json', MODELS));
      const refusal = readFileSync(new URL('refusal.json', MODELS));
      writeFileSync(new URL('manifest.json', directory), manifest);
      writeFileSync(new URL('refusal.json', directory), Buffer.concat([refusal, Buffer.from('\n')]));
      expect(() => loadScratchClassifiers(directory)).toThrow('SHA-256 mismatch');
    });
  });

  it('abstains below the threshold while retaining scores, and accepts at the threshold', () => {
    withTemporaryModels(directory => {
      for (const threshold of [0.5, 0.6, 1 + Number.EPSILON]) {
        const model = JSON.stringify({ version: 1, labels: ['allow', 'out_of_scope'], dimensions: 1,
          weights: Buffer.alloc(4).toString('base64'), weightScale: 1, bias: [0, 0], temperature: 1, threshold });
        const sha256 = createHash('sha256').update(model).digest('hex');
        for (const head of SCRATCH_HEADS) writeFileSync(new URL(`${head}.json`, directory), model);
        writeFileSync(new URL('manifest.json', directory), JSON.stringify({ version: 1,
          sha256: Object.fromEntries(SCRATCH_HEADS.map(head => [head, sha256])) }));
        const accepted = threshold === 0.5;
        expect(loadScratchClassifiers(directory).predict('refusal', 'Hello')).toEqual({
          label: accepted ? 'allow' : undefined,
          abstained: !accepted,
          topK: [{ label: 'allow', score: 0.5 }, { label: 'out_of_scope', score: 0.5 }],
        });
      }
    });
  });

  it('runs all four heads within 2 ms at p95 on mixed inputs and on bounded long inputs', ({ skip }) => {
    const mode = (import.meta as ImportMeta & { env?: { MODE: string } }).env?.MODE;
    skip(mode !== 'scratch-benchmark', 'Shared host scheduling affects wall-clock p95. Run this benchmark in isolation with --mode scratch-benchmark.');
    const short = [
      { text: 'could you expand on your second point?', previousText: 'How much did it cost last year?' },
      { text: 'تمام، وماذا عن الإسكندرية؟', previousText: 'كيف الجو في القاهرة اليوم؟' },
      { text: '2oly 3an elta2s elnaharda' },
      { text: 'اضبط المنبه على الساعة ٧:٣٠ صباحًا' },
    ];
    const long = short.map((_, offset) => {
      const turns = Array.from({ length: 64 }, (_, index) => short[(index + offset) % short.length]);
      return {
        text: turns.map((turn, index) => `${turn.text} ${index}`).join(' '),
        previousText: turns.map((turn, index) => `${turn.previousText ?? turn.text} ${index}`).join(' '),
      };
    });
    for (const [name, inputs] of [['mixed', short], ['long', long]] as const) {
      const run = (index: number) => {
        const { text, previousText } = inputs[index % inputs.length];
        classifiers.predictAll(text, { previousText });
      };
      for (let sample = 0; sample < 100; sample++) run(sample);
      const timings = Array.from({ length: 300 }, (_, sample) => {
        const started = performance.now();
        run(sample);
        return performance.now() - started;
      }).sort((left, right) => left - right);
      const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
      console.info(`Scratch classifiers ${name} p95: ${p95.toFixed(3)} ms (${timings.length} messages)`);
      expect(p95, name).toBeLessThan(2);
    }
  });
});
