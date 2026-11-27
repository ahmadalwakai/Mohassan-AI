import { describe, expect, it } from 'vitest';
import { ChatQuestionSchema } from '@mohassan/contracts';
import { clarificationCard, clarificationLanguage, decideClarification, missingClarificationSlot,
  type ClarificationChoice } from '../apps/server/src/assistant/clarify/policy.js';
import { resolveRequestContext } from '../apps/server/src/assistant/request-context.js';

// Development-only policy assertions. Numeric evidence is constructed in-process.
// The subject comes from the owner's request. These inputs are never training data.
const values = ['Paris, Texas', 'Paris, France', 'Paris Hilton', 'Paris (mythology)', 'Paris, Ontario'];
const candidates = (...scores: number[]): ClarificationChoice[] => scores.map((score, index) => ({
  label: values[index]!, value: values[index]!, score, source: 'search',
}));

describe('clarification choice policy', () => {
  it('requires corroborated alternatives and lets a well-separated or explicit choice win', () => {
    const input = { kind: 'entity', language: 'en', subject: 'Paris' } as const;
    expect(decideClarification({ ...input, candidates: candidates(0.81) }).decision).toBe('insufficient_evidence');
    expect(decideClarification({ ...input, candidates: candidates(0.91, 0.72) }).decision).toBe('clear_winner');
    expect(decideClarification({ ...input, candidates: candidates(0.95) }).decision).toBe('clear_winner');
    expect(decideClarification({ ...input, candidates: candidates(0.84, 0.81) }).decision).toBe('ask');
  });

  it('deduplicates, drops weak evidence, and gives the existing card at most four suggestions', () => {
    const variants = candidates(0.81, 0.82, 0.84, 0.85, 0.86);
    const result = decideClarification({ kind: 'entity', language: 'ar', subject: 'باريس', candidates: [
      { ...variants[4]!, score: 0.83, source: 'conversation' }, ...variants,
      { label: 'باريس', value: 'باريس', score: 0.51, source: 'search' },
    ] });
    expect(result.decision).toBe('ask');
    if (result.decision !== 'ask') return;
    expect(result.plan.reason).toBe('entity_matches');
    const card = ChatQuestionSchema.parse(clarificationCard(result.plan));
    expect(card.prompt).toBe('ماذا تقصد بـ«باريس»؟');
    expect(card.options.map(option => option.label)).toEqual(values.slice(1).reverse());
    expect(card.fields).toEqual([{ id: 'choice', prompt: card.prompt, placeholder: 'غير ذلك…',
      suggestions: card.options.map(({ label }) => ({ label })) }]);
  });

  it('uses the language of the request even when the subject uses another script', () => {
    expect(clarificationLanguage('Tell me about باريس')).toBe('en');
    expect(clarificationLanguage('أخبرني عن Paris')).toBe('ar');
  });

  it('leaves an explicitly named document and account alone', () => {
    expect(missingClarificationSlot('Read the file on my computer.')).toBe('file');
    expect(missingClarificationSlot('Read the file AGENTS.md.')).toBeNull();
    expect(missingClarificationSlot('افتح الملف على جهازي')).toBe('file');
    expect(missingClarificationSlot('افتح الملف علي جهازي')).toBe('file');
    expect(missingClarificationSlot('Show the balance in my account.')).toBe('account');
    expect(missingClarificationSlot('Show the balance in my personal account.')).toBeNull();
  });

  it('recognizes the supplied reminder date with either spelling of Friday', () => {
    for (const request of ['ذكرني يوم الجمعه بالاجتماع', 'ذكرني يوم الجمعة بالاجتماع']) {
      const resolution = resolveRequestContext(request);
      expect(resolution.intent).toBe('reminder');
      expect(missingClarificationSlot(request, resolution)).toBeNull();
    }
  });

  it('recognizes the account slot with either spelling of the preposition', () => {
    expect(missingClarificationSlot('اعرض الفواتير علي حسابي')).toBe('account');
    expect(missingClarificationSlot('اعرض الفواتير على حسابي')).toBe('account');
  });
});
