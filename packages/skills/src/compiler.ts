import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';
import { parseSkillManifest } from './frontmatter.ts';
import { skillTerms, type SkillContextMetadata } from './router.ts';

export const DEFAULT_SKILL_CONTEXT_CHARS = 4000;
export const MAX_SKILL_CONTEXT_CHARS = 12000;
export interface InstructionDocument {
  metadata: SkillContextMetadata;
  files: readonly { path: string; kind: string; content: string; contentHash: string }[];
}
export interface SkillContextSource { skillId: string; version: string; skillContentHash: string; path: string; contentHash: string; truncated: boolean }
export interface CompiledSkillContext { text: string; skills: SkillContextMetadata[]; sources: SkillContextSource[] }
export const emptySkillContext = (): CompiledSkillContext => ({ text: '', skills: [], sources: [] });

export function skillContextBudget(value = DEFAULT_SKILL_CONTEXT_CHARS): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SkillError('SKILL_CONTEXT_BUDGET_INVALID', 'ميزانية سياق المهارات غير صالحة.');
  return Math.min(MAX_SKILL_CONTEXT_CHARS, value);
}

/** Produces complete escaped JSON; only individual data strings may be shortened. */
export function compileInstructionContext(documents: readonly InstructionDocument[], goal: string, budgetChars?: number): CompiledSkillContext {
  const budget = skillContextBudget(budgetChars);
  type Snippet = { path: string; contentHash: string; text: string; truncated: boolean };
  type Entry = { id: string; slug: string; name: string; version: string; contentHash: string; sources: Snippet[] };
  const entries: Entry[] = [], metadata: SkillContextMetadata[] = [], sources: SkillContextSource[] = [];
  const seen = new Set<string>();
  const envelope = () => JSON.stringify({ kind: 'skill_context', trust: 'untrusted_instructions', permissionsGranted: false, skills: entries });
  const add = (document: InstructionDocument, file: InstructionDocument['files'][number], content: string, entry: Entry): boolean => {
    const textHash = sha256(content);
    if (seen.has(textHash) || !content.trim()) return false;
    const snippet: Snippet = { path: file.path, contentHash: file.contentHash, text: content, truncated: false };
    entry.sources.push(snippet);
    if (envelope().length > budget) {
      snippet.truncated = true;
      let low = 0, high = content.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2); snippet.text = content.slice(0, middle);
        if (envelope().length <= budget) low = middle; else high = middle - 1;
      }
      snippet.text = content.slice(0, low);
      if (!snippet.text.trim() || envelope().length > budget) { entry.sources.pop(); return false; }
    }
    seen.add(textHash);
    sources.push({ skillId: document.metadata.id, version: document.metadata.version, skillContentHash: document.metadata.contentHash, path: file.path, contentHash: file.contentHash, truncated: snippet.truncated });
    return true;
  };
  const selected: { document: InstructionDocument; entry: Entry; instructions: string }[] = [];
  // Every selected skill gets SKILL.md before any skill gets a reference file.
  for (const document of documents.slice(0, 6)) {
    const main = document.files.find(file => file.path === 'SKILL.md' && file.kind === 'instructions');
    if (!main) continue;
    const instructions = main.content.trimStart().startsWith('---') ? parseSkillManifest(main.content).body : main.content;
    const { id, slug, name, version, contentHash } = document.metadata;
    const entry: Entry = { id, slug, name, version, contentHash, sources: [] }; entries.push(entry);
    if (!add(document, main, instructions, entry)) { entries.pop(); continue; }
    metadata.push(document.metadata); selected.push({ document, entry, instructions });
  }
  const terms = new Set(skillTerms(goal));
  for (const { document, entry, instructions } of selected) {
    const references = document.files.filter(file => file.kind === 'reference')
      .map(file => ({ file, score: (instructions.includes(file.path) ? 100 : 0) + skillTerms(file.path).filter(term => terms.has(term)).length }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, 'en'));
    for (const { file } of references) add(document, file, file.content, entry);
  }
  return entries.length ? { text: envelope(), skills: metadata, sources } : emptySkillContext();
}
