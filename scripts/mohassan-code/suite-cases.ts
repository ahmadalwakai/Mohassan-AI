type Language = 'ar' | 'en';
type CodingCapability = 'check' | 'search' | 'imports' | 'fix';

interface TargetCase {
  id: string;
  project: string;
  language: Language;
  capability: CodingCapability;
  goal: string;
  expect: readonly string[];
  approval?: true;
  expectApproval?: readonly string[];
  reject?: readonly string[];
  needsModel?: true;
  control?: never;
  actor?: never;
}

interface ControlCase {
  id: string;
  capability: 'control';
  goal: string;
  expect: readonly string[];
  control: true;
  actor?: 'member';
  reject?: readonly string[];
  project?: never;
  language?: never;
  approval?: never;
  expectApproval?: never;
  needsModel?: never;
}

export type SuiteCase = TargetCase | ControlCase;

const importProject = 'Import Bench';
const spellingProject = 'Spelling Bench';
const lintProject = 'Lint Bench';
const logicProject = 'Logic Bench';
const typecheckProject = 'Typecheck Bench';

function target(id: string, project: string, language: Language, capability: Exclude<CodingCapability, 'fix'>,
    goal: string, expect: readonly string[]): TargetCase {
  return { id, project, language, capability, goal, expect: [project, ...expect] };
}

const approvals = {
  ar: 'لا يُنفَّذ أي تغيير في المنطق.',
  en: 'No logic change is made.',
};
const reviewed = {
  ar: ['طبّقت أدوات الإصلاح المؤكد', 'اجتاز الناتج الاختبارات', 'فرع المراجعة:', 'لم يُدمج شيء.'],
  en: ['The proven-fix tools applied', 'the result passed the tests', 'Review branch:', 'nothing was merged.'],
};
const needsModel = {
  ar: ['لم أجد إصلاحًا يمكن إثباته', 'فلم يتغيّر شيء.', 'تعديل المنطق يحتاج نموذجًا لا يعمل الآن.'],
  en: ['I found no provable fix', 'so nothing changed.', 'A logic change needs a model, which is not running now.'],
};
const claimedChange = ['طبّقت أدوات الإصلاح المؤكد', 'طبّقت الإصلاحات المثبتة', 'فرع المراجعة:', 'The proven-fix tools applied', 'I applied the proven fixes', 'Review branch:', 'mohassan/'];

function fix(id: string, project: string, language: Language, goal: string, outcome: 'TypeScript' | 'ESLint' | 'needs-model'): TargetCase {
  const refused = outcome === 'needs-model';
  return { id, project, language, capability: 'fix', goal, approval: true,
    expectApproval: [`«${project}»`, goal, approvals[language]],
    expect: [project, ...(refused ? needsModel[language] : [...reviewed[language], 'mohassan/', outcome])],
    ...(refused ? { needsModel: true, reject: claimedChange } : {}),
  };
}

