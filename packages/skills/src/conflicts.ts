import { TOOL_SIDE_EFFECTS, type SkillContract, type SkillPlanIssue, type SkillToolId } from '@mohassan/contracts';

export interface ConflictNode { id: string; contract: SkillContract; instructions: string }

/** Each of these holds one shared thing, so two skills using it must not overlap. */
const EXCLUSIVE: Readonly<Partial<Record<SkillToolId, string>>> = Object.freeze({
  'browser.interact': 'جلسة المتصفح', 'browser.submit': 'جلسة المتصفح', 'file.write': 'ملفات المجلد الممنوح', 'coding.change': 'مستودع البرمجة', 'studio.change': 'نسخة الاستوديو', 'computer.act': 'جهاز Windows',
});
const POSITIVE = /(?:^|[\s.:;-])(?:always|must|دائماً|دائما|يجب)\s+(.+)/iu;
const NEGATIVE = /(?:^|[\s.:;-])(?:never|must not|do not|don't|لا\s+ت|لا\s+ي|يمنع|ممنوع)\s*(.+)/iu;
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'any', 'all', 'it', 'in', 'on', 'for', 'من', 'في', 'على', 'إلى', 'أي', 'كل']);
const SIMILAR = 0.6;

function directives(text: string) {
  const found: { negative: boolean; words: Set<string>; line: string }[] = [];
  for (const line of text.split('\n').slice(0, 200)) {
    const negative = NEGATIVE.exec(line), positive = negative ? null : POSITIVE.exec(line);
    const object = negative?.[1] ?? positive?.[1];
    if (!object) continue;
    const words = new Set(object.toLocaleLowerCase('ar').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOP.has(word)).slice(0, 12));
    if (words.size >= 2) found.push({ negative: Boolean(negative), words, line: line.trim().slice(0, 80) });
  }
  return found;
}
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((word) => b.has(word)).length / new Set([...a, ...b]).size;

/** Direct contradictions only, and only a warning: wording this loose cannot prove two skills disagree. */
function instructionConflicts(a: ConflictNode, b: ConflictNode): SkillPlanIssue[] {
  const left = directives(a.instructions), right = directives(b.instructions);
  for (const first of left) for (const second of right) {
    if (first.negative !== second.negative && overlap(first.words, second.words) >= SIMILAR) {
      return [{ code: 'instruction_conflict', severity: 'warning', category: 'conflict', nodeId: b.id, message: `تعليمات ${a.contract.slug} و${b.contract.slug} قد تتعارض: ${first.line}` }];
    }
  }
  return [];
}

const toolsOf = (contract: SkillContract) => new Set<SkillToolId>([...contract.requires.tools, ...contract.steps.flatMap((step) => (step.tool ? [step.tool] : []))]);

export function detectSkillConflicts(nodes: readonly ConflictNode[], ordered: (a: string, b: string) => boolean): SkillPlanIssue[] {
  const issues: SkillPlanIssue[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.contract.slug === b.contract.slug) issues.push({ code: 'duplicate_skill', severity: 'warning', category: 'conflict', nodeId: b.id, message: `المهارة ${a.contract.slug} مكررة في الخطة.` });
    if (a.contract.conflicts.includes(b.contract.slug) || b.contract.conflicts.includes(a.contract.slug)) issues.push({ code: 'declared_conflict', severity: 'error', category: 'conflict', nodeId: b.id, message: `المهارتان ${a.contract.slug} و${b.contract.slug} معلنتان كمتعارضتين.` });
    if (!ordered(a.id, b.id)) {
      const shared = [...toolsOf(a.contract)].filter((tool) => EXCLUSIVE[tool] && [...toolsOf(b.contract)].some((other) => EXCLUSIVE[other] === EXCLUSIVE[tool]));
      for (const resource of new Set(shared.map((tool) => EXCLUSIVE[tool]))) issues.push({ code: 'resource_conflict', severity: 'error', category: 'conflict', nodeId: b.id, message: `${a.id} و${b.id} تستخدمان ${resource} بالتوازي؛ حدد ترتيباً بينهما.` });
    }
    issues.push(...instructionConflicts(a, b));
  }
  return issues;
}

export const requiresApproval = (contract: SkillContract) => contract.sideEffects !== 'none' && contract.sideEffects !== 'read'
  || contract.level !== 'instruction' && [...toolsOf(contract)].some((tool) => TOOL_SIDE_EFFECTS[tool] !== 'read');
