import { createTermIndex } from '../../../../packages/skills/src/catalogue.js';
import { readerEvidenceTerms } from '../../../../packages/skills/src/reader-terms.js';
import type { RequestTerm } from '../../../../packages/skills/src/stems.js';
import type { SkillReaderCandidate } from './skill-reader.js';

// SKILL.md descriptions already carry author-supplied aliases after these labels.
const KEYWORDS = /(?:^|\s)(?:كلمات|keywords)\s*[:：]\s*/iu;
const vocabulary = (text: string) => readerEvidenceTerms(text).flatMap(term => term.variants);

export type FindReaderTopic = (terms: readonly RequestTerm[]) => { skill: SkillReaderCandidate; terms: string[]; coverage: number } | null;

export function buildReaderRecallIndex(candidates: readonly SkillReaderCandidate[]): FindReaderTopic {
  const anchors = candidates.map(skill => {
    const label = KEYWORDS.exec(skill.description);
    const aliases = label ? skill.description.slice(label.index + label[0].length) : '';
    return new Set(vocabulary(`${skill.name} ${skill.slug} ${aliases}`));
  });
  // Prose can disqualify an ambiguous alias, but only a title or explicit keyword can support a pick.
  const index = createTermIndex(candidates.map((skill, position) => [...anchors[position]!, ...vocabulary(skill.description)]));

  return terms => {
    const topics = new Set(terms.map(term => term.variants[0]));
    const matched = new Map<string, string>();
    const used = new Set<string>();
    let owner: number | undefined;
    for (const { word, variants } of terms) {
      const positions = index.shortlist(variants);
      if (positions.length !== 1) continue;
      const position = positions[0]!;
      const anchor = variants.find(form => anchors[position]!.has(form));
      if (!anchor) continue;
      if (owner !== undefined && owner !== position) return null;
      owner = position;
      const topic = variants[0]!;
      if (!used.has(anchor) && !matched.has(topic)) {
        matched.set(topic, word);
        used.add(anchor);
      }
    }
    if (owner === undefined) return null;
    return { skill: candidates[owner]!, terms: [...matched.values()], coverage: matched.size / topics.size };
  };
}