// Freeze the prompts and all expectations before measuring either checkout.
// A blocked repair can meet the case when it truthfully explains why nothing changed.
export const SUITE_CASES: readonly SuiteCase[] = [
  target('I-C-AR', importProject, 'ar', 'check', `شغّل الفحوص في مشروع ${importProject} واشرح سبب الفشل`,
    ['وفشلت.', 'returns the expected answer', 'src/answer.ts:1', 'answerValue is not defined']),
  target('I-C-EN', importProject, 'en', 'check', `Run the tests in ${importProject} and explain the failure`,
    ['they failed.', 'returns the expected answer', 'src/answer.ts:1', 'answerValue is not defined']),
  target('I-S-AR', importProject, 'ar', 'search', `ابحث في مشروع ${importProject} عن answerValue`,
    ['وجدت', 'src/answer.ts:1', 'src/values.mjs:1', 'answerValue']),
  target('I-S-EN', importProject, 'en', 'search', `Where is answerValue used in ${importProject}?`,
    ['I found', 'src/answer.ts:1', 'src/values.mjs:1', 'answerValue']),
  target('I-I-AR', importProject, 'ar', 'imports', `ما الملفات التي تستورد src/answer.ts في مشروع ${importProject}؟`,
    ['الملفات التي تستورد', 'src/answer.ts', 'test/answer.test.mjs']),
  target('I-I-EN', importProject, 'en', 'imports', `What does test/answer.test.mjs import in ${importProject}?`,
    ['imports:', 'test/answer.test.mjs', 'node:test', 'node:assert/strict', 'src/answer.ts']),
  fix('I-F-AR', importProject, 'ar', `أصلح الكود في مشروع ${importProject}`, 'TypeScript'),
  fix('I-F-EN', importProject, 'en', `Fix the code in ${importProject}`, 'TypeScript'),

  target('S-C-AR', spellingProject, 'ar', 'check', `شغّل الاختبارات في مشروع ${spellingProject} واشرح سبب الفشل`,
    ['وفشلت.', 'adds positive values', 'src/sum.ts:2', 'rightHandVaule', 'TS2552']),
  target('S-C-EN', spellingProject, 'en', 'check', `Why do the tests fail in ${spellingProject}?`,
    ['they failed.', 'adds positive values', 'src/sum.ts:2', 'rightHandVaule', 'TS2552']),
  target('S-S-AR', spellingProject, 'ar', 'search', `أين يظهر rightHandVaule في مشروع ${spellingProject}؟`,
    ['وجدت', 'src/sum.ts:2', 'rightHandVaule']),
  target('S-S-EN', spellingProject, 'en', 'search', `Search ${spellingProject} for rightHandVaule`,
    ['I found', 'src/sum.ts:2', 'rightHandVaule']),
  target('S-I-AR', spellingProject, 'ar', 'imports', `من يستورد src/sum.ts في مشروع ${spellingProject}؟`,
    ['الملفات التي تستورد', 'src/sum.ts', 'test/sum.test.mjs']),
  target('S-I-EN', spellingProject, 'en', 'imports', `What does test/sum.test.mjs import in ${spellingProject}?`,
    ['imports:', 'test/sum.test.mjs', 'node:test', 'node:assert/strict', 'src/sum.ts']),
  fix('S-F-AR', spellingProject, 'ar', `صحح الأخطاء في مشروع ${spellingProject}`, 'TypeScript'),
  fix('S-F-EN', spellingProject, 'en', `Fix the code in ${spellingProject}`, 'TypeScript'),

  target('E-C-AR', lintProject, 'ar', 'check', `شغّل الفحوص في مشروع ${lintProject} واشرح النتيجة`,
    ['ونجحت كلها.', 'نجح 1 وفشل 0 من أصل 1']),
  target('E-C-EN', lintProject, 'en', 'check', `Run the checks in ${lintProject} and explain the result`,
    ['they all passed.', '1 passed and 0 failed out of 1']),
  target('E-S-AR', lintProject, 'ar', 'search', `ابحث في مشروع ${lintProject} عن "!!true"`,
    ['وجدت', 'src/lint.mjs:2', '!!true']),
  target('E-S-EN', lintProject, 'en', 'search', `Search ${lintProject} for "!!true"`,
    ['I found', 'src/lint.mjs:2', '!!true']),
  target('E-I-AR', lintProject, 'ar', 'imports', `أي ملف يستورد src/lint.mjs في مشروع ${lintProject}؟`,
    ['الملفات التي تستورد', 'src/lint.mjs', 'test/lint.test.mjs']),
  target('E-I-EN', lintProject, 'en', 'imports', `What does test/lint.test.mjs import in ${lintProject}?`,
    ['imports:', 'test/lint.test.mjs', 'node:test', 'node:assert/strict', 'src/lint.mjs']),
  fix('E-F-AR', lintProject, 'ar', `أصلح الكود في مشروع ${lintProject}`, 'ESLint'),
  fix('E-F-EN', lintProject, 'en', `Fix the code in ${lintProject}`, 'ESLint'),

  target('L-C-AR', logicProject, 'ar', 'check', `لماذا تفشل اختبارات مشروع ${logicProject}؟`,
    ['وفشلت.', 'subtracts the discount', 'test/discount.test.mjs', 'المتوقَّع: 8، الفعلي: 12']),
  target('L-C-EN', logicProject, 'en', 'check', `Run the tests in ${logicProject} and explain why they fail`,
    ['they failed.', 'subtracts the discount', 'test/discount.test.mjs', 'Expected: 8, actual: 12']),
  target('L-S-AR', logicProject, 'ar', 'search', `ابحث عن "price + discount" في مشروع ${logicProject}`,
    ['وجدت', 'src/discount.mjs:2', 'price + discount']),
  target('L-S-EN', logicProject, 'en', 'search', `Find "price + discount" in ${logicProject}`,
    ['I found', 'src/discount.mjs:2', 'price + discount']),
  target('L-I-AR', logicProject, 'ar', 'imports', `ما الملفات التي تستورد src/discount.mjs في مشروع ${logicProject}؟`,
    ['الملفات التي تستورد', 'src/discount.mjs', 'test/discount.test.mjs']),
  target('L-I-EN', logicProject, 'en', 'imports', `What does test/discount.test.mjs import in ${logicProject}?`,
    ['imports:', 'test/discount.test.mjs', 'node:test', 'node:assert/strict', 'src/discount.mjs']),
  fix('L-F-AR', logicProject, 'ar', `أصلح الكود في مشروع ${logicProject} ليطرح الخصم من السعر`, 'needs-model'),
  fix('L-F-EN', logicProject, 'en', `Fix the code in ${logicProject} to subtract the discount from the price`, 'needs-model'),

  target('T-C-AR', typecheckProject, 'ar', 'check', `شغّل الفحوص في مشروع ${typecheckProject} واشرح سبب الفشل`,
    ['وفشلت.', 'أخطاء فحص الأنواع (tsc)', 'src/label.tsx:1', 'TS2322', "Type 'string' is not assignable to type 'number'"]),
  target('T-C-EN', typecheckProject, 'en', 'check', `Run the checks in ${typecheckProject} and explain the failure`,
    ['they failed.', 'Type check errors (tsc)', 'src/label.tsx:1', 'TS2322', "Type 'string' is not assignable to type 'number'"]),
  target('T-S-AR', typecheckProject, 'ar', 'search', `ابحث في مشروع ${typecheckProject} عن "label: number"`,
    ['وجدت', 'src/label.tsx:1', 'label: number']),
  target('T-S-EN', typecheckProject, 'en', 'search', `Search ${typecheckProject} for "label: number"`,
    ['I found', 'src/label.tsx:1', 'label: number']),
  target('T-I-AR', typecheckProject, 'ar', 'imports', `ما الملفات التي تستورد src/value.mjs في مشروع ${typecheckProject}؟`,
    ['الملفات التي تستورد', 'src/value.mjs', 'src/label.tsx', 'test/label.test.mjs']),
  target('T-I-EN', typecheckProject, 'en', 'imports', `What does src/label.tsx import in ${typecheckProject}?`,
    ['imports:', 'src/label.tsx', './value.mjs', 'src/value.mjs']),
  fix('T-F-AR', typecheckProject, 'ar', `أصلح الكود في مشروع ${typecheckProject}`, 'needs-model'),
  fix('T-F-EN', typecheckProject, 'en', `Fix the code in ${typecheckProject}`, 'needs-model'),

  { id: 'K1', capability: 'control', control: true, goal: 'ما عاصمة فرنسا؟', expect: ['باريس'] },
  { id: 'K2', capability: 'control', control: true, goal: 'صحح هذا النص: انا ذهبت الي المدرسه', expect: ['تحسين نص أو إعادة صياغته', 'نموذج'] },
  { id: 'K3', capability: 'control', control: true, goal: 'ابحث عن ملف اسمه README على جهاز الكمبيوتر', expect: ['أداة التحكم بالكمبيوتر غير متاحة'] },
  { id: 'K4', capability: 'control', control: true, goal: 'Fix the code in project Unregistered Orchard', expect: ['Which project do you mean?', 'Registered projects:', 'nothing has run.'], reject: ['Unregistered Orchard'] },
  { id: 'K5', capability: 'control', control: true, actor: 'member', goal: `أصلح الكود في مشروع ${spellingProject}`, expect: ['هذا المسار غير متاح للحساب الحالي'] },
  { id: 'K6', capability: 'control', control: true, goal: 'السلام عليكم', expect: ['وعليكم السلام'] },
];
