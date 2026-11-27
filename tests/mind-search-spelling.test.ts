import { describe, expect, it } from 'vitest';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';
import { compileQuery } from '../packages/browser/src/search/ranking.js';

describe('Arabic spelling in search terms shared with Mind', () => {
  it.each(['من هو مصطفى كامل؟', 'من هو "مصطفى كامل"؟'])(
    'preserves the spelling of the name in %s',
    question => {
      expect(compileQuery(question).tokens).toEqual(['مصطفى', 'كامل']);
    },
  );

  it('preserves the spelling of focus terms used for evidence retrieval', () => {
    const { focus } = buildFrame('ما معنى كلمة الله في اللغة؟');
    expect(focus).toEqual(expect.arrayContaining(['معنى', 'الله']));
  });
});
