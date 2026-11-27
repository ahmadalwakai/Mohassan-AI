import { AD_GUIDANCE_SLUGS, wantsAdGuidance } from '../../../../packages/skills/src/ad-guidance.js';
import { isGenericRoutingWord } from '../../../../packages/skills/src/router.js';
import type { SkillMatch, SkillReaderCandidate } from './skill-reader.js';

// Preserve the production reader's verification window (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/skill-reader.ts#L364
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

  // Reserve the verification window for independently ranked topical matches.
  const window = topical.slice(0, READER_MATCH_WINDOW);
  const guidance: SkillMatch[] = [];
  for (const slug of AD_GUIDANCE_SLUGS) {
    const skill = candidates.find(candidate => candidate.slug === slug && candidate.category === 'marketing');
    if (!skill || window.some(match => match.skill.id === skill.id)) continue;
    const match = matches.find(entry => entry.skill.id === skill.id);
    guidance.push({ skill, score: Math.max(minScore, match?.score ?? 0), terms: match?.terms ?? [], promoted: true });
  }

  const guidanceIds = new Set(guidance.map(match => match.skill.id));
  const remaining = [...topical.slice(READER_MATCH_WINDOW), ...generic].filter(match => !guidanceIds.has(match.skill.id));
  return [...window, ...guidance, ...remaining];
}
