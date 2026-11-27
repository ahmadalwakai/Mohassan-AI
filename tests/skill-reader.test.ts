import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectSkill } from '@mohassan/skills';
import { buildSkillSource } from '../packages/skills/src/importer.ts';
import {
  buildSkillReaderIndex, composeSkillAnswer, createSkillReader, matchSkills, parseSkillSections, requestTerms, skillInstructionText, skillReadable, skillStems,
  type SkillReaderCandidate,
} from '../apps/server/src/assistant/skill-reader.js';

const SKILLS_DIR = resolve('skills');
interface Bundle { candidate: SkillReaderCandidate; body: string }
async function bundles(directory = SKILLS_DIR): Promise<Bundle[]> {
  const folders = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return Promise.all(folders.map(async slug => {
    const content = await readFile(join(directory, slug, 'SKILL.md'), 'utf8');
    const source = buildSkillSource([{ path: 'SKILL.md', content }], { root: `github:owner/skills@${'a'.repeat(40)}:skills/${slug}`, defaultSlug: slug });
    const { contract } = source;
    return { candidate: { id: `id-${slug}`, slug, name: contract.name, description: contract.description, category: contract.category, version: contract.version, contentHash: 'f'.repeat(64) },
      body: content.replace(/^---[\s\S]*?\n---\n/u, '') };
  }));
}

const fixture = (slug: string, name: string, description: string, category = 'reasoning'): SkillReaderCandidate => ({ id: `id-${slug}`, slug, name, description, category, version: '1.0.0', contentHash: 'e'.repeat(64) });

describe('Arabic-aware skill terms', () => {
  it('folds letters, drops the article and common suffixes the same way on both sides', () => {
    expect(skillStems('المقالات والتدوينات')).toEqual(expect.arrayContaining(['مقال', 'تدوين']));
    expect(skillStems('مقالة')).toEqual(['مقال']);
    expect(skillStems('أسعار الإعلانات')).toEqual(expect.arrayContaining(['اسعار', 'اعلان']));
    expect(skillStems('Writing professional emails')).toEqual(expect.arrayContaining(['writ', 'professional', 'email']));
    expect(skillStems('كيف هل من في the a how')).toEqual([]);
  });
  it('tries a word with and without a leading conjunction or preposition', () => {
    const [term] = requestTerms('ومقال');
    expect(term!.variants).toEqual(expect.arrayContaining(['ومقال', 'مقال']));
    expect(requestTerms('وصف')[0]!.variants).toEqual(['وصف']);
  });
});

describe('selecting a skill', () => {
  const pool = [
    fixture('arabic-seo-article', 'كتابة مقال متوافق مع محركات البحث', 'يوجّه كتابة مقال عربي. كلمات: مقال تدوينة سيو SEO كلمات مفتاحية جوجل اكتب article blog seo', 'marketing'),
    fixture('social-media-posts', 'كتابة منشورات وسائل التواصل', 'منشورات. كلمات: منشور بوست انستغرام تيك توك وسوم اكتب social media post instagram', 'marketing'),
    fixture('personal-budget', 'إعداد ميزانية شخصية', 'ميزانية شهرية. كلمات: ميزانية مصاريف راتب ادخار budget saving', 'business'),
  ];
  it('ranks the skill whose name and description share the request words, weighting rare words higher', () => {
    const [first] = matchSkills('كيف أكتب مقال سيو يتصدر جوجل؟', pool);
    expect(first!.skill.slug).toBe('arabic-seo-article');
    expect(first!.terms).toEqual(expect.arrayContaining(['مقال', 'سيو']));
    expect(matchSkills('how do I write an instagram post', pool)[0]!.skill.slug).toBe('social-media-posts');
  });
  it('keeps bare topics, generic wording and unrelated requests silent', () => {
    expect(matchSkills('مقال', pool)).toEqual([]);
    expect(matchSkills('اكتب لي شيئًا', pool)).toEqual([]);
    expect(matchSkills('ما عاصمة اليابان؟', pool)).toEqual([]);
    expect(matchSkills('', pool)).toEqual([]);
    expect(matchSkills('ميزانية', [])).toEqual([]);
  });
});

