import { describe, expect, it } from 'vitest';
import {
  classifyLearnedRefusal, refusalFeatureBuckets, scoreLearnedRefusal,
} from '../apps/server/src/assistant/refusal/learned-classifier.js';

describe('scratch-trained refusal score', () => {
  it('uses the Python trainer’s hashed features on accents and Arabic digits', () => {
    expect([...refusalFeatureBuckets('A\u030A١')].sort((a, b) => a - b))
      .toEqual([562, 5405, 7266, 8661, 21976, 23020, 26886]);
    expect(refusalFeatureBuckets('أَل٣')).toEqual(refusalFeatureBuckets('ال3'));
  });

  it('bounds feature extraction and abstains from empty text', () => {
    expect(refusalFeatureBuckets('x'.repeat(513))).toEqual(refusalFeatureBuckets('x'.repeat(512)));
    expect(classifyLearnedRefusal(' ؟🌤 ')).toBeNull();
  });

  // English calibration utterances from Larson et al., CLINC150 (CC BY 3.0).
  // The pinned source and full attribution are in scripts/refusal-classifier/README.md.
  it('matches the Python score for a confident out-of-scope prediction', () => {
    const score = classifyLearnedRefusal("i need you to text mickey saying 'can we reschedule");
    expect(score?.code).toBe('out_of_scope');
    expect(score?.confidence).toBeCloseTo(0.9770671114, 8);
  });

  it('abstains from a low-confidence refusal prediction', () => {
    const utterance = 'i need leslie to be texted saying have a good day';
    expect(scoreLearnedRefusal(utterance).label).toBe('out_of_scope');
    expect(classifyLearnedRefusal(utterance)).toBeNull();
  });

  // Arabic calibration utterance from MASSIVE (CC BY 4.0), © Amazon.com, Inc.
  // or its affiliates, localized from CC BY 4.0 SLURP text with human annotators.
  it('allows a human-localized Arabic weather query', () => {
    expect(classifyLearnedRefusal('هل يجب أن أرتدي جاكيت اليوم')).toBeNull();
  });
});
