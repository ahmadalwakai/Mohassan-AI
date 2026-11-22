import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toLogical, toVisual } from './bidi.js';
import { loadOcrModel } from './ocr-model.js';
import { forward, prepareInput, recognizeLine } from './recognize.js';

/**
 * The exported model must give the same answers here as in PyTorch. parity.json
 * is written by scripts/vision/export.py next to the weights; without an export
 * these checks are skipped, never faked.
 */
const MODEL_DIR = process.env.MOHASSAN_OCR_MODEL_DIR ?? join(process.cwd(), 'artifacts', 'vision', 'ocr-v1');
const available = existsSync(join(MODEL_DIR, 'parity.json')) && existsSync(join(MODEL_DIR, 'weights.bin'));

interface Parity {
  samples: { width: number; pixelsBase64: string; argmaxPerStep: number[]; decodedIndices: number[]; visual: string; logical: string; label: string }[];
  numeric: { width: number; pixelsBase64: string; logits: number[]; steps: number; classes: number }[];
  bidi: { logical: string; visual: string; roundTrip: string }[];
}

describe.skipIf(!available)('exported OCR model parity', () => {
  const parity: Parity = available ? JSON.parse(readFileSync(join(MODEL_DIR, 'parity.json'), 'utf-8')) : { samples: [], numeric: [], bidi: [] };

  it('loads and validates the exported weights', async () => {
    const model = await loadOcrModel(MODEL_DIR);
    expect(model.classes[0]).toBe('<blank>');
    expect(model.tensors['fc.bias'].shape[0]).toBe(model.classes.length);
  });

  it('reproduces PyTorch logits on fixed inputs', async () => {
    const model = await loadOcrModel(MODEL_DIR);
    for (const sample of parity.numeric) {
      const pixels = new Uint8Array(Buffer.from(sample.pixelsBase64, 'base64'));
      const input = prepareInput(model, { pixels, width: sample.width });
      const { logits, steps } = forward(model, input.data, input.width);
      expect(steps).toBe(sample.steps);
      expect(model.classes.length).toBe(sample.classes);
      let worst = 0;
      for (let i = 0; i < sample.logits.length; i++) worst = Math.max(worst, Math.abs(logits[i] - sample.logits[i]));
      expect(worst).toBeLessThan(2e-2);
    }
  });

  it('decodes the held-out samples exactly as PyTorch does', async () => {
    const model = await loadOcrModel(MODEL_DIR);
    for (const sample of parity.samples) {
      const pixels = new Uint8Array(Buffer.from(sample.pixelsBase64, 'base64'));
      const result = recognizeLine(model, { pixels, width: sample.width });
      expect(result.visual, sample.label).toBe(sample.visual);
      expect(toLogical(result.visual), sample.label).toBe(sample.logical);
    }
  });

  it('orders text exactly as the Python renderer', () => {
    for (const item of parity.bidi) {
      expect(toVisual(item.logical), item.logical).toBe(item.visual);
      expect(toVisual(toLogical(item.visual)), item.logical).toBe(item.roundTrip);
    }
  });
});