describe('when a skill may answer', () => {
  it('keeps live facts, plain fact questions in advice mode and reworking a supplied text away from skills', () => {
    expect(skillReadable('كيف أكتب مقال سيو؟', 'advice')).toBe(true);
    expect(skillReadable('خطة تسويق لمطعمي', 'advice')).toBe(true);
    expect(skillReadable('ما هي خطوات كتابة السيرة الذاتية؟', 'advice')).toBe(true);
    expect(skillReadable('ما هو السيو؟', 'advice')).toBe(false);
    expect(skillReadable('ما هو السيو؟', 'fallback')).toBe(true);
    expect(skillReadable('كيف حال الطقس اليوم؟', 'advice')).toBe(false);
    expect(skillReadable('اكتب مقال عن القهوة', 'writing')).toBe(true);
    expect(skillReadable('ترجم هذا النص إلى الإنجليزية', 'writing')).toBe(false);
    expect(skillReadable('لخص لي هذا المقال', 'writing')).toBe(false);
    expect(skillReadable('كيف أحدد سعر منتجي؟', 'advice')).toBe(true);
    expect(skillReadable('x'.repeat(900), 'fallback')).toBe(false);
  });
});

describe('reading a skill body', () => {
  const body = [
    'مقدمة المهارة في سطر.', '', '## متى تُستخدم', '- عند الحاجة.', '', '## ما أحتاجه منك', '- الموضوع.', '', '## الخطوات', '1. افعل الأول لـ {{الطلب}}.', '2. ثم الثاني.',
    '', '## شكل الجواب', '- العنوان.', '', '## تحقق قبل التسليم', '- هل تم؟', '', '## ملاحظة خاصة', 'نص إضافي <!-- مخفي --> ظاهر‮.',
  ].join('\n');
  it('names known sections, keeps unknown ones and removes hidden text', () => {
    const parsed = parseSkillSections(body);
    expect(parsed.intro).toBe('مقدمة المهارة في سطر.');
    expect(parsed.sections.map(section => section.key)).toEqual(['when', 'inputs', 'steps', 'answer', 'checks', 'other']);
    expect(parsed.sections.at(-1)!.text).toBe('نص إضافي  ظاهر.');
  });
  it('answers with steps, outline and checks, asks for the inputs last and names the skill as source', () => {
    const skill = fixture('demo-skill', 'مهارة تجريبية', 'وصف تجريبي للمهارة.');
    const { text, lang } = composeSkillAnswer('كيف أبدأ مشروعي؟', skill, body, { mode: 'advice', related: [fixture('other-skill', 'مهارة أخرى', 'وصف آخر.')] });
    expect(lang).toBe('ar');
    expect(text.startsWith('**مهارة تجريبية**')).toBe(true);
    expect(text.indexOf('**الخطوات**')).toBeLessThan(text.indexOf('**شكل الجواب**'));
    expect(text.indexOf('**شكل الجواب**')).toBeLessThan(text.indexOf('**تحقق قبل التسليم**'));
    expect(text.indexOf('**تحقق قبل التسليم**')).toBeLessThan(text.indexOf('لأطبّق المهارة على حالتك'));
    expect(text).toContain('افعل الأول لـ «كيف أبدأ مشروعي؟»');
    expect(text).toContain('مهارات قريبة: «مهارة أخرى».');
    expect(text.trimEnd().endsWith('المصدر: مهارة «مهارة تجريبية» (demo-skill)، الإصدار 1.0.0.')).toBe(true);
    expect(text).not.toContain('متى تُستخدم');
    expect(text).not.toContain('مخفي');
  });
  it('says plainly in writing mode that it gives the method, not the finished text, and uses English labels for English requests', () => {
    const skill = fixture('demo-skill', 'Demo skill', 'A demo skill.');
    expect(composeSkillAnswer('اكتب مقال عن القهوة', skill, body, { mode: 'writing' }).text).toMatch(/^لا أكتب نصًا حرًا كاملًا دون نموذج لغوي/u);
    const english = composeSkillAnswer('how do I start my project', skill, body, { mode: 'advice' });
    expect(english.lang).toBe('en');
    expect(english.text).toContain('**Steps**');
    expect(english.text.trimEnd().endsWith('Source: skill “Demo skill” (demo-skill), version 1.0.0.')).toBe(true);
  });
  it('stays within its size bound with a very long skill', () => {
    const long = ['## الخطوات', ...Array.from({ length: 400 }, (_, index) => `${index + 1}. خطوة طويلة جدًا تشرح العمل بالتفصيل.`), '## تحقق قبل التسليم', '- فحص.'].join('\n');
    const { text } = composeSkillAnswer('كيف؟', fixture('long-skill', 'مهارة طويلة', 'وصف.'), long, { mode: 'advice' });
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain('المصدر: مهارة «مهارة طويلة»');
  });
});

