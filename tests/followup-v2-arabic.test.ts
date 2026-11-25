import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicConversationFollowup } from '../apps/server/src/assistant/public-conversation-followup.js';
import { rewriteFollowUpQuestion } from '../apps/server/src/assistant/question-rewriter.js';
import { resolveRequestContext } from '../apps/server/src/assistant/request-context.js';

describe('Arabic follow-ups with the v2 rollout enabled', () => {
  beforeEach(() => vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('binds an age question to the person named in the preceding answer', () => {
    expect(rewriteFollowUpQuestion('وكم عمره؟', {
      turns: [{ question: 'ما اسم مهندس الجسر؟', answer: 'سامر النعيمي' }],
    })).toBe('كم عمر سامر النعيمي؟');
  });

  it('binds a founder question to the institution named in the preceding question', () => {
    expect(rewriteFollowUpQuestion('ومن أسسها؟', {
      turns: [{ question: 'أين تقع دار فنون السنديان؟' }],
    })).toBe('من أسس دار فنون السنديان؟');
  });

  it.each([
    { request: 'وماذا عن النمسا؟', query: 'عاصمة النمسا' },
    { request: 'وما عملتها؟', query: 'عملة المجر' },
  ])('refines the authorized public lookup for $request', ({ request, query }) => {
    const earlier = 'ما عاصمة المجر؟';
    const previous = resolveRequestContext(earlier, undefined, { turnId: 'prior' }).nextState;
    const resolution = resolveRequestContext(request, previous, { turnId: 'current' });

    expect(publicConversationFollowup({
      request,
      resolution,
      previousSource: previous?.sourceAssessment,
      earlierUserTurns: [earlier],
    })).toBe(query);
  });
});
