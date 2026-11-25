import { describe, expect, it } from 'vitest';
import { assessRequestScope, reviewPublicProjection } from '../apps/server/src/assistant/request-scope.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

/**
 * A dot inside a token is not sentence punctuation. Measured on 2026-11-22 (0-baseline §8.2): «Node.js latest version»
 * was refused as a public search because «Node.js» read as a sentence, and the run ended as «تعذّر» with no reply.
 */
describe('nominal public subjects with dots inside tokens', () => {
  it('keeps a short noun phrase with a dotted token a nominal public subject', () => {
    for (const text of ['Node.js latest version', 'python 3.12 release notes', 'ASP.NET Core تثبيت', 'سعر iPhone 15 Pro Max']) {
      const source = assessRequestScope(text);
      expect(source, text).toMatchObject({ source: 'public_lookup', scope: 'public', publicQueryEligible: true });
      expect(reviewPublicProjection(text, text).eligible, text).toBe(true);
    }
  });

  it('still reads a dot before a space or at the end as a sentence boundary', () => {
    expect(assessRequestScope('Describe a stack data structure.')).toMatchObject({ source: 'unresolved', reasons: ['missing_target'] });
    expect(assessRequestScope('My invoice is late. Send it again')).not.toMatchObject({ source: 'public_lookup' });
  });

  it('keeps acting requests and private references out of public lookup', () => {
    expect(assessRequestScope('احجز لي طاولة في مطعم')).toMatchObject({ source: 'unresolved', operation: 'act' });
    expect(assessRequestScope('ما هي ملاحظاتي عن العميل')).toMatchObject({ scope: 'private' });
  });

  it('recognizes a standalone Iraqi Arabic fact question and preserves private scope', () => {
    const question = 'شنو لون الياقوت؟';
    expect(assessRequestScope(question)).toMatchObject({ source: 'public_lookup', operation: 'lookup' });
    expect(decideRequestRoute({ text: question, capabilities: { search: true } })).toMatchObject({ route: 'web_search' });
    expect(assessRequestScope('شنو اسم شركتي؟')).toMatchObject({ source: 'prior_conversation', scope: 'private' });
  });
});