describe('skills in the published library shape', () => {
  const library = ['Use this to design, run and read A/B tests.', '1. Hypothesis first: name one metric.', '2. Test one change at a time.', 'Answer shape: the test plan, then how to read the outcome.'].join('\n');
  it('reads an opening line, numbered steps and the answer shape from a body without headings', () => {
    const parsed = parseSkillSections(library);
    expect(parsed.intro).toBe('Use this to design, run and read A/B tests.');
    expect(parsed.sections).toEqual([
      { key: 'steps', heading: '', text: '1. Hypothesis first: name one metric.\n2. Test one change at a time.' },
      { key: 'answer', heading: '', text: 'the test plan, then how to read the outcome.' },
    ]);
    expect(parseSkillSections('Plain advice without any numbering, written as one paragraph.').sections).toEqual([{ key: 'other', heading: '', text: 'Plain advice without any numbering, written as one paragraph.' }]);
  });
  it('shows every step of an English skill to an Arabic request and says the skill is in English', () => {
    const skill = fixture('ab-testing-experiments', 'تجارب A/B ومقارنة النسخ', 'تجارب واختبار A/B.', 'analytics');
    const { text } = composeSkillAnswer('كيف أعمل تجربة A/B لإعلاني؟', skill, library, { mode: 'advice' });
    expect(text).toContain('نص هذه المهارة مكتوب بالإنجليزية كما نُشر.');
    expect(text).toContain('**الخطوات**\n1. Hypothesis first: name one metric.\n2. Test one change at a time.');
    expect(text).toContain('**شكل الجواب**\nthe test plan, then how to read the outcome.');
    expect(composeSkillAnswer('كيف أعمل تجربة؟', skill, '## الخطوات\n1. خطوة.', { mode: 'advice' }).text).not.toContain('مكتوب بالإنجليزية');
  });
  const question = 'كيف أعمل تجربة بين نسختين؟';
  const english = fixture('ab-testing-experiments', 'تجربة نسختين A/B', 'كلمات: تجربة نسختين', 'analytics');
  it('prefers a close skill written in the request language over an equally good one in another language', async () => {
    const arabic = fixture('ab-tests-ar', 'تجربة نسختين بالعربية', 'كلمات: تجربة نسختين', 'analytics');
    const bodies: Record<string, string> = { [english.id]: library, [arabic.id]: '## الخطوات\n1. حدد فرضية واحدة.' };
    const loaded: string[] = [];
    const read = createSkillReader({ candidates: async () => [english, arabic], instructions: async (_owner, id) => { loaded.push(id); return bodies[id] ?? null; } });
    const ranked = matchSkills(question, [english, arabic]);
    expect(ranked.map(match => match.skill.id)).toEqual([english.id, arabic.id]);
    expect(ranked[1]!.score).toBe(ranked[0]!.score);
    const result = await read('owner', question, { mode: 'advice' });
    expect(result?.skill.id).toBe(arabic.id);
    expect(loaded).toEqual([english.id, arabic.id]);
    expect(result!.text).not.toContain('مكتوب بالإنجليزية');
  });
  it('keeps the only fitting skill when it is in another language, and says so', async () => {
    const unrelated = fixture('cooking-recipes', 'وصفات الطبخ', 'كلمات: طبخ وصفات مطبخ', 'reasoning');
    const read = createSkillReader({ candidates: async () => [english, unrelated], instructions: async (_owner, id) => id === english.id ? library : '## الخطوات\n1. اطبخ.' });
    const result = await read('owner', question, { mode: 'advice' });
    expect(result?.skill.id).toBe(english.id);
    expect(result!.text).toContain('نص هذه المهارة مكتوب بالإنجليزية كما نُشر.');
  });
});

