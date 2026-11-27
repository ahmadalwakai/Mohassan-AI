import { describe, expect, it } from 'vitest';
import { councilWeight } from '../apps/server/src/assistant/council-receipts.js';

describe('council accuracy receipts', () => {
  it('selects matched passage QA receipts and keeps the measured ordering specific to each language', () => {
    const v3 = (language: 'ar' | 'en') => councilWeight('reading-v3-last', 'reader', language, 'reading');
    const lora = (language: 'ar' | 'en') => councilWeight('reading-v4-lora', 'reader', language, 'reading');
    // Published exact matches: Arabic T1 LoRA leads on both sets, and v3 leads on English SQuAD.
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/RESPONSE-QUALITY-RESULTS-2026-11-22.md#L282-L290 (retrieved 2026-11-27)
    expect(lora('ar').weight).toBeGreaterThan(v3('ar').weight);
    expect(v3('en').weight).toBeGreaterThan(lora('en').weight);
    expect(v3('ar')).toMatchObject({ measured: true, weightSource: expect.stringContaining('TyDi Arabic + ARCD') });
    expect(v3('en')).toMatchObject({ measured: true, weightSource: expect.stringContaining('SQuAD') });
  });

  it('reports minimum weight when any receipt dimension is missing', () => {
    const unknown = [
      councilWeight('reading-v4-hn-last', 'reader', 'en', 'reading'),
      councilWeight('reading-v3-last', 'reader', 'other', 'reading'),
      councilWeight('reading-v3-last', 'reader', 'ar', 'date'),
      councilWeight('reading-v3-last', 'verifier', 'ar', 'reading'),
      councilWeight('pipeline', 'pipeline', 'en', 'population'),
    ];
    for (const vote of unknown) {
      expect(vote).toMatchObject({ weight: 0, measured: false, weightSource: expect.stringContaining('no measured accuracy receipt') });
    }
  });
});
