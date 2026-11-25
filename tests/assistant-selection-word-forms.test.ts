import { describe, expect, it } from 'vitest';
import { selectionTerms, stemOverlap } from '../apps/server/src/assistant/selection/word-forms.js';

const overlap = (question: string, sentence: string) => stemOverlap(selectionTerms(question), selectionTerms(sentence));

describe('answer-selection word forms', () => {
  it('pairs a verb with its verbal noun after folding and possessive suffix removal', () => {
    expect(overlap('متى استقلت الجزائر؟', 'أعلنت الجزائرُ استقلالها.')).toBe(1);
    expect(overlap('اسْتِقْلَالًا', 'وستستقل')).toBe(1);
    expect(overlap('تهاجر الطيور', 'هجرة الطائر')).toBe(1);
  });

  it('pairs a color adjective with its gender and nominal forms', () => {
    expect(overlap('زرقاء', 'اللون الأزرق')).toBe(1);
    expect(overlap('زرقة', 'اللون الأزرق')).toBe(1);
  });

  it('handles stacked clitics, including an attached article, on either side', () => {
    expect(overlap('مشروع', 'وبمشاريعهم')).toBe(1);
    expect(overlap('فللكتب', 'كتاب')).toBe(1);
    expect(overlap('وَبِالْمَدَارِسِ', 'المدرسة')).toBe(1);
    expect(selectionTerms('فبذلك ومتى كيف')).toEqual([]);
  });

  it('supports listed broken plurals without guessing unrelated roots', () => {
    expect(overlap('مدينة', 'مدن')).toBe(1);
    expect(overlap('عضو', 'أعضائها')).toBe(1);
    expect(overlap('بالأب', 'وللآباء')).toBe(1);
    expect(overlap('علماء', 'إعلام')).toBe(0);
    expect(overlap('استقلال', 'استغلال')).toBe(0);
    expect(overlap('وصف', 'صف')).toBe(0);
    expect(overlap('rain', 'brain')).toBe(0);
  });

  it('retains shared English stems and counts a candidate term at most once', () => {
    expect(overlap('How were discoveries reported?', 'The report describes a discovery.')).toBe(1);
    expect(overlap('مدينة المدن', 'مدن مدن')).toBe(0.5);
    expect(overlap('مدينة المدن', 'مدن مدينة')).toBe(1);
    expect(overlap('متى؟', 'استقلالها')).toBe(0);
  });
});