describe('the compiled skill context', () => {
  it('yields the verified SKILL.md text and nothing from an unexpected envelope', () => {
    const envelope = (extra: Record<string, unknown> = {}) => JSON.stringify({ kind: 'skill_context', trust: 'untrusted_instructions', permissionsGranted: false,
      skills: [{ id: 'x', slug: 's', name: 'n', version: '1.0.0', contentHash: 'h', sources: [{ path: 'references/a.md', contentHash: 'h', text: 'ref', truncated: false }, { path: 'SKILL.md', contentHash: 'h', text: 'body', truncated: false }] }], ...extra });
    expect(skillInstructionText(envelope())).toBe('body');
    expect(skillInstructionText(envelope({ permissionsGranted: true }))).toBeNull();
    expect(skillInstructionText(envelope({ kind: 'other' }))).toBeNull();
    expect(skillInstructionText('{not json')).toBeNull();
    expect(skillInstructionText('')).toBeNull();
  });
});

describe('the reader', () => {
  const seo = fixture('arabic-seo-article', 'كتابة مقال سيو متوافق مع محركات البحث', 'كلمات: مقال سيو SEO جوجل كلمات مفتاحية', 'marketing');
  const seoTwin = fixture('seo-backup', 'مقال سيو احتياطي', 'كلمات: مقال سيو جوجل', 'marketing');
  it('answers from the best skill that still passes the gate and skips one that no longer does', async () => {
    const ranked = matchSkills('كيف أكتب مقال سيو؟', [seo, seoTwin]).map(match => match.skill);
    expect(ranked).toHaveLength(2);
    const [first, second] = ranked as [SkillReaderCandidate, SkillReaderCandidate];
    const loaded: string[] = [];
    const read = createSkillReader({ candidates: async () => [seo, seoTwin], instructions: async (_owner, id) => { loaded.push(id); return id === first.id ? null : '## الخطوات\n1. خطوة.'; } });
    const result = await read('owner', 'كيف أكتب مقال سيو؟', { mode: 'advice' });
    expect(loaded).toEqual([first.id, second.id]);
    expect(result?.skill.id).toBe(second.id);
    expect(result!.related.map(skill => skill.id)).toEqual([first.id]);
    expect(result!.text).toContain('خطوة.');
  });
  it('returns nothing without a match, without skills, for a live question, on a failing store and after cancellation', async () => {
    const body = async () => '## الخطوات\n1. خطوة.';
    expect(await createSkillReader({ candidates: async () => [seo], instructions: body })('owner', 'ما عاصمة فرنسا؟', { mode: 'fallback' })).toBeNull();
    expect(await createSkillReader({ candidates: async () => [], instructions: body })('owner', 'كيف أكتب مقال سيو؟', { mode: 'advice' })).toBeNull();
    expect(await createSkillReader({ candidates: async () => [seo], instructions: body })('owner', 'مقال سيو عن أخبار اليوم', { mode: 'advice' })).toBeNull();
    expect(await createSkillReader({ candidates: async () => { throw new Error('store down'); }, instructions: body })('owner', 'كيف أكتب مقال سيو؟', { mode: 'advice' })).toBeNull();
    const controller = new AbortController(); controller.abort();
    expect(await createSkillReader({ candidates: async () => [seo], instructions: body })('owner', 'كيف أكتب مقال سيو؟', { mode: 'advice', signal: controller.signal })).toBeNull();
  });
});

describe('the skills shipped in skills/', () => {
  it('are thirty instruction skills that parse, pass the real inspector without findings and carry the sections the reader uses', async () => {
    const all = await bundles();
    expect(all).toHaveLength(30);
    for (const { candidate } of all) {
      const content = await readFile(join(SKILLS_DIR, candidate.slug, 'SKILL.md'), 'utf8');
      const source = buildSkillSource([{ path: 'SKILL.md', content }], { root: 'github:owner/skills', defaultSlug: candidate.slug });
      expect(source.contract, candidate.slug).toMatchObject({ slug: candidate.slug, level: 'instruction', sideEffects: 'none', requires: { tools: [], scopes: [], paths: [] } });
      const inspection = inspectSkill(source.contract, source.files);
      expect({ slug: candidate.slug, verdict: inspection.verdict, findings: inspection.findings.map(finding => finding.code) }).toEqual({ slug: candidate.slug, verdict: 'pass', findings: [] });
      const keys = parseSkillSections(source.files[0]!.content.replace(/^---[\s\S]*?\n---\n/u, '')).sections.map(section => section.key);
      expect(keys, candidate.slug).toEqual(expect.arrayContaining(['when', 'inputs', 'steps', 'answer', 'checks', 'pitfalls']));
      expect(Buffer.byteLength(content), candidate.slug).toBeLessThan(8000);
    }
  });
});

