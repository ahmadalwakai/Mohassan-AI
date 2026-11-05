import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';

export interface BuiltinSkill { contract: SkillContract; instructions: string }

const define = (contract: unknown, instructions: string): BuiltinSkill => ({ contract: SkillContractSchema.parse(contract), instructions: instructions.trim() });

/** Project-authored skills. They are labelled `custom` and still pass the same lifecycle as imported ones. */
export const builtinSkills: readonly BuiltinSkill[] = Object.freeze([
  define({
    slug: 'verified-web-research', name: 'بحث موثق من الويب', version: '1.0.0', category: 'research', level: 'instruction',
    description: 'يوجه الوصول إلى إجابة مبنية على مصادر قُرئت فعلاً، مع التمييز بين ما ثبت وما لم يثبت.',
    requires: { tools: ['browser.open', 'research.run'], scopes: ['browser:read', 'research:read'] }, sideEffects: 'read',
  }, `
Use this when the request depends on current or checkable facts.
1. Search, then open at least two independent sources before stating a fact.
2. Report only what those pages say, and name the source next to each claim.
3. If sources disagree, show the disagreement instead of picking one silently.
4. If a fact was not found, say so plainly.`),
  define({
    slug: 'careful-form-filling', name: 'تعبئة النماذج بحذر', version: '1.0.0', category: 'browser', level: 'instruction',
    description: 'يوجه تعبئة نماذج المواقع مع مراجعة القيم والتوقف قبل أي إرسال حساس.',
    requires: { tools: ['browser.open', 'browser.interact'], scopes: ['browser:read', 'browser:write'] }, sideEffects: 'write_local',
    rollback: { mode: 'manual', note: 'تُفرَّغ الحقول يدوياً قبل الإرسال؛ لا يوجد إرسال في هذه المهارة.' },
  }, `
Use this when the task fills in a form on a website.
1. Read every field label before typing, and match values to labels.
2. After filling, read the fields back from the page to confirm the values.
3. Never guess identity, payment or legal details; ask the user.
4. Stop before the final submit button and let the approval step decide.`),
  define({
    slug: 'arabic-editing-review', name: 'مراجعة النصوص العربية', version: '1.0.0', category: 'languages', level: 'instruction',
    description: 'يوجه تحرير النص العربي وترجمته مع الحفاظ على المعنى والأرقام والأسماء.',
  }, `
Use this when writing, editing or translating Arabic text.
1. Keep the meaning, numbers, dates and names exactly as given.
2. Prefer clear modern standard Arabic unless the user asks for a dialect.
3. Keep English product names and code identifiers unchanged.
4. Note any place where the source is ambiguous rather than inventing a meaning.`),
]);
