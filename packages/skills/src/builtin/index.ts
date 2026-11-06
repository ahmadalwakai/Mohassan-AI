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
  define({
    slug: 'google-ads-campaign', name: 'حملات Google Ads', version: '1.1.0', category: 'marketing', level: 'instruction',
    description: 'يوجه تخطيط حملة Google Ads (إعلانات جوجل، اعلانات قوقل) وكتابة الإعلانات والكلمات المفتاحية ومراجعتها، وقراءة أداء الحساب المربوط، وحفظ المسودات للمراجعة دون نشر أو إنفاق بلا موافقة المالك.',
    requires: { tools: ['browser.open', 'browser.interact', 'browser.submit', 'research.run'], scopes: ['browser:read', 'browser:write', 'research:read'] }, sideEffects: 'financial',
    rollback: { mode: 'manual', note: 'تُوقف الحملة أو تُزال من حساب Google Ads يدوياً؛ لا يمكن استرداد ما أُنفق.' },
  }, `
Use this for Google Ads work: planning a search campaign, writing ads or keywords, reviewing a draft, or building a campaign in the account. When ads_status shows a connected account, use the official API tools: ads_report for real figures and ads_draft to save a preview. Publishing and launch are only the owner's, in the Google Ads section. If no account is connected, say so and offer the Google Ads section; never invent figures.
1. Facts first. Get the business, service, area, landing page, budget and what counts as a conversion. Open the landing page and use only claims it makes. Never invent prices, ratings, phone numbers or guarantees. Ask once for what is missing.
2. Structure. One search campaign per goal and one ad group per service, with its keywords, ads and landing page all about that service. For a local business, recommend the location option "Presence: People in or regularly in your targeted locations".
3. Keywords. Exact is [moving services], phrase is "moving services", broad is moving services. Never write +moving +services: new keywords cannot use broad match modifier. Propose negative keywords only for searches the business cannot serve, never for words ads_check refused.
4. Ads. A responsive search ad has 3 to 15 headlines of up to 30 characters, 2 to 4 descriptions of up to 90, and up to 2 display paths of up to 15. Write ads and keywords in the language the customers search in, which is the landing page's language or the main language of the target area, not the language of this chat, unless told otherwise.
5. Check. Before showing a draft or typing it into Google Ads, pass every headline, description, path and keyword to ads_check. Fix what fails and check again. After PASS, do not repeat the text in your answer: the program adds it.
6. Money. The daily budget is an average: for most campaigns one day can reach 2 times it and a month 30.4 times it. Say so. Give click, cost or lead forecasts only from figures you read in Keyword Planner or the account, never from memory.
7. Measurement. Confirm conversion tracking exists, or list what must be set up. Without it the campaign is not ready to launch, and the reply must say so.
8. In the account. Never build, publish, enable or change a campaign or budget through the browser: that would skip the checks and the owner's approval. Campaigns go through ads_draft, then the owner approves them in the Google Ads section. Use the browser for public pages only, such as the landing page.
9. Reporting. Explain in the owner's language, and keep ad text in the ad's language. Say a campaign is live only when the Google Ads section shows it as confirmed from the account.`),
]);