/**
 * Routing measured on questions written before the first run. The development half guided the skill descriptions;
 * the held-out half was never used to change a description or a rule, so its numbers are the honest estimate.
 */
const DEVELOPMENT: [string, string][] = [
  ['كيف أكتب مقال سيو يتصدر جوجل؟', 'arabic-seo-article'], ['ما هي خطوات كتابة مقالة متوافقة مع محركات البحث؟', 'arabic-seo-article'],
  ['كيف أكتب ايميل رسمي لعميل؟', 'professional-email'], ['نصائح لكتابة بريد إلكتروني مهني لمديري', 'professional-email'],
  ['كيف أكتب منشور انستغرام يجيب تفاعل؟', 'social-media-posts'], ['أفكار بوست لينكدان لشركتي', 'social-media-posts'],
  ['كيف أكتب وصف منتج في متجر سلة؟', 'product-description'], ['وصف منتج مقنع لعطر في متجري الإلكتروني', 'product-description'],
  ['كيف أكتب سيرة ذاتية احترافية؟', 'cv-resume-ar'], ['ساعدني في السي في للتقديم على وظيفة محاسب', 'cv-resume-ar'],
  ['كيف أكتب خطاب تقديم لوظيفة؟', 'cover-letter'], ['نصائح لرسالة تحفيزية للتقديم على منحة', 'cover-letter'],
  ['كيف أكتب محضر اجتماع؟', 'meeting-minutes'], ['ساعدني أوثق قرارات ومهام اجتماع الفريق', 'meeting-minutes'],
  ['كيف أكتب تقرير شهري لمديري؟', 'professional-report'], ['كيف أكتب تقرير أداء ربع سنوي؟', 'professional-report'],
  ['كيف أعمل عرض تقديمي مقنع للمستثمرين؟', 'presentation-outline'], ['أفكار شرائح بوربوينت لعرض مشروع تخرج', 'presentation-outline'],
  ['كيف أكتب خطة عمل لمشروع صغير؟', 'business-plan-ar'], ['ساعدني في دراسة جدوى لمشروع مقهى', 'business-plan-ar'],
  ['كيف أسوي خطة تسويق لمطعمي؟', 'marketing-plan'], ['استراتيجية تسويق إلكتروني لمتجر صغير', 'marketing-plan'],
  ['كيف أعمل تحليل SWOT لشركتي؟', 'swot-analysis'], ['نقاط القوة والضعف والفرص والتهديدات لمشروعي', 'swot-analysis'],
  ['كيف أحدد سعر منتجي؟', 'pricing-strategy-ar'], ['استراتيجية تسعير باقات الاشتراك', 'pricing-strategy-ar'],
  ['كيف أرد على شكوى عميل غاضب؟', 'customer-complaint'], ['عميل كتب تقييم سلبي عن متجري وش أرد عليه', 'customer-complaint'],
  ['كيف أقنع العميل يشتري؟', 'sales-pitch'], ['ساعدني أكتب عرض مبيعات لخدمة التصميم', 'sales-pitch'],
  ['كيف أحلل المنافسين في السوق؟', 'competitor-analysis'], ['دراسة المنافسين لمتجر عطور', 'competitor-analysis'],
  ['كيف أعمل خطة مشروع بمراحل ومهام؟', 'project-plan'], ['جدول زمني لمشروع بناء موقع إلكتروني', 'project-plan'],
  ['ما هي مؤشرات الأداء المناسبة لمتجري؟', 'kpi-metrics'], ['كيف أحدد مؤشرات أداء لفريق المبيعات؟', 'kpi-metrics'],
  ['كيف أستعد لمقابلة عمل؟', 'hiring-interview'], ['أسئلة مقابلة توظيف لمحاسب', 'hiring-interview'],
  ['كيف ألخص بحث علمي؟', 'research-summary'], ['طريقة تلخيص كتاب في نقاط رئيسية', 'research-summary'],
  ['محتار بين عرضين وظيفيين كيف أقرر؟', 'decision-making-ar'], ['كيف أختار بين خيارين صعبين؟', 'decision-making-ar'],
  ['كيف أعرف السبب الجذري لمشكلة تتكرر؟', 'root-cause-analysis-ar'], ['تحليل لماذا الخمسة لمشكلة تأخير التسليم', 'root-cause-analysis-ar'],
  ['كيف أحلل بيانات المبيعات في الإكسل؟', 'data-analysis-ar'], ['طريقة عمل جدول محوري', 'data-analysis-ar'],
  ['كيف أراجع الكود قبل الدمج؟', 'code-review-ar'], ['راجع لي جودة هذا الكود', 'code-review-ar'],
  ['التطبيق يطلع لي رسالة خطأ كيف أصلحها؟', 'bug-debugging'], ['كيف أتتبع خطأ برمجي؟', 'bug-debugging'],
  ['كيف أكتب استعلام SQL لربط جدولين؟', 'sql-queries'], ['الاستعلام بطيء في قاعدة البيانات كيف أسرعه؟', 'sql-queries'],
  ['كيف أحمي حساباتي من الاختراق؟', 'account-security'], ['انسرق حسابي في الانستغرام وش أسوي؟', 'account-security'],
  ['كيف أذاكر للاختبارات النهائية؟', 'study-plan'], ['ساعدني في خطة مذاكرة لشهر', 'study-plan'],
  ['كيف أترجم عقد من الإنجليزية إلى العربية بدقة؟', 'translation-quality'], ['نصائح للمترجمين المبتدئين', 'translation-quality'],
  ['كيف أعمل ميزانية شهرية لراتبي؟', 'personal-budget'], ['طريقة الادخار من الراتب', 'personal-budget'],
];
const HELD_OUT: [string, string][] = [
  ['ابغى اكتب تدوينة لمدونتي وتطلع أول نتيجة في جوجل', 'arabic-seo-article'], ['How do I write an SEO blog article?', 'arabic-seo-article'],
  ['how to write a professional email to a client', 'professional-email'], ['ما أفضل طريقة لصياغة إيميل متابعة لطلب لم يُرد عليه؟', 'professional-email'],
  ['ساعدني في كابشن تيك توك لمتجري', 'social-media-posts'], ['how to write engaging social media posts for instagram', 'social-media-posts'],
  ['write a product description for my shopify store', 'product-description'], ['ابي وصف للمنتج يزيد المبيعات في أمازون', 'product-description'],
  ['how do I make my resume pass ATS', 'cv-resume-ar'], ['أبغى أحسن سيرتي الذاتية عشان أتوظف', 'cv-resume-ar'],
  ['how to write a cover letter for a marketing job', 'cover-letter'], ['ما الذي يجب كتابته في خطاب التغطية؟', 'cover-letter'],
  ['how to write meeting minutes with action items', 'meeting-minutes'], ['نموذج ملخص اجتماع بالقرارات والمسؤولين', 'meeting-minutes'],
  ['write an executive summary for a weekly business report', 'professional-report'], ['ساعدني بتقرير عن نتائج المشروع للإدارة', 'professional-report'],
  ['help me structure a pitch deck', 'presentation-outline'], ['نصائح لتقديم عرض أمام الإدارة', 'presentation-outline'],
  ['how to write a business plan for a startup', 'business-plan-ar'], ['ابي بزنس بلان لمشروع متجر ملابس عشان أقدمه للممول', 'business-plan-ar'],
  ['help me build a digital marketing plan with a small budget', 'marketing-plan'], ['كيف أجذب عملاء جدد لمحلي؟', 'marketing-plan'],
  ['swot analysis for a coffee shop', 'swot-analysis'], ['ساعدني بتحليل سوات قبل ما أفتح المشروع', 'swot-analysis'],
  ['how should I price my consulting service', 'pricing-strategy-ar'], ['كم أحط هامش ربح على المنتجات؟', 'pricing-strategy-ar'],
  ['how to respond to a negative review', 'customer-complaint'], ['أفضل طريقة للتعامل مع شكاوى العملاء', 'customer-complaint'],
  ['how to handle sales objections about price', 'sales-pitch'], ['نصائح لمندوب مبيعات جديد لزيادة المبيعات', 'sales-pitch'],
  ['how to do a competitor analysis', 'competitor-analysis'], ['ابي اعرف نقاط ضعف المنافسين عشان اتميز عليهم', 'competitor-analysis'],
  ['help me create a project plan with milestones', 'project-plan'], ['ساعدني في إدارة مشروع متأخر عن موعده', 'project-plan'],
  ['which KPIs should I track for my ecommerce store', 'kpi-metrics'], ['أبي داشبورد أتابع فيه أداء الفريق', 'kpi-metrics'],
  ['how to prepare for a job interview', 'hiring-interview'], ['كيف أقيّم المرشحين في المقابلة؟', 'hiring-interview'],
  ['how to summarize a research paper', 'research-summary'], ['ساعدني بمراجعة أدبيات لرسالة الماجستير', 'research-summary'],
  ['help me decide between two job offers', 'decision-making-ar'], ['مصفوفة قرار لاختيار مورد', 'decision-making-ar'],
  ['how to do a root cause analysis', 'root-cause-analysis-ar'], ['عندنا شكاوى متكررة من العملاء كيف نوصل لأصل المشكلة', 'root-cause-analysis-ar'],
  ['how to analyze sales data in excel', 'data-analysis-ar'], ['أبي أنظف بيانات جدول جوجل شيت وأطلع منه نتائج', 'data-analysis-ar'],
  ['how to do a good code review', 'code-review-ar'], ['ما الذي أفحصه في مراجعة طلب سحب؟', 'code-review-ar'],
  ['how do I debug an exception in my app', 'bug-debugging'], ['الكود لا يعمل ويطلع خطأ عند التشغيل', 'bug-debugging'],
  ['how to write a sql query with group by', 'sql-queries'], ['ابي استعلام يجمع المبيعات لكل عميل من قاعدة البيانات', 'sql-queries'],
  ['how to enable two factor authentication', 'account-security'], ['وصلتني رسالة مشبوهة تطلب رمز التحقق هل هي احتيال؟', 'account-security'],
  ['make me a study plan for exams', 'study-plan'], ['أبي أتعلم لغة جديدة بطريقة منظمة', 'study-plan'],
  ['tips for translating a website from english to arabic', 'translation-quality'], ['ما أفضل طريقة لترجمة المصطلحات التقنية؟', 'translation-quality'],
  ['how to make a monthly budget and save money', 'personal-budget'], ['مصاريفي كثيرة وما أقدر أوفر كيف أنظم فلوسي؟', 'personal-budget'],
];
const NEGATIVE_DEVELOPMENT = ['ما عاصمة اليابان؟', 'من هو مؤسس شركة مايكروسوفت؟', 'كم عدد سكان مصر؟', 'سعر الذهب اليوم', 'طقس الرياض الآن', 'مرحبا كيف حالك', 'شكرا لك',
  'افتح يوتيوب', 'احجز لي فندق في دبي', 'ارسم لي صورة قطة', 'كيف أطبخ الكبسة؟', 'ما علاج الصداع النصفي؟', 'أفضل الأماكن السياحية في تركيا', 'من فاز بكأس العالم 2022؟',
  'متى يبدأ شهر رمضان؟', 'what is the capital of france', 'who won the champions league', 'play some music', 'تذكر أن اسم زوجتي سارة', 'احسب 15 بالمئة من 200'];
