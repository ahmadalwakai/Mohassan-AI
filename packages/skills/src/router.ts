import type { SkillCategory } from '@mohassan/contracts';

export interface SkillContextMetadata {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: string;
  contentHash: string;
}

const CATEGORY_WORDS: Record<SkillCategory, string> = {
  reasoning: 'reasoning planning plan تحليل تخطيط خطة استدلال',
  coding: 'coding code software program typescript javascript python برمجة كود برنامج تطبيق',
  browser: 'browser web navigate website متصفح تصفح موقع',
  computer: 'computer desktop windows حاسوب كمبيوتر سطح مكتب',
  design: 'design ui ux interface تصميم واجهة ألوان',
  creativity: 'creativity creative ideas إبداع أفكار ابتكار',
  documents: 'documents document report pdf word مستند وثيقة تقرير',
  languages: 'languages translate translation لغة ترجمة لغات',
  business: 'business company strategy أعمال شركة استراتيجية',
  marketing: 'marketing campaign ads تسويق حملة إعلان',
  research: 'research sources evidence search بحث مصادر أدلة',
  security: 'security audit permissions أمان أمن تدقيق صلاحيات',
  analytics: 'analytics data analysis statistics بيانات إحصاء تحليلات',
  media: 'media image video audio صورة فيديو صوت',
};
const STOP_WORDS = new Set('the a an and or to of in for on with this that please use task من في على إلى الى عن هذا هذه مع أو او و طلب مهمة'.split(' '));
export function skillTerms(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(term => term.length > 1 && !STOP_WORDS.has(term)).slice(0, 100);
}

export interface SkillRoutingRelations {
  /** Bounded, positive graph relations already filtered by the owner's graph.
   * Conflict edges are never converted into recommendation candidates. */
  relatedCandidates?: readonly SkillContextMetadata[];
}

/** Deterministic metadata-only ranking. A match is guidance, never a tool grant. */
export function routeInstructionSkills(goal: string, candidates: readonly SkillContextMetadata[], limit = 6, relations: SkillRoutingRelations = {}): SkillContextMetadata[] {
  const terms = skillTerms(goal.slice(0, 16000));
  const related = relations.relatedCandidates?.slice(0, 12) ?? [];
  if (!terms.length && !related.length) return [];
  const relatedIds = new Set(related.map(skill => skill.id));
  const combined = [...new Map([...candidates.slice(0, 200), ...related].map(skill => [skill.id, skill])).values()];
  const overlap = (text: string) => { const words = new Set(skillTerms(text)); return terms.filter(term => words.has(term)).length; };
  return combined.map(skill => ({ skill, score: overlap(skill.slug.replace(/-/g, ' ')) * 6 + overlap(skill.name) * 4 + overlap(skill.description) * 2 + overlap(CATEGORY_WORDS[skill.category]) }))
    .filter(entry => entry.score > 0 || relatedIds.has(entry.skill.id))
    .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug, 'en') || a.skill.id.localeCompare(b.skill.id, 'en'))
    .slice(0, Math.min(6, Math.max(0, Math.floor(limit))))
    .map(entry => entry.skill);
}
