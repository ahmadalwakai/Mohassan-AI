import { describe, expect, it } from 'vitest';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';
import { reviewMemoryRecallEvidence } from '../apps/server/src/assistant/memory-recall-evidence.js';
import { parsePreferredLanguageFact } from '../apps/server/src/assistant/preferred-language-fact.js';

const EN = 'From my memory, return my preferred language only.';
const AR = 'من ذاكرتي، أعد لغتي المفضلة فقط.';

/** Independent cached-source audit; no provider, storage, network or write. */
describe('preferred-language proof retains the complete leading source statement', () => {
  it.each([
    { request: EN, prefix: 'I prefer Arabic', suffix: 'and English.', proposed: 'Arabic' },
    { request: EN, prefix: 'I prefer Arabic', suffix: 'except at work.', proposed: 'Arabic' },
    { request: EN, prefix: 'My preferred language is Arabic', suffix: 'except for my client.', proposed: 'Arabic' },
    { request: AR, prefix: 'أنني أفضل العربية', suffix: 'والإنجليزية.', proposed: 'العربية' },
    { request: AR, prefix: 'لغتي المفضلة هي العربية', suffix: 'إلا في العمل.', proposed: 'العربية' },
  ])('does not promote a clipped prefix into whole-preference evidence: $prefix / $suffix', async entry => {
    const source = `${entry.prefix}${' '.repeat(350)}${entry.suffix}`;
    expect(source.length).toBeGreaterThan(320);
    expect(parsePreferredLanguageFact(source)).toBeNull();
    const local = await evaluateLocalRecall(entry.request, { async memory() { return [source]; } }, new AbortController().signal);
    const reviewed = await reviewMemoryRecallEvidence(entry.request, entry.proposed, [source], new AbortController().signal);
    expect(local?.status, JSON.stringify(local)).not.toBe('completed');
    expect(reviewed.status, JSON.stringify(reviewed)).not.toBe('verified');
  });

  it.each([
    { request: EN, source: 'I prefer Arabic.', proposed: 'Arabic' },
    { request: EN, source: 'My preferred language is English.', proposed: 'English' },
    { request: AR, source: 'أنني أفضل العربية', proposed: 'العربية' },
    { request: AR, source: 'لغتي المفضلة هي الإنجليزية.', proposed: 'الإنجليزية' },
  ])('keeps complete supported statements usable: $source', async entry => {
    const reviewed = await reviewMemoryRecallEvidence(entry.request, entry.proposed, [entry.source], new AbortController().signal);
    expect(reviewed).toMatchObject({ status: 'verified', answer: entry.proposed,
      reply: { status: 'completed', text: entry.proposed, evidence: [{ source: 'memory', value: entry.proposed }] } });
    if (reviewed.status === 'verified') {
      expect(entry.source.includes(reviewed.reply.evidence[0]!.quote)).toBe(true);
      expect(reviewed.reply.evidence[0]!.quote.includes(entry.proposed)).toBe(true);
    }
  });

  it.each(['From my memory, what is my preferred language?', 'من ذاكرتي، ما لغتي المفضلة؟'])
    ('leaves an unformatted self-preference conflict unresolved: %s', async request => {
      const source = ['I prefer Arabic.', 'لغتي المفضلة هي الإنجليزية.'];
      const result = await evaluateLocalRecall(request, { async memory() { return source; } }, new AbortController().signal);
      expect(result?.status, JSON.stringify(result)).toBe('partial');
      expect(result?.claims.filter(claim => claim.status === 'conflict')).toHaveLength(2);
      expect(result?.evidence.map(evidence => evidence.source)).toEqual(['memory', 'memory']);
    });
});