const NEGATIVE_HELD_OUT = ['ما هو الذكاء الاصطناعي؟', 'كم يبعد القمر عن الأرض؟', 'نتيجة مباراة الهلال والنصر', 'كيف حال الطقس في جدة غدا؟', 'اهلا', 'تمام شكرا', 'اتصل بأخي',
  'اشتري لي تذكرة طيران', 'كيف أزرع الطماطم في البيت؟', 'كيف أخسر وزني بسرعة؟', 'ما معنى كلمة سرنديبيتي؟', 'قصة قصيرة للأطفال عن الصدق', 'كيف أصلح تسريب ماء في الحمام؟',
  'how tall is the eiffel tower', 'how do I bake a chocolate cake', 'best football players of all time', 'ذكرني بموعد الطبيب بكرة', 'متى تأسست الأمم المتحدة؟',
  'كيف أربي قطة صغيرة؟', 'كيف أتعلم السباحة؟'];

function measure(pool: readonly SkillReaderCandidate[], positives: readonly [string, string][], negatives: readonly string[]) {
  const misses = positives.flatMap(([question, slug]) => { const top = matchSkills(question, pool)[0]?.skill.slug ?? null; return top === slug ? [] : [{ question, expected: slug, got: top }]; });
  const falsePositives = negatives.flatMap(question => { const top = matchSkills(question, pool)[0]; return top ? [{ question, got: top.skill.slug }] : []; });
  return { correct: positives.length - misses.length, total: positives.length, misses, falsePositives };
}

