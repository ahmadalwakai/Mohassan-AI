import { AD_GUIDANCE_SLUGS, wantsAdGuidance } from '../../../../packages/skills/src/ad-guidance.js';
import { isGenericRoutingWord } from '../../../../packages/skills/src/router.js';
import type { SkillMatch, SkillReaderCandidate } from './skill-reader.js';

export const READER_MATCH_WINDOW = 3;

/** Prioritize evidence about the topic while retaining generic matches as fallbacks. */
export function orderReaderMatches(request: string, matches: SkillMatch[], candidates: readonly SkillReaderCandidate[], minScore: number): SkillMatch[] {
  const topical: SkillMatch[] = [];
  const generic: SkillMatch[] = [];
  for (const [position, match] of matches.entries()) {
    if (match.terms.some(term => !isGenericRoutingWord(term))) topical.push(match);
    else generic.push(position < READER_MATCH_WINDOW ? { ...match, genericFallback: true } : match);
  }
  if (!wantsAdGuidance(request)) return [...topical, ...generic];

  // PR #2 reserves a place for active Ads guidance after the first topical match.
  // https://github.com/ahmadalwakai/Mohassan-AI/pull/2 (retrieved 2026-11-27).
  const first = topical[0];
  const guidance: SkillMatch[] = [];
  for (const slug of AD_GUIDANCE_SLUGS) {
    const skill = candidates.find(candidate => candidate.slug === slug && candidate.category === 'marketing');
    if (!skill || skill.id === first?.skill.id) continue;
    const match = matches.find(entry => entry.skill.id === skill.id);
    // Keep a promoted guide within the reader's same-language comparison window.
    guidance.push({ skill, score: first?.score ?? Math.max(minScore, match?.score ?? 0), terms: match?.terms ?? [] });
  }

  const guidanceIds = new Set(guidance.map(match => match.skill.id));
  const remaining = [...topical.slice(1), ...generic].filter(match => !guidanceIds.has(match.skill.id));
  return [...topical.slice(0, 1), ...guidance, ...remaining];
}