describe('recalling an author-supplied topic', () => {
  // Exercise the existing development request against its checked-in skill.
  const [request, expected] = DEVELOPMENT.findLast(([, slug]) => slug === 'translation-quality')!;

  it('recalls one distinctive keyword in either catalogue path and loads the verified body', async () => {
    const library = await bundles();
    const pool = library.map(entry => entry.candidate);
    const index = buildSkillReaderIndex(pool);
    const matches = matchSkills(request, pool);
    expect(matches.map(match => match.skill.slug)).toEqual([expected]);
    expect(matchSkills(request, pool, index)).toEqual(matches);

    const reader = createSkillReader({
      candidates: async () => pool,
      index: async () => index,
      instructions: async (_owner, id) => library.find(entry => entry.candidate.id === id)?.body ?? null,
    });
    expect((await reader('owner', request, { mode: 'advice' }))?.skill.slug).toBe(expected);
  });

  it('requires an explicit keyword or title and abstains when another skill uses the same topic', async () => {
    const library = await bundles();
    const skill = library.find(entry => entry.candidate.slug === expected)!.candidate;
    const aliases = skill.description.split('كلمات:')[1]!;
    const duplicate = library.find(entry => entry.candidate.slug !== expected)!.candidate;
    expect(matchSkills(request, [{ ...skill, description: aliases }])).toEqual([]);
    expect(matchSkills(request, [skill, { ...duplicate, description: aliases }])).toEqual([]);
  });

  it('abstains on the pilot development request for generic project help', async () => {
    const cases = JSON.parse(await readFile('skills-pilot/tests/cases.json', 'utf8')) as { ambiguous: string[] };
    const genericHelp = cases.ambiguous.find(text => text.startsWith('help me'))!;
    const pool = (await bundles(resolve('skills-pilot/skills'))).map(entry => entry.candidate);
    expect(matchSkills(genericHelp, pool, buildSkillReaderIndex(pool))).toEqual([]);
  });
});

describe('routing on real questions', () => {
  it('development set: picks the intended skill and stays silent on unrelated requests', async () => {
    const pool = (await bundles()).map(entry => entry.candidate);
    const result = measure(pool, DEVELOPMENT, NEGATIVE_DEVELOPMENT);
    console.log(`SKILL_ROUTING development ${JSON.stringify({ correct: result.correct, total: result.total, falsePositives: result.falsePositives.length, misses: result.misses, unrelated: result.falsePositives })}`);
    expect(result.falsePositives).toEqual([]);
    // Measured 2026-11-22: 59 of 60 after tuning on this set (55 of 60 before).
    expect(result.correct / result.total).toBeGreaterThanOrEqual(0.95);
  });
  it('held-out set: reports the honest estimate and never answers an unrelated request from a skill', async () => {
    const pool = (await bundles()).map(entry => entry.candidate);
    const result = measure(pool, HELD_OUT, NEGATIVE_HELD_OUT);
    console.log(`SKILL_ROUTING held-out ${JSON.stringify({ correct: result.correct, total: result.total, falsePositives: result.falsePositives.length, misses: result.misses, unrelated: result.falsePositives })}`);
    expect(result.falsePositives).toEqual([]);
    // Measured 2026-11-22: 53 of 60 (50 of 60 before the general rule changes made on the development set); 6 abstain, 1 wrong skill.
    expect(result.correct / result.total).toBeGreaterThanOrEqual(0.85);
  });
});
